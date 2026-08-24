use std::path::Path;
use std::time::{Duration, SystemTime};

use jiff::{RoundMode, Timestamp, TimestampRound, Unit};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::conformer::decode_cached_rows;
use crate::credential::{CACHE_ENTRY_READ_BYTES, CACHE_FUTURE_SKEW_SECONDS};
use crate::operation::{operation_spec, parse_operation_id};
use crate::state::{ObservedFile, StateRoot};
use crate::{
    Freshness, KrxError, KrxErrorCode, OperationId, QueryResult, ResultProvenance, ResultSource,
    Row, TradingDate,
};

#[derive(Clone, Debug, Default)]
pub struct CacheInspectOptions {
    pub operation: Option<OperationId>,
    pub date: Option<TradingDate>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct CacheEntryDescription {
    pub operation: OperationId,
    pub date: TradingDate,
    pub fetched_at: SystemTime,
    pub freshness: Freshness,
    pub size_bytes: u64,
    pub contract_id: String,
}

#[derive(Clone, Debug)]
pub struct CacheInspection {
    pub entries: Vec<CacheEntryDescription>,
    pub total_entries: usize,
    pub total_size_bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default)]
pub struct CachePruneOptions {
    pub older_than: Option<SystemTime>,
    pub max_entries: Option<usize>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CachePruneResult {
    pub removed_entries: usize,
    pub removed_bytes: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct CacheKey {
    operation: OperationId,
    date: TradingDate,
    parameters: Vec<(String, String)>,
    v1_path: String,
    v2_path: String,
    v2_digest: String,
}

impl CacheKey {
    pub(crate) fn new(operation: OperationId, date: TradingDate) -> Result<Self, KrxError> {
        let spec = operation_spec(operation);
        let parameters = vec![(spec.request_field.to_owned(), date.as_str().to_owned())];
        let parameters_json = serde_json::to_string(&parameters).map_err(|_| {
            KrxError::new(
                KrxErrorCode::InternalFailure,
                "cache key serialization failed",
            )
            .for_operation(operation)
        })?;
        let legacy = digest_hex(format!("{}:{parameters_json}", spec.path).as_bytes());
        let v2_digest = digest_hex(
            format!("krx-cache-v2\n{}\n{parameters_json}", operation.as_str()).as_bytes(),
        );
        let v1_path = format!("cache/{}/{}.json", date.as_str(), &legacy[..16]);
        let v2_path = format!("cache/v2/{}/{v2_digest}.json", date.as_str());
        Ok(Self {
            operation,
            date,
            parameters,
            v1_path,
            v2_path,
            v2_digest,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CacheVersion {
    V1,
    V2,
}

#[derive(Clone, Debug)]
pub(crate) struct CacheHit {
    pub result: QueryResult,
    version: CacheVersion,
    source_path: String,
    source: ObservedFile,
}

impl CacheHit {
    pub(crate) fn version(&self) -> CacheVersion {
        self.version
    }
}

#[derive(Clone, Debug)]
pub(crate) enum CacheRead {
    Hit(Box<CacheHit>),
    Miss,
    Invalid,
}

#[derive(Clone, Debug)]
pub(crate) struct CacheStore {
    state: StateRoot,
}

impl CacheStore {
    pub(crate) fn new(state: StateRoot) -> Self {
        Self { state }
    }

    pub(crate) fn key(
        &self,
        operation: OperationId,
        date: TradingDate,
    ) -> Result<CacheKey, KrxError> {
        CacheKey::new(operation, date)
    }

    pub(crate) fn read(
        &self,
        key: &CacheKey,
        max_age: Duration,
        now: SystemTime,
    ) -> Result<CacheRead, KrxError> {
        let mut observed_invalid = false;
        if let Some(observed) = self.state.read_cache(
            &key.v2_path,
            CACHE_ENTRY_READ_BYTES,
            KrxErrorCode::CacheReadFailed,
        )? {
            match observed
                .is_complete()
                .then(|| decode_v2(key, &observed, max_age, now))
            {
                Some(Ok(result)) => {
                    return Ok(CacheRead::Hit(Box::new(CacheHit {
                        result,
                        version: CacheVersion::V2,
                        source_path: key.v2_path.clone(),
                        source: observed,
                    })));
                }
                Some(Err(())) | None => {
                    self.quarantine(&key.v2_path, &observed, now)?;
                    observed_invalid = true;
                }
            }
        }

        let Some(observed) = self.state.read_cache(
            &key.v1_path,
            CACHE_ENTRY_READ_BYTES,
            KrxErrorCode::CacheReadFailed,
        )?
        else {
            return Ok(if observed_invalid {
                CacheRead::Invalid
            } else {
                CacheRead::Miss
            });
        };
        match observed
            .is_complete()
            .then(|| decode_v1(key, &observed, max_age, now))
        {
            Some(Ok(result)) => Ok(CacheRead::Hit(Box::new(CacheHit {
                result,
                version: CacheVersion::V1,
                source_path: key.v1_path.clone(),
                source: observed,
            }))),
            Some(Err(())) | None => {
                self.quarantine(&key.v1_path, &observed, now)?;
                Ok(CacheRead::Invalid)
            }
        }
    }

    pub(crate) fn write_v2(
        &self,
        key: &CacheKey,
        rows: &[Row],
        fetched_at: SystemTime,
        now: SystemTime,
    ) -> Result<bool, KrxError> {
        if rows.is_empty() || !is_historical(&key.date, now)? {
            return Ok(false);
        }
        if fetched_at.duration_since(now).unwrap_or(Duration::ZERO)
            > Duration::from_secs(CACHE_FUTURE_SKEW_SECONDS)
        {
            return Err(cache_error(
                KrxErrorCode::CacheWriteFailed,
                key.operation,
                "cache entry timestamp is too far in the future",
            ));
        }
        let spec = operation_spec(key.operation);
        let entry = CacheV2Write {
            version: 2,
            operation_id: key.operation.as_str(),
            schema_sha256: spec.contract_id,
            fetched_at: format_timestamp(fetched_at)?,
            params: &key.parameters,
            rows: rows.iter().map(row_value).collect(),
        };
        let bytes = serde_json::to_vec(&entry).map_err(|_| {
            cache_error(
                KrxErrorCode::CacheWriteFailed,
                key.operation,
                "cache entry serialization failed",
            )
        })?;
        if bytes.len() as u64 > CACHE_ENTRY_READ_BYTES {
            return Err(cache_error(
                KrxErrorCode::CacheWriteFailed,
                key.operation,
                "cache entry exceeds its write bound",
            ));
        }
        self.state
            .atomic_write(&key.v2_path, &bytes, KrxErrorCode::CacheWriteFailed)
            .map_err(|error| error.for_operation(key.operation))?;
        Ok(true)
    }

    pub(crate) fn promote_v1(
        &self,
        key: &CacheKey,
        hit: &CacheHit,
        now: SystemTime,
    ) -> Result<bool, KrxError> {
        if hit.version != CacheVersion::V1 || hit.source_path != key.v1_path {
            return Ok(false);
        }
        if !self.write_v2(key, &hit.result.rows, hit.result.provenance.fetched_at, now)? {
            return Ok(false);
        }
        let removed = self
            .state
            .remove_if_unchanged(
                &hit.source_path,
                &hit.source,
                KrxErrorCode::CacheWriteFailed,
            )
            .map_err(|error| error.for_operation(key.operation))?;
        Ok(removed)
    }

    fn quarantine(
        &self,
        relative: &str,
        observed: &ObservedFile,
        now: SystemTime,
    ) -> Result<(), KrxError> {
        let leaf = Path::new(relative)
            .file_name()
            .and_then(|leaf| leaf.to_str())
            .ok_or_else(|| {
                KrxError::new(KrxErrorCode::CacheReadFailed, "cache entry path is invalid")
            })?;
        let timestamp = Timestamp::try_from(now).map_err(|_| {
            KrxError::new(
                KrxErrorCode::CacheReadFailed,
                "cache quarantine timestamp is out of range",
            )
        })?;
        let target = format!(
            "{leaf}.corrupt-{}-{}",
            timestamp.strftime("%Y%m%dT%H%M%SZ"),
            Uuid::new_v4()
        );
        self.state.rename_if_unchanged(
            relative,
            observed,
            &target,
            KrxErrorCode::CacheReadFailed,
        )?;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CacheV1Read {
    version: u8,
    fetched_at: String,
    endpoint: String,
    params: Vec<(String, String)>,
    data: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CacheV2Read {
    version: u8,
    operation_id: String,
    schema_sha256: String,
    fetched_at: String,
    params: Vec<(String, String)>,
    rows: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheV2Write<'a> {
    version: u8,
    operation_id: &'a str,
    schema_sha256: &'a str,
    fetched_at: String,
    params: &'a [(String, String)],
    rows: Vec<Value>,
}

fn decode_v1(
    key: &CacheKey,
    observed: &ObservedFile,
    max_age: Duration,
    now: SystemTime,
) -> Result<QueryResult, ()> {
    let entry: CacheV1Read = serde_json::from_slice(observed.bytes()).map_err(|_| ())?;
    let spec = operation_spec(key.operation);
    if entry.version != 1
        || entry.endpoint != spec.path
        || entry.params != key.parameters
        || entry.data.is_empty()
        || !is_historical(&key.date, now).map_err(|_| ())?
    {
        return Err(());
    }
    cache_result(
        key.operation,
        spec.contract_id,
        entry.fetched_at,
        entry.data,
        max_age,
        now,
    )
}

fn decode_v2(
    key: &CacheKey,
    observed: &ObservedFile,
    max_age: Duration,
    now: SystemTime,
) -> Result<QueryResult, ()> {
    let entry: CacheV2Read = serde_json::from_slice(observed.bytes()).map_err(|_| ())?;
    let spec = operation_spec(key.operation);
    if entry.version != 2
        || parse_operation_id(&entry.operation_id) != Some(key.operation)
        || entry.schema_sha256 != spec.contract_id
        || entry.params != key.parameters
        || entry.rows.is_empty()
        || !is_historical(&key.date, now).map_err(|_| ())?
    {
        return Err(());
    }
    cache_result(
        key.operation,
        spec.contract_id,
        entry.fetched_at,
        entry.rows,
        max_age,
        now,
    )
}

fn cache_result(
    operation: OperationId,
    contract_id: &str,
    fetched_at: String,
    rows: Vec<Value>,
    max_age: Duration,
    now: SystemTime,
) -> Result<QueryResult, ()> {
    let fetched_at = parse_timestamp(&fetched_at).ok_or(())?;
    if fetched_at.duration_since(now).unwrap_or(Duration::ZERO)
        > Duration::from_secs(CACHE_FUTURE_SKEW_SECONDS)
    {
        return Err(());
    }
    let freshness = if now.duration_since(fetched_at).unwrap_or(Duration::ZERO) >= max_age {
        Freshness::Stale
    } else {
        Freshness::Fresh
    };
    let rows = decode_cached_rows(operation, &rows).map_err(|_| ())?;
    if rows.is_empty() {
        return Err(());
    }
    Ok(QueryResult {
        rows,
        provenance: ResultProvenance {
            source: ResultSource::Cache,
            fetched_at,
            freshness,
            contract_id: contract_id.to_owned(),
        },
    })
}

fn row_value(row: &Row) -> Value {
    Value::Object(
        row.iter()
            .map(|(field, value)| (field.to_owned(), Value::String(value.to_owned())))
            .collect::<Map<_, _>>(),
    )
}

fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut result, "{byte:02x}").expect("writing to a String cannot fail");
    }
    result
}

fn parse_timestamp(value: &str) -> Option<SystemTime> {
    if !has_rfc3339_shape(value) {
        return None;
    }
    let timestamp: Timestamp = value.parse().ok()?;
    Some(timestamp.into())
}

fn has_rfc3339_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
        || !bytes[17..19].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let mut zone_start = 19;
    if bytes.get(zone_start) == Some(&b'.') {
        zone_start += 1;
        let fraction_start = zone_start;
        while bytes.get(zone_start).is_some_and(u8::is_ascii_digit) {
            zone_start += 1;
        }
        if zone_start == fraction_start {
            return false;
        }
    }
    match &bytes[zone_start..] {
        [b'Z' | b'z'] => true,
        [b'+' | b'-', hour_a, hour_b, b':', minute_a, minute_b] => {
            [*hour_a, *hour_b, *minute_a, *minute_b]
                .iter()
                .all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

fn format_timestamp(value: SystemTime) -> Result<String, KrxError> {
    let timestamp = Timestamp::try_from(value)
        .and_then(|timestamp| {
            timestamp.round(
                TimestampRound::new()
                    .smallest(Unit::Millisecond)
                    .mode(RoundMode::Trunc),
            )
        })
        .map_err(|_| {
            KrxError::new(
                KrxErrorCode::CacheWriteFailed,
                "cache timestamp is out of range",
            )
        })?;
    Ok(timestamp.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn is_historical(date: &TradingDate, now: SystemTime) -> Result<bool, KrxError> {
    let shifted = now
        .checked_add(Duration::from_secs(9 * 60 * 60))
        .ok_or_else(|| {
            KrxError::new(
                KrxErrorCode::CacheReadFailed,
                "system time is outside the supported KST calendar",
            )
        })?;
    let timestamp = Timestamp::try_from(shifted).map_err(|_| {
        KrxError::new(
            KrxErrorCode::CacheReadFailed,
            "system time is outside the supported KST calendar",
        )
    })?;
    let today = TradingDate::parse(&timestamp.strftime("%Y%m%d").to_string()).map_err(|_| {
        KrxError::new(
            KrxErrorCode::CacheReadFailed,
            "system time is outside the supported KST calendar",
        )
    })?;
    Ok(date < &today)
}

fn cache_error(code: KrxErrorCode, operation: OperationId, message: &'static str) -> KrxError {
    KrxError::new(code, message).for_operation(operation)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use jiff::Timestamp;

    use super::*;

    struct Fixture {
        parent: PathBuf,
        store: CacheStore,
    }

    impl Fixture {
        fn new() -> Self {
            let parent = std::env::current_dir()
                .unwrap()
                .join("target")
                .join("cache-tests")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&parent).unwrap();
            let state = StateRoot::new(parent.join(".krx-cli")).unwrap();
            Self {
                parent,
                store: CacheStore::new(state),
            }
        }

        fn root(&self) -> PathBuf {
            self.parent.join(".krx-cli")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.parent).unwrap();
        }
    }

    fn at(value: &str) -> SystemTime {
        value.parse::<Timestamp>().unwrap().into()
    }

    fn key(store: &CacheStore) -> CacheKey {
        store
            .key(
                OperationId::StockStkByddTrd,
                TradingDate::parse("20260102").unwrap(),
            )
            .unwrap()
    }

    fn v1_fixture() -> Vec<u8> {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/product/v1/fixtures/cache-v1-full.json"
        ))
        .to_vec()
    }

    fn v2_fixture() -> Vec<u8> {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/product/v1/fixtures/cache-v2-full.json"
        ))
        .to_vec()
    }

    #[test]
    fn canonical_keys_and_strict_v1_v2_fixtures_match() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        assert_eq!(key.v1_path, "cache/20260102/f7a6dcad228ef7ba.json");
        assert_eq!(key.v2_digest.len(), 64);

        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &v1_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let hit = match fixture.store.read(
            &key,
            Duration::from_secs(7 * 24 * 60 * 60),
            at("2026-01-04T00:00:00Z"),
        ) {
            Ok(CacheRead::Hit(hit)) => hit,
            other => panic!("expected v1 hit, got {other:?}"),
        };
        assert_eq!(hit.version(), CacheVersion::V1);
        assert_eq!(hit.result.rows.len(), 1);

        fixture
            .store
            .state
            .atomic_write(&key.v2_path, &v2_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let hit = match fixture.store.read(
            &key,
            Duration::from_secs(7 * 24 * 60 * 60),
            at("2026-01-04T00:00:00Z"),
        ) {
            Ok(CacheRead::Hit(hit)) => hit,
            other => panic!("expected v2 hit, got {other:?}"),
        };
        assert_eq!(hit.version(), CacheVersion::V2);
    }

    #[test]
    fn invalid_partial_rows_are_quarantined() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        let invalid = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/product/v1/fixtures/cache-v1-partial-invalid.json"
        ));
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, invalid, KrxErrorCode::CacheWriteFailed)
            .unwrap();
        assert!(matches!(
            fixture
                .store
                .read(&key, Duration::from_secs(1), at("2026-01-04T00:00:00Z")),
            Ok(CacheRead::Invalid)
        ));
        assert!(!fixture.root().join(&key.v1_path).exists());
        let quarantine_count = fs::read_dir(fixture.root().join("cache/20260102"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(quarantine_count, 1);
    }

    #[test]
    fn invalid_v2_does_not_shadow_a_valid_v1() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &v1_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let invalid_v2 = fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../contracts/product/v1/fixtures/cache-v2-extra-param-invalid.json"),
        )
        .unwrap();
        fixture
            .store
            .state
            .atomic_write(&key.v2_path, &invalid_v2, KrxErrorCode::CacheWriteFailed)
            .unwrap();

        let hit = match fixture.store.read(
            &key,
            Duration::from_secs(7 * 24 * 60 * 60),
            at("2026-01-04T00:00:00Z"),
        ) {
            Ok(CacheRead::Hit(hit)) => hit,
            other => panic!("expected v1 fallback hit, got {other:?}"),
        };
        assert_eq!(hit.version(), CacheVersion::V1);
        assert!(fixture.root().join(&key.v1_path).exists());
        assert!(!fixture.root().join(&key.v2_path).exists());
    }

