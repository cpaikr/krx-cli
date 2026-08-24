use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::credential::credential_fingerprint;
use crate::state::{ReadSensitivity, StateRoot};
use crate::{ApiKey, Cancellation, KrxError, KrxErrorCode, TradingDate};

const QUOTA_PATH: &str = "rate-limit.json";
const QUOTA_LOCK_PATH: &str = "rate-limit.json.lock";
const QUOTA_READ_BOUND: u64 = 2 * 1024 * 1024;
const DAILY_LIMIT: u32 = 10_000;
const MAX_CREDENTIALS: usize = 10_000;
const LOCK_POLL: Duration = Duration::from_millis(25);
const LOCK_TIMEOUT: Duration = Duration::from_millis(5_000);
const LOCK_STALE_AFTER: Duration = Duration::from_millis(30_000);

#[derive(Clone, Debug)]
pub(crate) struct QuotaStore {
    state: StateRoot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct QuotaReservation {
    pub(crate) count: u32,
    pub(crate) remaining: u32,
    pub(crate) reserved: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct QuotaEntry {
    date: String,
    count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QuotaRootV0 {
    date: String,
    count: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct QuotaV1 {
    version: u8,
    credentials: BTreeMap<String, QuotaEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PersistedQuota {
    V1(QuotaV1),
    V0(QuotaRootV0),
}

impl QuotaStore {
    pub(crate) fn new(root: PathBuf) -> Result<Self, KrxError> {
        Ok(Self {
            state: StateRoot::new(root)?,
        })
    }

    pub(crate) async fn reserve(
        &self,
        api_key: &ApiKey,
        date: &TradingDate,
        cancellation: &Cancellation,
    ) -> Result<QuotaReservation, KrxError> {
        let state = self.state.clone();
        let fingerprint = credential_fingerprint(api_key);
        let date = date.clone();
        let cancellation = cancellation.clone();
        tokio::task::spawn_blocking(move || {
            reserve_blocking(&state, &fingerprint, &date, &cancellation)
        })
        .await
        .map_err(|_| KrxError::new(KrxErrorCode::InternalFailure, "local quota worker failed"))?
    }
}

fn reserve_blocking(
    state: &StateRoot,
    fingerprint: &str,
    date: &TradingDate,
    cancellation: &Cancellation,
) -> Result<QuotaReservation, KrxError> {
    let deadline = Instant::now() + LOCK_TIMEOUT;
    let owner = format!("{}-{}", std::process::id(), Uuid::new_v4());
    let lock = loop {
        if cancellation.is_cancelled() {
            return Err(KrxError::new(
                KrxErrorCode::RequestCancelled,
                "request was cancelled while waiting for the local quota lock",
            ));
        }
        if let Some(lock) = state.try_acquire_plain_lock(
            QUOTA_LOCK_PATH,
            owner.clone(),
            KrxErrorCode::QuotaStateIoFailed,
        )? {
            break lock;
        }
        let stole = state.steal_plain_lock_if_stale(
            QUOTA_LOCK_PATH,
            LOCK_STALE_AFTER,
            SystemTime::now(),
            KrxErrorCode::QuotaStateIoFailed,
        )?;
        if stole {
            continue;
        }
        if Instant::now() >= deadline {
            return Err(KrxError::new(
                KrxErrorCode::QuotaLockTimeout,
                "timed out waiting for the local quota lock",
            ));
        }
        std::thread::sleep(LOCK_POLL);
    };

    let mut data = read_quota(state, fingerprint)?;
    let existing_count = data
        .credentials
        .get(fingerprint)
        .filter(|entry| entry.date == date.as_str())
        .map_or(0, |entry| entry.count);
    if existing_count >= DAILY_LIMIT {
        drop(lock);
        return Ok(QuotaReservation {
            count: DAILY_LIMIT,
            remaining: 0,
            reserved: false,
        });
    }

    data.credentials
        .retain(|_, entry| entry.date == date.as_str());
    if !data.credentials.contains_key(fingerprint) && data.credentials.len() >= MAX_CREDENTIALS {
        return Err(invalid_quota(
            "local quota state cannot admit another credential",
        ));
    }
    let count = existing_count + 1;
    data.credentials.insert(
        fingerprint.to_owned(),
        QuotaEntry {
            date: date.as_str().to_owned(),
            count,
        },
    );
    let mut bytes = serde_json::to_vec_pretty(&data)
        .map_err(|_| invalid_quota("local quota state could not be serialized"))?;
    bytes.push(b'\n');
    state.atomic_write(QUOTA_PATH, &bytes, KrxErrorCode::QuotaStateIoFailed)?;
    drop(lock);
    Ok(QuotaReservation {
        count,
        remaining: DAILY_LIMIT - count,
        reserved: true,
    })
}

fn read_quota(state: &StateRoot, fingerprint: &str) -> Result<QuotaV1, KrxError> {
    let Some(observed) = state.read(
        QUOTA_PATH,
        QUOTA_READ_BOUND,
        ReadSensitivity::NonSecret,
        KrxErrorCode::QuotaStateIoFailed,
    )?
    else {
        return Ok(QuotaV1 {
            version: 1,
            credentials: BTreeMap::new(),
        });
    };
    decode_quota(observed.bytes(), fingerprint)
}

fn decode_quota(bytes: &[u8], fingerprint: &str) -> Result<QuotaV1, KrxError> {
    let persisted: PersistedQuota =
        serde_json::from_slice(bytes).map_err(|_| invalid_quota("local quota state is invalid"))?;
    let data = match persisted {
        PersistedQuota::V1(data) => data,
        PersistedQuota::V0(entry) => QuotaV1 {
            version: 1,
            credentials: BTreeMap::from([(
                fingerprint.to_owned(),
                QuotaEntry {
                    date: entry.date,
                    count: entry.count,
                },
            )]),
        },
    };
    validate_quota(&data)?;
    Ok(data)
}

fn validate_quota(data: &QuotaV1) -> Result<(), KrxError> {
    if data.version != 1 || data.credentials.len() > MAX_CREDENTIALS {
        return Err(invalid_quota("local quota state is invalid"));
    }
    for (fingerprint, entry) in &data.credentials {
        if fingerprint.len() != 64
            || !fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || entry.count > DAILY_LIMIT
            || TradingDate::parse(&entry.date).is_err()
        {
            return Err(invalid_quota("local quota state is invalid"));
        }
    }
    Ok(())
}

fn invalid_quota(message: &'static str) -> KrxError {
    KrxError::new(KrxErrorCode::QuotaStateInvalid, message)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    struct TestStore {
        parent: PathBuf,
        store: QuotaStore,
    }

    impl TestStore {
        fn new() -> Self {
            let parent = std::env::current_dir()
                .expect("working directory")
                .join("target")
                .join("quota-tests")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&parent).expect("test parent");
            let store = QuotaStore::new(parent.join(".krx-cli")).expect("quota store");
            Self { parent, store }
        }

        fn quota_path(&self) -> PathBuf {
            self.parent.join(".krx-cli/rate-limit.json")
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.parent).expect("remove quota test state");
        }
    }

    #[tokio::test]
    async fn migrates_and_reserves_legacy_quota_by_exact_credential_identity() {
        let fixture = TestStore::new();
        fs::create_dir(fixture.parent.join(".krx-cli")).expect("state root");
        fs::write(fixture.quota_path(), br#"{"date":"20260102","count":9}"#).expect("legacy quota");
        let key = ApiKey::parse("fixture-secret").expect("key");
        let date = TradingDate::parse("20260102").expect("date");
        let reservation = fixture
            .store
            .reserve(&key, &date, &Cancellation::new())
            .await
            .expect("reservation");
        assert_eq!(reservation.count, 10);
        assert!(reservation.reserved);
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.quota_path()).unwrap()).unwrap();
        assert_eq!(
            persisted["credentials"][credential_fingerprint(&key)]["count"],
            10
        );
        assert!(
            !fs::read_to_string(fixture.quota_path())
                .unwrap()
                .contains("fixture-secret")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_reservations_are_exact_and_corrupt_state_is_preserved() {
        let fixture = TestStore::new();
        let key = ApiKey::parse("shared-key").expect("key");
        let date = TradingDate::parse("20260102").expect("date");
        let mut tasks = Vec::new();
        for _ in 0..40 {
            let store = fixture.store.clone();
            let key = key.clone();
            let date = date.clone();
            tasks.push(tokio::spawn(async move {
                store.reserve(&key, &date, &Cancellation::new()).await
            }));
        }
        for task in tasks {
            assert!(task.await.unwrap().unwrap().reserved);
        }
        let persisted: QuotaV1 =
            serde_json::from_slice(&fs::read(fixture.quota_path()).unwrap()).unwrap();
        assert_eq!(
            persisted.credentials[&credential_fingerprint(&key)].count,
            40
        );

        fs::write(fixture.quota_path(), b"{not-json").expect("corrupt state");
        let error = fixture
            .store
            .reserve(&key, &date, &Cancellation::new())
            .await
            .expect_err("corruption rejected");
        assert_eq!(error.code(), KrxErrorCode::QuotaStateInvalid);
        assert_eq!(fs::read(fixture.quota_path()).unwrap(), b"{not-json");
    }

    #[tokio::test]
    async fn cancellation_does_not_touch_quota_state() {
        let fixture = TestStore::new();
        let cancellation = Cancellation::new();
        cancellation.cancel();
        let error = fixture
            .store
            .reserve(
                &ApiKey::parse("key").unwrap(),
                &TradingDate::parse("20260102").unwrap(),
                &cancellation,
            )
            .await
            .expect_err("cancelled");
        assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
        assert!(!fixture.quota_path().exists());
    }

    #[test]
    fn production_decoder_matches_every_frozen_quota_fixture() {
        let fingerprint = "66e7c82b49bb291dd09c8e020448311c4a7bb96aeb5c5db769f66812b13a50b5";
        for valid in [
            include_bytes!("../../../contracts/product/v1/fixtures/quota-root-v0.json").as_slice(),
            include_bytes!("../../../contracts/product/v1/fixtures/quota-v1.json").as_slice(),
        ] {
            assert!(decode_quota(valid, fingerprint).is_ok());
        }
        for invalid in [
            include_bytes!(
                "../../../contracts/product/v1/fixtures/quota-root-impossible-date-invalid.json"
            )
            .as_slice(),
            include_bytes!(
                "../../../contracts/product/v1/fixtures/quota-v1-impossible-date-invalid.json"
            )
            .as_slice(),
            include_bytes!("../../../contracts/product/v1/fixtures/quota-over-limit-invalid.json")
                .as_slice(),
        ] {
            assert_eq!(
                decode_quota(invalid, fingerprint).unwrap_err().code(),
                KrxErrorCode::QuotaStateInvalid
            );
        }
    }

    #[test]
    fn canonical_maximum_quota_state_fits_the_read_bound() {
        let credentials = (0..10_000)
            .map(|index| {
                (
                    format!("{index:064x}"),
                    QuotaEntry {
                        date: "20260102".to_owned(),
                        count: DAILY_LIMIT,
                    },
                )
            })
            .collect();
        let state = QuotaV1 {
            version: 1,
            credentials,
        };
        let serialized = serde_json::to_vec_pretty(&state).expect("canonical quota");
        assert!((serialized.len() as u64) < QUOTA_READ_BOUND);
        validate_quota(&state).expect("maximum canonical quota is valid");
    }

    #[tokio::test]
    async fn exhausted_and_invalid_quota_bytes_are_preserved_exactly() {
        let fixture = TestStore::new();
        fs::create_dir(fixture.parent.join(".krx-cli")).expect("state root");
        let key = ApiKey::parse("shared-key").expect("key");
        let date = TradingDate::parse("20260102").expect("date");
        let exhausted = format!(
            "{{\"version\":1,\"credentials\":{{\"{}\":{{\"date\":\"20260102\",\"count\":10000}}}}}}",
            credential_fingerprint(&key)
        );
        fs::write(fixture.quota_path(), exhausted.as_bytes()).expect("exhausted quota");
        let reservation = fixture
            .store
            .reserve(&key, &date, &Cancellation::new())
            .await
            .expect("exhausted status");
        assert!(!reservation.reserved);
        assert_eq!(reservation.remaining, 0);
        assert_eq!(
            fs::read(fixture.quota_path()).unwrap(),
            exhausted.as_bytes()
        );

        let invalid = include_bytes!(
            "../../../contracts/product/v1/fixtures/quota-root-impossible-date-invalid.json"
        );
        fs::write(fixture.quota_path(), invalid).expect("invalid quota");
        let error = fixture
            .store
            .reserve(&key, &date, &Cancellation::new())
            .await
            .expect_err("impossible date rejected");
        assert_eq!(error.code(), KrxErrorCode::QuotaStateInvalid);
        assert_eq!(fs::read(fixture.quota_path()).unwrap(), invalid);
    }

    #[tokio::test]
    async fn credential_capacity_is_fail_closed_and_preserves_exact_bytes() {
        let fixture = TestStore::new();
        fs::create_dir(fixture.parent.join(".krx-cli")).expect("state root");
        let key = ApiKey::parse("new-credential").expect("key");
        let fingerprint = credential_fingerprint(&key);
        let credentials = (0..MAX_CREDENTIALS)
            .map(|index| {
                let existing = format!("{index:064x}");
                assert_ne!(existing, fingerprint);
                (
                    existing,
                    QuotaEntry {
                        date: "20260102".to_owned(),
                        count: 1,
                    },
                )
            })
            .collect();
        let mut original = serde_json::to_vec(&QuotaV1 {
            version: 1,
            credentials,
        })
        .expect("full quota state");
        original.push(b'\n');
        fs::write(fixture.quota_path(), &original).expect("full state");

        let error = fixture
            .store
            .reserve(
                &key,
                &TradingDate::parse("20260102").unwrap(),
                &Cancellation::new(),
            )
            .await
            .expect_err("capacity rejected");
        assert_eq!(error.code(), KrxErrorCode::QuotaStateInvalid);
        assert_eq!(fs::read(fixture.quota_path()).unwrap(), original);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "started by the Node/Rust quota interoperability contract test"]
    async fn node_interop_worker() {
        let root = PathBuf::from(
            std::env::var("KRX_TEST_QUOTA_ROOT").expect("interop state root is required"),
        );
        let calls = std::env::var("KRX_TEST_QUOTA_CALLS")
            .expect("interop call count is required")
            .parse::<usize>()
            .expect("interop call count");
        let parent = root.parent().expect("interop parent");
        fs::create_dir_all(parent).expect("interop parent exists");
        fs::write(parent.join("rust-ready"), b"ready").expect("ready marker");
        let start = parent.join("start");
        let deadline = Instant::now() + Duration::from_secs(30);
        while !start.exists() {
            assert!(Instant::now() < deadline, "interop start marker timed out");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let store = QuotaStore::new(root).expect("interop store");
        let key = ApiKey::parse("shared-key").expect("interop key");
        let date = TradingDate::parse("20260102").expect("interop date");
        let mut reservations = Vec::with_capacity(calls);
        for _ in 0..calls {
            let store = store.clone();
            let key = key.clone();
            let date = date.clone();
            reservations.push(tokio::spawn(async move {
                store.reserve(&key, &date, &Cancellation::new()).await
            }));
        }
        for reservation in reservations {
            assert!(reservation.await.unwrap().unwrap().reserved);
        }
    }
}
