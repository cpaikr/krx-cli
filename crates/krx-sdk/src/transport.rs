use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::{Duration, Instant, SystemTime};

use futures_util::StreamExt;
use jiff::Timestamp;
use jiff::fmt::rfc2822;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE, HeaderName, HeaderValue, RETRY_AFTER};
use url::Url;
use uuid::Uuid;

use crate::conformer::{PreparedRequest, decode_response, prepare_request};
use crate::error::{http_error_code, retryable_http_status};
use crate::operation::{ATTEMPT_TIMEOUT_MS, DEFAULT_RETRIES, OFFICIAL_SERVER, OVERALL_TIMEOUT_MS};
use crate::quota::{QuotaReservation, QuotaStore};
use crate::{ApiKey, Cancellation, DirectRequest, KrxError, KrxErrorCode, Row, TradingDate};

const BASE_DELAY: Duration = Duration::from_secs(1);
const MAX_DELAY: Duration = Duration::from_secs(10);

// A full market response can be materially larger than the disposable probe's
// representative payloads. This private cap matches the largest accepted
// local cache object while still bounding response-body work per attempt.
const RESPONSE_LIMIT: usize = 64 * 1024 * 1024;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug)]
struct AttemptResponse {
    status: u16,
    retry_after: Option<String>,
    body: Vec<u8>,
}

#[derive(Debug)]
enum AttemptFailure {
    Cancelled,
    Timeout,
    Network,
    BodyTooLarge,
    InvalidCredential,
    Internal,
}

trait HttpAdapter: Send + Sync {
    fn send<'a>(
        &'a self,
        request: &'a PreparedRequest,
        auth_value: &'a HeaderValue,
        cancellation: &'a Cancellation,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<AttemptResponse, AttemptFailure>>;
}

trait QuotaAdmission: Send + Sync {
    fn reserve<'a>(
        &'a self,
        api_key: &'a ApiKey,
        date: &'a TradingDate,
        cancellation: &'a Cancellation,
        deadline: Instant,
    ) -> BoxFuture<'a, Result<QuotaReservation, KrxError>>;
}

trait Runtime: Send + Sync {
    fn monotonic_now(&self) -> Instant;
    fn wall_now(&self) -> SystemTime;
    fn jitter_unit(&self) -> f64;
    fn sleep<'a>(&'a self, duration: Duration) -> BoxFuture<'a, ()>;
}

#[derive(Clone, Debug)]
struct ReqwestAdapter {
    client: reqwest::Client,
    base_url: Url,
}

impl ReqwestAdapter {
    fn official() -> Result<Self, KrxError> {
        let base_url = Url::parse(OFFICIAL_SERVER).map_err(|_| {
            KrxError::new(
                KrxErrorCode::ContractMismatch,
                "canonical provider origin is invalid",
            )
        })?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .connect_timeout(Duration::from_millis(ATTEMPT_TIMEOUT_MS))
            .build()
            .map_err(|_| {
                KrxError::new(
                    KrxErrorCode::InternalFailure,
                    "provider HTTP client initialization failed",
                )
            })?;
        Ok(Self { client, base_url })
    }

    #[cfg(test)]
    fn loopback(base_url: Url) -> Result<Self, KrxError> {
        let mut adapter = Self::official()?;
        adapter.base_url = base_url;
        Ok(adapter)
    }

    async fn send_and_read(
        &self,
        request: &PreparedRequest,
        auth_value: &HeaderValue,
    ) -> Result<AttemptResponse, AttemptFailure> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| AttemptFailure::Internal)?;
        let url = self
            .base_url
            .join(request.path)
            .map_err(|_| AttemptFailure::Internal)?;
        let auth_name = HeaderName::from_bytes(request.auth_header.as_bytes())
            .map_err(|_| AttemptFailure::Internal)?;
        let content_type =
            HeaderValue::from_str(request.content_type).map_err(|_| AttemptFailure::Internal)?;

        let response = self
            .client
            .request(method, url)
            .header(auth_name, auth_value.clone())
            .header(CONTENT_TYPE, content_type)
            .body(request.body.clone())
            .send()
            .await
            .map_err(classify_reqwest_error)?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if status != 200 {
            return Ok(AttemptResponse {
                status,
                retry_after,
                body: Vec::new(),
            });
        }
        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > RESPONSE_LIMIT as u64)
        {
            return Err(AttemptFailure::BodyTooLarge);
        }

        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(classify_reqwest_error)?;
            if body.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
                return Err(AttemptFailure::BodyTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(AttemptResponse {
            status,
            retry_after,
            body,
        })
    }
}