    #[test]
    fn every_frozen_invalid_cache_fixture_is_rejected() {
        for (name, version, date, now) in [
            (
                "cache-v1-extra-param-invalid.json",
                CacheVersion::V1,
                "20260102",
                "2026-01-04T00:00:00Z",
            ),
            (
                "cache-v2-current-invalid.json",
                CacheVersion::V2,
                "20260103",
                "2026-01-03T00:00:00Z",
            ),
            (
                "cache-v2-extra-param-invalid.json",
                CacheVersion::V2,
                "20260102",
                "2026-01-04T00:00:00Z",
            ),
            (
                "cache-v2-missing-param-invalid.json",
                CacheVersion::V2,
                "20260102",
                "2026-01-04T00:00:00Z",
            ),
            (
                "cache-v2-duplicate-param-invalid.json",
                CacheVersion::V2,
                "20260102",
                "2026-01-04T00:00:00Z",
            ),
        ] {
            let fixture = Fixture::new();
            let key = fixture
                .store
                .key(
                    OperationId::StockStkByddTrd,
                    TradingDate::parse(date).unwrap(),
                )
                .unwrap();
            let path = match version {
                CacheVersion::V1 => &key.v1_path,
                CacheVersion::V2 => &key.v2_path,
            };
            let bytes = fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../contracts/product/v1/fixtures")
                    .join(name),
            )
            .unwrap();
            fixture
                .store
                .state
                .atomic_write(path, &bytes, KrxErrorCode::CacheWriteFailed)
                .unwrap();
            assert!(matches!(
                fixture.store.read(&key, Duration::from_secs(1), at(now)),
                Ok(CacheRead::Invalid)
            ));
            assert!(!fixture.root().join(path).exists(), "{name}");
        }
    }

    #[test]
    fn oversized_entries_are_invalid_without_unbounded_reads() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        fixture
            .store
            .state
            .atomic_write(&key.v2_path, b"", KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let file = fs::OpenOptions::new()
            .write(true)
            .open(fixture.root().join(&key.v2_path))
            .unwrap();
        file.set_len(CACHE_ENTRY_READ_BYTES + 1).unwrap();
        drop(file);

        assert!(matches!(
            fixture
                .store
                .read(&key, Duration::from_secs(1), at("2026-01-04T00:00:00Z")),
            Ok(CacheRead::Invalid)
        ));
        assert!(fixture.root().join(&key.v2_path).exists());
    }

    #[test]
    fn promotion_commits_v2_before_conditionally_removing_v1() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &v1_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let hit = match fixture
            .store
            .read(&key, Duration::from_secs(1), at("2026-01-04T00:00:00Z"))
        {
            Ok(CacheRead::Hit(hit)) => hit,
            other => panic!("expected v1 hit, got {other:?}"),
        };
        assert!(
            fixture
                .store
                .promote_v1(&key, &hit, at("2026-01-04T00:00:00Z"))
                .unwrap()
        );
        assert!(fixture.root().join(&key.v2_path).exists());
        assert!(!fixture.root().join(&key.v1_path).exists());
    }

    #[test]
    fn promotion_never_removes_a_concurrent_legacy_replacement() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &v1_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let hit = match fixture
            .store
            .read(&key, Duration::from_secs(1), at("2026-01-04T00:00:00Z"))
        {
            Ok(CacheRead::Hit(hit)) => hit,
            other => panic!("expected v1 hit, got {other:?}"),
        };
        let mut replacement = v1_fixture();
        replacement.push(b'\n');
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &replacement, KrxErrorCode::CacheWriteFailed)
            .unwrap();

        assert!(
            !fixture
                .store
                .promote_v1(&key, &hit, at("2026-01-04T00:00:00Z"))
                .unwrap()
        );
        assert!(fixture.root().join(&key.v2_path).exists());
        assert_eq!(
            fs::read(fixture.root().join(&key.v1_path)).unwrap(),
            replacement
        );
    }

    #[test]
    fn never_writes_empty_current_or_future_entries() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        assert!(
            !fixture
                .store
                .write_v2(
                    &key,
                    &[],
                    at("2026-01-03T00:00:00Z"),
                    at("2026-01-03T00:00:00Z")
                )
                .unwrap()
        );
        let current = fixture
            .store
            .key(
                OperationId::StockStkByddTrd,
                TradingDate::parse("20260103").unwrap(),
            )
            .unwrap();
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &v1_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let rows =
            match fixture
                .store
                .read(&key, Duration::from_secs(1), at("2026-01-04T00:00:00Z"))
            {
                Ok(CacheRead::Hit(hit)) => hit.result.rows,
                other => panic!("unexpected cache state {other:?}"),
            };
        assert!(
            !fixture
                .store
                .write_v2(
                    &current,
                    &rows,
                    at("2026-01-03T00:00:00Z"),
                    at("2026-01-03T00:00:00Z")
                )
                .unwrap()
        );
        let future_timestamp = fixture.store.write_v2(
            &key,
            &rows,
            at("2026-01-03T00:05:01Z"),
            at("2026-01-03T00:00:00Z"),
        );
        assert!(matches!(
            future_timestamp,
            Err(error) if error.code() == KrxErrorCode::CacheWriteFailed
        ));
    }

    #[test]
    fn timestamp_parser_accepts_the_schema_rfc3339_surface() {
        assert!(parse_timestamp("2026-01-03T00:00:00.000Z").is_some());
        assert!(parse_timestamp("2026-01-03T00:00:00Z").is_some());
        assert!(parse_timestamp("2026-01-03T09:00:00.000+09:00").is_some());
        assert!(parse_timestamp("2026-01-03T00:00:00Z[UTC]").is_none());
        assert!(parse_timestamp("2026-01-03T00:00:00+09").is_none());
    }
}
