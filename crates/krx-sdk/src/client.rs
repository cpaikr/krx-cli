use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use crate::cache::{
    CACHE_LEASE_POLL, CacheHit, CacheKey, CacheRead, CacheRefreshLease, CacheStore, CacheVersion,
};
use crate::credential::CredentialManager;
use crate::operation::{DEFAULT_CACHE_MAX_AGE_HOURS, DEFAULT_RETRIES, OVERALL_TIMEOUT_MS};
use crate::state::StateRoot;
use crate::transport::DirectTransport;
use crate::{
    ApiKey, CachePolicy, DirectRequest, Freshness, KrxError, KrxErrorCode, QueryResult,
    ResultProvenance, ResultSource, Row,
};

type TransportFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<Row>, KrxError>> + Send + 'a>>;

pub(crate) trait ClientTransport: Send + Sync + 'static {
    fn execute_until<'a>(
        &'a self,
        request: &'a DirectRequest,
        api_key: &'a ApiKey,
        deadline: Instant,
    ) -> TransportFuture<'a>;
}

impl ClientTransport for DirectTransport {
    fn execute_until<'a>(
        &'a self,
        request: &'a DirectRequest,
        api_key: &'a ApiKey,
        deadline: Instant,
    ) -> TransportFuture<'a> {
        Box::pin(DirectTransport::execute_until(
            self, request, api_key, deadline,
        ))
    }
}

pub(crate) struct DirectQueryClient<T = DirectTransport> {
    credentials: CredentialManager,
    cache: CacheStore,
    transport: Arc<T>,
    #[cfg(test)]
    after_refresh_baseline: Option<RefreshBaselinePause>,
}

#[cfg(test)]
#[derive(Clone)]
struct RefreshBaselinePause {
    reached: Arc<tokio::sync::Barrier>,
    resume: Arc<tokio::sync::Barrier>,
}

impl DirectQueryClient<DirectTransport> {
    pub(crate) fn native(state_root: PathBuf, explicit: Option<ApiKey>) -> Result<Self, KrxError> {
        Ok(Self {
            credentials: CredentialManager::native(state_root.clone(), explicit),
            cache: CacheStore::new(StateRoot::new(state_root.clone())?),
            transport: Arc::new(DirectTransport::new(state_root)?),
            #[cfg(test)]
            after_refresh_baseline: None,
        })
    }
}

