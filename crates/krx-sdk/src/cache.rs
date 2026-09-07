use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jiff::{RoundMode, Timestamp, TimestampRound, Unit};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::{Uuid, Variant};

use crate::conformer::decode_cached_rows;
use crate::credential::{
    CACHE_ENTRY_READ_BYTES, CACHE_FUTURE_SKEW_SECONDS, CACHE_INSPECT_DEFAULT_ENTRIES,
    CACHE_INSPECT_MAXIMUM_ENTRIES, CACHE_LEASE_ABSOLUTE_AGE_MS, CACHE_LEASE_OWNER_DEAD_MS,
    CACHE_PRUNE_DELETE_BATCH_MAXIMUM, CACHE_PRUNE_SCAN_MAXIMUM_FILES,
    CACHE_PRUNE_SCAN_MAXIMUM_METADATA_BYTES,
};
use crate::operation::{DEFAULT_CACHE_MAX_AGE_HOURS, operation_spec, parse_operation_id};
use crate::state::{
    CacheDirectoryLease, ObservedCacheDirectoryLease, ObservedFile, StateRoot, process_is_alive,
};
use crate::{
    Cancellation, Freshness, KrxError, KrxErrorCode, OperationId, QueryResult, ResultProvenance,
    ResultSource, Row, TradingDate,
};

const CACHE_LEASE_OWNER_BYTES: u64 = 1024;
pub(crate) const CACHE_LEASE_POLL: Duration = Duration::from_millis(50);

