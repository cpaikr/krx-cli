use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use jiff::{RoundMode, Timestamp, TimestampRound, Unit};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::credential::{APPROVAL_TTL_SECONDS, credential_fingerprint};
use crate::state::{ReadSensitivity, StateRoot};
use crate::{ApiKey, ApprovalCategory, KrxError, KrxErrorCode, KrxErrorKind};

const CONFIG_PATH: &str = "config.json";
const CONFIG_LOCK_PATH: &str = "config.json.lock";
const CONFIG_READ_BOUND: u64 = 16 * 1024 * 1024;
const LOCK_POLL: Duration = Duration::from_millis(25);
const LOCK_TIMEOUT: Duration = Duration::from_millis(5_000);
const LOCK_STALE_AFTER: Duration = Duration::from_millis(30_000);
const ERROR_MAX_CHARACTERS: usize = 240;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalState {
    Approved,
    Rejected,
    Inconclusive,
}

#[derive(Clone, Debug)]
pub struct ApprovalObservation {
    pub category: ApprovalCategory,
    pub state: ApprovalState,
    pub checked_at: SystemTime,
    pub valid_until: SystemTime,
    pub fresh: bool,
    pub error: Option<KrxError>,
}

#[derive(Clone, Debug)]
pub(crate) struct ApprovalStore {
    state: StateRoot,
}