impl<T> DirectQueryClient<T>
where
    T: ClientTransport,
{
    #[cfg(test)]
    fn with_transport(state_root: PathBuf, explicit: Option<ApiKey>, transport: T) -> Self {
        Self {
            credentials: CredentialManager::native(state_root.clone(), explicit),
            cache: CacheStore::new(StateRoot::new(state_root).expect("test state root")),
            transport: Arc::new(transport),
            after_refresh_baseline: None,
        }
    }

    #[cfg(test)]
    fn with_refresh_baseline_pause(mut self, pause: RefreshBaselinePause) -> Self {
        self.after_refresh_baseline = Some(pause);
        self
    }

    pub(crate) async fn query(&self, request: DirectRequest) -> Result<QueryResult, KrxError> {
        validate_request(&request)?;
        let deadline = Instant::now() + Duration::from_millis(OVERALL_TIMEOUT_MS);
        check_request_budget(&request, deadline)?;
        let key = self.cache.key(request.operation, request.date.clone())?;

        match request.options.cache.clone() {
            CachePolicy::Offline => self.offline_query(&request, &key, deadline).await,
            CachePolicy::Bypass => self.network_query(&request, None, deadline).await,
            CachePolicy::Prefer { max_age } => {
                let initial = self.probe_cache(&key, max_age, &request, deadline).await?;
                if let CacheRead::Hit(hit) = &initial
                    && hit.freshness() == Freshness::Fresh
                    && (hit.version() == CacheVersion::V1
                        || self.legacy_entry_present(&key, &request, deadline).await?)
                {
                    return self
                        .coordinated_query(
                            &request,
                            &key,
                            Coordination::Prefer { max_age },
                            Some(initial_hit(initial)),
                            deadline,
                        )
                        .await;
                }
                if let CacheRead::Hit(hit) = initial
                    && hit.freshness() == Freshness::Fresh
                {
                    return Ok(hit.result);
                }
                self.coordinated_query(
                    &request,
                    &key,
                    Coordination::Prefer { max_age },
                    None,
                    deadline,
                )
                .await
            }
            CachePolicy::Refresh => {
                let baseline = match self
                    .probe_cache(&key, default_cache_age(), &request, deadline)
                    .await?
                {
                    CacheRead::Hit(hit) => Some(hit),
                    CacheRead::Miss | CacheRead::Invalid => None,
                };
                #[cfg(test)]
                if let Some(pause) = &self.after_refresh_baseline {
                    pause.reached.wait().await;
                    pause.resume.wait().await;
                }
                self.coordinated_query(&request, &key, Coordination::Refresh, baseline, deadline)
                    .await
            }
        }
    }

    async fn offline_query(
        &self,
        request: &DirectRequest,
        key: &CacheKey,
        deadline: Instant,
    ) -> Result<QueryResult, KrxError> {
        match self
            .read_cache(key, default_cache_age(), request, deadline, None)
            .await?
        {
            CacheRead::Hit(hit) => Ok(hit.result),
            CacheRead::Miss => Err(KrxError::new(
                KrxErrorCode::CacheMiss,
                "offline cache entry is absent",
            )
            .for_operation(request.operation)),
            CacheRead::Invalid => Err(KrxError::new(
                KrxErrorCode::CacheInvalid,
                "offline cache entry is invalid",
            )
            .for_operation(request.operation)),
        }
    }

    async fn coordinated_query(
        &self,
        request: &DirectRequest,
        key: &CacheKey,
        coordination: Coordination,
        baseline: Option<Box<CacheHit>>,
        deadline: Instant,
    ) -> Result<QueryResult, KrxError> {
        let flight = self
            .cache
            .acquire_flight(key, &request.options.cancellation, deadline)
            .await?;
        check_request_budget(request, deadline)?;
        if let Some(result) = flight.shared_network_result() {
            return Ok(result);
        }
        flight.clear_network_result();
        loop {
            check_request_budget(request, deadline)?;
            if let Some(lease) = self
                .await_until(request, deadline, self.cache.try_acquire_refresh_lease(key))
                .await??
            {
                let lease = Arc::new(lease);
                let current = self
                    .read_cache(
                        key,
                        coordination.max_age(),
                        request,
                        deadline,
                        Some(Arc::clone(&lease)),
                    )
                    .await?;
                if let CacheRead::Hit(hit) = current
                    && coordination.accepts(&hit, baseline.as_deref())
                {
                    return self
                        .finish_cache_hit(key, *hit, request, deadline, lease)
                        .await;
                }
                return self
                    .network_query(request, Some((key, lease)), deadline)
                    .await
                    .inspect(|result| flight.publish_network_result(result.clone()));
            }

            let current = self
                .probe_cache(key, coordination.max_age(), request, deadline)
                .await?;
            if let CacheRead::Hit(hit) = current
                && coordination.accepts_without_lease(&hit, baseline.as_deref())
            {
                return Ok(hit.result);
            }
            self.sleep_until(request, deadline, CACHE_LEASE_POLL)
                .await?;
        }
    }

    async fn finish_cache_hit(
        &self,
        key: &CacheKey,
        hit: CacheHit,
        request: &DirectRequest,
        deadline: Instant,
        lease: Arc<CacheRefreshLease>,
    ) -> Result<QueryResult, KrxError> {
        let result = hit.result.clone();
        match hit.version() {
            CacheVersion::V1 => {
                let cache = self.cache.clone();
                let key = key.clone();
                let operation = key.operation;
                let lease = Arc::clone(&lease);
                self.await_until(request, deadline, async move {
                    tokio::task::spawn_blocking(move || {
                        let _lease = lease;
                        cache.promote_v1(&key, &hit, SystemTime::now())
                    })
                    .await
                    .map_err(|_| {
                        KrxError::new(
                            KrxErrorCode::CacheWriteFailed,
                            "cache promotion task failed",
                        )
                        .for_operation(operation)
                    })?
                })
                .await??;
            }
            CacheVersion::V2 => {
                if let CacheRead::Hit(legacy) = self
                    .read_legacy(
                        key,
                        default_cache_age(),
                        request,
                        deadline,
                        Arc::clone(&lease),
                    )
                    .await?
                {
                    let cache = self.cache.clone();
                    let key = key.clone();
                    let operation = key.operation;
                    let lease = Arc::clone(&lease);
                    self.await_until(request, deadline, async move {
                        tokio::task::spawn_blocking(move || {
                            let _lease = lease;
                            cache.remove_legacy(&key, &legacy)
                        })
                        .await
                        .map_err(|_| {
                            KrxError::new(
                                KrxErrorCode::CacheWriteFailed,
                                "legacy cache cleanup task failed",
                            )
                            .for_operation(operation)
                        })?
                    })
                    .await??;
                }
            }
        }
        Ok(result)
    }

    async fn network_query(
        &self,
        request: &DirectRequest,
        cache_write: Option<(&CacheKey, Arc<CacheRefreshLease>)>,
        deadline: Instant,
    ) -> Result<QueryResult, KrxError> {
        let credential = self
            .await_until(request, deadline, self.credentials.resolve_required())
            .await?
            .map_err(|error| error.for_operation(request.operation))?;
        let rows = self
            .await_until(
                request,
                deadline,
                self.transport
                    .execute_until(request, &credential.api_key, deadline),
            )
            .await?
            .map_err(|error| error.for_operation(request.operation))?;
        let fetched_at = SystemTime::now();
        if let Some((key, lease)) = cache_write {
            let cache = self.cache.clone();
            let key = key.clone();
            let operation = key.operation;
            let cache_rows = rows.clone();
            self.await_until(request, deadline, async move {
                tokio::task::spawn_blocking(move || {
                    let _lease = lease;
                    cache.write_v2_after_refresh(&key, &cache_rows, fetched_at, SystemTime::now())
                })
                .await
                .map_err(|_| {
                    KrxError::new(KrxErrorCode::CacheWriteFailed, "cache write task failed")
                        .for_operation(operation)
                })?
            })
            .await??;
        }
        Ok(QueryResult {
            rows,
            provenance: ResultProvenance {
                source: ResultSource::Network,
                fetched_at,
                freshness: Freshness::Fresh,
                contract_id: crate::operation::operation_spec(request.operation)
                    .contract_id
                    .to_owned(),
            },
        })
    }

    async fn read_cache(
        &self,
        key: &CacheKey,
        max_age: Duration,
        request: &DirectRequest,
        deadline: Instant,
        lease: Option<Arc<CacheRefreshLease>>,
    ) -> Result<CacheRead, KrxError> {
        let cache = self.cache.clone();
        let key = key.clone();
        let operation = key.operation;
        self.await_until(request, deadline, async move {
            tokio::task::spawn_blocking(move || {
                let _lease = lease;
                cache.read(&key, max_age, SystemTime::now())
            })
            .await
            .map_err(|_| {
                KrxError::new(KrxErrorCode::CacheReadFailed, "cache read task failed")
                    .for_operation(operation)
            })?
        })
        .await?
    }

    async fn probe_cache(
        &self,
        key: &CacheKey,
        max_age: Duration,
        request: &DirectRequest,
        deadline: Instant,
    ) -> Result<CacheRead, KrxError> {
        let cache = self.cache.clone();
        let key = key.clone();
        let operation = key.operation;
        self.await_until(request, deadline, async move {
            tokio::task::spawn_blocking(move || cache.probe(&key, max_age, SystemTime::now()))
                .await
                .map_err(|_| {
                    KrxError::new(KrxErrorCode::CacheReadFailed, "cache probe task failed")
                        .for_operation(operation)
                })?
        })
        .await?
    }

    async fn read_legacy(
        &self,
        key: &CacheKey,
        max_age: Duration,
        request: &DirectRequest,
        deadline: Instant,
        lease: Arc<CacheRefreshLease>,
    ) -> Result<CacheRead, KrxError> {
        let cache = self.cache.clone();
        let key = key.clone();
        let operation = key.operation;
        self.await_until(request, deadline, async move {
            tokio::task::spawn_blocking(move || {
                let _lease = lease;
                cache.read_legacy(&key, max_age, SystemTime::now())
            })
            .await
            .map_err(|_| {
                KrxError::new(
                    KrxErrorCode::CacheReadFailed,
                    "legacy cache read task failed",
                )
                .for_operation(operation)
            })?
        })
        .await?
    }

    async fn legacy_entry_present(
        &self,
        key: &CacheKey,
        request: &DirectRequest,
        deadline: Instant,
    ) -> Result<bool, KrxError> {
        let cache = self.cache.clone();
        let key = key.clone();
        let operation = key.operation;
        self.await_until(request, deadline, async move {
            tokio::task::spawn_blocking(move || cache.legacy_entry_present(&key))
                .await
                .map_err(|_| {
                    KrxError::new(
                        KrxErrorCode::CacheReadFailed,
                        "legacy cache probe task failed",
                    )
                    .for_operation(operation)
                })?
        })
        .await?
    }

    async fn await_until<F, O>(
        &self,
        request: &DirectRequest,
        deadline: Instant,
        future: F,
    ) -> Result<O, KrxError>
    where
        F: Future<Output = O>,
    {
        let remaining = deadline.saturating_duration_since(Instant::now());
        tokio::select! {
            biased;
            _ = request.options.cancellation.cancelled() => {
                Err(cancelled(request))
            }
            _ = tokio::time::sleep(remaining) => {
                Err(deadline_error(request))
            }
            output = future => Ok(output),
        }
    }

    async fn sleep_until(
        &self,
        request: &DirectRequest,
        deadline: Instant,
        duration: Duration,
    ) -> Result<(), KrxError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let duration = duration.min(remaining);
        tokio::select! {
            biased;
            _ = request.options.cancellation.cancelled() => Err(cancelled(request)),
            _ = tokio::time::sleep(duration) => {
                check_request_budget(request, deadline)
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Coordination {
    Prefer { max_age: Duration },
    Refresh,
}

impl Coordination {
    fn max_age(self) -> Duration {
        match self {
            Self::Prefer { max_age } => max_age,
            Self::Refresh => default_cache_age(),
        }
    }

    fn accepts(self, hit: &CacheHit, baseline: Option<&CacheHit>) -> bool {
        match self {
            Self::Prefer { .. } => hit.freshness() == Freshness::Fresh,
            Self::Refresh => {
                hit.version() == CacheVersion::V2
                    && baseline.is_none_or(|baseline| !hit.same_refresh_generation(baseline))
            }
        }
    }

    fn accepts_without_lease(self, hit: &CacheHit, baseline: Option<&CacheHit>) -> bool {
        match self {
            Self::Prefer { .. } => {
                hit.version() == CacheVersion::V2 && hit.freshness() == Freshness::Fresh
            }
            Self::Refresh => self.accepts(hit, baseline),
        }
    }
}

fn initial_hit(read: CacheRead) -> Box<CacheHit> {
    match read {
        CacheRead::Hit(hit) => hit,
        CacheRead::Miss | CacheRead::Invalid => unreachable!("caller checked cache hit"),
    }
}

fn validate_request(request: &DirectRequest) -> Result<(), KrxError> {
    if request.options.retries > DEFAULT_RETRIES {
        return Err(KrxError::new(
            KrxErrorCode::InvalidArgument,
            "retry count must be between zero and three",
        )
        .for_operation(request.operation));
    }
    Ok(())
}

fn check_request_budget(request: &DirectRequest, deadline: Instant) -> Result<(), KrxError> {
    if request.options.cancellation.is_cancelled() {
        return Err(cancelled(request));
    }
    if Instant::now() >= deadline {
        return Err(deadline_error(request));
    }
    Ok(())
}

fn cancelled(request: &DirectRequest) -> KrxError {
    KrxError::new(KrxErrorCode::RequestCancelled, "request was cancelled")
        .for_operation(request.operation)
}

fn deadline_error(request: &DirectRequest) -> KrxError {
    if request.options.cancellation.is_cancelled() {
        cancelled(request)
    } else {
        KrxError::new(
            KrxErrorCode::DeadlineExceeded,
            "request exceeded its overall deadline",
        )
        .for_operation(request.operation)
    }
}

fn default_cache_age() -> Duration {
    Duration::from_secs(DEFAULT_CACHE_MAX_AGE_HOURS * 60 * 60)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::{CallOptions, OperationId, TradingDate};

    #[derive(Clone)]
    struct MockTransport {
        calls: Arc<AtomicUsize>,
        delay: Duration,
        rows: Vec<Row>,
        failure: Option<KrxErrorCode>,
    }

    impl ClientTransport for MockTransport {
        fn execute_until<'a>(
            &'a self,
            _request: &'a DirectRequest,
            _api_key: &'a ApiKey,
            _deadline: Instant,
        ) -> TransportFuture<'a> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(self.delay).await;
                if let Some(code) = self.failure {
                    return Err(KrxError::new(code, "injected transport failure"));
                }
                Ok(self.rows.clone())
            })
        }
    }

    struct Fixture {
        parent: PathBuf,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let parent = std::env::current_dir()
                .unwrap()
                .join("target/client-tests")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&parent).unwrap();
            let root = parent.join(".krx-cli");
            Self { parent, root }
        }

        fn client(&self, transport: MockTransport) -> DirectQueryClient<MockTransport> {
            DirectQueryClient::with_transport(
                self.root.clone(),
                Some(ApiKey::parse("test-placeholder").unwrap()),
                transport,
            )
        }

        fn paused_refresh_client(
            &self,
            transport: MockTransport,
        ) -> (DirectQueryClient<MockTransport>, RefreshBaselinePause) {
            let pause = RefreshBaselinePause {
                reached: Arc::new(tokio::sync::Barrier::new(2)),
                resume: Arc::new(tokio::sync::Barrier::new(2)),
            };
            (
                self.client(transport)
                    .with_refresh_baseline_pause(pause.clone()),
                pause,
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.parent).unwrap();
        }
    }

    fn row(operation: OperationId) -> Row {
        let fields = crate::operation::operation_spec(operation).response_fields;
        Row::new(
            fields
                .iter()
                .map(|field| (field.name.to_owned(), "1".to_owned()))
                .collect::<BTreeMap<_, _>>(),
        )
    }

    fn request(policy: CachePolicy) -> DirectRequest {
        DirectRequest {
            operation: OperationId::StockStkByddTrd,
            date: TradingDate::parse("20260102").unwrap(),
            options: CallOptions {
                cache: policy,
                retries: 0,
                cancellation: crate::Cancellation::new(),
            },
        }
    }

    fn mock(delay: Duration) -> MockTransport {
        MockTransport {
            calls: Arc::new(AtomicUsize::new(0)),
            delay,
            rows: vec![row(OperationId::StockStkByddTrd)],
            failure: None,
        }
    }

    fn failing_mock() -> MockTransport {
        MockTransport {
            failure: Some(KrxErrorCode::RequestFailed),
            ..mock(Duration::ZERO)
        }
    }

    fn write_v1(fixture: &Fixture, request: &DirectRequest, fetched_at: &str) -> CacheKey {
        let cache = CacheStore::new(StateRoot::new(fixture.root.clone()).unwrap());
        let key = cache.key(request.operation, request.date.clone()).unwrap();
        let spec = crate::operation::operation_spec(request.operation);
        let entry = json!({
            "version": 1,
            "fetchedAt": fetched_at,
            "endpoint": spec.path,
            "params": [[spec.request_field, request.date.as_str()]],
            "data": [row(request.operation).iter().collect::<BTreeMap<_, _>>()],
        });
        StateRoot::new(fixture.root.clone())
            .unwrap()
            .atomic_write(
                key.legacy_path(),
                &serde_json::to_vec(&entry).unwrap(),
                KrxErrorCode::CacheWriteFailed,
            )
            .unwrap();
        key
    }

    fn write_v2(fixture: &Fixture, request: &DirectRequest) -> CacheKey {
        let cache = CacheStore::new(StateRoot::new(fixture.root.clone()).unwrap());
        let key = cache.key(request.operation, request.date.clone()).unwrap();
        cache
            .write_v2(
                &key,
                &[row(request.operation)],
                SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60),
                SystemTime::now(),
            )
            .unwrap();
        key
    }

    #[tokio::test]
    async fn offline_miss_stops_before_credentials_transport_and_lease() {
        let fixture = Fixture::new();
        let transport = mock(Duration::ZERO);
        let calls = Arc::clone(&transport.calls);
        let client = fixture.client(transport);
        let error = client
            .query(request(CachePolicy::Offline))
            .await
            .unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::CacheMiss);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!fixture.root.join("cache/.leases").exists());
    }

    #[tokio::test]
    async fn offline_v1_hit_is_returned_without_promotion_or_lease() {
        let fixture = Fixture::new();
        let transport = mock(Duration::ZERO);
        let calls = Arc::clone(&transport.calls);
        let client = fixture.client(transport);
        let request = request(CachePolicy::Offline);
        let key = write_v1(&fixture, &request, "2025-01-01T00:00:00.000Z");

        let result = client.query(request).await.unwrap();
        assert_eq!(result.provenance.source, ResultSource::Cache);
        assert_eq!(result.provenance.freshness, Freshness::Stale);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(fixture.root.join(key.legacy_path()).exists());
        assert!(!fixture.root.join("cache/v2").exists());
        assert!(!fixture.root.join("cache/.leases").exists());
    }

    #[tokio::test]
    async fn invalid_retries_are_rejected_before_offline_cache_mutation() {
        let fixture = Fixture::new();
        let transport = mock(Duration::ZERO);
        let calls = Arc::clone(&transport.calls);
        let client = fixture.client(transport);
        let mut request = request(CachePolicy::Offline);
        let cache = CacheStore::new(StateRoot::new(fixture.root.clone()).unwrap());
        let key = cache.key(request.operation, request.date.clone()).unwrap();
        StateRoot::new(fixture.root.clone())
            .unwrap()
            .atomic_write(key.legacy_path(), b"{}", KrxErrorCode::CacheWriteFailed)
            .unwrap();
        request.options.retries = DEFAULT_RETRIES + 1;

        let error = client.query(request).await.unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::InvalidArgument);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            fs::read(fixture.root.join(key.legacy_path())).unwrap(),
            b"{}"
        );
        assert!(!fixture.root.join("cache/.leases").exists());
    }

    #[tokio::test]
    async fn fresh_online_v1_hit_is_promoted_under_the_refresh_lease() {
        let fixture = Fixture::new();
        let transport = mock(Duration::ZERO);
        let calls = Arc::clone(&transport.calls);
        let client = fixture.client(transport);
        let request = request(CachePolicy::Prefer {
            max_age: default_cache_age(),
        });
        let fetched_at_millis = jiff::Timestamp::try_from(SystemTime::now())
            .unwrap()
            .strftime("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let fetched_at = format!("{}123Z", fetched_at_millis.strip_suffix('Z').unwrap());
        let key = write_v1(&fixture, &request, &fetched_at);

        let result = client.query(request).await.unwrap();
        assert_eq!(result.provenance.source, ResultSource::Cache);
        assert_eq!(result.provenance.freshness, Freshness::Fresh);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!fixture.root.join(key.legacy_path()).exists());
        assert!(fixture.root.join(key.current_path()).exists());
        assert!(
            !fixture
                .root
                .join("cache/.leases")
                .read_dir()
                .is_ok_and(|mut entries| entries.next().is_some())
        );
    }

    #[tokio::test]
    async fn fresh_v1_waits_for_the_lease_instead_of_skipping_promotion() {
        let fixture = Fixture::new();
        let transport = mock(Duration::ZERO);
        let calls = Arc::clone(&transport.calls);
        let client = fixture.client(transport);
        let request = request(CachePolicy::Prefer {
            max_age: default_cache_age(),
        });
        let fetched_at = jiff::Timestamp::try_from(SystemTime::now())
            .unwrap()
            .strftime("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let key = write_v1(&fixture, &request, &fetched_at);
        let cache = CacheStore::new(StateRoot::new(fixture.root.clone()).unwrap());
        let lease = cache
            .try_acquire_refresh_lease(&key)
            .await
            .unwrap()
            .unwrap();
        let query = tokio::spawn(async move { client.query(request).await });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!query.is_finished());

        drop(lease);
        let result = query.await.unwrap().unwrap();
        assert_eq!(result.provenance.source, ResultSource::Cache);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!fixture.root.join(key.legacy_path()).exists());
        assert!(fixture.root.join(key.current_path()).exists());
    }

    #[tokio::test]
    async fn singleflight_and_lease_coalesce_concurrent_refreshes() {
        let fixture = Fixture::new();
        let transport = mock(Duration::from_millis(100));
        let calls = Arc::clone(&transport.calls);
        let left = fixture.client(transport.clone());
        let right = fixture.client(transport);
        let (left, right) = tokio::join!(
            left.query(request(CachePolicy::Prefer {
                max_age: default_cache_age(),
            })),
            right.query(request(CachePolicy::Prefer {
                max_age: default_cache_age(),
            })),
        );
        assert_eq!(left.unwrap().provenance.source, ResultSource::Network);
        assert_eq!(right.unwrap().provenance.source, ResultSource::Network);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            !fixture
                .root
                .join("cache/.leases")
                .read_dir()
                .is_ok_and(|mut entries| entries.next().is_some())
        );
    }

    #[tokio::test]
    async fn singleflight_shares_an_empty_result_that_is_not_cacheable() {
        let fixture = Fixture::new();
        let mut transport = mock(Duration::from_millis(100));
        transport.rows.clear();
        let calls = Arc::clone(&transport.calls);
        let left = fixture.client(transport.clone());
        let right = fixture.client(transport);

        let (left, right) = tokio::join!(
            left.query(request(CachePolicy::Prefer {
                max_age: default_cache_age(),
            })),
            right.query(request(CachePolicy::Prefer {
                max_age: default_cache_age(),
            })),
        );

        for result in [left.unwrap(), right.unwrap()] {
            assert!(result.rows.is_empty());
            assert_eq!(result.provenance.source, ResultSource::Network);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(!fixture.root.join("cache/v2").exists());
    }

    #[tokio::test]
    async fn concurrent_explicit_refreshes_accept_only_the_changed_v2() {
        let fixture = Fixture::new();
        let seeded_request = request(CachePolicy::Refresh);
        write_v2(&fixture, &seeded_request);
        let transport = mock(Duration::from_millis(100));
        let calls = Arc::clone(&transport.calls);
        let left = fixture.client(transport.clone());
        let right = fixture.client(transport);

        let (left, right) = tokio::join!(
            left.query(request(CachePolicy::Refresh)),
            right.query(request(CachePolicy::Refresh)),
        );
        assert_eq!(left.unwrap().provenance.source, ResultSource::Network);
        assert_eq!(right.unwrap().provenance.source, ResultSource::Network);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn v1_promotion_does_not_satisfy_a_network_forcing_refresh() {
        let fixture = Fixture::new();
        let refresh_request = request(CachePolicy::Refresh);
        let fetched_at_millis = jiff::Timestamp::try_from(SystemTime::now())
            .unwrap()
            .strftime("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let fetched_at = format!("{}123Z", fetched_at_millis.strip_suffix('Z').unwrap());
        let key = write_v1(&fixture, &refresh_request, &fetched_at);
        let transport = mock(Duration::ZERO);
        let calls = Arc::clone(&transport.calls);
        let (refresh, pause) = fixture.paused_refresh_client(transport.clone());
        let refresh_task = tokio::spawn(async move { refresh.query(refresh_request).await });
        pause.reached.wait().await;

        let prefer = fixture.client(transport);
        let promoted = prefer
            .query(request(CachePolicy::Prefer {
                max_age: default_cache_age(),
            }))
            .await
            .unwrap();
        assert_eq!(promoted.provenance.source, ResultSource::Cache);
        assert!(!fixture.root.join(key.legacy_path()).exists());
        assert!(fixture.root.join(key.current_path()).exists());

        pause.resume.wait().await;
        let refreshed = refresh_task.await.unwrap().unwrap();
        assert_eq!(refreshed.provenance.source, ResultSource::Network);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refresh_accepts_a_changed_v2_published_after_its_baseline() {
        let fixture = Fixture::new();
        let refresh_request = request(CachePolicy::Refresh);
        let key = write_v2(&fixture, &refresh_request);
        let transport = mock(Duration::ZERO);
        let calls = Arc::clone(&transport.calls);
        let (refresh, pause) = fixture.paused_refresh_client(transport);
        let refresh_task = tokio::spawn(async move { refresh.query(refresh_request).await });
        pause.reached.wait().await;

        CacheStore::new(StateRoot::new(fixture.root.clone()).unwrap())
            .write_v2(
                &key,
                &[row(OperationId::StockStkByddTrd)],
                SystemTime::now() - Duration::from_secs(24 * 60 * 60),
                SystemTime::now(),
            )
            .unwrap();
        pause.resume.wait().await;

        let result = refresh_task.await.unwrap().unwrap();
        assert_eq!(result.provenance.source, ResultSource::Cache);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn failed_refresh_preserves_the_previous_valid_entry_exactly() {
        let fixture = Fixture::new();
        let request = request(CachePolicy::Refresh);
        let key = write_v2(&fixture, &request);
        let before = fs::read(fixture.root.join(key.current_path())).unwrap();
        let transport = failing_mock();
        let calls = Arc::clone(&transport.calls);
        let client = fixture.client(transport);

        let error = client.query(request).await.unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::RequestFailed);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            fs::read(fixture.root.join(key.current_path())).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn cancellation_while_a_live_process_holds_the_lease_stops_without_network() {
        let fixture = Fixture::new();
        let transport = mock(Duration::ZERO);
        let calls = Arc::clone(&transport.calls);
        let client = fixture.client(transport);
        let request = request(CachePolicy::Prefer {
            max_age: default_cache_age(),
        });
        let cache = CacheStore::new(StateRoot::new(fixture.root.clone()).unwrap());
        let key = cache.key(request.operation, request.date.clone()).unwrap();
        StateRoot::new(fixture.root.clone())
            .unwrap()
            .atomic_write(key.legacy_path(), b"{}", KrxErrorCode::CacheWriteFailed)
            .unwrap();
        let lease = cache
            .try_acquire_refresh_lease(&key)
            .await
            .unwrap()
            .unwrap();
        let cancellation = request.options.cancellation.clone();
        let query = tokio::spawn(async move { client.query(request).await });
        tokio::time::sleep(Duration::from_millis(25)).await;
        cancellation.cancel();

        let error = query.await.unwrap().unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            fs::read(fixture.root.join(key.legacy_path())).unwrap(),
            b"{}"
        );
        drop(lease);
    }

    #[tokio::test]
    async fn cancelling_a_waiter_does_not_cancel_the_producer() {
        let fixture = Fixture::new();
        let transport = mock(Duration::from_millis(150));
        let calls = Arc::clone(&transport.calls);
        let producer = Arc::new(fixture.client(transport.clone()));
        let waiter = Arc::new(fixture.client(transport));
        let producer_task = {
            let producer = Arc::clone(&producer);
            tokio::spawn(async move {
                producer
                    .query(request(CachePolicy::Prefer {
                        max_age: default_cache_age(),
                    }))
                    .await
            })
        };
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let waiter_request = request(CachePolicy::Prefer {
            max_age: default_cache_age(),
        });
        waiter_request.options.cancellation.cancel();
        let error = waiter.query(waiter_request).await.unwrap_err();
        assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
        assert_eq!(
            producer_task.await.unwrap().unwrap().provenance.source,
            ResultSource::Network
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn native_query_client_builds_without_exposing_runtime_seams() {
        let fixture = Fixture::new();
        DirectQueryClient::native(
            fixture.root.clone(),
            Some(ApiKey::parse("test-placeholder").unwrap()),
        )
        .unwrap();
    }
}