static CACHE_FLIGHTS: OnceLock<Mutex<HashMap<CacheFlightKey, Weak<CacheFlight>>>> = OnceLock::new();

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheFlightKey {
    state_root: PathBuf,
    v2_digest: String,
}

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
    /// Number of distinct trading dates across all matching entries.
    pub total_dates: usize,
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
    pub(crate) operation: OperationId,
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

    fn lease_path(&self) -> String {
        format!("cache/.leases/{}.lock", self.v2_digest)
    }

    #[cfg(test)]
    pub(crate) fn legacy_path(&self) -> &str {
        &self.v1_path
    }

    #[cfg(test)]
    pub(crate) fn current_path(&self) -> &str {
        &self.v2_path
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

    pub(crate) fn freshness(&self) -> Freshness {
        self.result.provenance.freshness
    }

    pub(crate) fn same_refresh_generation(&self, other: &Self) -> bool {
        match (
            canonical_cache_timestamp(self.result.provenance.fetched_at),
            canonical_cache_timestamp(other.result.provenance.fetched_at),
        ) {
            (Some(left), Some(right)) => left == right && self.result.rows == other.result.rows,
            (None, _) | (_, None) => false,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum CacheRead {
    Hit(Box<CacheHit>),
    Miss,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CacheWriteOutcome {
    Skipped,
    Durable,
    CommittedNotSynced,
}

#[derive(Clone, Debug)]
pub(crate) struct CacheStore {
    state: StateRoot,
    #[cfg(test)]
    fail_after_cache_commit: bool,
}

impl CacheStore {
    pub(crate) fn new(state: StateRoot) -> Self {
        Self {
            state,
            #[cfg(test)]
            fail_after_cache_commit: false,
        }
    }

    #[cfg(test)]
    fn with_post_commit_cache_failure(mut self) -> Self {
        self.fail_after_cache_commit = true;
        self
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
        self.read_with_quarantine(key, max_age, now, true)
    }

    pub(crate) fn probe(
        &self,
        key: &CacheKey,
        max_age: Duration,
        now: SystemTime,
    ) -> Result<CacheRead, KrxError> {
        self.read_with_quarantine(key, max_age, now, false)
    }

    fn read_with_quarantine(
        &self,
        key: &CacheKey,
        max_age: Duration,
        now: SystemTime,
        quarantine_invalid: bool,
    ) -> Result<CacheRead, KrxError> {
        let mut observed_invalid = false;
        if let Some(observed) = self
            .state
            .read_cache(
                &key.v2_path,
                CACHE_ENTRY_READ_BYTES,
                KrxErrorCode::CacheReadFailed,
            )
            .map_err(|error| error.for_operation(key.operation))?
        {
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
                    if quarantine_invalid {
                        self.quarantine(&key.v2_path, &observed, now)
                            .map_err(|error| error.for_operation(key.operation))?;
                    }
                    observed_invalid = true;
                }
            }
        }

        let Some(observed) = self
            .state
            .read_cache(
                &key.v1_path,
                CACHE_ENTRY_READ_BYTES,
                KrxErrorCode::CacheReadFailed,
            )
            .map_err(|error| error.for_operation(key.operation))?
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
                if quarantine_invalid {
                    self.quarantine(&key.v1_path, &observed, now)
                        .map_err(|error| error.for_operation(key.operation))?;
                }
                Ok(CacheRead::Invalid)
            }
        }
    }

    pub(crate) fn legacy_entry_present(&self, key: &CacheKey) -> Result<bool, KrxError> {
        self.state
            .read_cache(
                &key.v1_path,
                CACHE_ENTRY_READ_BYTES,
                KrxErrorCode::CacheReadFailed,
            )
            .map(|observed| observed.is_some())
            .map_err(|error| error.for_operation(key.operation))
    }

    pub(crate) fn read_legacy(
        &self,
        key: &CacheKey,
        max_age: Duration,
        now: SystemTime,
    ) -> Result<CacheRead, KrxError> {
        let Some(observed) = self
            .state
            .read_cache(
                &key.v1_path,
                CACHE_ENTRY_READ_BYTES,
                KrxErrorCode::CacheReadFailed,
            )
            .map_err(|error| error.for_operation(key.operation))?
        else {
            return Ok(CacheRead::Miss);
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
                self.quarantine(&key.v1_path, &observed, now)
                    .map_err(|error| error.for_operation(key.operation))?;
                Ok(CacheRead::Invalid)
            }
        }
    }

    pub(crate) fn remove_legacy(&self, key: &CacheKey, hit: &CacheHit) -> Result<bool, KrxError> {
        if hit.version != CacheVersion::V1 || hit.source_path != key.v1_path {
            return Ok(false);
        }
        self.state
            .remove_if_unchanged(
                &hit.source_path,
                &hit.source,
                KrxErrorCode::CacheWriteFailed,
            )
            .map_err(|error| error.for_operation(key.operation))
    }

    pub(crate) async fn inspect(
        &self,
        options: CacheInspectOptions,
    ) -> Result<CacheInspection, KrxError> {
        let limit = validate_inspect_limit(options.limit)?;
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let scan = scan_admin_entries(&state, SystemTime::now())?;
            let mut matching = scan
                .entries
                .into_iter()
                .filter(|entry| {
                    options
                        .operation
                        .is_none_or(|operation| entry.description.operation == operation)
                        && options
                            .date
                            .as_ref()
                            .is_none_or(|date| &entry.description.date == date)
                })
                .collect::<Vec<_>>();
            matching.sort_by(|left, right| left.relative.cmp(&right.relative));
            let total_entries = matching.len();
            let total_dates = matching
                .iter()
                .map(|entry| entry.description.date.as_str())
                .collect::<HashSet<_>>()
                .len();
            let total_size_bytes = matching
                .iter()
                .map(|entry| entry.description.size_bytes)
                .sum();
            let truncated = total_entries > limit;
            let entries = matching
                .drain(..total_entries.min(limit))
                .map(|entry| entry.description)
                .collect();
            Ok(CacheInspection {
                entries,
                total_entries,
                total_dates,
                total_size_bytes,
                truncated,
            })
        })
        .await
        .map_err(|_| {
            KrxError::new(
                KrxErrorCode::CacheReadFailed,
                "cache inspection task failed",
            )
        })?
    }

    pub(crate) async fn prune(
        &self,
        options: CachePruneOptions,
    ) -> Result<CachePruneResult, KrxError> {
        if options
            .max_entries
            .is_some_and(|maximum| maximum > CACHE_PRUNE_DELETE_BATCH_MAXIMUM as usize)
        {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                format!(
                    "cache prune maximum entries must not exceed {}",
                    CACHE_PRUNE_DELETE_BATCH_MAXIMUM
                ),
            ));
        }
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let scan = scan_admin_entries(&state, SystemTime::now())?;
            let entries = scan.entries;
            let mut remove = HashSet::new();
            if let Some(older_than) = options.older_than {
                remove.extend(
                    entries
                        .iter()
                        .filter(|entry| entry.description.fetched_at < older_than)
                        .map(|entry| entry.relative.clone()),
                );
            }
            if let Some(max_entries) = options.max_entries {
                let mut order = (0..entries.len()).collect::<Vec<_>>();
                order.sort_by(|left, right| {
                    entries[*right]
                        .description
                        .fetched_at
                        .partial_cmp(&entries[*left].description.fetched_at)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| {
                            is_v2_cache_path(&entries[*right].relative)
                                .cmp(&is_v2_cache_path(&entries[*left].relative))
                        })
                        .then_with(|| entries[*left].relative.cmp(&entries[*right].relative))
                });
                remove.extend(
                    order
                        .into_iter()
                        .skip(max_entries)
                        .map(|index| entries[index].relative.clone()),
                );
            }
            let mut result = delete_admin_entries(&state, entries, &remove)?;
            result = delete_stale_artifacts(&state, scan.artifacts, result)?;
            delete_stale_leases(&state, scan.leases, result)
        })
        .await
        .map_err(|_| KrxError::new(KrxErrorCode::CacheWriteFailed, "cache prune task failed"))?
    }

    pub(crate) async fn clear(&self) -> Result<CachePruneResult, KrxError> {
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let scan = scan_admin_entries(&state, SystemTime::now())?;
            let entries = scan.entries;
            let remove = entries
                .iter()
                .map(|entry| entry.relative.clone())
                .collect::<HashSet<_>>();
            // Deliberately do not remove arbitrary cache children, quarantine
            // files, or live/unrecognized leases: only revalidated entries,
            // exact stale atomic temporaries, and securely observed stale
            // leases are safe administration targets.
            let result = delete_admin_entries(&state, entries, &remove)?;
            let result = delete_stale_artifacts(&state, scan.artifacts, result)?;
            delete_stale_leases(&state, scan.leases, result)
        })
        .await
        .map_err(|_| KrxError::new(KrxErrorCode::CacheWriteFailed, "cache clear task failed"))?
    }

    pub(crate) fn write_v2(
        &self,
        key: &CacheKey,
        rows: &[Row],
        fetched_at: SystemTime,
        now: SystemTime,
    ) -> Result<bool, KrxError> {
        Ok(!matches!(
            self.write_v2_outcome(key, rows, fetched_at, now)?,
            CacheWriteOutcome::Skipped
        ))
    }

    pub(crate) fn write_v2_after_refresh(
        &self,
        key: &CacheKey,
        rows: &[Row],
        fetched_at: SystemTime,
        now: SystemTime,
    ) -> Result<bool, KrxError> {
        let outcome = self.write_v2_outcome(key, rows, fetched_at, now)?;
        if outcome == CacheWriteOutcome::Durable
            && let CacheRead::Hit(legacy) = self.read_legacy(key, Duration::MAX, now)?
        {
            self.remove_legacy(key, &legacy)?;
        }
        Ok(!matches!(outcome, CacheWriteOutcome::Skipped))
    }

    fn write_v2_outcome(
        &self,
        key: &CacheKey,
        rows: &[Row],
        fetched_at: SystemTime,
        now: SystemTime,
    ) -> Result<CacheWriteOutcome, KrxError> {
        if rows.is_empty()
            || !is_historical(&key.date, now, KrxErrorCode::CacheWriteFailed)
                .map_err(|error| error.for_operation(key.operation))?
        {
            return Ok(CacheWriteOutcome::Skipped);
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
            fetched_at: format_timestamp(fetched_at)
                .map_err(|error| error.for_operation(key.operation))?,
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
        #[cfg(test)]
        let write = if self.fail_after_cache_commit {
            self.state.atomic_write_with_post_commit_failure(
                &key.v2_path,
                &bytes,
                KrxErrorCode::CacheWriteFailed,
            )
        } else {
            self.state
                .atomic_write_observed(&key.v2_path, &bytes, KrxErrorCode::CacheWriteFailed)
        };
        #[cfg(not(test))]
        let write =
            self.state
                .atomic_write_observed(&key.v2_path, &bytes, KrxErrorCode::CacheWriteFailed);
        match write {
            Ok(()) => Ok(CacheWriteOutcome::Durable),
            Err(failure) if failure.committed() => Ok(CacheWriteOutcome::CommittedNotSynced),
            Err(failure) => Err(failure.into_error().for_operation(key.operation)),
        }
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
        match self.write_v2_outcome(key, &hit.result.rows, hit.result.provenance.fetched_at, now)? {
            CacheWriteOutcome::Durable => {}
            CacheWriteOutcome::Skipped | CacheWriteOutcome::CommittedNotSynced => {
                return Ok(false);
            }
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

    pub(crate) async fn acquire_flight(
        &self,
        key: &CacheKey,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<CacheFlightGuard, KrxError> {
        let flights = CACHE_FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()));
        let flight_key = CacheFlightKey {
            state_root: self.state.flight_namespace().to_path_buf(),
            v2_digest: key.v2_digest.clone(),
        };
        let mutex = {
            let mut flights = flights
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            flights.retain(|_, flight| flight.strong_count() > 0);
            if let Some(flight) = flights.get(&flight_key).and_then(Weak::upgrade) {
                flight
            } else {
                let flight = Arc::new(CacheFlight {
                    gate: Arc::new(tokio::sync::Mutex::new(())),
                    network_result: Mutex::new(None),
                });
                flights.insert(flight_key.clone(), Arc::downgrade(&flight));
                flight
            }
        };
        let (guard, waited) = match Arc::clone(&mutex.gate).try_lock_owned() {
            Ok(guard) => (guard, false),
            Err(_) => {
                let owned = Arc::clone(&mutex.gate).lock_owned();
                let remaining = deadline.saturating_duration_since(Instant::now());
                let guard = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(cache_cancelled(key.operation)),
                    _ = tokio::time::sleep(remaining) => {
                        return Err(cache_deadline(key.operation, cancellation));
                    }
                    guard = owned => guard,
                };
                (guard, true)
            }
        };
        Ok(CacheFlightGuard {
            key: flight_key,
            flight: mutex,
            guard: Some(guard),
            waited,
        })
    }

    pub(crate) async fn try_acquire_refresh_lease(
        &self,
        key: &CacheKey,
    ) -> Result<Option<CacheRefreshLease>, KrxError> {
        let owner = CacheLeaseOwner::new().map_err(|error| error.for_operation(key.operation))?;
        let owner_bytes = serde_json::to_vec(&owner).map_err(|_| {
            cache_error(
                KrxErrorCode::CacheWriteFailed,
                key.operation,
                "cache lease owner serialization failed",
            )
        })?;
        let path = key.lease_path();
        let state = self.state.clone();
        let path_for_attempt = path.clone();
        let attempt = tokio::task::spawn_blocking(move || {
            state.try_acquire_cache_lease(
                &path_for_attempt,
                &owner_bytes,
                KrxErrorCode::CacheWriteFailed,
            )
        })
        .await
        .map_err(|_| {
            cache_error(
                KrxErrorCode::CacheWriteFailed,
                key.operation,
                "cache lease acquisition task failed",
            )
        })?
        .map_err(|error| error.for_operation(key.operation))?;
        if let Some(lease) = attempt {
            return Ok(Some(CacheRefreshLease { _lease: lease }));
        }

        let state = self.state.clone();
        let path_for_observation = path.clone();
        let now = SystemTime::now();
        tokio::task::spawn_blocking(move || {
            let Some(observed) = state.observe_cache_lease(
                &path_for_observation,
                CACHE_LEASE_OWNER_BYTES,
                KrxErrorCode::CacheWriteFailed,
            )?
            else {
                return Ok(false);
            };
            if !cache_lease_is_stale(&observed, now) {
                return Ok(false);
            }
            let tombstone = format!(
                "{}.stale-{}",
                Path::new(&path_for_observation)
                    .file_name()
                    .and_then(|leaf| leaf.to_str())
                    .ok_or_else(|| {
                        KrxError::new(KrxErrorCode::InternalFailure, "cache lease path is invalid")
                    })?,
                Uuid::new_v4()
            );
            state.steal_cache_lease_if_unchanged(
                &path_for_observation,
                &observed,
                &tombstone,
                KrxErrorCode::CacheWriteFailed,
            )
        })
        .await
        .map_err(|_| {
            cache_error(
                KrxErrorCode::CacheWriteFailed,
                key.operation,
                "cache lease recovery task failed",
            )
        })?
        .map_err(|error| error.for_operation(key.operation))?;
        // A successful steal only frees the pathname. The caller retries to
        // acquire the replacement lease.
        Ok(None)
    }
}