#[derive(Clone, Debug)]
pub(crate) enum ApprovalOutcome {
    Approved,
    Rejected(KrxError),
    Inconclusive(Option<KrxError>),
    NoData,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PersistedState {
    Approved,
    Rejected,
    Inconclusive,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PersistedFailureType {
    Timeout,
    Cancelled,
    RateLimit,
    Authentication,
    Approval,
    Network,
    Upstream,
    InvalidResponse,
    Integrity,
    LocalState,
    NoData,
    UnknownCategory,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedObservation {
    state: PersistedState,
    #[serde(skip_serializing_if = "Option::is_none")]
    approved: Option<bool>,
    checked_at: String,
    valid_until: String,
    credential_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_type: Option<PersistedFailureType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug)]
enum ApprovalRows {
    Bound(BTreeMap<ApprovalCategory, PersistedObservation>),
    Unbound,
}

#[derive(Debug)]
struct ClassifiedConfig {
    root: Map<String, Value>,
    rows: ApprovalRows,
    version: Option<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ApprovalMigration {
    pub(crate) approvals_migrated: usize,
    pub(crate) changed: bool,
}

impl ApprovalStore {
    pub(crate) fn new(root: PathBuf) -> Result<Self, KrxError> {
        Ok(Self {
            state: StateRoot::new(root)?,
        })
    }

    pub(crate) async fn status(
        &self,
        api_key: &ApiKey,
        category: ApprovalCategory,
        now: SystemTime,
    ) -> Result<Option<ApprovalObservation>, KrxError> {
        let state = self.state.clone();
        let fingerprint = credential_fingerprint(api_key);
        let exact_secret = Zeroizing::new(api_key.expose().to_owned());
        tokio::task::spawn_blocking(move || {
            status_blocking(&state, &fingerprint, exact_secret.as_str(), category, now)
        })
        .await
        .map_err(|_| KrxError::new(KrxErrorCode::InternalFailure, "approval worker failed"))?
    }

    pub(crate) async fn record(
        &self,
        api_key: &ApiKey,
        category: ApprovalCategory,
        outcome: ApprovalOutcome,
        checked_at: SystemTime,
    ) -> Result<ApprovalObservation, KrxError> {
        let state = self.state.clone();
        let fingerprint = credential_fingerprint(api_key);
        let exact_secret = Zeroizing::new(api_key.expose().to_owned());
        tokio::task::spawn_blocking(move || {
            record_blocking(
                &state,
                &fingerprint,
                exact_secret.as_str(),
                category,
                outcome,
                checked_at,
            )
        })
        .await
        .map_err(|_| KrxError::new(KrxErrorCode::InternalFailure, "approval worker failed"))?
    }

    pub(crate) async fn clear_for_rotation(&self) -> Result<(), KrxError> {
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || clear_for_rotation_blocking(&state))
            .await
            .map_err(|_| KrxError::new(KrxErrorCode::InternalFailure, "approval worker failed"))?
    }
}

fn status_blocking(
    state: &StateRoot,
    fingerprint: &str,
    exact_secret: &str,
    category: ApprovalCategory,
    now: SystemTime,
) -> Result<Option<ApprovalObservation>, KrxError> {
    let Some(observed) = state.read(
        CONFIG_PATH,
        CONFIG_READ_BOUND,
        ReadSensitivity::LegacySecret,
        KrxErrorCode::LegacyStateInvalid,
    )?
    else {
        return Ok(None);
    };
    let config = classify_config(observed.bytes(), Some(exact_secret))?;
    let ApprovalRows::Bound(rows) = config.rows else {
        return Ok(None);
    };
    let Some(persisted) = rows.get(&category) else {
        return Ok(None);
    };
    if persisted.credential_id != fingerprint {
        return Ok(None);
    }
    Ok(Some(public_observation(category, persisted, now, None)?))
}

fn record_blocking(
    state: &StateRoot,
    fingerprint: &str,
    exact_secret: &str,
    category: ApprovalCategory,
    outcome: ApprovalOutcome,
    checked_at: SystemTime,
) -> Result<ApprovalObservation, KrxError> {
    let checked_at = canonical_timestamp(checked_at)?;
    let valid_until = checked_at
        .checked_add(Duration::from_secs(APPROVAL_TTL_SECONDS))
        .ok_or_else(|| invalid_config("approval timestamp is out of range"))?;
    let public_error = outcome_error(&outcome).map(|error| error.redact_exact(exact_secret));
    let persisted =
        persisted_observation(fingerprint, exact_secret, outcome, checked_at, valid_until)?;

    let _lock = acquire_config_lock(state)?;
    let mut config = read_config_for_write(state, Some(exact_secret))?;
    if config.root.contains_key("apiKey") {
        return Err(invalid_config(
            "legacy credential must be migrated before approval state can be updated",
        ));
    }
    let mut rows = match config.rows {
        ApprovalRows::Bound(rows) => rows,
        ApprovalRows::Unbound => BTreeMap::new(),
    };
    rows.insert(category, persisted.clone());
    upgrade_root(&mut config.root, &rows)?;
    write_config(state, &config.root)?;
    public_observation(category, &persisted, checked_at, public_error)
}

pub(crate) fn clear_for_rotation_blocking(state: &StateRoot) -> Result<(), KrxError> {
    let _lock = acquire_config_lock(state)?;
    clear_for_rotation_locked(state)
}

pub(crate) fn clear_for_rotation_locked(state: &StateRoot) -> Result<(), KrxError> {
    let Some(observed) = state.read(
        CONFIG_PATH,
        CONFIG_READ_BOUND,
        ReadSensitivity::LegacySecret,
        KrxErrorCode::MigrationFailed,
    )?
    else {
        return Ok(());
    };
    let mut config = classify_config(observed.bytes(), None)?;
    if config.root.contains_key("apiKey") {
        return Err(invalid_config(
            "legacy credential must be migrated before credential rotation",
        ));
    }
    upgrade_root(&mut config.root, &BTreeMap::new())?;
    write_config(state, &config.root)
}

pub(crate) fn migrate_approval_root(
    root: &mut Map<String, Value>,
    exact_secret: Option<&str>,
) -> Result<ApprovalMigration, KrxError> {
    let bytes = serde_json::to_vec(root)
        .map_err(|_| invalid_config("configuration could not be validated"))?;
    let mut config = classify_config(&bytes, exact_secret)?;
    let approvals_migrated = match &config.rows {
        ApprovalRows::Bound(rows) if config.version.is_none() => rows.len(),
        ApprovalRows::Bound(_) | ApprovalRows::Unbound => 0,
    };
    let changed = config.version != Some(1);
    let rows = match config.rows {
        ApprovalRows::Bound(rows) => rows,
        ApprovalRows::Unbound => BTreeMap::new(),
    };
    upgrade_root(&mut config.root, &rows)?;
    *root = config.root;
    Ok(ApprovalMigration {
        approvals_migrated,
        changed,
    })
}

fn read_config_for_write(
    state: &StateRoot,
    exact_secret: Option<&str>,
) -> Result<ClassifiedConfig, KrxError> {
    let Some(observed) = state.read(
        CONFIG_PATH,
        CONFIG_READ_BOUND,
        ReadSensitivity::LegacySecret,
        KrxErrorCode::MigrationFailed,
    )?
    else {
        return Ok(ClassifiedConfig {
            root: Map::new(),
            rows: ApprovalRows::Unbound,
            version: None,
        });
    };
    classify_config(observed.bytes(), exact_secret)
}

fn classify_config(bytes: &[u8], exact_secret: Option<&str>) -> Result<ClassifiedConfig, KrxError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| invalid_config("configuration is not valid JSON"))?;
    let root = value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid_config("configuration root must be an object"))?;
    let version = match root.get("version") {
        None => None,
        Some(Value::Number(number)) if number.as_u64() == Some(1) => Some(1),
        Some(_) => {
            return Err(invalid_config(
                "configuration has an unsupported root version",
            ));
        }
    };
    if version == Some(1) && root.contains_key("apiKey") {
        return Err(invalid_config(
            "version 1 configuration must not contain a plaintext credential",
        ));
    }

    let rows = match root.get("serviceStatus") {
        None if version == Some(1) => {
            return Err(invalid_config(
                "version 1 configuration is missing serviceStatus",
            ));
        }
        None => ApprovalRows::Unbound,
        Some(Value::Object(statuses)) if statuses.is_empty() => {
            ApprovalRows::Bound(BTreeMap::new())
        }
        Some(Value::Object(statuses)) => {
            if statuses.len() > ApprovalCategory::ALL.len() {
                return Err(invalid_config("configuration has too many approval rows"));
            }
            classify_rows(statuses, exact_secret, version == Some(1))?
        }
        Some(_) => return Err(invalid_config("configuration serviceStatus is invalid")),
    };

    Ok(ClassifiedConfig {
        root,
        rows,
        version,
    })
}

