use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

use crate::request::SecurityCode;
use crate::result::WatchlistMarket;
use crate::state::{ReadSensitivity, StateRoot};
use crate::{KrxError, KrxErrorCode};

const WATCHLIST_PATH: &str = "watchlist.json";
const WATCHLIST_LOCK_PATH: &str = "watchlist.json.lock";
const WATCHLIST_MAX_ENTRIES: usize = 10_000;
// This admits the schema's maximum number of entries even when names contain
// four-byte Unicode characters, while placing a finite bound on local input.
const WATCHLIST_READ_BOUND: u64 = 16 * 1024 * 1024;
const LOCK_POLL: Duration = Duration::from_millis(25);
const LOCK_TIMEOUT: Duration = Duration::from_millis(5_000);
const LOCK_STALE_AFTER: Duration = Duration::from_millis(30_000);

/// A security saved in the local watchlist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchlistEntry {
    pub isin: String,
    pub security_code: SecurityCode,
    pub name: String,
    pub market: WatchlistMarket,
}

impl WatchlistEntry {
    pub fn new(
        isin: &str,
        security_code: &str,
        name: &str,
        market: WatchlistMarket,
    ) -> Result<Self, KrxError> {
        if !valid_isin(isin) || name.trim() != name || name.is_empty() || name.chars().count() > 256
        {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "watchlist entry is invalid",
            ));
        }
        Ok(Self {
            isin: isin.to_owned(),
            security_code: SecurityCode::parse(security_code)?,
            name: name.to_owned(),
            market,
        })
    }
}

#[derive(Clone)]
pub(crate) struct WatchlistStore {
    state: StateRoot,
}

impl WatchlistStore {
    pub(crate) fn new(root: PathBuf) -> Result<Self, KrxError> {
        Ok(Self {
            state: StateRoot::new(root)?,
        })
    }

    pub(crate) async fn list(&self) -> Result<Vec<WatchlistEntry>, KrxError> {
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || list_blocking(&state))
            .await
            .map_err(|_| KrxError::new(KrxErrorCode::InternalFailure, "watchlist worker failed"))?
    }

    pub(crate) async fn add(&self, entry: WatchlistEntry) -> Result<bool, KrxError> {
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || add_blocking(&state, entry))
            .await
            .map_err(|_| KrxError::new(KrxErrorCode::InternalFailure, "watchlist worker failed"))?
    }

    pub(crate) async fn remove(&self, selector: &str) -> Result<bool, KrxError> {
        let state = self.state.clone();
        let selector = selector.to_owned();
        tokio::task::spawn_blocking(move || remove_blocking(&state, &selector))
            .await
            .map_err(|_| KrxError::new(KrxErrorCode::InternalFailure, "watchlist worker failed"))?
    }
}

fn list_blocking(state: &StateRoot) -> Result<Vec<WatchlistEntry>, KrxError> {
    let Some(observed) = state.read(
        WATCHLIST_PATH,
        WATCHLIST_READ_BOUND,
        ReadSensitivity::NonSecret,
        KrxErrorCode::WatchlistIoFailed,
    )?
    else {
        return Ok(Vec::new());
    };
    if !observed.is_complete() {
        return Err(invalid_watchlist("watchlist state is oversized"));
    }
    decode_watchlist(observed.bytes())
}

fn add_blocking(state: &StateRoot, entry: WatchlistEntry) -> Result<bool, KrxError> {
    validate_entry_argument(&entry)?;
    let _lock = acquire_lock(state)?;
    let (mut entries, source) = read_locked(state)?;
    let duplicate = entries.iter().any(|current| current.isin == entry.isin);
    if !duplicate {
        if entries.len() >= WATCHLIST_MAX_ENTRIES {
            return Err(invalid_watchlist("watchlist has too many entries"));
        }
        entries.push(entry);
    }
    // A v0 source is always cut over during the first Rust mutation, including
    // an idempotent request. Existing v1 no-op requests retain their bytes.
    if matches!(source, SourceVersion::V0) || !duplicate {
        write_v1(state, &entries)?;
    }
    Ok(!duplicate)
}