impl HttpAdapter for ReqwestAdapter {
    fn send<'a>(
        &'a self,
        request: &'a PreparedRequest,
        auth_value: &'a HeaderValue,
        cancellation: &'a Cancellation,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<AttemptResponse, AttemptFailure>> {
        Box::pin(async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(AttemptFailure::Cancelled),
                result = tokio::time::timeout(timeout, self.send_and_read(request, auth_value)) => {
                    result.unwrap_or(Err(AttemptFailure::Timeout))
                }
            }
        })
    }
}

fn classify_reqwest_error(error: reqwest::Error) -> AttemptFailure {
    if error.is_timeout() {
        AttemptFailure::Timeout
    } else {
        AttemptFailure::Network
    }
}

impl QuotaAdmission for QuotaStore {
    fn reserve<'a>(
        &'a self,
        api_key: &'a ApiKey,
        date: &'a TradingDate,
        cancellation: &'a Cancellation,
        deadline: Instant,
    ) -> BoxFuture<'a, Result<QuotaReservation, KrxError>> {
        Box::pin(self.reserve_until(api_key, date, cancellation, deadline))
    }
}

#[derive(Clone, Copy, Debug)]
struct TokioRuntime;

impl Runtime for TokioRuntime {
    fn monotonic_now(&self) -> Instant {
        Instant::now()
    }

    fn wall_now(&self) -> SystemTime {
        SystemTime::now()
    }

    fn jitter_unit(&self) -> f64 {
        let mut bytes = [0_u8; 8];
        bytes.copy_from_slice(&Uuid::new_v4().as_bytes()[..8]);
        let sample = u64::from_le_bytes(bytes) >> 11;
        (sample as f64) / ((1_u64 << 53) as f64)
    }

    fn sleep<'a>(&'a self, duration: Duration) -> BoxFuture<'a, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}

struct RetryEngine<H, Q, R> {
    http: H,
    quota: Q,
    runtime: R,
}