fn classify_rows(
    statuses: &Map<String, Value>,
    exact_secret: Option<&str>,
    requires_bound: bool,
) -> Result<ApprovalRows, KrxError> {
    let mut bound = BTreeMap::new();
    let mut bound_count = 0;
    let mut legacy_count = 0;
    for (name, value) in statuses {
        let category = ApprovalCategory::parse(name)
            .ok_or_else(|| invalid_config("configuration has an unknown approval category"))?;
        match serde_json::from_value::<PersistedObservation>(value.clone()) {
            Ok(observation) => {
                validate_observation(&observation, exact_secret)?;
                bound.insert(category, observation);
                bound_count += 1;
            }
            Err(_) if is_legacy_observation(value) => legacy_count += 1,
            Err(_) => return Err(invalid_config("configuration approval row is invalid")),
        }
    }
    if legacy_count == 0 {
        return Ok(ApprovalRows::Bound(bound));
    }
    if bound_count == 0 && !requires_bound {
        return Ok(ApprovalRows::Unbound);
    }
    Err(invalid_config(
        "configuration mixes bound and unbound approval rows",
    ))
}

fn is_legacy_observation(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if [
        "state",
        "validUntil",
        "credentialId",
        "failureType",
        "error",
    ]
    .iter()
    .any(|field| object.contains_key(*field))
    {
        return false;
    }
    object.get("approved").is_some_and(Value::is_boolean)
        && object.get("checkedAt").is_some_and(Value::is_string)
}

fn validate_observation(
    observation: &PersistedObservation,
    exact_secret: Option<&str>,
) -> Result<(), KrxError> {
    if observation.credential_id.len() != 64
        || !observation
            .credential_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_config("approval credential identity is invalid"));
    }
    let checked_at = parse_canonical_timestamp(&observation.checked_at)?;
    let valid_until = parse_canonical_timestamp(&observation.valid_until)?;
    if checked_at.checked_add(Duration::from_secs(APPROVAL_TTL_SECONDS)) != Some(valid_until) {
        return Err(invalid_config("approval validity interval is invalid"));
    }
    if observation
        .error
        .as_ref()
        .is_some_and(|message| message.chars().count() > ERROR_MAX_CHARACTERS)
    {
        return Err(invalid_config("approval error is too long"));
    }
    if exact_secret.is_some_and(|secret| {
        !secret.is_empty()
            && observation
                .error
                .as_ref()
                .is_some_and(|message| message.contains(secret))
    }) {
        return Err(invalid_config("approval error contains credential bytes"));
    }
    match observation.state {
        PersistedState::Approved
            if observation.approved == Some(true)
                && observation.failure_type.is_none()
                && observation.error.is_none() => {}
        PersistedState::Rejected
            if observation.approved == Some(false)
                && observation.failure_type == Some(PersistedFailureType::Approval) => {}
        PersistedState::Inconclusive if observation.approved.is_none() => {}
        _ => return Err(invalid_config("approval state fields are inconsistent")),
    }
    Ok(())
}