fn remove_blocking(state: &StateRoot, selector: &str) -> Result<bool, KrxError> {
    let _lock = acquire_lock(state)?;
    let (entries, source) = read_locked(state)?;
    let mut removed = false;
    let filtered = entries
        .into_iter()
        .filter(|entry| {
            let matches = entry.isin == selector || entry.name == selector;
            removed |= matches;
            !matches
        })
        .collect::<Vec<_>>();
    if matches!(source, SourceVersion::V0) || removed {
        write_v1(state, &filtered)?;
    }
    Ok(removed)
}

fn acquire_lock(state: &StateRoot) -> Result<crate::state::PlainDirectoryLock, KrxError> {
    let deadline = Instant::now() + LOCK_TIMEOUT;
    let owner = format!("{}-{}", std::process::id(), Uuid::new_v4());
    loop {
        if let Some(lock) = state.try_acquire_plain_lock(
            WATCHLIST_LOCK_PATH,
            owner.clone(),
            KrxErrorCode::WatchlistIoFailed,
        )? {
            return Ok(lock);
        }
        if state.steal_plain_lock_if_stale(
            WATCHLIST_LOCK_PATH,
            LOCK_STALE_AFTER,
            SystemTime::now(),
            KrxErrorCode::WatchlistIoFailed,
        )? {
            continue;
        }
        if Instant::now() >= deadline {
            return Err(KrxError::new(
                KrxErrorCode::WatchlistIoFailed,
                "timed out waiting for the watchlist lock",
            ));
        }
        std::thread::sleep(LOCK_POLL);
    }
}

#[derive(Clone, Copy)]
enum SourceVersion {
    V0,
    V1,
}

fn read_locked(state: &StateRoot) -> Result<(Vec<WatchlistEntry>, SourceVersion), KrxError> {
    let Some(observed) = state.read(
        WATCHLIST_PATH,
        WATCHLIST_READ_BOUND,
        ReadSensitivity::NonSecret,
        KrxErrorCode::WatchlistIoFailed,
    )?
    else {
        return Ok((Vec::new(), SourceVersion::V1));
    };
    if !observed.is_complete() {
        return Err(invalid_watchlist("watchlist state is oversized"));
    }
    let bytes = observed.bytes();
    let (entries, source) = decode_persisted(bytes)?;
    Ok((entries, source))
}

fn write_v1(state: &StateRoot, entries: &[WatchlistEntry]) -> Result<(), KrxError> {
    let data = PersistedV1::from_entries(entries);
    let mut bytes = serde_json::to_vec_pretty(&data).map_err(|_| {
        KrxError::new(
            KrxErrorCode::WatchlistIoFailed,
            "watchlist serialization failed",
        )
    })?;
    bytes.push(b'\n');
    state.atomic_write(WATCHLIST_PATH, &bytes, KrxErrorCode::WatchlistIoFailed)
}

fn decode_watchlist(bytes: &[u8]) -> Result<Vec<WatchlistEntry>, KrxError> {
    decode_persisted(bytes).map(|(entries, _)| entries)
}