fn is_v2_cache_path(relative: &str) -> bool {
    relative.starts_with("cache/v2/")
}

#[derive(Debug)]
struct CacheAdminEntry {
    relative: String,
    observed: ObservedFile,
    description: CacheEntryDescription,
}

struct CacheAdminScan {
    entries: Vec<CacheAdminEntry>,
    artifacts: Vec<CacheAdminEntry>,
    leases: Vec<CacheLeaseTarget>,
}

struct CacheLeaseTarget {
    relative: String,
    observed: ObservedCacheDirectoryLease,
}

fn validate_inspect_limit(limit: Option<usize>) -> Result<usize, KrxError> {
    let limit = limit.unwrap_or(CACHE_INSPECT_DEFAULT_ENTRIES as usize);
    if limit == 0 || limit > CACHE_INSPECT_MAXIMUM_ENTRIES as usize {
        return Err(KrxError::new(
            KrxErrorCode::InvalidArgument,
            format!(
                "cache inspection limit must be between one and {}",
                CACHE_INSPECT_MAXIMUM_ENTRIES
            ),
        ));
    }
    Ok(limit)
}

fn scan_admin_entries(state: &StateRoot, now: SystemTime) -> Result<CacheAdminScan, KrxError> {
    let enumeration = state.enumerate_cache_paths(
        CACHE_PRUNE_SCAN_MAXIMUM_FILES,
        CACHE_PRUNE_SCAN_MAXIMUM_METADATA_BYTES,
        KrxErrorCode::CacheReadFailed,
    )?;
    let max_age = Duration::from_secs(DEFAULT_CACHE_MAX_AGE_HOURS * 60 * 60);
    let mut entries = Vec::new();
    let mut artifacts = Vec::new();
    for path in enumeration.paths {
        let Some(observed) = state.read_cache(
            &path.relative,
            CACHE_ENTRY_READ_BYTES,
            KrxErrorCode::CacheReadFailed,
        )?
        else {
            continue;
        };
        if !observed.is_complete() {
            continue;
        }
        if let Some(description) = recognize_cache_entry(&path.relative, &observed, max_age, now) {
            entries.push(CacheAdminEntry {
                relative: path.relative,
                observed,
                description,
            });
        } else if is_stale_cache_temporary(&path.relative, observed.modified(), now) {
            let size_bytes = observed.bytes().len() as u64;
            artifacts.push(CacheAdminEntry {
                relative: path.relative,
                observed,
                description: CacheEntryDescription {
                    operation: OperationId::StockStkByddTrd,
                    date: TradingDate::parse("19000101").expect("valid artifact placeholder date"),
                    fetched_at: UNIX_EPOCH,
                    freshness: Freshness::Stale,
                    size_bytes,
                    contract_id: String::new(),
                },
            });
        }
    }
    let mut leases = Vec::new();
    for relative in enumeration.leases {
        let Some(observed) = state.observe_cache_lease(
            &relative,
            CACHE_LEASE_OWNER_BYTES,
            KrxErrorCode::CacheReadFailed,
        )?
        else {
            continue;
        };
        if cache_lease_is_stale(&observed, now) {
            leases.push(CacheLeaseTarget { relative, observed });
        }
    }
    Ok(CacheAdminScan {
        entries,
        artifacts,
        leases,
    })
}

