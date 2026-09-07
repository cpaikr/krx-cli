use std::env::VarError;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::approval::{
    acquire_config_lock, acquire_legacy_migration_lock, clear_for_rotation_locked,
    migrate_approval_root, write_config, write_config_observed,
};
use crate::state::{ReadSensitivity, StateRoot};
use crate::{ApiKey, ApprovalCategory, KrxError, KrxErrorCode, OperationId};

const CONFIG_PATH: &str = "config.json";
const CONFIG_READ_BOUND: u64 = 16 * 1024 * 1024;
type ConfigWriter = fn(&StateRoot, &Map<String, Value>) -> Result<(), (KrxError, bool)>;

include!(concat!(env!("OUT_DIR"), "/local_state_contract.rs"));

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialSource {
    Explicit,
    Environment,
    Keychain,
    Missing,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialStatus {
    pub source: CredentialSource,
    pub persisted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialMigrationResult {
    pub migrated: bool,
    pub legacy_secret_removed: bool,
    pub approvals_migrated: usize,
}

#[derive(Clone)]
pub(crate) struct CredentialManager {
    explicit: Option<ApiKey>,
    environment: Arc<dyn Environment>,
    backend: Arc<dyn CredentialBackend>,
    state_root: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedCredential {
    pub(crate) api_key: ApiKey,
    pub(crate) source: CredentialSource,
}

impl CredentialManager {
    pub(crate) fn native(state_root: PathBuf, explicit: Option<ApiKey>) -> Self {
        Self {
            explicit,
            environment: Arc::new(ProcessEnvironment),
            backend: Arc::new(NativeCredentialBackend),
            state_root,
        }
    }

    pub(crate) async fn status(&self) -> Result<CredentialStatus, KrxError> {
        let resolved = self.resolve().await?;
        Ok(match resolved {
            Some(resolved) => CredentialStatus {
                source: resolved.source,
                persisted: resolved.source == CredentialSource::Keychain,
            },
            None => CredentialStatus {
                source: CredentialSource::Missing,
                persisted: false,
            },
        })
    }

    pub(crate) async fn resolve_required(&self) -> Result<ResolvedCredential, KrxError> {
        self.resolve().await?.ok_or_else(|| {
            KrxError::new(KrxErrorCode::CredentialMissing, "KRX credential is missing")
        })
    }

    async fn resolve(&self) -> Result<Option<ResolvedCredential>, KrxError> {
        if let Some(api_key) = &self.explicit {
            return Ok(Some(ResolvedCredential {
                api_key: api_key.clone(),
                source: CredentialSource::Explicit,
            }));
        }
        if let Some(value) = self.environment.api_key()? {
            let value = Zeroizing::new(value);
            return Ok(Some(ResolvedCredential {
                api_key: ApiKey::parse(&value)?,
                source: CredentialSource::Environment,
            }));
        }
        let backend = Arc::clone(&self.backend);
        let persisted = tokio::task::spawn_blocking(move || backend.get())
            .await
            .map_err(|_| credential_store_unavailable("credential task failed"))??;
        let Some(persisted) = persisted else {
            return Ok(None);
        };
        Ok(Some(ResolvedCredential {
            api_key: persisted_api_key(persisted)?,
            source: CredentialSource::Keychain,
        }))
    }

    pub(crate) async fn set(&self, api_key: ApiKey) -> Result<(), KrxError> {
        let backend = Arc::clone(&self.backend);
        let state = StateRoot::new(self.state_root.clone())?;
        let secret = Zeroizing::new(api_key.expose().to_owned());
        tokio::task::spawn_blocking(move || set_blocking(backend.as_ref(), &state, &secret))
            .await
            .map_err(|_| credential_store_unavailable("credential task failed"))?
    }

    pub(crate) async fn remove(&self) -> Result<bool, KrxError> {
        let backend = Arc::clone(&self.backend);
        tokio::task::spawn_blocking(move || backend.remove())
            .await
            .map_err(|_| credential_store_unavailable("credential task failed"))?
    }

    pub(crate) async fn migrate_legacy(&self) -> Result<CredentialMigrationResult, KrxError> {
        let backend = Arc::clone(&self.backend);
        let state = StateRoot::new(self.state_root.clone())?;
        tokio::task::spawn_blocking(move || migrate_legacy_blocking(backend.as_ref(), &state))
            .await
            .map_err(|_| credential_store_unavailable("credential migration task failed"))?
    }

    pub(crate) fn state_root(&self) -> &PathBuf {
        &self.state_root
    }
}

fn set_blocking(
    backend: &dyn CredentialBackend,
    state: &StateRoot,
    secret: &str,
) -> Result<(), KrxError> {
    let _lock = acquire_config_lock(state)?;
    // Clear credential-bound approvals before touching the keychain. If the
    // later keychain write fails, losing advisory approval state is safer than
    // reactivating rows for a removed-and-reinstalled credential.
    clear_for_rotation_locked(state)?;
    let write_error = backend.set(secret).err();
    if let Err(verification_error) = verify_backend(backend, secret) {
        return match (write_error, verification_error.code()) {
            (_, KrxErrorCode::CredentialReadFailed) => Err(verification_error),
            (Some(error), _) => Err(error),
            (None, _) => Err(verification_error),
        };
    }
    Ok(())
}

fn migrate_legacy_blocking(
    backend: &dyn CredentialBackend,
    state: &StateRoot,
) -> Result<CredentialMigrationResult, KrxError> {
    migrate_legacy_blocking_with_writer(backend, state, write_config_observed)
}

fn migrate_legacy_blocking_with_writer(
    backend: &dyn CredentialBackend,
    state: &StateRoot,
    write: ConfigWriter,
) -> Result<CredentialMigrationResult, KrxError> {
    let _lock = acquire_legacy_migration_lock(state)?;
    let Some(observed) = state.read(
        CONFIG_PATH,
        CONFIG_READ_BOUND,
        ReadSensitivity::LegacySecret,
        KrxErrorCode::LegacyStateInvalid,
    )?
    else {
        return Ok(CredentialMigrationResult {
            migrated: false,
            legacy_secret_removed: false,
            approvals_migrated: 0,
        });
    };
    let legacy_bytes = Zeroizing::new(observed.into_bytes());
    let value: Value = serde_json::from_slice(&legacy_bytes)
        .map_err(|_| legacy_invalid("legacy configuration is not valid JSON"))?;
    let Value::Object(mut root) = value else {
        return Err(legacy_invalid(
            "legacy configuration root must be an object",
        ));
    };
    let legacy_secret = match root.remove("apiKey") {
        None => None,
        Some(Value::String(secret)) => {
            let secret = Zeroizing::new(secret);
            if validate_persisted_api_key(&secret).is_err() {
                return Err(legacy_invalid("legacy configuration credential is invalid"));
            }
            Some(secret)
        }
        Some(_) => {
            return Err(legacy_invalid("legacy configuration credential is invalid"));
        }
    };
    let approval = migrate_approval_root(&mut root, legacy_secret.as_deref().map(String::as_str))?;
    let Some(secret) = legacy_secret else {
        if approval.changed {
            write_config(state, &root)?;
        }
        return Ok(CredentialMigrationResult {
            migrated: false,
            legacy_secret_removed: false,
            approvals_migrated: approval.approvals_migrated,
        });
    };

    let existing = backend.get()?.map(Zeroizing::new);
    let created = match existing.as_deref() {
        None => {
            if let Err(error) = backend.set(&secret) {
                return if rollback_created_backend(backend, &secret) {
                    Err(error)
                } else {
                    Err(credential_rollback_failed(
                        "credential migration rollback failed",
                    ))
                };
            }
            true
        }
        Some(value) if validate_persisted_api_key(value).is_err() => {
            return Err(KrxError::new(
                KrxErrorCode::CredentialReadFailed,
                "persisted credential is invalid",
            ));
        }
        Some(value) if value == secret.as_str() => false,
        Some(_) => {
            return Err(KrxError::new(
                KrxErrorCode::MigrationConflict,
                "persisted credential conflicts with the legacy credential",
            ));
        }
    };
    if let Err(error) = verify_backend(backend, &secret) {
        if created && !rollback_created_backend(backend, &secret) {
            return Err(credential_rollback_failed(
                "credential migration rollback failed",
            ));
        }
        return Err(error);
    }
    if let Err((error, committed)) = write(state, &root) {
        if created && !committed && !rollback_created_backend(backend, &secret) {
            return Err(credential_rollback_failed(
                "credential migration rollback failed",
            ));
        }
        return Err(error);
    }
    Ok(CredentialMigrationResult {
        migrated: true,
        legacy_secret_removed: true,
        approvals_migrated: approval.approvals_migrated,
    })
}

fn verify_backend(backend: &dyn CredentialBackend, expected: &str) -> Result<(), KrxError> {
    let read_back = backend.get()?.map(Zeroizing::new).ok_or_else(|| {
        KrxError::new(
            KrxErrorCode::CredentialVerifyFailed,
            "credential verification failed",
        )
    })?;
    if read_back.as_str() != expected {
        return Err(KrxError::new(
            KrxErrorCode::CredentialVerifyFailed,
            "credential verification failed",
        ));
    }
    Ok(())
}

fn rollback_created_backend(backend: &dyn CredentialBackend, expected: &str) -> bool {
    match backend.get() {
        Ok(Some(current)) if current == expected => {
            if backend.remove().is_err() {
                return false;
            }
            match backend.get() {
                Ok(None) => true,
                Ok(Some(current)) => current != expected,
                Err(_) => false,
            }
        }
        Ok(_) => true,
        Err(_) => false,
    }
}

fn credential_rollback_failed(message: &'static str) -> KrxError {
    KrxError::new(KrxErrorCode::CredentialVerifyFailed, message)
}

fn legacy_invalid(message: &'static str) -> KrxError {
    KrxError::new(KrxErrorCode::LegacyStateInvalid, message)
}

trait Environment: Send + Sync {
    fn api_key(&self) -> Result<Option<String>, KrxError>;
}

struct ProcessEnvironment;

impl Environment for ProcessEnvironment {
    fn api_key(&self) -> Result<Option<String>, KrxError> {
        match std::env::var(CREDENTIAL_ENVIRONMENT) {
            Ok(value) => Ok(Some(value)),
            Err(VarError::NotPresent) => Ok(None),
            Err(VarError::NotUnicode(_)) => Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "API key must be a non-empty token",
            )),
        }
    }
}

trait CredentialBackend: Send + Sync {
    fn get(&self) -> Result<Option<String>, KrxError>;
    fn set(&self, secret: &str) -> Result<(), KrxError>;
    fn remove(&self) -> Result<bool, KrxError>;
}

struct NativeCredentialBackend;

impl NativeCredentialBackend {
    fn entry(&self) -> Result<keyring::Entry, KrxError> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|_| credential_store_unavailable("credential store is unavailable"))
    }

    fn entry_for_read(&self) -> Result<keyring::Entry, KrxError> {
        // Some platform backends defer store discovery until get_password(),
        // while headless Linux can reject Entry construction itself. Keep the
        // public read diagnostic independent of that backend-specific boundary.
        classify_read_entry(keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT))
    }
}