fn decode_persisted(bytes: &[u8]) -> Result<(Vec<WatchlistEntry>, SourceVersion), KrxError> {
    let persisted: Persisted = serde_json::from_slice(bytes)
        .map_err(|_| invalid_watchlist("watchlist state is invalid"))?;
    let (wire_entries, source) = match persisted {
        Persisted::V0(entries) => (entries, SourceVersion::V0),
        Persisted::V1(entries) => (entries, SourceVersion::V1),
    };
    if wire_entries.len() > WATCHLIST_MAX_ENTRIES {
        return Err(invalid_watchlist("watchlist has too many entries"));
    }
    let mut seen = HashSet::with_capacity(wire_entries.len());
    let entries = wire_entries
        .into_iter()
        .map(|entry| {
            let value = entry.into_entry()?;
            if !seen.insert(value.isin.clone()) {
                return Err(invalid_watchlist("watchlist contains duplicate ISINs"));
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, KrxError>>()?;
    Ok((entries, source))
}

fn valid_isin(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 12 && bytes.starts_with(b"KR") && bytes[2..].iter().all(u8::is_ascii_digit)
}

fn invalid_watchlist(message: &'static str) -> KrxError {
    KrxError::new(KrxErrorCode::WatchlistStateInvalid, message)
}

fn validate_entry_argument(entry: &WatchlistEntry) -> Result<(), KrxError> {
    if !valid_isin(&entry.isin)
        || !valid_security_code(entry.security_code.as_str())
        || entry.name.trim() != entry.name
        || entry.name.is_empty()
        || entry.name.chars().count() > 256
    {
        return Err(KrxError::new(
            KrxErrorCode::InvalidArgument,
            "watchlist entry is invalid",
        ));
    }
    Ok(())
}

fn valid_security_code(value: &str) -> bool {
    value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug)]
struct WireEntry {
    isin: String,
    security_code: String,
    name: String,
    market: String,
}

impl WireEntry {
    fn into_entry(self) -> Result<WatchlistEntry, KrxError> {
        if self.name.trim() != self.name
            || self.name.is_empty()
            || self.name.chars().count() > 256
            || !valid_isin(&self.isin)
        {
            return Err(invalid_watchlist("watchlist entry is invalid"));
        }
        let market = parse_market(&self.market)
            .ok_or_else(|| invalid_watchlist("watchlist entry has an invalid market"))?;
        WatchlistEntry::new(&self.isin, &self.security_code, &self.name, market)
            .map_err(|_| invalid_watchlist("watchlist entry is invalid"))
    }
}

fn market_as_str(market: WatchlistMarket) -> &'static str {
    match market {
        WatchlistMarket::Kospi => "KOSPI",
        WatchlistMarket::Kosdaq => "KOSDAQ",
        WatchlistMarket::Konex => "KONEX",
    }
}

fn parse_market(value: &str) -> Option<WatchlistMarket> {
    match value {
        "KOSPI" => Some(WatchlistMarket::Kospi),
        "KOSDAQ" => Some(WatchlistMarket::Kosdaq),
        "KONEX" => Some(WatchlistMarket::Konex),
        _ => None,
    }
}

#[derive(Serialize)]
struct PersistedV1 {
    version: u8,
    entries: Vec<WireEntrySerializable>,
}

#[derive(Serialize)]
struct WireEntrySerializable {
    #[serde(rename = "isuCd")]
    isin: String,
    #[serde(rename = "isuSrtCd")]
    security_code: String,
    name: String,
    market: String,
}

impl From<&WatchlistEntry> for WireEntrySerializable {
    fn from(entry: &WatchlistEntry) -> Self {
        Self {
            isin: entry.isin.clone(),
            security_code: entry.security_code.as_str().to_owned(),
            name: entry.name.clone(),
            market: market_as_str(entry.market).to_owned(),
        }
    }
}

impl PersistedV1 {
    fn from_entries(entries: &[WatchlistEntry]) -> Self {
        Self {
            version: 1,
            entries: entries.iter().map(Into::into).collect(),
        }
    }
}

enum Persisted {
    V0(Vec<WireEntry>),
    V1(Vec<WireEntry>),
}

impl<'de> Deserialize<'de> for Persisted {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(PersistedVisitor)
    }
}

struct PersistedVisitor;

impl<'de> Visitor<'de> for PersistedVisitor {
    type Value = Persisted;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a legacy watchlist array or versioned watchlist object")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut entries = Vec::new();
        while let Some(entry) = seq.next_element::<WireEntry>()? {
            if entries.len() == WATCHLIST_MAX_ENTRIES {
                return Err(de::Error::custom("watchlist has too many entries"));
            }
            entries.push(entry);
        }
        Ok(Persisted::V0(entries))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut version = None;
        let mut entries = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "version" if version.is_none() => version = Some(map.next_value::<u64>()?),
                "entries" if entries.is_none() => {
                    entries = Some(map.next_value::<Vec<WireEntry>>()?)
                }
                "version" | "entries" => {
                    return Err(de::Error::custom("duplicate watchlist root field"));
                }
                _ => return Err(de::Error::custom("unknown watchlist root field")),
            }
        }
        if version != Some(1) {
            return Err(de::Error::custom("unsupported watchlist version"));
        }
        let entries = entries.ok_or_else(|| de::Error::custom("missing watchlist entries"))?;
        if entries.len() > WATCHLIST_MAX_ENTRIES {
            return Err(de::Error::custom("watchlist has too many entries"));
        }
        Ok(Persisted::V1(entries))
    }
}

impl<'de> Deserialize<'de> for WireEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(WireEntryVisitor)
    }
}

struct WireEntryVisitor;