fn persisted_observation(
    fingerprint: &str,
    exact_secret: &str,
    outcome: ApprovalOutcome,
    checked_at: SystemTime,
    valid_until: SystemTime,
) -> Result<PersistedObservation, KrxError> {
    let (state, approved, failure_type, error) = match outcome {
        ApprovalOutcome::Approved => (PersistedState::Approved, Some(true), None, None),
        ApprovalOutcome::Rejected(error) => (
            PersistedState::Rejected,
            Some(false),
            Some(PersistedFailureType::Approval),
            Some(sanitize_error(error.message(), exact_secret)),
        ),
        ApprovalOutcome::Inconclusive(error) => {
            let failure_type = error
                .as_ref()
                .map(failure_type_for_error)
                .unwrap_or(PersistedFailureType::Upstream);
            let message = error
                .as_ref()
                .map(|error| sanitize_error(error.message(), exact_secret));
            (
                PersistedState::Inconclusive,
                None,
                Some(failure_type),
                message,
            )
        }
        ApprovalOutcome::NoData => (
            PersistedState::Inconclusive,
            None,
            Some(PersistedFailureType::NoData),
            Some("Probe succeeded but returned no rows".to_owned()),
        ),
    };
    let persisted = PersistedObservation {
        state,
        approved,
        checked_at: format_timestamp(checked_at)?,
        valid_until: format_timestamp(valid_until)?,
        credential_id: fingerprint.to_owned(),
        failure_type,
        error,
    };
    validate_observation(&persisted, Some(exact_secret))?;
    Ok(persisted)
}

fn outcome_error(outcome: &ApprovalOutcome) -> Option<KrxError> {
    match outcome {
        ApprovalOutcome::Rejected(error) | ApprovalOutcome::Inconclusive(Some(error)) => {
            Some(error.clone())
        }
        ApprovalOutcome::Approved
        | ApprovalOutcome::Inconclusive(None)
        | ApprovalOutcome::NoData => None,
    }
}

fn failure_type_for_error(error: &KrxError) -> PersistedFailureType {
    match error.kind() {
        KrxErrorKind::Cancelled => PersistedFailureType::Cancelled,
        KrxErrorKind::Timeout => PersistedFailureType::Timeout,
        KrxErrorKind::Authentication => PersistedFailureType::Authentication,
        KrxErrorKind::Approval => PersistedFailureType::Approval,
        KrxErrorKind::RateLimit => PersistedFailureType::RateLimit,
        KrxErrorKind::Network => PersistedFailureType::Network,
        KrxErrorKind::Upstream => PersistedFailureType::Upstream,
        KrxErrorKind::InvalidResponse => PersistedFailureType::InvalidResponse,
        KrxErrorKind::Integrity => PersistedFailureType::Integrity,
        KrxErrorKind::LocalState | KrxErrorKind::Offline | KrxErrorKind::Internal => {
            PersistedFailureType::LocalState
        }
        KrxErrorKind::InvalidRequest => PersistedFailureType::UnknownCategory,
    }
}

fn public_observation(
    category: ApprovalCategory,
    persisted: &PersistedObservation,
    now: SystemTime,
    error: Option<KrxError>,
) -> Result<ApprovalObservation, KrxError> {
    let checked_at = parse_canonical_timestamp(&persisted.checked_at)?;
    let valid_until = parse_canonical_timestamp(&persisted.valid_until)?;
    Ok(ApprovalObservation {
        category,
        state: match persisted.state {
            PersistedState::Approved => ApprovalState::Approved,
            PersistedState::Rejected => ApprovalState::Rejected,
            PersistedState::Inconclusive => ApprovalState::Inconclusive,
        },
        checked_at,
        valid_until,
        fresh: valid_until > now,
        // Persisted failure categories are deliberately coarse. A cached read
        // must not invent the structured fields of the original KrxError.
        error,
    })
}