fn classify_read_entry<T, E>(entry: Result<T, E>) -> Result<T, KrxError> {
    entry.map_err(|_| KrxError::new(KrxErrorCode::CredentialReadFailed, "credential read failed"))
}

impl CredentialBackend for NativeCredentialBackend {
    fn get(&self) -> Result<Option<String>, KrxError> {
        match self.entry_for_read()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(KrxError::new(
                KrxErrorCode::CredentialReadFailed,
                "credential read failed",
            )),
        }
    }

    fn set(&self, secret: &str) -> Result<(), KrxError> {
        self.entry()?.set_password(secret).map_err(|_| {
            KrxError::new(
                KrxErrorCode::CredentialWriteFailed,
                "credential write failed",
            )
        })
    }

    fn remove(&self) -> Result<bool, KrxError> {
        match self.entry()?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(KrxError::new(
                KrxErrorCode::CredentialWriteFailed,
                "credential removal failed",
            )),
        }
    }
}

fn persisted_api_key(value: String) -> Result<ApiKey, KrxError> {
    let value = Zeroizing::new(value);
    validate_persisted_api_key(&value)?;
    Ok(ApiKey::from_exact(value.as_str().to_owned()))
}

fn validate_persisted_api_key(value: &str) -> Result<(), KrxError> {
    if !crate::request::valid_api_key_value(value) {
        return Err(KrxError::new(
            KrxErrorCode::CredentialReadFailed,
            "persisted credential is invalid",
        ));
    }
    Ok(())
}