impl<H, Q, R> RetryEngine<H, Q, R>
where
    H: HttpAdapter,
    Q: QuotaAdmission,
    R: Runtime,
{
    async fn execute(
        &self,
        request: &DirectRequest,
        api_key: &ApiKey,
    ) -> Result<Vec<Row>, KrxError> {
        let deadline = self.runtime.monotonic_now() + Duration::from_millis(OVERALL_TIMEOUT_MS);
        self.execute_until(request, api_key, deadline).await
    }

    async fn execute_until(
        &self,
        request: &DirectRequest,
        api_key: &ApiKey,
        deadline: Instant,
    ) -> Result<Vec<Row>, KrxError> {
        let operation = request.operation;
        if request.options.retries > DEFAULT_RETRIES {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "retry count must be between zero and three",
            ));
        }
        if request.options.cancellation.is_cancelled() {
            return Err(cancelled(operation));
        }
        let prepared = prepare_request(operation, &request.date)?;
        let auth_value =
            auth_header_value(api_key).map_err(|failure| attempt_error(failure, operation))?;
        let attempt_cancellation = request.options.cancellation.child();

        for attempt in 0..=request.options.retries {
            if request.options.cancellation.is_cancelled() {
                return Err(cancelled(operation));
            }
            let remaining = self.remaining(deadline, operation)?;
            let quota_date = kst_date(self.runtime.wall_now())
                .map_err(|error| error.for_operation(operation))?;
            let reservation = tokio::select! {
                biased;
                _ = request.options.cancellation.cancelled() => {
                    attempt_cancellation.cancel();
                    return Err(cancelled(operation));
                }
                _ = tokio::time::sleep(remaining) => {
                    attempt_cancellation.cancel();
                    if request.options.cancellation.is_cancelled() {
                        return Err(cancelled(operation));
                    }
                    return Err(deadline_exceeded(operation));
                }
                result = self.quota.reserve(api_key, &quota_date, &attempt_cancellation, deadline) => result,
            }
            .map_err(|error| error.for_operation(operation))?;
            if !reservation.reserved {
                return Err(KrxError::new(
                    KrxErrorCode::LocalQuotaExhausted,
                    format!(
                        "local advisory daily quota exhausted ({}/{})",
                        reservation.count,
                        reservation.count.saturating_add(reservation.remaining)
                    ),
                )
                .for_operation(operation));
            }
            if request.options.cancellation.is_cancelled() {
                attempt_cancellation.cancel();
                return Err(cancelled(operation));
            }

            let remaining = self.remaining(deadline, operation)?;
            let attempt_timeout = remaining.min(Duration::from_millis(ATTEMPT_TIMEOUT_MS));
            let outcome = self
                .http
                .send(
                    &prepared,
                    &auth_value,
                    &attempt_cancellation,
                    attempt_timeout,
                )
                .await;
            if request.options.cancellation.is_cancelled() {
                attempt_cancellation.cancel();
                return Err(cancelled(operation));
            }

            match outcome {
                Ok(response) if response.status == 200 => {
                    return decode_response(operation, &response.body, Some(api_key));
                }
                Ok(response)
                    if retryable_http_status(response.status)
                        && attempt < request.options.retries =>
                {
                    let delay = response
                        .retry_after
                        .as_deref()
                        .and_then(|value| parse_retry_after(value, self.runtime.wall_now()))
                        .unwrap_or_else(|| retry_delay(attempt, self.runtime.jitter_unit()));
                    self.wait_to_retry(delay, deadline, request, &attempt_cancellation)
                        .await?;
                }
                Ok(response) => {
                    return Err(KrxError::new(
                        http_error_code(response.status),
                        "provider returned an unsuccessful HTTP status",
                    )
                    .with_http_status(response.status)
                    .for_operation(operation));
                }
                Err(AttemptFailure::Network | AttemptFailure::Timeout)
                    if attempt < request.options.retries =>
                {
                    let delay = retry_delay(attempt, self.runtime.jitter_unit());
                    self.wait_to_retry(delay, deadline, request, &attempt_cancellation)
                        .await?;
                }
                Err(failure) => return Err(attempt_error(failure, operation)),
            }
        }
        Err(KrxError::new(
            KrxErrorCode::InternalFailure,
            "provider retry state was exhausted unexpectedly",
        )
        .for_operation(operation))
    }

    fn remaining(
        &self,
        deadline: Instant,
        operation: crate::OperationId,
    ) -> Result<Duration, KrxError> {
        deadline
            .checked_duration_since(self.runtime.monotonic_now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| deadline_exceeded(operation))
    }

    async fn wait_to_retry(
        &self,
        delay: Duration,
        deadline: Instant,
        request: &DirectRequest,
        attempt_cancellation: &Cancellation,
    ) -> Result<(), KrxError> {
        let remaining = self.remaining(deadline, request.operation)?;
        if delay >= remaining {
            return Err(deadline_exceeded(request.operation));
        }
        tokio::select! {
            biased;
            _ = request.options.cancellation.cancelled() => {
                attempt_cancellation.cancel();
                Err(cancelled(request.operation))
            }
            _ = tokio::time::sleep(remaining) => {
                attempt_cancellation.cancel();
                if request.options.cancellation.is_cancelled() {
                    Err(cancelled(request.operation))
                } else {
                    Err(deadline_exceeded(request.operation))
                }
            }
            _ = self.runtime.sleep(delay) => Ok(()),
        }
    }
}

pub(crate) struct DirectTransport {
    engine: RetryEngine<ReqwestAdapter, QuotaStore, TokioRuntime>,
}

impl DirectTransport {
    pub(crate) fn new(state_root: PathBuf) -> Result<Self, KrxError> {
        Ok(Self {
            engine: RetryEngine {
                http: ReqwestAdapter::official()?,
                quota: QuotaStore::new(state_root)?,
                runtime: TokioRuntime,
            },
        })
    }

    pub(crate) async fn execute(
        &self,
        request: &DirectRequest,
        api_key: &ApiKey,
    ) -> Result<Vec<Row>, KrxError> {
        self.engine.execute(request, api_key).await
    }

    pub(crate) async fn execute_until(
        &self,
        request: &DirectRequest,
        api_key: &ApiKey,
        deadline: Instant,
    ) -> Result<Vec<Row>, KrxError> {
        self.engine.execute_until(request, api_key, deadline).await
    }
}

fn retry_delay(attempt: u8, jitter_unit: f64) -> Duration {
    let multiplier = 1_u64.checked_shl(u32::from(attempt)).unwrap_or(u64::MAX);
    let exponential_ms = (BASE_DELAY.as_millis() as u64)
        .saturating_mul(multiplier)
        .min(MAX_DELAY.as_millis() as u64);
    let unit = if jitter_unit.is_finite() {
        jitter_unit.clamp(0.0, 1.0)
    } else {
        0.0
    };
    Duration::from_millis(((exponential_ms as f64) * (0.5 + unit * 0.5)).floor() as u64)
}