fn recognize_cache_entry(
    relative: &str,
    observed: &ObservedFile,
    max_age: Duration,
    now: SystemTime,
) -> Option<CacheEntryDescription> {
    let parts = relative.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["cache", date, filename] if filename.ends_with(".json") => {
            let date = TradingDate::parse(date).ok()?;
            let entry: CacheV1Read = serde_json::from_slice(observed.bytes()).ok()?;
            let operation = OperationId::ALL
                .into_iter()
                .find(|operation| operation_spec(*operation).path == entry.endpoint)?;
            let key = CacheKey::new(operation, date).ok()?;
            if key.v1_path != relative {
                return None;
            }
            let result = decode_v1(&key, observed, max_age, now).ok()?;
            Some(CacheEntryDescription {
                operation,
                date: key.date,
                fetched_at: result.provenance.fetched_at,
                freshness: result.provenance.freshness,
                size_bytes: observed.bytes().len() as u64,
                contract_id: result.provenance.contract_id.to_owned(),
            })
        }
        ["cache", "v2", date, filename] if filename.ends_with(".json") => {
            let date = TradingDate::parse(date).ok()?;
            let entry: CacheV2Read = serde_json::from_slice(observed.bytes()).ok()?;
            let operation = parse_operation_id(&entry.operation_id)?;
            let key = CacheKey::new(operation, date).ok()?;
            if key.v2_path != relative {
                return None;
            }
            let result = decode_v2(&key, observed, max_age, now).ok()?;
            Some(CacheEntryDescription {
                operation,
                date: key.date,
                fetched_at: result.provenance.fetched_at,
                freshness: result.provenance.freshness,
                size_bytes: observed.bytes().len() as u64,
                contract_id: result.provenance.contract_id.to_owned(),
            })
        }
        _ => None,
    }
}