impl<'de> Visitor<'de> for WireEntryVisitor {
    type Value = WireEntry;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a strict watchlist entry object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut isin = None;
        let mut security_code = None;
        let mut name = None;
        let mut market = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "isuCd" if isin.is_none() => isin = Some(map.next_value::<String>()?),
                "isuSrtCd" if security_code.is_none() => {
                    security_code = Some(map.next_value::<String>()?)
                }
                "name" if name.is_none() => name = Some(map.next_value::<String>()?),
                "market" if market.is_none() => market = Some(map.next_value::<String>()?),
                "isuCd" | "isuSrtCd" | "name" | "market" => {
                    return Err(de::Error::custom("duplicate watchlist entry field"));
                }
                _ => return Err(de::Error::custom("unknown watchlist entry field")),
            }
        }
        Ok(WireEntry {
            isin: isin.ok_or_else(|| de::Error::custom("missing watchlist ISIN"))?,
            security_code: security_code
                .ok_or_else(|| de::Error::custom("missing watchlist security code"))?,
            name: name.ok_or_else(|| de::Error::custom("missing watchlist name"))?,
            market: market.ok_or_else(|| de::Error::custom("missing watchlist market"))?,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn test_root() -> PathBuf {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("krx-sdk-watchlist-tests")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        root
    }

    #[test]
    fn public_entries_reject_invalid_arguments_without_state_error_codes() {
        for result in [
            WatchlistEntry::new("KR700593000X", "005930", "Samsung", WatchlistMarket::Kospi),
            WatchlistEntry::new("KR7005930003", "5930", "Samsung", WatchlistMarket::Kospi),
            WatchlistEntry::new(
                "KR7005930003",
                "005930",
                " Samsung ",
                WatchlistMarket::Kospi,
            ),
        ] {
            assert_eq!(result.unwrap_err().code(), KrxErrorCode::InvalidArgument);
        }
    }

    #[tokio::test]
    async fn reads_legacy_fixture_and_migrates_on_first_mutation() {
        let root = test_root();
        let state = StateRoot::new(root.clone()).unwrap();
        state
            .atomic_write(
                WATCHLIST_PATH,
                include_bytes!("../../../contracts/product/v1/fixtures/watchlist-v0.json"),
                KrxErrorCode::WatchlistIoFailed,
            )
            .unwrap();
        let store = WatchlistStore::new(root.clone()).unwrap();
        assert_eq!(store.list().await.unwrap().len(), 2);
        assert!(
            store
                .add(
                    WatchlistEntry::new(
                        "KR7000660001",
                        "000660",
                        "SK하이닉스",
                        WatchlistMarket::Kospi,
                    )
                    .unwrap()
                )
                .await
                .unwrap()
        );
        let written = fs::read(root.join(WATCHLIST_PATH)).unwrap();
        assert!(written.starts_with(b"{\n  \"version\": 1,"));
        assert_eq!(store.list().await.unwrap().len(), 3);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn invalid_state_is_rejected_without_replacing_bytes() {
        let root = test_root();
        let state = StateRoot::new(root.clone()).unwrap();
        let bytes = include_bytes!(
            "../../../contracts/product/v1/fixtures/watchlist-extra-field-invalid.json"
        );
        state
            .atomic_write(WATCHLIST_PATH, bytes, KrxErrorCode::WatchlistIoFailed)
            .unwrap();
        let store = WatchlistStore::new(root.clone()).unwrap();
        let error = store.list().await.unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::WatchlistStateInvalid);
        assert_eq!(fs::read(root.join(WATCHLIST_PATH)).unwrap(), bytes);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn concurrent_additions_are_serialized_and_preserve_order() {
        let root = test_root();
        let store = WatchlistStore::new(root.clone()).unwrap();
        let mut tasks = Vec::new();
        for index in 0..8u32 {
            let store = store.clone();
            tasks.push(tokio::spawn(async move {
                let isin = format!("KR{index:010}");
                let code = format!("{index:06}");
                store
                    .add(
                        WatchlistEntry::new(
                            &isin,
                            &code,
                            &format!("Stock {index}"),
                            WatchlistMarket::Kospi,
                        )
                        .unwrap(),
                    )
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            assert!(task.await.unwrap());
        }
        assert_eq!(store.list().await.unwrap().len(), 8);
        let _ = fs::remove_dir_all(root);
    }
}