fn parse_retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(
            value
                .parse::<u64>()
                .map(Duration::from_secs)
                .unwrap_or(Duration::MAX),
        );
    }
    if let Ok(seconds) = value.parse::<f64>()
        && seconds.is_finite()
        && seconds >= 0.0
    {
        return Some(Duration::try_from_secs_f64(seconds).unwrap_or(Duration::MAX));
    }
    let timestamp = rfc2822::parse(value).ok()?.timestamp();
    let target: SystemTime = timestamp.into();
    Some(target.duration_since(now).unwrap_or(Duration::ZERO))
}

fn auth_header_value(api_key: &ApiKey) -> Result<HeaderValue, AttemptFailure> {
    let mut value =
        HeaderValue::from_str(api_key.expose()).map_err(|_| AttemptFailure::InvalidCredential)?;
    value.set_sensitive(true);
    Ok(value)
}

pub(crate) fn kst_date(now: SystemTime) -> Result<TradingDate, KrxError> {
    let shifted = now
        .checked_add(Duration::from_secs(9 * 60 * 60))
        .ok_or_else(|| {
            KrxError::new(
                KrxErrorCode::InternalFailure,
                "system time is outside the supported KST calendar",
            )
        })?;
    let timestamp = Timestamp::try_from(shifted).map_err(|_| {
        KrxError::new(
            KrxErrorCode::InternalFailure,
            "system time is outside the supported KST calendar",
        )
    })?;
    TradingDate::parse(&timestamp.strftime("%Y%m%d").to_string()).map_err(|_| {
        KrxError::new(
            KrxErrorCode::InternalFailure,
            "system time is outside the supported KST calendar",
        )
    })
}

fn attempt_error(failure: AttemptFailure, operation: crate::OperationId) -> KrxError {
    let (code, message) = match failure {
        AttemptFailure::Cancelled => (
            KrxErrorCode::RequestCancelled,
            "provider request was cancelled",
        ),
        AttemptFailure::Timeout => (
            KrxErrorCode::DeadlineExceeded,
            "provider request attempt timed out",
        ),
        AttemptFailure::Network => (
            KrxErrorCode::RequestFailed,
            "provider network request failed",
        ),
        AttemptFailure::BodyTooLarge => (
            KrxErrorCode::InvalidEnvelope,
            "provider response exceeded the safe body limit",
        ),
        AttemptFailure::InvalidCredential => (
            KrxErrorCode::InvalidArgument,
            "API key cannot be represented as an HTTP header",
        ),
        AttemptFailure::Internal => (
            KrxErrorCode::InternalFailure,
            "provider request construction failed",
        ),
    };
    KrxError::new(code, message).for_operation(operation)
}

fn cancelled(operation: crate::OperationId) -> KrxError {
    KrxError::new(
        KrxErrorCode::RequestCancelled,
        "provider request was cancelled",
    )
    .for_operation(operation)
}