fn delete_admin_entries(
    state: &StateRoot,
    entries: Vec<CacheAdminEntry>,
    remove: &HashSet<String>,
) -> Result<CachePruneResult, KrxError> {
    let mut result = CachePruneResult::default();
    let targets = entries
        .into_iter()
        .filter(|entry| remove.contains(&entry.relative))
        .collect::<Vec<_>>();
    for entry in &targets {
        if state.remove_if_unchanged(
            &entry.relative,
            &entry.observed,
            KrxErrorCode::CacheWriteFailed,
        )? {
            result.removed_entries += 1;
            result.removed_bytes += entry.description.size_bytes;
        }
    }
    Ok(result)
}

fn delete_stale_artifacts(
    state: &StateRoot,
    artifacts: Vec<CacheAdminEntry>,
    mut result: CachePruneResult,
) -> Result<CachePruneResult, KrxError> {
    let remove = artifacts
        .iter()
        .map(|entry| entry.relative.clone())
        .collect::<HashSet<_>>();
    let deleted = delete_admin_entries(state, artifacts, &remove)?;
    result.removed_entries += deleted.removed_entries;
    result.removed_bytes += deleted.removed_bytes;
    Ok(result)
}

fn delete_stale_leases(
    state: &StateRoot,
    leases: Vec<CacheLeaseTarget>,
    mut result: CachePruneResult,
) -> Result<CachePruneResult, KrxError> {
    for lease in leases {
        let tombstone = format!(".stale-admin-{}", Uuid::new_v4());
        if state.steal_cache_lease_if_unchanged(
            &lease.relative,
            &lease.observed,
            &tombstone,
            KrxErrorCode::CacheWriteFailed,
        )? {
            result.removed_entries += 1;
        }
    }
    Ok(result)
}

fn is_stale_cache_temporary(relative: &str, modified: SystemTime, now: SystemTime) -> bool {
    let parts = relative.split('/').collect::<Vec<_>>();
    let (filename, digest_length) = match parts.as_slice() {
        ["cache", date, filename] if TradingDate::parse(date).is_ok() => (filename, 16),
        ["cache", "v2", date, filename] if TradingDate::parse(date).is_ok() => (filename, 64),
        _ => return false,
    };
    if !filename.starts_with('.') || !filename.ends_with(".tmp") {
        return false;
    }
    let body = &filename[1..filename.len() - 4];
    let Some((prefix, uuid_text)) = body.rsplit_once('.') else {
        return false;
    };
    let target = prefix
        .rsplit_once('.')
        .filter(|(_, candidate)| candidate.parse::<u32>().is_ok_and(|pid| pid > 0))
        .map_or(prefix, |(target, _)| target);
    if !target.ends_with(".json") || target.len() != digest_length + ".json".len() {
        return false;
    }
    let stem = target.strip_suffix(".json").unwrap_or_default();
    if stem.len() != digest_length
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return false;
    }
    let valid_uuid = Uuid::parse_str(uuid_text).ok().is_some_and(|uuid| {
        uuid.get_version_num() == 4
            && uuid.get_variant() == Variant::RFC4122
            && uuid.to_string() == uuid_text
    });
    valid_uuid
        && now.duration_since(modified).unwrap_or(Duration::ZERO) >= Duration::from_secs(60 * 60)
}

pub(crate) struct CacheRefreshLease {
    _lease: CacheDirectoryLease,
}