fn upgrade_root(
    root: &mut Map<String, Value>,
    rows: &BTreeMap<ApprovalCategory, PersistedObservation>,
) -> Result<(), KrxError> {
    let mut statuses = Map::new();
    for (category, observation) in rows {
        statuses.insert(
            category.as_str().to_owned(),
            serde_json::to_value(observation)
                .map_err(|_| invalid_config("approval row could not be serialized"))?,
        );
    }
    root.insert("version".to_owned(), Value::from(1));
    root.insert("serviceStatus".to_owned(), Value::Object(statuses));
    Ok(())
}

pub(crate) fn write_config(state: &StateRoot, root: &Map<String, Value>) -> Result<(), KrxError> {
    write_config_observed(state, root).map_err(|(error, _)| error)
}

pub(crate) fn write_config_observed(
    state: &StateRoot,
    root: &Map<String, Value>,
) -> Result<(), (KrxError, bool)> {
    let mut bytes = serde_json::to_vec_pretty(root).map_err(|_| {
        (
            KrxError::new(KrxErrorCode::MigrationFailed, "configuration write failed"),
            false,
        )
    })?;
    bytes.push(b'\n');
    state
        .atomic_write_observed(CONFIG_PATH, &bytes, KrxErrorCode::MigrationFailed)
        .map_err(|failure| {
            let committed = failure.committed();
            (failure.into_error(), committed)
        })
}

pub(crate) fn acquire_config_lock(
    state: &StateRoot,
) -> Result<crate::state::PlainDirectoryLock, KrxError> {
    acquire_config_lock_with_error(state, KrxErrorCode::MigrationFailed)
}

pub(crate) fn acquire_legacy_migration_lock(
    state: &StateRoot,
) -> Result<crate::state::PlainDirectoryLock, KrxError> {
    acquire_config_lock_with_error(state, KrxErrorCode::LegacyStateInvalid)
}

fn acquire_config_lock_with_error(
    state: &StateRoot,
    error_code: KrxErrorCode,
) -> Result<crate::state::PlainDirectoryLock, KrxError> {
    let deadline = Instant::now() + LOCK_TIMEOUT;
    let owner = format!("{}-{}", std::process::id(), Uuid::new_v4());
    loop {
        if let Some(lock) = state.try_acquire_legacy_secret_plain_lock(
            CONFIG_LOCK_PATH,
            owner.clone(),
            error_code,
        )? {
            return Ok(lock);
        }
        if state.steal_legacy_secret_plain_lock_if_stale(
            CONFIG_LOCK_PATH,
            LOCK_STALE_AFTER,
            SystemTime::now(),
            error_code,
        )? {
            continue;
        }
        if Instant::now() >= deadline {
            return Err(KrxError::new(
                error_code,
                "timed out waiting for the configuration lock",
            ));
        }
        std::thread::sleep(LOCK_POLL);
    }
}

fn canonical_timestamp(value: SystemTime) -> Result<SystemTime, KrxError> {
    let timestamp = Timestamp::try_from(value)
        .and_then(|timestamp| {
            timestamp.round(
                TimestampRound::new()
                    .smallest(Unit::Millisecond)
                    .mode(RoundMode::Trunc),
            )
        })
        .map_err(|_| invalid_config("approval timestamp is out of range"))?;
    Ok(timestamp.into())
}