fn credential_store_unavailable(message: &'static str) -> KrxError {
    KrxError::new(KrxErrorCode::CredentialStoreUnavailable, message)
}

pub(crate) fn credential_fingerprint(api_key: &ApiKey) -> String {
    let digest = Sha256::digest(api_key.expose().as_bytes());
    let mut fingerprint = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut fingerprint, "{byte:02x}").expect("writing to a String cannot fail");
    }
    fingerprint
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::{Mutex, mpsc};
    use std::time::Duration;

    use super::*;

    #[derive(Default)]
    struct FakeEnvironment(Mutex<Option<Result<Option<String>, KrxError>>>);

    impl FakeEnvironment {
        fn value(value: Option<&str>) -> Self {
            Self(Mutex::new(Some(Ok(value.map(str::to_owned)))))
        }
    }

    impl Environment for FakeEnvironment {
        fn api_key(&self) -> Result<Option<String>, KrxError> {
            self.0
                .lock()
                .expect("environment lock")
                .take()
                .unwrap_or(Ok(None))
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        secret: Mutex<Option<String>>,
        gets: Mutex<usize>,
        sets: Mutex<usize>,
        removes: Mutex<usize>,
        get_results: Mutex<VecDeque<Result<Option<String>, KrxError>>>,
        set_errors_after_write: Mutex<VecDeque<KrxError>>,
    }

    impl FakeBackend {
        fn with_secret(secret: Option<&str>) -> Self {
            Self {
                secret: Mutex::new(secret.map(str::to_owned)),
                ..Self::default()
            }
        }

        fn with_get_results(
            secret: Option<&str>,
            results: impl IntoIterator<Item = Result<Option<String>, KrxError>>,
        ) -> Self {
            Self {
                secret: Mutex::new(secret.map(str::to_owned)),
                get_results: Mutex::new(results.into_iter().collect()),
                ..Self::default()
            }
        }

        fn with_partial_set_error(error: KrxError) -> Self {
            Self::with_secret_and_partial_set_error(None, error)
        }

        fn with_secret_and_partial_set_error(secret: Option<&str>, error: KrxError) -> Self {
            Self {
                secret: Mutex::new(secret.map(str::to_owned)),
                set_errors_after_write: Mutex::new(VecDeque::from([error])),
                ..Self::default()
            }
        }
    }

    impl CredentialBackend for FakeBackend {
        fn get(&self) -> Result<Option<String>, KrxError> {
            *self.gets.lock().expect("get counter") += 1;
            if let Some(result) = self.get_results.lock().expect("get results").pop_front() {
                return result;
            }
            Ok(self.secret.lock().expect("secret lock").clone())
        }

        fn set(&self, secret: &str) -> Result<(), KrxError> {
            *self.sets.lock().expect("set counter") += 1;
            *self.secret.lock().expect("secret lock") = Some(secret.to_owned());
            match self
                .set_errors_after_write
                .lock()
                .expect("set errors")
                .pop_front()
            {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }

        fn remove(&self) -> Result<bool, KrxError> {
            *self.removes.lock().expect("remove counter") += 1;
            Ok(self.secret.lock().expect("secret lock").take().is_some())
        }
    }

    struct PausingBackend {
        secret: Mutex<Option<String>>,
        pause_secret: String,
        paused: Mutex<Option<mpsc::Sender<()>>>,
        resume: Mutex<mpsc::Receiver<()>>,
    }

    impl PausingBackend {
        fn new(initial: &str, pause_secret: &str) -> (Self, mpsc::Receiver<()>, mpsc::Sender<()>) {
            let (paused_tx, paused_rx) = mpsc::channel();
            let (resume_tx, resume_rx) = mpsc::channel();
            (
                Self {
                    secret: Mutex::new(Some(initial.to_owned())),
                    pause_secret: pause_secret.to_owned(),
                    paused: Mutex::new(Some(paused_tx)),
                    resume: Mutex::new(resume_rx),
                },
                paused_rx,
                resume_tx,
            )
        }
    }

    impl CredentialBackend for PausingBackend {
        fn get(&self) -> Result<Option<String>, KrxError> {
            Ok(self.secret.lock().unwrap().clone())
        }

        fn set(&self, secret: &str) -> Result<(), KrxError> {
            *self.secret.lock().unwrap() = Some(secret.to_owned());
            if secret == self.pause_secret
                && let Some(paused) = self.paused.lock().unwrap().take()
            {
                paused.send(()).unwrap();
                self.resume.lock().unwrap().recv().unwrap();
            }
            Ok(())
        }

        fn remove(&self) -> Result<bool, KrxError> {
            Ok(self.secret.lock().unwrap().take().is_some())
        }
    }

    struct TestRoot {
        parent: PathBuf,
        state: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            let parent = std::env::current_dir()
                .expect("working directory")
                .join("target")
                .join("credential-tests")
                .join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&parent).unwrap();
            Self {
                state: parent.join(".krx-cli"),
                parent,
            }
        }

        fn write_fixture(&self, name: &str) {
            let bytes = fs::read(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../contracts/product/v1/fixtures")
                    .join(name),
            )
            .unwrap();
            self.write_config_bytes(&bytes);
        }

        fn write_config_bytes(&self, bytes: &[u8]) {
            fs::create_dir_all(&self.parent).unwrap();
            StateRoot::new(self.state.clone())
                .unwrap()
                .atomic_write(CONFIG_PATH, bytes, KrxErrorCode::MigrationFailed)
                .unwrap();
        }

        fn config(&self) -> Value {
            serde_json::from_slice(&fs::read(self.state.join(CONFIG_PATH)).unwrap()).unwrap()
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.parent).unwrap();
        }
    }

    fn manager(
        explicit: Option<ApiKey>,
        environment: Arc<dyn Environment>,
        backend: Arc<dyn CredentialBackend>,
    ) -> CredentialManager {
        CredentialManager {
            explicit,
            environment,
            backend,
            state_root: PathBuf::from("/unused"),
        }
    }

    fn manager_at(
        state_root: PathBuf,
        environment: Arc<dyn Environment>,
        backend: Arc<dyn CredentialBackend>,
    ) -> CredentialManager {
        CredentialManager {
            explicit: None,
            environment,
            backend,
            state_root,
        }
    }

    #[test]
    fn read_entry_setup_failure_uses_the_frozen_read_diagnostic() {
        let error = classify_read_entry::<(), _>(Err("backend unavailable")).unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::CredentialReadFailed);
        assert_eq!(error.message(), "credential read failed");
    }

    fn write_then_report_post_commit_failure(
        state: &StateRoot,
        root: &Map<String, Value>,
    ) -> Result<(), (KrxError, bool)> {
        write_config(state, root).unwrap();
        Err((
            KrxError::new(
                KrxErrorCode::MigrationFailed,
                "injected post-commit sync failure",
            ),
            true,
        ))
    }

    fn report_pre_commit_failure(
        _state: &StateRoot,
        _root: &Map<String, Value>,
    ) -> Result<(), (KrxError, bool)> {
        Err((
            KrxError::new(KrxErrorCode::MigrationFailed, "injected pre-commit failure"),
            false,
        ))
    }

    #[tokio::test]
    async fn resolves_exact_precedence_without_lower_source_reads() {
        let backend = Arc::new(FakeBackend::with_secret(Some("persisted")));
        let explicit = manager(
            Some(ApiKey::parse("explicit").unwrap()),
            Arc::new(FakeEnvironment::value(Some("environment"))),
            backend.clone(),
        );
        assert_eq!(
            explicit.status().await.unwrap(),
            CredentialStatus {
                source: CredentialSource::Explicit,
                persisted: false,
            }
        );
        assert_eq!(*backend.gets.lock().unwrap(), 0);

        let environment = manager(
            None,
            Arc::new(FakeEnvironment::value(Some(" environment "))),
            backend.clone(),
        );
        let resolved = environment.resolve_required().await.unwrap();
        assert_eq!(resolved.source, CredentialSource::Environment);
        assert_eq!(resolved.api_key.expose(), "environment");
        assert_eq!(*backend.gets.lock().unwrap(), 0);

        let persisted = manager(
            None,
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        );
        assert_eq!(
            persisted.status().await.unwrap(),
            CredentialStatus {
                source: CredentialSource::Keychain,
                persisted: true,
            }
        );
        assert_eq!(*backend.gets.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn invalid_present_sources_do_not_fall_through() {
        let backend = Arc::new(FakeBackend::with_secret(Some("persisted")));
        let invalid_environment = manager(
            None,
            Arc::new(FakeEnvironment::value(Some("   "))),
            backend.clone(),
        );
        assert_eq!(
            invalid_environment.status().await.unwrap_err().code(),
            KrxErrorCode::InvalidArgument
        );
        assert_eq!(*backend.gets.lock().unwrap(), 0);

        let invalid_keychain = manager(
            None,
            Arc::new(FakeEnvironment::value(None)),
            Arc::new(FakeBackend::with_secret(Some(""))),
        );
        assert_eq!(
            invalid_keychain.status().await.unwrap_err().code(),
            KrxErrorCode::CredentialReadFailed
        );
    }

    #[tokio::test]
    async fn verifies_set_and_removes_only_the_persisted_item() {
        let root = TestRoot::new();
        let backend = Arc::new(FakeBackend::default());
        let manager = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(Some("active-environment"))),
            backend.clone(),
        );
        manager
            .set(ApiKey::parse(" stored ").unwrap())
            .await
            .unwrap();
        assert_eq!(backend.secret.lock().unwrap().as_deref(), Some("stored"));
        assert_eq!(*backend.sets.lock().unwrap(), 1);
        assert_eq!(*backend.gets.lock().unwrap(), 1);
        assert!(manager.remove().await.unwrap());
        assert!(!manager.remove().await.unwrap());
        assert_eq!(*backend.removes.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn rerunning_set_with_the_same_secret_still_clears_approval_state() {
        let root = TestRoot::new();
        root.write_fixture("approval-v1.json");
        let backend = Arc::new(FakeBackend::with_secret(Some("fixture-key")));
        manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        )
        .set(ApiKey::parse("fixture-key").unwrap())
        .await
        .unwrap();
        assert_eq!(*backend.sets.lock().unwrap(), 1);
        assert_eq!(root.config()["serviceStatus"], serde_json::json!({}));
    }

    #[tokio::test]
    async fn failed_set_verification_never_recreates_the_previous_item() {
        let verification_failures = [
            Ok(None),
            Ok(Some("mismatched".to_owned())),
            Err(KrxError::new(
                KrxErrorCode::CredentialReadFailed,
                "injected read failure",
            )),
        ];
        for failure in verification_failures {
            let root = TestRoot::new();
            let backend = Arc::new(FakeBackend::with_get_results(Some("previous"), [failure]));
            let error = manager_at(
                root.state.clone(),
                Arc::new(FakeEnvironment::value(None)),
                backend.clone(),
            )
            .set(ApiKey::parse("replacement").unwrap())
            .await
            .unwrap_err();
            assert!(matches!(
                error.code(),
                KrxErrorCode::CredentialVerifyFailed | KrxErrorCode::CredentialReadFailed
            ));
            assert_eq!(
                backend.secret.lock().unwrap().as_deref(),
                Some("replacement")
            );
            assert_eq!(*backend.sets.lock().unwrap(), 1);
        }
    }

    #[tokio::test]
    async fn partial_set_failure_with_exact_readback_is_reconciled() {
        for previous in [Some("previous"), None] {
            let root = TestRoot::new();
            let backend = Arc::new(FakeBackend::with_secret_and_partial_set_error(
                previous,
                KrxError::new(
                    KrxErrorCode::CredentialWriteFailed,
                    "injected partial write failure",
                ),
            ));
            manager_at(
                root.state.clone(),
                Arc::new(FakeEnvironment::value(None)),
                backend.clone(),
            )
            .set(ApiKey::parse("replacement").unwrap())
            .await
            .unwrap();
            assert_eq!(
                backend.secret.lock().unwrap().as_deref(),
                Some("replacement")
            );
            assert_eq!(*backend.sets.lock().unwrap(), 1);
            assert_eq!(*backend.gets.lock().unwrap(), 1);
        }
    }

    #[tokio::test]
    async fn credential_sets_serialize() {
        let root = TestRoot::new();
        let (backend, paused, resume) = PausingBackend::new("previous", "replacement");
        let backend = Arc::new(backend);
        let manager = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        );
        let first_manager = manager.clone();
        let first = tokio::spawn(async move {
            first_manager
                .set(ApiKey::parse("replacement").unwrap())
                .await
        });
        tokio::task::spawn_blocking(move || {
            paused
                .recv_timeout(Duration::from_secs(10))
                .expect("credential operation did not reach the backend")
        })
        .await
        .unwrap();

        let second_manager = manager.clone();
        let mut second =
            tokio::spawn(async move { second_manager.set(ApiKey::parse("newer").unwrap()).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut second)
                .await
                .is_err(),
            "second credential set escaped the shared lock"
        );
        resume.send(()).unwrap();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(backend.secret.lock().unwrap().as_deref(), Some("newer"));
    }

    #[tokio::test]
    async fn remove_is_keychain_only_and_concurrent_removal_wins() {
        let untouched = TestRoot::new();
        let untouched_backend = Arc::new(FakeBackend::with_secret(Some("persisted")));
        assert!(
            manager_at(
                untouched.state.clone(),
                Arc::new(FakeEnvironment::value(None)),
                untouched_backend,
            )
            .remove()
            .await
            .unwrap()
        );
        assert!(!untouched.state.exists());

        let root = TestRoot::new();
        let (backend, paused, resume) = PausingBackend::new("previous", "replacement");
        let backend = Arc::new(backend);
        let manager = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        );
        let first_manager = manager.clone();
        let first = tokio::spawn(async move {
            first_manager
                .set(ApiKey::parse("replacement").unwrap())
                .await
        });
        tokio::task::spawn_blocking(move || {
            paused
                .recv_timeout(Duration::from_secs(10))
                .expect("credential operation did not reach the backend")
        })
        .await
        .unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(100), manager.remove())
                .await
                .expect("keychain-only removal must not wait for the config lock")
                .unwrap()
        );
        resume.send(()).unwrap();
        let error = first.await.unwrap().unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::CredentialVerifyFailed);
        assert!(backend.secret.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn migrates_legacy_secret_and_drops_unbound_approvals() {
        let root = TestRoot::new();
        root.write_fixture("legacy-config-v0.json");
        let backend = Arc::new(FakeBackend::default());
        let manager = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        );
        assert_eq!(
            manager.migrate_legacy().await.unwrap(),
            CredentialMigrationResult {
                migrated: true,
                legacy_secret_removed: true,
                approvals_migrated: 0,
            }
        );
        assert_eq!(
            backend.secret.lock().unwrap().as_deref(),
            Some("fixture-key")
        );
        assert_eq!(*backend.sets.lock().unwrap(), 1);
        let config = root.config();
        assert!(config.get("apiKey").is_none());
        assert_eq!(config["version"], 1);
        assert_eq!(config["serviceStatus"], serde_json::json!({}));
        assert_eq!(config["preservedUnknown"]["owner"], "legacy");
    }

    #[tokio::test]
    async fn migration_reuses_same_keychain_and_rejects_conflicts_without_writes() {
        let same_root = TestRoot::new();
        same_root.write_fixture("legacy-config-v0.json");
        let same_backend = Arc::new(FakeBackend::with_secret(Some("fixture-key")));
        manager_at(
            same_root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            same_backend.clone(),
        )
        .migrate_legacy()
        .await
        .unwrap();
        assert_eq!(*same_backend.sets.lock().unwrap(), 0);

        for existing in ["different-fixture-key", ""] {
            let root = TestRoot::new();
            root.write_fixture("legacy-config-v0.json");
            let before = fs::read(root.state.join(CONFIG_PATH)).unwrap();
            let backend = Arc::new(FakeBackend::with_secret(Some(existing)));
            let error = manager_at(
                root.state.clone(),
                Arc::new(FakeEnvironment::value(None)),
                backend.clone(),
            )
            .migrate_legacy()
            .await
            .unwrap_err();
            assert_eq!(
                error.code(),
                if existing.is_empty() {
                    KrxErrorCode::CredentialReadFailed
                } else {
                    KrxErrorCode::MigrationConflict
                }
            );
            assert_eq!(*backend.sets.lock().unwrap(), 0);
            assert_eq!(fs::read(root.state.join(CONFIG_PATH)).unwrap(), before);
        }
    }

    #[tokio::test]
    async fn invalid_legacy_secret_precedes_all_keychain_access_and_preserves_bytes() {
        const INVALID: &[u8] = b"{\"version\":0,\"apiKey\":\"   \",\"serviceStatus\":null}\n";
        for existing in [None, Some("conflicting-key")] {
            let root = TestRoot::new();
            root.write_config_bytes(INVALID);
            let backend = Arc::new(FakeBackend::with_secret(existing));
            let error = manager_at(
                root.state.clone(),
                Arc::new(FakeEnvironment::value(None)),
                backend.clone(),
            )
            .migrate_legacy()
            .await
            .unwrap_err();

            assert_eq!(error.code(), KrxErrorCode::LegacyStateInvalid);
            assert_eq!(*backend.gets.lock().unwrap(), 0);
            assert_eq!(*backend.sets.lock().unwrap(), 0);
            assert_eq!(*backend.removes.lock().unwrap(), 0);
            assert_eq!(fs::read(root.state.join(CONFIG_PATH)).unwrap(), INVALID);
        }
    }

    #[tokio::test]
    async fn migration_rerun_after_keychain_write_completes_from_original_bytes() {
        let root = TestRoot::new();
        root.write_fixture("legacy-config-v0.json");
        let original = fs::read(root.state.join(CONFIG_PATH)).unwrap();
        let backend = Arc::new(FakeBackend::with_secret(Some("fixture-key")));

        // This is the durable state left by a crash after the keychain write
        // but before the atomic configuration replacement.
        assert_eq!(fs::read(root.state.join(CONFIG_PATH)).unwrap(), original);
        let result = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        )
        .migrate_legacy()
        .await
        .unwrap();

        assert!(result.migrated);
        assert!(result.legacy_secret_removed);
        assert_eq!(*backend.sets.lock().unwrap(), 0);
        assert_eq!(
            backend.secret.lock().unwrap().as_deref(),
            Some("fixture-key")
        );
        assert!(root.config().get("apiKey").is_none());
    }

    #[tokio::test]
    async fn partial_keychain_set_failure_rolls_back_and_preserves_config_bytes() {
        let root = TestRoot::new();
        root.write_fixture("legacy-config-v0.json");
        let original = fs::read(root.state.join(CONFIG_PATH)).unwrap();
        let backend = Arc::new(FakeBackend::with_partial_set_error(KrxError::new(
            KrxErrorCode::CredentialWriteFailed,
            "injected partial write failure",
        )));

        let error = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        )
        .migrate_legacy()
        .await
        .unwrap_err();

        assert_eq!(error.code(), KrxErrorCode::CredentialWriteFailed);
        assert!(backend.secret.lock().unwrap().is_none());
        assert_eq!(*backend.removes.lock().unwrap(), 1);
        assert_eq!(fs::read(root.state.join(CONFIG_PATH)).unwrap(), original);
    }

    #[test]
    fn post_commit_migration_failure_preserves_the_only_credential() {
        let root = TestRoot::new();
        root.write_fixture("legacy-config-v0.json");
        let backend = FakeBackend::default();

        let error = migrate_legacy_blocking_with_writer(
            &backend,
            &StateRoot::new(root.state.clone()).unwrap(),
            write_then_report_post_commit_failure,
        )
        .unwrap_err();

        assert_eq!(error.code(), KrxErrorCode::MigrationFailed);
        assert_eq!(
            backend.secret.lock().unwrap().as_deref(),
            Some("fixture-key")
        );
        assert_eq!(*backend.removes.lock().unwrap(), 0);
        assert!(root.config().get("apiKey").is_none());
    }

    #[test]
    fn pre_commit_migration_failure_rolls_back_and_preserves_exact_config() {
        let root = TestRoot::new();
        root.write_fixture("legacy-config-v0.json");
        let original = fs::read(root.state.join(CONFIG_PATH)).unwrap();
        let backend = FakeBackend::default();

        let error = migrate_legacy_blocking_with_writer(
            &backend,
            &StateRoot::new(root.state.clone()).unwrap(),
            report_pre_commit_failure,
        )
        .unwrap_err();

        assert_eq!(error.code(), KrxErrorCode::MigrationFailed);
        assert!(backend.secret.lock().unwrap().is_none());
        assert_eq!(*backend.removes.lock().unwrap(), 1);
        assert_eq!(fs::read(root.state.join(CONFIG_PATH)).unwrap(), original);
    }

    #[tokio::test]
    async fn invalid_legacy_state_fails_before_keychain_inspection() {
        let root = TestRoot::new();
        root.write_fixture("legacy-config-invalid-with-secret-v0.json");
        let before = fs::read(root.state.join(CONFIG_PATH)).unwrap();
        let backend = Arc::new(FakeBackend::with_secret(Some("conflicting")));
        let error = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        )
        .migrate_legacy()
        .await
        .unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::LegacyStateInvalid);
        assert_eq!(*backend.gets.lock().unwrap(), 0);
        assert_eq!(fs::read(root.state.join(CONFIG_PATH)).unwrap(), before);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unsafe_legacy_root_is_rejected_without_permission_repair() {
        use std::os::unix::fs::PermissionsExt as _;

        let root = TestRoot::new();
        root.write_fixture("legacy-config-v0.json");
        fs::set_permissions(&root.state, fs::Permissions::from_mode(0o755)).unwrap();
        let backend = Arc::new(FakeBackend::with_secret(Some("conflicting")));

        let error = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        )
        .migrate_legacy()
        .await
        .unwrap_err();

        assert_eq!(error.code(), KrxErrorCode::LegacyStateInvalid);
        assert_eq!(*backend.gets.lock().unwrap(), 0);
        assert_eq!(
            fs::metadata(&root.state).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[tokio::test]
    async fn explicit_migration_preserves_bound_approval_rows() {
        let root = TestRoot::new();
        root.write_fixture("approval-bound-v0.json");
        let backend = Arc::new(FakeBackend::default());
        let result = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        )
        .migrate_legacy()
        .await
        .unwrap();
        assert_eq!(
            result,
            CredentialMigrationResult {
                migrated: false,
                legacy_secret_removed: false,
                approvals_migrated: 1,
            }
        );
        assert_eq!(*backend.gets.lock().unwrap(), 0);
        assert_eq!(root.config()["serviceStatus"]["stock"]["state"], "approved");
    }

    #[tokio::test]
    async fn failed_approval_clear_does_not_touch_the_keychain() {
        let root = TestRoot::new();
        root.write_fixture("legacy-config-v0.json");
        let backend = Arc::new(FakeBackend::with_secret(Some("previous")));
        let error = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        )
        .set(ApiKey::parse("replacement").unwrap())
        .await
        .unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::LegacyStateInvalid);
        assert_eq!(backend.secret.lock().unwrap().as_deref(), Some("previous"));
        assert_eq!(*backend.sets.lock().unwrap(), 0);
        assert_eq!(*backend.gets.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn failed_clear_never_reinstalls_a_removed_credential() {
        let root = TestRoot::new();
        root.write_fixture("approval-invalid-ttl-v1.json");
        let backend = Arc::new(FakeBackend::default());
        let error = manager_at(
            root.state.clone(),
            Arc::new(FakeEnvironment::value(None)),
            backend.clone(),
        )
        .set(ApiKey::parse("fixture-key").unwrap())
        .await
        .unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::LegacyStateInvalid);
        assert!(backend.secret.lock().unwrap().is_none());
        assert_eq!(*backend.sets.lock().unwrap(), 0);
        assert_eq!(*backend.gets.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn missing_required_credential_is_typed() {
        let manager = manager(
            None,
            Arc::new(FakeEnvironment::value(None)),
            Arc::new(FakeBackend::default()),
        );
        assert_eq!(
            manager.resolve_required().await.unwrap_err().code(),
            KrxErrorCode::CredentialMissing
        );
    }

    #[test]
    fn exact_fingerprint_matches_the_frozen_fixture() {
        assert_eq!(
            credential_fingerprint(&ApiKey::parse("fixture-key").unwrap()),
            "66e7c82b49bb291dd09c8e020448311c4a7bb96aeb5c5db769f66812b13a50b5"
        );
    }

    #[test]
    fn generated_local_state_contract_is_complete() {
        assert_eq!(KEYRING_SERVICE, "krx-cli");
        assert_eq!(KEYRING_ACCOUNT, "default");
        assert_eq!(CREDENTIAL_ENVIRONMENT, "KRX_API_KEY");
        assert_eq!(APPROVAL_TTL_SECONDS, 900);
        assert_eq!(CACHE_ENTRY_READ_BYTES, 64 * 1024 * 1024);
        assert_eq!(CACHE_FUTURE_SKEW_SECONDS, 5 * 60);
        assert_eq!(CACHE_LEASE_OWNER_DEAD_MS, 30_000);
        assert_eq!(CACHE_LEASE_ABSOLUTE_AGE_MS, 60_000);
        assert_eq!(APPROVAL_PROBES.len(), 7);
        let native = CredentialManager::native(PathBuf::from("/native-state"), None);
        assert_eq!(native.state_root(), &PathBuf::from("/native-state"));
    }
}