struct CacheFlight {
    gate: Arc<tokio::sync::Mutex<()>>,
    network_result: Mutex<Option<QueryResult>>,
}

pub(crate) struct CacheFlightGuard {
    key: CacheFlightKey,
    flight: Arc<CacheFlight>,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
    waited: bool,
}

impl CacheFlightGuard {
    pub(crate) fn shared_network_result(&self) -> Option<QueryResult> {
        if !self.waited {
            return None;
        }
        self.flight
            .network_result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn clear_network_result(&self) {
        *self
            .flight
            .network_result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    pub(crate) fn publish_network_result(&self, result: QueryResult) {
        *self
            .flight
            .network_result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result);
    }
}

impl Drop for CacheFlightGuard {
    fn drop(&mut self) {
        self.guard.take();
        let Some(flights) = CACHE_FLIGHTS.get() else {
            return;
        };
        let mut flights = flights
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if Arc::strong_count(&self.flight) == 1
            && flights
                .get(&self.key)
                .and_then(Weak::upgrade)
                .is_some_and(|current| Arc::ptr_eq(&current, &self.flight))
        {
            flights.remove(&self.key);
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CacheLeaseOwner {
    version: u8,
    pid: u32,
    nonce: String,
    created_at: String,
}

impl CacheLeaseOwner {
    fn new() -> Result<Self, KrxError> {
        Ok(Self {
            version: 1,
            pid: std::process::id(),
            nonce: Uuid::new_v4().to_string(),
            created_at: format_timestamp(SystemTime::now())?,
        })
    }

    fn parse(bytes: &[u8]) -> Option<(Self, SystemTime)> {
        let owner: Self = serde_json::from_slice(bytes).ok()?;
        let nonce = Uuid::parse_str(&owner.nonce).ok()?;
        if owner.version != 1
            || owner.pid == 0
            || nonce.get_version_num() != 4
            || nonce.get_variant() != Variant::RFC4122
            || owner.nonce.bytes().any(|byte| byte.is_ascii_uppercase())
        {
            return None;
        }
        let created_at = parse_timestamp(&owner.created_at)?;
        if format_timestamp(created_at).ok()?.as_str() != owner.created_at {
            return None;
        }
        Some((owner, created_at))
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
        || !is_historical(&key.date, now, KrxErrorCode::CacheReadFailed).map_err(|_| ())?
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
        || !is_historical(&key.date, now, KrxErrorCode::CacheReadFailed).map_err(|_| ())?
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
    contract_id: &'static str,
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
            contract_id,
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
    let timestamp = canonical_cache_timestamp(value).ok_or_else(|| {
        KrxError::new(
            KrxErrorCode::CacheWriteFailed,
            "cache timestamp is out of range",
        )
    })?;
    Ok(timestamp.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn canonical_cache_timestamp(value: SystemTime) -> Option<Timestamp> {
    Timestamp::try_from(value)
        .and_then(|timestamp| {
            timestamp.round(
                TimestampRound::new()
                    .smallest(Unit::Millisecond)
                    .mode(RoundMode::Trunc),
            )
        })
        .ok()
}

fn is_historical(
    date: &TradingDate,
    now: SystemTime,
    error_code: KrxErrorCode,
) -> Result<bool, KrxError> {
    let shifted = now
        .checked_add(Duration::from_secs(9 * 60 * 60))
        .ok_or_else(|| {
            KrxError::new(
                error_code,
                "system time is outside the supported KST calendar",
            )
        })?;
    let timestamp = Timestamp::try_from(shifted).map_err(|_| {
        KrxError::new(
            error_code,
            "system time is outside the supported KST calendar",
        )
    })?;
    let today = TradingDate::parse(&timestamp.strftime("%Y%m%d").to_string()).map_err(|_| {
        KrxError::new(
            error_code,
            "system time is outside the supported KST calendar",
        )
    })?;
    Ok(date < &today)
}

fn cache_lease_is_stale(
    observed: &crate::state::ObservedCacheDirectoryLease,
    now: SystemTime,
) -> bool {
    let fallback_age = now
        .duration_since(observed.modified())
        .unwrap_or(Duration::ZERO);
    let Some((owner, created_at)) = observed.owner_bytes().and_then(CacheLeaseOwner::parse) else {
        return fallback_age >= Duration::from_millis(CACHE_LEASE_OWNER_DEAD_MS);
    };
    let Ok(age) = now.duration_since(created_at) else {
        // A canonical but future-dated owner is not allowed to wedge the key
        // indefinitely. Treat it like malformed owner state and recover only
        // after the directory itself crosses the conservative dead-owner age.
        return fallback_age >= Duration::from_millis(CACHE_LEASE_OWNER_DEAD_MS);
    };
    age >= Duration::from_millis(CACHE_LEASE_ABSOLUTE_AGE_MS)
        || (age >= Duration::from_millis(CACHE_LEASE_OWNER_DEAD_MS) && !process_is_alive(owner.pid))
}

fn cache_cancelled(operation: OperationId) -> KrxError {
    cache_error(
        KrxErrorCode::RequestCancelled,
        operation,
        "cache wait was cancelled",
    )
}

fn cache_deadline(operation: OperationId, cancellation: &Cancellation) -> KrxError {
    if cancellation.is_cancelled() {
        cache_cancelled(operation)
    } else {
        cache_error(
            KrxErrorCode::DeadlineExceeded,
            operation,
            "cache wait exceeded the request deadline",
        )
    }
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

    #[tokio::test]
    async fn administration_is_strict_and_preserves_unrecognized_bytes() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &v1_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        fixture
            .store
            .state
            .atomic_write(&key.v2_path, &v2_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let unknown = fixture.root().join("cache/20260102/unknown.json");
        fixture
            .store
            .state
            .atomic_write(
                "cache/20260102/unknown.json",
                b"preserve me",
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap();

        let inspection = fixture
            .store
            .inspect(CacheInspectOptions::default())
            .await
            .unwrap();
        assert_eq!(inspection.total_entries, 2);
        // Aggregate status must remain exact even when the entry listing is
        // bounded for CLI and SDK consumers.
        assert_eq!(inspection.total_dates, 1);
        assert_eq!(inspection.entries.len(), 2);
        assert_eq!(
            inspection.total_size_bytes as usize,
            v1_fixture().len() + v2_fixture().len()
        );
        assert!(!inspection.truncated);

        let result = fixture
            .store
            .prune(CachePruneOptions {
                older_than: Some(at("2026-01-04T00:00:00Z")),
                max_entries: None,
            })
            .await
            .unwrap();
        assert_eq!(result.removed_entries, 2);
        assert!(!fixture.root().join(&key.v1_path).exists());
        assert!(!fixture.root().join(&key.v2_path).exists());
        assert_eq!(fs::read(&unknown).unwrap(), b"preserve me");
    }

    #[tokio::test]
    async fn administration_limit_is_typed_and_clear_is_conditional() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &v1_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let error = fixture
            .store
            .inspect(CacheInspectOptions {
                limit: Some(CACHE_INSPECT_MAXIMUM_ENTRIES as usize + 1),
                ..CacheInspectOptions::default()
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::InvalidArgument);

        let replacement = b"replacement";
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, replacement, KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let result = fixture.store.clear().await.unwrap();
        assert_eq!(result.removed_entries, 0);
        assert_eq!(
            fs::read(fixture.root().join(&key.v1_path)).unwrap(),
            replacement
        );
    }

    #[tokio::test]
    async fn prune_rejects_an_oversized_batch_before_traversal() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root()).unwrap();
        fs::write(fixture.root().join("cache"), b"not a directory").unwrap();

        let error = fixture
            .store
            .prune(CachePruneOptions {
                max_entries: Some(CACHE_PRUNE_DELETE_BATCH_MAXIMUM as usize + 1),
                ..CachePruneOptions::default()
            })
            .await
            .unwrap_err();

        assert_eq!(error.code(), KrxErrorCode::InvalidArgument);
    }

    #[tokio::test]
    async fn max_entry_pruning_prefers_v2_when_timestamps_match() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        fixture
            .store
            .state
            .atomic_write(&key.v1_path, &v1_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();
        fixture
            .store
            .state
            .atomic_write(&key.v2_path, &v2_fixture(), KrxErrorCode::CacheWriteFailed)
            .unwrap();

        let result = fixture
            .store
            .prune(CachePruneOptions {
                max_entries: Some(1),
                ..CachePruneOptions::default()
            })
            .await
            .unwrap();

        assert_eq!(result.removed_entries, 1);
        assert!(!fixture.root().join(&key.v1_path).exists());
        assert!(fixture.root().join(&key.v2_path).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn administration_never_traverses_symlinked_cache_directories() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let outside = fixture.parent.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.json"), b"outside").unwrap();
        fs::create_dir_all(fixture.root().join("cache")).unwrap();
        symlink(&outside, fixture.root().join("cache/20260102")).unwrap();

        let inspection = fixture
            .store
            .inspect(CacheInspectOptions::default())
            .await
            .unwrap();

        assert_eq!(inspection.total_entries, 0);
        assert_eq!(fs::read(outside.join("secret.json")).unwrap(), b"outside");
    }

    #[tokio::test]
    async fn administration_removes_stale_leases_but_preserves_live_leases() {
        let fixture = Fixture::new();
        let stale_key = fixture
            .store
            .key(
                OperationId::StockStkByddTrd,
                TradingDate::parse("20260102").unwrap(),
            )
            .unwrap();
        let stale_owner = CacheLeaseOwner {
            version: 1,
            pid: u32::MAX,
            nonce: Uuid::new_v4().to_string(),
            created_at: format_timestamp(at("2020-01-01T00:00:00Z")).unwrap(),
        };
        let stale_owner_bytes = serde_json::to_vec(&stale_owner).unwrap();
        let stale_lease = fixture
            .store
            .state
            .try_acquire_cache_lease(
                &stale_key.lease_path(),
                &stale_owner_bytes,
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap()
            .expect("stale lease setup");

        let live_key = fixture
            .store
            .key(
                OperationId::StockStkByddTrd,
                TradingDate::parse("20260103").unwrap(),
            )
            .unwrap();
        let live_lease = fixture
            .store
            .try_acquire_refresh_lease(&live_key)
            .await
            .unwrap()
            .expect("live lease setup");
        let observed_stale = fixture
            .store
            .state
            .observe_cache_lease(
                &stale_key.lease_path(),
                CACHE_LEASE_OWNER_BYTES,
                KrxErrorCode::CacheReadFailed,
            )
            .unwrap()
            .unwrap();
        assert!(cache_lease_is_stale(&observed_stale, SystemTime::now()));
        let result = fixture
            .store
            .prune(CachePruneOptions::default())
            .await
            .unwrap();
        assert_eq!(result.removed_entries, 1);
        assert!(!fixture.root().join(stale_key.lease_path()).exists());
        assert!(fixture.root().join(live_key.lease_path()).exists());
        drop(stale_lease);
        drop(live_lease);
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
    fn committed_but_unsynced_v2_preserves_the_matching_v1() {
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
        let failing_store = fixture.store.clone().with_post_commit_cache_failure();

        assert!(
            !failing_store
                .promote_v1(&key, &hit, at("2026-01-04T00:00:00Z"))
                .unwrap()
        );
        assert!(fixture.root().join(&key.v2_path).exists());
        assert_eq!(
            fs::read(fixture.root().join(&key.v1_path)).unwrap(),
            v1_fixture()
        );
    }

    #[test]
    fn stale_temporary_recognition_is_exact_for_each_platform_layout() {
        let now = SystemTime::now();
        let stale = now.checked_sub(Duration::from_secs(7_200)).unwrap();
        let uuid = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
        let v1 = format!("cache/20260102/.{}.json.123.{uuid}.tmp", "a".repeat(16));
        let v2 = format!("cache/v2/20260102/.{}.json.{uuid}.tmp", "b".repeat(64));
        assert!(is_stale_cache_temporary(&v1, stale, now));
        assert!(is_stale_cache_temporary(&v2, stale, now));
        assert!(!is_stale_cache_temporary(
            &v1.replace(&"a".repeat(16), &"a".repeat(64)),
            stale,
            now,
        ));
        assert!(!is_stale_cache_temporary(
            &v2.replace(&"b".repeat(64), &"b".repeat(16)),
            stale,
            now,
        ));
        assert!(!is_stale_cache_temporary(
            &v2.replace(uuid, &uuid.to_uppercase()),
            stale,
            now,
        ));
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

    #[test]
    fn cache_lease_owner_schema_and_stale_thresholds_are_strict() {
        let fixture = Fixture::new();
        let path = "cache/.leases/key.lock";
        let now = at("2026-01-03T00:01:01.000Z");
        let owner = CacheLeaseOwner {
            version: 1,
            pid: std::process::id(),
            nonce: "00000000-0000-4000-8000-000000000001".to_owned(),
            created_at: "2026-01-03T00:00:00.000Z".to_owned(),
        };
        let lease = fixture
            .store
            .state
            .try_acquire_cache_lease(
                path,
                &serde_json::to_vec(&owner).unwrap(),
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap()
            .unwrap();
        let observed = fixture
            .store
            .state
            .observe_cache_lease(path, 1024, KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .unwrap();
        assert!(cache_lease_is_stale(&observed, now));
        drop(lease);

        let dead_owner = CacheLeaseOwner {
            version: 1,
            pid: u32::MAX,
            nonce: "00000000-0000-4000-8000-000000000002".to_owned(),
            created_at: "2026-01-03T00:00:30.000Z".to_owned(),
        };
        let lease = fixture
            .store
            .state
            .try_acquire_cache_lease(
                path,
                &serde_json::to_vec(&dead_owner).unwrap(),
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap()
            .unwrap();
        let observed = fixture
            .store
            .state
            .observe_cache_lease(path, 1024, KrxErrorCode::CacheWriteFailed)
            .unwrap()
            .unwrap();
        assert!(cache_lease_is_stale(&observed, now));
        drop(lease);

        assert!(CacheLeaseOwner::parse(br#"{"version":1}"#).is_none());
        assert!(
            CacheLeaseOwner::parse(
                br#"{"version":1,"pid":1,"nonce":"00000000-0000-4000-8000-000000000001","createdAt":"2026-01-03T00:00:00Z"}"#
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn dead_stale_lease_is_stolen_before_the_next_acquisition() {
        let fixture = Fixture::new();
        let key = key(&fixture.store);
        let path = key.lease_path();
        let owner = CacheLeaseOwner {
            version: 1,
            pid: u32::MAX,
            nonce: "00000000-0000-4000-8000-000000000003".to_owned(),
            created_at: "2020-01-01T00:00:00.000Z".to_owned(),
        };
        let stale = fixture
            .store
            .state
            .try_acquire_cache_lease(
                &path,
                &serde_json::to_vec(&owner).unwrap(),
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap()
            .unwrap();

        assert!(
            fixture
                .store
                .try_acquire_refresh_lease(&key)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!fixture.root().join(&path).exists());
        let replacement = fixture
            .store
            .try_acquire_refresh_lease(&key)
            .await
            .unwrap()
            .expect("stale lease should no longer block acquisition");
        drop(replacement);
        drop(stale);
    }
}