fn format_timestamp(value: SystemTime) -> Result<String, KrxError> {
    let timestamp = Timestamp::try_from(value)
        .map_err(|_| invalid_config("approval timestamp is out of range"))?;
    Ok(timestamp.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn parse_canonical_timestamp(value: &str) -> Result<SystemTime, KrxError> {
    let timestamp: Timestamp = value
        .parse()
        .map_err(|_| invalid_config("approval timestamp is invalid"))?;
    let parsed: SystemTime = timestamp.into();
    if format_timestamp(parsed)? != value {
        return Err(invalid_config("approval timestamp is not canonical UTC"));
    }
    Ok(parsed)
}

fn sanitize_error(message: &str, exact_secret: &str) -> String {
    let redacted = if exact_secret.is_empty() {
        message.to_owned()
    } else {
        message.replace(exact_secret, "[REDACTED]")
    };
    redacted.chars().take(ERROR_MAX_CHARACTERS).collect()
}

fn invalid_config(message: &'static str) -> KrxError {
    KrxError::new(KrxErrorCode::LegacyStateInvalid, message)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    struct TestRoot {
        parent: PathBuf,
        state: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            let parent = std::env::current_dir()
                .expect("working directory")
                .join("target")
                .join("approval-tests")
                .join(Uuid::new_v4().to_string());
            Self {
                state: parent.join(".krx-cli"),
                parent,
            }
        }

        fn store(&self) -> ApprovalStore {
            ApprovalStore::new(self.state.clone()).unwrap()
        }

        fn write(&self, bytes: &[u8]) {
            fs::create_dir_all(&self.state).unwrap();
            fs::write(self.state.join(CONFIG_PATH), bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                fs::set_permissions(&self.state, fs::Permissions::from_mode(0o700)).unwrap();
                fs::set_permissions(
                    self.state.join(CONFIG_PATH),
                    fs::Permissions::from_mode(0o600),
                )
                .unwrap();
            }
        }

        fn read_json(&self) -> Value {
            serde_json::from_slice(&fs::read(self.state.join(CONFIG_PATH)).unwrap()).unwrap()
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.parent).unwrap();
        }
    }

    fn fixture(name: &str) -> Vec<u8> {
        fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../contracts/product/v1/fixtures")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn classifies_frozen_bound_and_unbound_fixtures() {
        let bound =
            classify_config(&fixture("approval-bound-v0.json"), Some("fixture-key")).unwrap();
        assert!(matches!(bound.rows, ApprovalRows::Bound(_)));
        assert_eq!(bound.version, None);

        let unbound = classify_config(
            &fixture("legacy-config-without-secret-v0.json"),
            Some("fixture-key"),
        )
        .unwrap();
        assert!(matches!(unbound.rows, ApprovalRows::Unbound));
    }

    #[test]
    fn rejects_semantically_invalid_and_mixed_fixtures() {
        for name in [
            "approval-invalid-ttl-v1.json",
            "approval-error-secret-v1.json",
            "approval-mixed-invalid-v0.json",
            "approval-bound-version-collision-v0.json",
            "legacy-config-invalid-status-v0.json",
        ] {
            assert_eq!(
                classify_config(&fixture(name), Some("fixture-key"))
                    .unwrap_err()
                    .code(),
                KrxErrorCode::LegacyStateInvalid,
                "{name}"
            );
        }
    }

    #[test]
    fn every_probe_outcome_maps_to_a_valid_persisted_state() {
        let checked_at: SystemTime = "2026-01-02T00:00:00.000Z"
            .parse::<Timestamp>()
            .unwrap()
            .into();
        let valid_until = checked_at
            .checked_add(Duration::from_secs(APPROVAL_TTL_SECONDS))
            .unwrap();
        let fingerprint = credential_fingerprint(&ApiKey::parse("fixture-key").unwrap());
        let outcomes = [
            ApprovalOutcome::Approved,
            ApprovalOutcome::Rejected(KrxError::new(
                KrxErrorCode::ServiceNotApproved,
                "service denied fixture-key",
            )),
            ApprovalOutcome::NoData,
        ];
        for outcome in outcomes {
            let persisted = persisted_observation(
                &fingerprint,
                "fixture-key",
                outcome,
                checked_at,
                valid_until,
            )
            .unwrap();
            validate_observation(&persisted, Some("fixture-key")).unwrap();
            assert!(
                !serde_json::to_string(&persisted)
                    .unwrap()
                    .contains("fixture-key")
            );
        }
    }

    #[tokio::test]
    async fn cached_status_is_credential_bound_and_reports_staleness() {
        let root = TestRoot::new();
        root.write(&fixture("approval-v1.json"));
        let store = root.store();
        let fixture_key = ApiKey::parse("fixture-key").unwrap();
        let fresh_time: Timestamp = "2026-01-02T00:14:59.999Z".parse().unwrap();
        let stale_time: Timestamp = "2026-01-02T00:15:00.000Z".parse().unwrap();
        assert!(
            store
                .status(&fixture_key, ApprovalCategory::Stock, fresh_time.into(),)
                .await
                .unwrap()
                .unwrap()
                .fresh
        );
        assert!(
            !store
                .status(&fixture_key, ApprovalCategory::Stock, stale_time.into(),)
                .await
                .unwrap()
                .unwrap()
                .fresh
        );
        assert!(
            store
                .status(
                    &ApiKey::parse("other-key").unwrap(),
                    ApprovalCategory::Stock,
                    fresh_time.into(),
                )
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn merge_writes_preserve_unknown_keys_and_redact_errors() {
        let root = TestRoot::new();
        root.write(&fixture("approval-bound-v0.json"));
        let store = root.store();
        let api_key = ApiKey::parse("fixture-key").unwrap();
        let checked_at: Timestamp = "2026-01-03T12:00:00.123456789Z".parse().unwrap();
        let error = KrxError::new(
            KrxErrorCode::RequestFailed,
            "network exposed fixture-key before sanitization",
        );
        let observation = store
            .record(
                &api_key,
                ApprovalCategory::Etp,
                ApprovalOutcome::Inconclusive(Some(error)),
                checked_at.into(),
            )
            .await
            .unwrap();
        assert_eq!(observation.state, ApprovalState::Inconclusive);
        assert!(!observation.error.unwrap().message().contains("fixture-key"));
        let config = root.read_json();
        assert_eq!(config["version"], 1);
        assert_eq!(config["preservedUnknown"]["owner"], "legacy");
        assert_eq!(
            config["serviceStatus"]["etp"]["checkedAt"],
            "2026-01-03T12:00:00.123Z"
        );
        assert!(
            !serde_json::to_string(&config)
                .unwrap()
                .contains("fixture-key")
        );
    }

    #[tokio::test]
    async fn concurrent_category_writes_serialize_and_merge() {
        let root = TestRoot::new();
        root.write(&fixture("approval-v1.json"));
        let first = root.store();
        let second = first.clone();
        let api_key = ApiKey::parse("fixture-key").unwrap();
        let first_key = api_key.clone();
        let checked_at: SystemTime = "2026-01-03T12:00:00.000Z"
            .parse::<Timestamp>()
            .unwrap()
            .into();
        let (index, etp) = tokio::join!(
            first.record(
                &first_key,
                ApprovalCategory::Index,
                ApprovalOutcome::Approved,
                checked_at,
            ),
            second.record(
                &api_key,
                ApprovalCategory::Etp,
                ApprovalOutcome::NoData,
                checked_at,
            )
        );
        index.unwrap();
        etp.unwrap();
        let config = root.read_json();
        assert_eq!(config["serviceStatus"]["index"]["state"], "approved");
        assert_eq!(config["serviceStatus"]["etp"]["state"], "inconclusive");
        assert_eq!(config["serviceStatus"]["stock"]["state"], "approved");
    }

    #[tokio::test]
    async fn malformed_bound_row_is_not_reclassified_or_rewritten() {
        let root = TestRoot::new();
        let malformed = br#"{
  "preservedUnknown": { "owner": "legacy" },
  "serviceStatus": {
    "stock": {
      "approved": true,
      "checkedAt": "2026-01-02T00:00:00.000Z",
      "state": "not-a-state",
      "validUntil": "2026-01-02T00:15:00.000Z",
      "credentialId": "66e7c82b49bb291dd09c8e020448311c4a7bb96aeb5c5db769f66812b13a50b5"
    }
  }
}
"#;
        root.write(malformed);
        let before = fs::read(root.state.join(CONFIG_PATH)).unwrap();
        let error = root
            .store()
            .record(
                &ApiKey::parse("fixture-key").unwrap(),
                ApprovalCategory::Etp,
                ApprovalOutcome::Approved,
                SystemTime::UNIX_EPOCH,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::LegacyStateInvalid);
        assert_eq!(fs::read(root.state.join(CONFIG_PATH)).unwrap(), before);
    }

    #[tokio::test]
    async fn rotation_clears_only_approval_rows() {
        let root = TestRoot::new();
        root.write(&fixture("approval-v1.json"));
        root.store().clear_for_rotation().await.unwrap();
        let config = root.read_json();
        assert_eq!(config["version"], 1);
        assert_eq!(config["serviceStatus"], serde_json::json!({}));
        assert_eq!(config["preservedUnknown"]["owner"], "legacy");
    }
}