fn deadline_exceeded(operation: crate::OperationId) -> KrxError {
    KrxError::new(
        KrxErrorCode::DeadlineExceeded,
        "provider request deadline exceeded",
    )
    .for_operation(operation)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use serde_json::{Map, Value, json};

    use super::*;
    use crate::operation::operation_spec;
    use crate::{CallOptions, OperationId};

    #[derive(Debug)]
    struct ScriptedHttp {
        outcomes: Mutex<VecDeque<Result<AttemptResponse, AttemptFailure>>>,
        sends: Mutex<usize>,
    }

    impl ScriptedHttp {
        fn new(outcomes: Vec<Result<AttemptResponse, AttemptFailure>>) -> Self {
            Self {
                outcomes: Mutex::new(outcomes.into()),
                sends: Mutex::new(0),
            }
        }

        fn sends(&self) -> usize {
            *self.sends.lock().expect("send counter")
        }
    }

    impl HttpAdapter for Arc<ScriptedHttp> {
        fn send<'a>(
            &'a self,
            _request: &'a PreparedRequest,
            _auth_value: &'a HeaderValue,
            _cancellation: &'a Cancellation,
            _timeout: Duration,
        ) -> BoxFuture<'a, Result<AttemptResponse, AttemptFailure>> {
            Box::pin(async move {
                *self.sends.lock().expect("send counter") += 1;
                self.outcomes
                    .lock()
                    .expect("HTTP script")
                    .pop_front()
                    .expect("scripted HTTP outcome")
            })
        }
    }

    #[derive(Debug)]
    struct ScriptedQuota {
        reservations: Mutex<VecDeque<Result<QuotaReservation, KrxError>>>,
        dates: Mutex<Vec<String>>,
    }

    impl ScriptedQuota {
        fn admitted(count: usize) -> Arc<Self> {
            Arc::new(Self {
                reservations: Mutex::new(
                    (1..=count)
                        .map(|count| {
                            Ok(QuotaReservation {
                                count: count as u32,
                                remaining: 10_000 - count as u32,
                                reserved: true,
                            })
                        })
                        .collect(),
                ),
                dates: Mutex::new(Vec::new()),
            })
        }
    }

    impl QuotaAdmission for Arc<ScriptedQuota> {
        fn reserve<'a>(
            &'a self,
            _api_key: &'a ApiKey,
            date: &'a TradingDate,
            _cancellation: &'a Cancellation,
            _deadline: Instant,
        ) -> BoxFuture<'a, Result<QuotaReservation, KrxError>> {
            Box::pin(async move {
                self.dates
                    .lock()
                    .expect("quota dates")
                    .push(date.as_str().to_owned());
                self.reservations
                    .lock()
                    .expect("quota script")
                    .pop_front()
                    .expect("scripted quota outcome")
            })
        }
    }

    #[derive(Debug)]
    struct TestRuntime {
        monotonic: Instant,
        wall: SystemTime,
        jitter: f64,
        sleeps: Mutex<Vec<Duration>>,
    }

    impl TestRuntime {
        fn new() -> Self {
            Self {
                monotonic: Instant::now(),
                wall: SystemTime::UNIX_EPOCH + Duration::from_secs(17 * 60 * 60),
                jitter: 0.0,
                sleeps: Mutex::new(Vec::new()),
            }
        }
    }

    impl Runtime for Arc<TestRuntime> {
        fn monotonic_now(&self) -> Instant {
            self.monotonic
        }

        fn wall_now(&self) -> SystemTime {
            self.wall
        }

        fn jitter_unit(&self) -> f64 {
            self.jitter
        }

        fn sleep<'a>(&'a self, duration: Duration) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                self.sleeps.lock().expect("retry sleeps").push(duration);
            })
        }
    }

    #[derive(Debug)]
    struct PendingRuntime {
        monotonic: Instant,
        wall: SystemTime,
        sleep_started: tokio::sync::Notify,
    }

    impl Runtime for Arc<PendingRuntime> {
        fn monotonic_now(&self) -> Instant {
            self.monotonic
        }

        fn wall_now(&self) -> SystemTime {
            self.wall
        }

        fn jitter_unit(&self) -> f64 {
            0.0
        }

        fn sleep<'a>(&'a self, _duration: Duration) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                self.sleep_started.notify_one();
                std::future::pending().await
            })
        }
    }

    #[derive(Debug)]
    struct PendingQuota;

    impl QuotaAdmission for PendingQuota {
        fn reserve<'a>(
            &'a self,
            _api_key: &'a ApiKey,
            _date: &'a TradingDate,
            _cancellation: &'a Cancellation,
            _deadline: Instant,
        ) -> BoxFuture<'a, Result<QuotaReservation, KrxError>> {
            Box::pin(std::future::pending())
        }
    }

    type TestEngine = RetryEngine<Arc<ScriptedHttp>, Arc<ScriptedQuota>, Arc<TestRuntime>>;
    type TestEngineParts = (
        TestEngine,
        Arc<ScriptedHttp>,
        Arc<ScriptedQuota>,
        Arc<TestRuntime>,
    );

    fn operation() -> OperationId {
        OperationId::StockStkByddTrd
    }

    fn direct(retries: u8) -> DirectRequest {
        DirectRequest {
            operation: operation(),
            date: TradingDate::parse("20260824").expect("request date"),
            options: CallOptions {
                retries,
                ..CallOptions::default()
            },
        }
    }

    fn success_body() -> Vec<u8> {
        let spec = operation_spec(operation());
        let row = spec
            .response_fields
            .iter()
            .map(|field| (field.name.to_owned(), Value::String("fixture".to_owned())))
            .collect::<Map<_, _>>();
        serde_json::to_vec(&json!({ spec.success_envelope: [row] })).expect("response JSON")
    }

    fn response(status: u16) -> Result<AttemptResponse, AttemptFailure> {
        Ok(AttemptResponse {
            status,
            retry_after: None,
            body: if status == 200 {
                success_body()
            } else {
                Vec::new()
            },
        })
    }

    fn build_engine(
        outcomes: Vec<Result<AttemptResponse, AttemptFailure>>,
        quota_count: usize,
    ) -> TestEngineParts {
        let http = Arc::new(ScriptedHttp::new(outcomes));
        let quota = ScriptedQuota::admitted(quota_count);
        let runtime = Arc::new(TestRuntime::new());
        (
            RetryEngine {
                http: Arc::clone(&http),
                quota: Arc::clone(&quota),
                runtime: Arc::clone(&runtime),
            },
            http,
            quota,
            runtime,
        )
    }

    #[tokio::test]
    async fn retries_only_the_frozen_transient_statuses_and_reserves_each_attempt() {
        let key = ApiKey::parse("fixture-key").expect("key");
        for status in [408, 429, 500, 502, 503, 504] {
            let (engine, http, quota, _) = build_engine(vec![response(status), response(200)], 2);
            let rows = engine
                .execute(&direct(1), &key)
                .await
                .expect("retry success");
            assert_eq!(rows.len(), 1);
            assert_eq!(http.sends(), 2);
            assert_eq!(quota.dates.lock().expect("dates").len(), 2);
        }

        for status in [300, 400, 401, 403, 404, 409, 422] {
            let (engine, http, quota, _) = build_engine(vec![response(status)], 1);
            let error = engine
                .execute(&direct(3), &key)
                .await
                .expect_err("terminal status");
            assert_eq!(error.http_status(), Some(status));
            assert_eq!(http.sends(), 1);
            assert_eq!(quota.dates.lock().expect("dates").len(), 1);
        }
    }

    #[tokio::test]
    async fn invalid_retry_count_and_header_credential_prevent_quota_and_dispatch() {
        let key = ApiKey::parse("fixture-key").expect("key");
        let (engine, http, quota, _) = build_engine(Vec::new(), 0);
        let error = engine
            .execute(&direct(4), &key)
            .await
            .expect_err("retry count");
        assert_eq!(error.code(), KrxErrorCode::InvalidArgument);
        assert_eq!(http.sends(), 0);
        assert!(quota.dates.lock().expect("dates").is_empty());

        let malformed = ApiKey::from_exact("fixture\0key".to_owned());
        let (engine, http, quota, _) = build_engine(Vec::new(), 0);
        let error = engine
            .execute(&direct(0), &malformed)
            .await
            .expect_err("header credential");
        assert_eq!(error.code(), KrxErrorCode::InvalidArgument);
        assert_eq!(http.sends(), 0);
        assert!(quota.dates.lock().expect("dates").is_empty());
    }

    #[tokio::test]
    async fn retries_network_and_attempt_timeout_failures_with_bounded_jitter() {
        let key = ApiKey::parse("fixture-key").expect("key");
        let (engine, http, _, runtime) = build_engine(
            vec![
                Err(AttemptFailure::Network),
                Err(AttemptFailure::Timeout),
                response(200),
            ],
            3,
        );
        engine
            .execute(&direct(2), &key)
            .await
            .expect("retry success");
        assert_eq!(http.sends(), 3);
        assert_eq!(
            *runtime.sleeps.lock().expect("sleeps"),
            [Duration::from_millis(500), Duration::from_secs(1)]
        );
    }

    #[tokio::test]
    async fn retry_after_replaces_jitter_and_must_fit_before_deadline() {
        let key = ApiKey::parse("fixture-key").expect("key");
        let (engine, _, _, runtime) = build_engine(
            vec![
                Ok(AttemptResponse {
                    status: 429,
                    retry_after: Some("2".to_owned()),
                    body: Vec::new(),
                }),
                response(200),
            ],
            2,
        );
        engine
            .execute(&direct(1), &key)
            .await
            .expect("retry success");
        assert_eq!(
            *runtime.sleeps.lock().expect("sleeps"),
            [Duration::from_secs(2)]
        );

        let (engine, http, _, _) = build_engine(
            vec![Ok(AttemptResponse {
                status: 503,
                retry_after: Some("1".to_owned()),
                body: Vec::new(),
            })],
            1,
        );
        let deadline = engine.runtime.monotonic_now() + Duration::from_secs(1);
        let error = engine
            .execute_until(&direct(1), &key, deadline)
            .await
            .expect_err("deadline");
        assert_eq!(error.code(), KrxErrorCode::DeadlineExceeded);
        assert_eq!(http.sends(), 1);

        let (engine, http, quota, _) = build_engine(
            vec![Ok(AttemptResponse {
                status: 503,
                retry_after: Some("18446744073709551616".to_owned()),
                body: Vec::new(),
            })],
            1,
        );
        let error = engine
            .execute(&direct(1), &key)
            .await
            .expect_err("oversized Retry-After");
        assert_eq!(error.code(), KrxErrorCode::DeadlineExceeded);
        assert_eq!(http.sends(), 1);
        assert_eq!(quota.dates.lock().expect("dates").len(), 1);

        let (engine, http, quota, _) = build_engine(
            vec![Ok(AttemptResponse {
                status: 503,
                retry_after: Some("9".repeat(352)),
                body: Vec::new(),
            })],
            1,
        );
        let error = engine
            .execute(&direct(1), &key)
            .await
            .expect_err("unbounded Retry-After");
        assert_eq!(error.code(), KrxErrorCode::DeadlineExceeded);
        assert_eq!(http.sends(), 1);
        assert_eq!(quota.dates.lock().expect("dates").len(), 1);
    }

    #[tokio::test]
    async fn quota_exhaustion_and_pre_cancel_prevent_dispatch() {
        let key = ApiKey::parse("fixture-key").expect("key");
        let http = Arc::new(ScriptedHttp::new(Vec::new()));
        let quota = Arc::new(ScriptedQuota {
            reservations: Mutex::new(VecDeque::from([Ok(QuotaReservation {
                count: 10_000,
                remaining: 0,
                reserved: false,
            })])),
            dates: Mutex::new(Vec::new()),
        });
        let quota_engine = RetryEngine {
            http: Arc::clone(&http),
            quota,
            runtime: Arc::new(TestRuntime::new()),
        };
        let error = quota_engine
            .execute(&direct(0), &key)
            .await
            .expect_err("quota");
        assert_eq!(error.code(), KrxErrorCode::LocalQuotaExhausted);
        assert_eq!(http.sends(), 0);

        let request = direct(0);
        request.options.cancellation.cancel();
        let (engine, http, quota, _) = build_engine(Vec::new(), 0);
        let error = engine.execute(&request, &key).await.expect_err("cancelled");
        assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
        assert_eq!(http.sends(), 0);
        assert!(quota.dates.lock().expect("dates").is_empty());
    }

    #[tokio::test]
    async fn cancellation_wins_during_retry_sleep() {
        let key = ApiKey::parse("fixture-key").expect("key");
        let request = direct(1);
        let cancellation = request.options.cancellation.clone();
        let http = Arc::new(ScriptedHttp::new(vec![Err(AttemptFailure::Network)]));
        let quota = ScriptedQuota::admitted(1);
        let runtime = Arc::new(PendingRuntime {
            monotonic: Instant::now(),
            wall: SystemTime::UNIX_EPOCH,
            sleep_started: tokio::sync::Notify::new(),
        });
        let engine = RetryEngine {
            http,
            quota,
            runtime: Arc::clone(&runtime),
        };
        let pending = async move { engine.execute(&request, &key).await };
        let cancel = async move {
            runtime.sleep_started.notified().await;
            cancellation.cancel();
        };
        let (result, ()) = tokio::join!(pending, cancel);
        assert_eq!(
            result.expect_err("cancelled sleep").code(),
            KrxErrorCode::RequestCancelled
        );
    }

    #[tokio::test]
    async fn overall_deadline_covers_pending_quota_admission() {
        let key = ApiKey::parse("fixture-key").expect("key");
        let http = Arc::new(ScriptedHttp::new(Vec::new()));
        let runtime = Arc::new(TestRuntime::new());
        let engine = RetryEngine {
            http: Arc::clone(&http),
            quota: PendingQuota,
            runtime: Arc::clone(&runtime),
        };
        let deadline = runtime.monotonic_now() + Duration::from_millis(20);
        let error = engine
            .execute_until(&direct(0), &key, deadline)
            .await
            .expect_err("quota deadline");
        assert_eq!(error.code(), KrxErrorCode::DeadlineExceeded);
        assert_eq!(http.sends(), 0);
    }

    #[test]
    fn current_quota_day_is_computed_in_kst() {
        assert_eq!(
            kst_date(SystemTime::UNIX_EPOCH + Duration::from_secs(14 * 60 * 60 + 59 * 60))
                .expect("KST date")
                .as_str(),
            "19700101"
        );
        assert_eq!(
            kst_date(SystemTime::UNIX_EPOCH + Duration::from_secs(15 * 60 * 60))
                .expect("KST date")
                .as_str(),
            "19700102"
        );
    }

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        let now = SystemTime::UNIX_EPOCH;
        assert_eq!(parse_retry_after("3", now), Some(Duration::from_secs(3)));
        assert_eq!(
            parse_retry_after("Thu, 01 Jan 1970 00:00:05 GMT", now),
            Some(Duration::from_secs(5))
        );
        assert_eq!(parse_retry_after("invalid", now), None);
        assert_eq!(
            parse_retry_after("18446744073709551616", now),
            Some(Duration::MAX)
        );
        assert_eq!(
            parse_retry_after(&"9".repeat(352), now),
            Some(Duration::MAX)
        );
    }

    #[test]
    fn auth_header_is_sensitive() {
        let key = ApiKey::parse("fixture-key").expect("key");
        assert!(auth_header_value(&key).expect("header").is_sensitive());
    }

    #[tokio::test]
    async fn reqwest_adapter_refuses_redirects_and_prechecks_body_size() {
        async fn serve(response: &'static str) -> Url {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("listener");
            let address = listener.local_addr().expect("address");
            tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("connection");
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).await;
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("response");
            });
            Url::parse(&format!("http://{address}/")).expect("loopback URL")
        }

        let key = ApiKey::parse("fixture-key").expect("key");
        let auth_value = auth_header_value(&key).expect("auth header");
        let prepared = prepare_request(operation(), &direct(0).date).expect("request");
        let cancellation = Cancellation::new();
        let base =
            serve("HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n").await;
        let adapter = ReqwestAdapter::loopback(base).expect("adapter");
        let response = adapter
            .send(
                &prepared,
                &auth_value,
                &cancellation,
                Duration::from_secs(1),
            )
            .await
            .expect("redirect response");
        assert_eq!(response.status, 302);

        let base = serve("HTTP/1.1 503 Unavailable\r\nContent-Length: 67108865\r\n\r\n").await;
        let adapter = ReqwestAdapter::loopback(base).expect("adapter");
        let response = adapter
            .send(
                &prepared,
                &auth_value,
                &cancellation,
                Duration::from_secs(1),
            )
            .await
            .expect("opaque error response");
        assert_eq!(response.status, 503);
        assert!(response.body.is_empty());

        let base = serve("HTTP/1.1 200 OK\r\nContent-Length: 67108865\r\n\r\n").await;
        let adapter = ReqwestAdapter::loopback(base).expect("adapter");
        assert!(matches!(
            adapter
                .send(
                    &prepared,
                    &auth_value,
                    &cancellation,
                    Duration::from_secs(1),
                )
                .await,
            Err(AttemptFailure::BodyTooLarge)
        ));
    }

    #[tokio::test]
    async fn reqwest_adapter_bounds_stalled_bodies_by_timeout_and_cancellation() {
        async fn stalled_server() -> Url {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("listener");
            let address = listener.local_addr().expect("address");
            tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("connection");
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).await;
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
                    .await
                    .expect("headers");
                tokio::time::sleep(Duration::from_secs(1)).await;
            });
            Url::parse(&format!("http://{address}/")).expect("loopback URL")
        }

        let key = ApiKey::parse("fixture-key").expect("key");
        let auth_value = auth_header_value(&key).expect("auth header");
        let prepared = prepare_request(operation(), &direct(0).date).expect("request");
        let cancellation = Cancellation::new();
        let adapter = ReqwestAdapter::loopback(stalled_server().await).expect("adapter");
        assert!(matches!(
            adapter
                .send(
                    &prepared,
                    &auth_value,
                    &cancellation,
                    Duration::from_millis(20),
                )
                .await,
            Err(AttemptFailure::Timeout)
        ));

        let cancellation = Cancellation::new();
        let cancel = cancellation.clone();
        let adapter = ReqwestAdapter::loopback(stalled_server().await).expect("adapter");
        let (result, ()) = tokio::join!(
            adapter.send(
                &prepared,
                &auth_value,
                &cancellation,
                Duration::from_secs(1),
            ),
            async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                cancel.cancel();
            }
        );
        assert!(matches!(result, Err(AttemptFailure::Cancelled)));
    }
}
