use std::collections::BTreeMap;
use std::env::VarError;
use std::fmt;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use reqwest::header::{CONTENT_TYPE as CONTENT_TYPE_HEADER, HeaderName, HeaderValue};
use serde_json::{Map, Value};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use url::Url;
use zeroize::Zeroizing;

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../contracts/generated/operation-id.rs"
));

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ApprovalCategory {
    Index,
    Stock,
    Etp,
    Bond,
    Derivative,
    Commodity,
    Esg,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationFieldDescription {
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationDescription {
    pub operation_id: OperationId,
    pub category: ApprovalCategory,
    pub description: &'static str,
    pub description_ko: &'static str,
    pub contract_id: &'static str,
    pub request_fields: &'static [OperationFieldDescription],
    pub response_fields: &'static [OperationFieldDescription],
}

include!(concat!(env!("OUT_DIR"), "/wire_contract.rs"));

#[cfg(feature = "probe-hooks")]
pub struct ProbeWireContract {
    pub method: &'static str,
    pub path: &'static str,
    pub auth_header: &'static str,
    pub content_type: &'static str,
    pub request_date_field: &'static str,
    pub success_envelope: &'static str,
    pub provider_code_field: &'static str,
    pub provider_message_field: &'static str,
    pub representative_fields: &'static [&'static str],
}

#[doc(hidden)]
#[cfg(feature = "probe-hooks")]
pub fn probe_wire_contract() -> ProbeWireContract {
    ProbeWireContract {
        method: METHOD,
        path: PROVIDER_PATH,
        auth_header: AUTH_HEADER,
        content_type: CONTENT_TYPE,
        request_date_field: REQUEST_DATE_FIELD,
        success_envelope: SUCCESS_ENVELOPE,
        provider_code_field: PROVIDER_CODE_FIELD,
        provider_message_field: PROVIDER_MESSAGE_FIELD,
        representative_fields: REPRESENTATIVE_FIELDS,
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ApiKey(Zeroizing<String>);

impl ApiKey {
    pub fn parse(value: &str) -> Result<Self, KrxError> {
        let value = value.trim();
        if value.is_empty() || value.chars().any(char::is_whitespace) {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "API key must be a non-empty token",
            ));
        }
        Ok(Self(Zeroizing::new(value.to_owned())))
    }

    fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ApiKey([REDACTED])")
    }
}

#[derive(Clone, Debug)]
pub struct Cancellation(CancellationToken);

impl Cancellation {
    pub fn new() -> Self {
        Self(CancellationToken::new())
    }

    pub fn cancel(&self) {
        self.0.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    async fn cancelled(&self) {
        self.0.cancelled().await;
    }
}

impl Default for Cancellation {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResultSource {
    Network,
    Cache,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Freshness {
    Fresh,
    Stale,
}

#[derive(Clone, Debug)]
pub struct ResultProvenance {
    pub source: ResultSource,
    pub fetched_at: SystemTime,
    pub freshness: Freshness,
    pub contract_id: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Row(BTreeMap<String, String>);

impl Row {
    pub fn get(&self, field: &str) -> Option<&str> {
        self.0.get(field).map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }
}

#[derive(Clone, Debug)]
pub struct QueryResult {
    pub rows: Vec<Row>,
    pub provenance: ResultProvenance,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradingDate(String);

impl TradingDate {
    pub fn parse(value: &str) -> Result<Self, KrxError> {
        if !valid_date(value) {
            return Err(KrxError::new(
                KrxErrorCode::InvalidDate,
                "date must be a valid YYYYMMDD calendar date",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn valid_date(value: &str) -> bool {
    if value.len() != 8 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let year = value[0..4].parse::<u32>().ok();
    let month = value[4..6].parse::<u32>().ok();
    let day = value[6..8].parse::<u32>().ok();
    let (Some(year), Some(month), Some(day)) = (year, month, day) else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day > 0 && day <= days
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecurityCode(String);

impl SecurityCode {
    pub fn parse(value: &str) -> Result<Self, KrxError> {
        if value.len() != 6 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "security code must contain exactly six digits",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug)]
pub struct DateRange {
    pub from: TradingDate,
    pub to: TradingDate,
}

impl DateRange {
    pub fn new(from: TradingDate, to: TradingDate) -> Result<Self, KrxError> {
        if from.as_str() > to.as_str() {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "range start must not follow range end",
            ));
        }
        Ok(Self { from, to })
    }
}

#[derive(Clone, Debug)]
pub enum CachePolicy {
    Prefer { max_age: Duration },
    Refresh,
    Bypass,
    Offline,
}

#[derive(Clone, Debug)]
pub struct CallOptions {
    pub cache: CachePolicy,
    pub retries: u8,
    pub cancellation: Cancellation,
}

impl Default for CallOptions {
    fn default() -> Self {
        Self {
            cache: CachePolicy::Prefer {
                max_age: Duration::from_secs(168 * 60 * 60),
            },
            retries: 3,
            cancellation: Cancellation::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DirectRequest {
    pub operation: OperationId,
    pub date: TradingDate,
    pub options: CallOptions,
}

#[derive(Clone, Debug)]
pub enum RangeMode {
    Raw,
    Adjusted { security_code: SecurityCode },
}

#[derive(Clone, Debug)]
pub struct RangeRequest {
    pub operation: OperationId,
    pub range: DateRange,
    pub mode: RangeMode,
    pub options: CallOptions,
}

#[derive(Clone, Debug)]
pub struct StockSearchRequest {
    pub query: String,
    pub options: CallOptions,
}

impl StockSearchRequest {
    pub fn new(query: &str, options: CallOptions) -> Result<Self, KrxError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "stock search query must not be empty",
            ));
        }
        Ok(Self {
            query: query.to_owned(),
            options,
        })
    }
}

#[derive(Clone, Debug)]
pub struct MarketSummaryRequest {
    pub date: TradingDate,
    pub options: CallOptions,
}

impl MarketSummaryRequest {
    pub fn new(date: TradingDate, options: CallOptions) -> Self {
        Self { date, options }
    }
}

#[derive(Clone, Debug)]
pub struct WatchlistPricesRequest {
    pub date: TradingDate,
    pub security_codes: Vec<SecurityCode>,
    pub options: CallOptions,
}

impl WatchlistPricesRequest {
    pub fn new(
        date: TradingDate,
        security_codes: Vec<SecurityCode>,
        options: CallOptions,
    ) -> Result<Self, KrxError> {
        if security_codes.is_empty() {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "watchlist request must contain at least one security code",
            ));
        }
        Ok(Self {
            date,
            security_codes,
            options,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletenessState {
    Complete,
    Partial,
    Empty,
    Failed,
}

#[derive(Clone, Debug)]
pub struct CompositeFailure<Id> {
    pub id: Id,
    pub error: KrxError,
}

#[derive(Clone, Debug)]
pub struct Completeness<Id> {
    pub state: CompletenessState,
    pub requested: Vec<Id>,
    pub succeeded: Vec<Id>,
    pub failed: Vec<CompositeFailure<Id>>,
    pub skipped: Vec<Id>,
}

#[derive(Clone, Debug)]
pub struct CompositeResult<Data, Id> {
    pub success: bool,
    pub data: Data,
    pub completeness: Completeness<Id>,
    pub provenance: BTreeMap<Id, ResultProvenance>,
    pub error: Option<KrxError>,
}

#[derive(Clone, Debug)]
pub struct RangeResult {
    pub result: CompositeResult<Vec<Row>, TradingDate>,
    pub fetched_days: usize,
    pub failed_days: usize,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SearchMarket {
    Kospi,
    Kosdaq,
}

#[derive(Clone, Debug)]
pub struct StockSearchMatch {
    pub isu_cd: String,
    pub isu_srt_cd: String,
    pub isu_nm: String,
    pub market: SearchMarket,
}

pub type StockSearchResult = CompositeResult<Vec<StockSearchMatch>, SearchMarket>;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MarketComponent {
    KospiIndex,
    KosdaqIndex,
    KospiStocks,
    KosdaqStocks,
}

#[derive(Clone, Debug, Default)]
pub struct MarketSummary {
    pub date: String,
}

pub type MarketSummaryResult = CompositeResult<MarketSummary, MarketComponent>;

#[derive(Clone, Debug, Default)]
pub struct WatchlistPrices {
    pub date: String,
    pub stocks: Vec<Row>,
}

pub type WatchlistPricesResult = CompositeResult<WatchlistPrices, SearchMarket>;

#[derive(Clone, Debug)]
pub struct KrxError {
    code: KrxErrorCode,
    message: String,
    http_status: Option<u16>,
    provider_code: Option<String>,
    operation_id: Option<OperationId>,
}

impl KrxError {
    fn new(code: KrxErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            http_status: None,
            provider_code: None,
            operation_id: None,
        }
    }

    #[doc(hidden)]
    #[cfg(feature = "probe-hooks")]
    pub fn from_probe_invalid_argument(message: impl Into<String>) -> Self {
        Self::new(KrxErrorCode::InvalidArgument, message)
    }

    fn for_operation(mut self, operation_id: OperationId) -> Self {
        self.operation_id = Some(operation_id);
        self
    }

    fn with_http_status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }

    fn with_provider_code(mut self, code: Option<String>) -> Self {
        self.provider_code = code;
        self
    }

    pub fn kind(&self) -> KrxErrorKind {
        self.code.kind()
    }

    pub fn code(&self) -> KrxErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn retryable(&self) -> bool {
        self.code.retryable()
    }

    pub fn http_status(&self) -> Option<u16> {
        self.http_status
    }

    pub fn provider_code(&self) -> Option<&str> {
        self.provider_code.as_deref()
    }

    pub fn operation_id(&self) -> Option<OperationId> {
        self.operation_id
    }
}

impl fmt::Display for KrxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for KrxError {}

#[derive(Clone)]
pub struct Client {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    http: reqwest::Client,
    base_url: Url,
    api_key: Option<ApiKey>,
    attempt_timeout: Duration,
    cache_max_age: Duration,
    credential_backend: Arc<dyn CredentialBackend>,
}

pub struct ClientBuilder {
    api_key: Option<ApiKey>,
    base_url: Url,
    attempt_timeout: Duration,
    cache_max_age: Duration,
    credential_backend: Arc<dyn CredentialBackend>,
}

impl ClientBuilder {
    pub fn api_key(mut self, api_key: ApiKey) -> Self {
        self.api_key = Some(api_key);
        self
    }

    pub fn cache_max_age(mut self, max_age: Duration) -> Self {
        self.cache_max_age = max_age;
        self
    }

    #[cfg(any(test, feature = "probe-hooks"))]
    pub fn probe_base_url(mut self, base_url: &str) -> Result<Self, KrxError> {
        let parsed = Url::parse(base_url).map_err(|_| {
            KrxError::new(KrxErrorCode::InvalidArgument, "probe base URL is invalid")
        })?;
        let loopback = parsed
            .host_str()
            .and_then(|host| host.parse::<IpAddr>().ok())
            .is_some_and(|address| address.is_loopback());
        if parsed.scheme() != "http"
            || !loopback
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
        {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "probe transport requires an isolated loopback fixture",
            ));
        }
        self.base_url = parsed;
        Ok(self)
    }

    #[cfg(any(test, feature = "probe-hooks"))]
    pub fn probe_attempt_timeout(mut self, duration: Duration) -> Self {
        self.attempt_timeout = duration;
        self
    }

    pub fn build(self) -> Result<Client, KrxError> {
        let official_url = Url::parse(OFFICIAL_SERVER).expect("canonical server URL is validated");
        let alternate_transport = self.base_url != official_url;
        let fixture_credential = self
            .api_key
            .as_ref()
            .is_some_and(|api_key| api_key.expose() == "fixture-key");
        if alternate_transport && !fixture_credential {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "probe transport requires an isolated loopback fixture",
            ));
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(self.attempt_timeout)
            .build()
            .map_err(|_| {
                KrxError::new(
                    KrxErrorCode::InternalFailure,
                    "failed to initialize the HTTP transport",
                )
            })?;
        Ok(Client {
            inner: Arc::new(ClientInner {
                http,
                base_url: self.base_url,
                api_key: self.api_key,
                attempt_timeout: self.attempt_timeout,
                cache_max_age: self.cache_max_age,
                credential_backend: self.credential_backend,
            }),
        })
    }
}

impl Client {
    pub fn builder() -> ClientBuilder {
        ClientBuilder {
            api_key: None,
            base_url: Url::parse(OFFICIAL_SERVER).expect("canonical server URL is validated"),
            attempt_timeout: Duration::from_secs(15),
            cache_max_age: Duration::from_secs(168 * 60 * 60),
            credential_backend: Arc::new(NativeCredentialBackend::canonical()),
        }
    }

    pub async fn query(&self, request: DirectRequest) -> Result<QueryResult, KrxError> {
        if request.options.retries > 3 {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "retry count must be between zero and three",
            ));
        }
        if request.operation != OperationId::StockStkByddTrd {
            return Err(KrxError::new(
                KrxErrorCode::InternalFailure,
                "operation is intentionally outside the disposable probe",
            )
            .for_operation(request.operation));
        }
        if matches!(request.options.cache, CachePolicy::Offline) {
            return Err(KrxError::new(
                KrxErrorCode::CacheMiss,
                "the disposable probe contains no persistent cache",
            )
            .for_operation(request.operation));
        }
        if request.options.cancellation.is_cancelled() {
            return Err(cancelled_error(request.operation));
        }
        self.query_representative(request).await
    }

    async fn query_representative(&self, request: DirectRequest) -> Result<QueryResult, KrxError> {
        let api_key = self.inner.api_key.as_ref().ok_or_else(|| {
            KrxError::new(KrxErrorCode::CredentialMissing, "KRX credential is missing")
                .for_operation(request.operation)
        })?;
        let url = self
            .inner
            .base_url
            .join(PROVIDER_PATH.trim_start_matches('/'))
            .map_err(|_| {
                KrxError::new(
                    KrxErrorCode::InternalFailure,
                    "canonical provider URL could not be constructed",
                )
            })?;
        let method = reqwest::Method::from_bytes(METHOD.as_bytes()).map_err(|_| {
            KrxError::new(
                KrxErrorCode::InternalFailure,
                "canonical provider method is invalid",
            )
        })?;
        let auth_name = HeaderName::from_bytes(AUTH_HEADER.as_bytes()).map_err(|_| {
            KrxError::new(
                KrxErrorCode::InternalFailure,
                "canonical credential header is invalid",
            )
        })?;
        let auth_value = HeaderValue::from_str(api_key.expose()).map_err(|_| {
            KrxError::new(
                KrxErrorCode::InvalidArgument,
                "API key contains invalid header bytes",
            )
        })?;
        let mut body = Map::new();
        body.insert(
            REQUEST_DATE_FIELD.to_owned(),
            Value::String(request.date.as_str().to_owned()),
        );
        let body = serde_json::to_vec(&Value::Object(body)).map_err(|_| {
            KrxError::new(
                KrxErrorCode::InternalFailure,
                "request body serialization failed",
            )
        })?;
        let send = self
            .inner
            .http
            .request(method, url)
            .header(auth_name, auth_value)
            .header(CONTENT_TYPE_HEADER, CONTENT_TYPE)
            .body(body)
            .send();

        let attempt = async {
            let response = send.await.map_err(|_| {
                KrxError::new(KrxErrorCode::RequestFailed, "provider request failed")
                    .for_operation(request.operation)
            })?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                return Err(KrxError::new(
                    http_error_code(status),
                    "provider returned an unsuccessful HTTP status",
                )
                .with_http_status(status)
                .for_operation(request.operation));
            }
            const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    KrxError::new(KrxErrorCode::RequestFailed, "provider response read failed")
                        .for_operation(request.operation)
                })?;
                if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
                    return Err(KrxError::new(
                        KrxErrorCode::InvalidEnvelope,
                        "provider response exceeded the probe limit",
                    )
                    .for_operation(request.operation));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        };

        let bytes = tokio::select! {
            _ = request.options.cancellation.cancelled() => {
                return Err(cancelled_error(request.operation));
            }
            result = timeout(self.inner.attempt_timeout, attempt) => {
                match result {
                    Err(_) => return Err(KrxError::new(KrxErrorCode::DeadlineExceeded, "provider attempt timed out").for_operation(request.operation)),
                    Ok(Err(error)) => return Err(error),
                    Ok(Ok(bytes)) => bytes,
                }
            }
        };
        decode_representative(&bytes, request.operation, api_key.expose())
    }

    pub async fn range(&self, _request: RangeRequest) -> Result<RangeResult, KrxError> {
        Err(probe_only_error())
    }

    pub async fn search_stocks(
        &self,
        _request: StockSearchRequest,
    ) -> Result<StockSearchResult, KrxError> {
        Err(probe_only_error())
    }

    pub async fn market_summary(
        &self,
        _request: MarketSummaryRequest,
    ) -> Result<MarketSummaryResult, KrxError> {
        Err(probe_only_error())
    }

    pub async fn watchlist_prices(
        &self,
        _request: WatchlistPricesRequest,
    ) -> Result<WatchlistPricesResult, KrxError> {
        Err(probe_only_error())
    }

    pub fn capabilities(&self) -> &'static [OperationDescription] {
        GENERATED_CAPABILITIES
    }

    pub fn credentials(&self) -> CredentialStore {
        CredentialStore {
            explicit: self.inner.api_key.is_some(),
            backend: Arc::clone(&self.inner.credential_backend),
        }
    }

    pub fn cache(&self) -> CacheStore {
        let _ = self.inner.cache_max_age;
        CacheStore
    }

    pub fn watchlist(&self) -> WatchlistStore {
        WatchlistStore
    }
}

fn cancelled_error(operation: OperationId) -> KrxError {
    KrxError::new(KrxErrorCode::RequestCancelled, "request was cancelled").for_operation(operation)
}

fn probe_only_error() -> KrxError {
    KrxError::new(
        KrxErrorCode::InternalFailure,
        "operation is intentionally outside the disposable probe",
    )
}

fn decode_representative(
    bytes: &[u8],
    operation: OperationId,
    credential: &str,
) -> Result<QueryResult, KrxError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        KrxError::new(INVALID_JSON, "provider returned malformed JSON").for_operation(operation)
    })?;
    let object = value.as_object().ok_or_else(|| {
        KrxError::new(INVALID_ENVELOPE, "provider response must be an object")
            .for_operation(operation)
    })?;
    if object.contains_key(PROVIDER_CODE_FIELD) || object.contains_key(PROVIDER_MESSAGE_FIELD) {
        let provider_code = object
            .get(PROVIDER_CODE_FIELD)
            .and_then(Value::as_str)
            .map(|code| sanitize_provider_code(code, credential));
        return Err(
            KrxError::new(PROVIDER_ERROR, "provider rejected the request")
                .with_provider_code(provider_code)
                .for_operation(operation),
        );
    }
    if object.len() != 1 {
        return Err(KrxError::new(
            INVALID_ENVELOPE,
            "provider success envelope contains unknown fields",
        )
        .for_operation(operation));
    }
    let rows = object
        .get(SUCCESS_ENVELOPE)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            KrxError::new(INVALID_ENVELOPE, "provider success envelope is invalid")
                .for_operation(operation)
        })?;
    let expected = REPRESENTATIVE_FIELDS
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let mut decoded = Vec::with_capacity(rows.len());
    for row in rows {
        let row = row.as_object().ok_or_else(|| {
            KrxError::new(INVALID_ROW, "provider row must be an object").for_operation(operation)
        })?;
        let actual = row
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        if actual != expected {
            return Err(KrxError::new(
                INVALID_ROW,
                "provider row fields do not match the canonical contract",
            )
            .for_operation(operation));
        }
        let mut fields = BTreeMap::new();
        for field in REPRESENTATIVE_FIELDS {
            let value = row.get(*field).and_then(Value::as_str).ok_or_else(|| {
                KrxError::new(INVALID_ROW, "provider row field must be a string")
                    .for_operation(operation)
            })?;
            fields.insert((*field).to_owned(), value.to_owned());
        }
        decoded.push(Row(fields));
    }
    let contract_id = GENERATED_CAPABILITIES
        .iter()
        .find(|description| description.operation_id == operation)
        .expect("generated representative capability")
        .contract_id;
    Ok(QueryResult {
        rows: decoded,
        provenance: ResultProvenance {
            source: ResultSource::Network,
            fetched_at: SystemTime::now(),
            freshness: Freshness::Fresh,
            contract_id,
        },
    })
}

fn sanitize_provider_code(code: &str, credential: &str) -> String {
    code.replace(credential, "[REDACTED]")
        .chars()
        .take(240)
        .collect()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialSource {
    Explicit,
    Environment,
    Keychain,
    Missing,
}

#[derive(Clone, Debug)]
pub struct CredentialStatus {
    pub source: CredentialSource,
    pub persisted: bool,
}

#[derive(Clone, Debug)]
pub struct ApprovalObservation {
    pub category: ApprovalCategory,
}

#[derive(Clone, Debug)]
pub struct CredentialMigrationResult {
    pub migrated: bool,
    pub legacy_secret_removed: bool,
    pub approvals_migrated: usize,
}

#[derive(Clone)]
pub struct CredentialStore {
    explicit: bool,
    backend: Arc<dyn CredentialBackend>,
}

impl CredentialStore {
    pub async fn status(&self) -> Result<CredentialStatus, KrxError> {
        if self.explicit {
            return Ok(CredentialStatus {
                source: CredentialSource::Explicit,
                persisted: false,
            });
        }
        self.status_with_environment(std::env::var("KRX_API_KEY"))
            .await
    }

    async fn status_with_environment(
        &self,
        environment: Result<String, VarError>,
    ) -> Result<CredentialStatus, KrxError> {
        match environment {
            Ok(value) => {
                ApiKey::parse(&value)?;
                return Ok(CredentialStatus {
                    source: CredentialSource::Environment,
                    persisted: false,
                });
            }
            Err(VarError::NotPresent) => {}
            Err(VarError::NotUnicode(_)) => {
                return Err(KrxError::new(
                    KrxErrorCode::InvalidArgument,
                    "API key must be a non-empty token",
                ));
            }
        }
        let backend = Arc::clone(&self.backend);
        let present = tokio::task::spawn_blocking(move || backend.get())
            .await
            .map_err(|_| credential_store_error("credential task failed"))??;
        Ok(CredentialStatus {
            source: if present.is_some() {
                CredentialSource::Keychain
            } else {
                CredentialSource::Missing
            },
            persisted: present.is_some(),
        })
    }

    pub async fn set(&self, api_key: ApiKey) -> Result<(), KrxError> {
        let secret = api_key.expose().to_owned();
        let backend = Arc::clone(&self.backend);
        tokio::task::spawn_blocking(move || {
            backend.set(&secret)?;
            let read_back = backend.get()?.ok_or_else(|| {
                KrxError::new(
                    KrxErrorCode::CredentialVerifyFailed,
                    "credential verification failed",
                )
            })?;
            if read_back != secret {
                return Err(KrxError::new(
                    KrxErrorCode::CredentialVerifyFailed,
                    "credential verification failed",
                ));
            }
            Ok(())
        })
        .await
        .map_err(|_| credential_store_error("credential task failed"))?
    }

    pub async fn remove(&self) -> Result<bool, KrxError> {
        let backend = Arc::clone(&self.backend);
        tokio::task::spawn_blocking(move || backend.remove())
            .await
            .map_err(|_| credential_store_error("credential task failed"))?
    }

    pub async fn approval_status(
        &self,
        _category: ApprovalCategory,
    ) -> Result<Option<ApprovalObservation>, KrxError> {
        Err(probe_only_error())
    }

    pub async fn check_approval(
        &self,
        _category: ApprovalCategory,
        _cancellation: Cancellation,
    ) -> Result<ApprovalObservation, KrxError> {
        Err(probe_only_error())
    }

    pub async fn migrate_legacy(&self) -> Result<CredentialMigrationResult, KrxError> {
        Err(probe_only_error())
    }
}

trait CredentialBackend: Send + Sync {
    fn get(&self) -> Result<Option<String>, KrxError>;
    fn set(&self, secret: &str) -> Result<(), KrxError>;
    fn remove(&self) -> Result<bool, KrxError>;
}

struct NativeCredentialBackend {
    service: String,
    account: String,
}

impl NativeCredentialBackend {
    fn canonical() -> Self {
        Self {
            service: KEYRING_SERVICE.to_owned(),
            account: KEYRING_ACCOUNT.to_owned(),
        }
    }

    #[cfg(test)]
    fn for_probe(account: String) -> Self {
        Self {
            service: "krx-cli-disposable-probe".to_owned(),
            account,
        }
    }

    fn entry(&self) -> Result<keyring::Entry, KrxError> {
        let entry = keyring::Entry::new(&self.service, &self.account)
            .map_err(|_| credential_store_error("credential store is unavailable"))?;
        Ok(entry)
    }
}

impl CredentialBackend for NativeCredentialBackend {
    fn get(&self) -> Result<Option<String>, KrxError> {
        let entry = self.entry()?;
        match entry.get_password() {
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

fn credential_store_error(message: &str) -> KrxError {
    KrxError::new(KrxErrorCode::CredentialStoreUnavailable, message)
}

#[derive(Clone, Debug, Default)]
pub struct CacheInspectOptions {
    _private: (),
}

#[derive(Clone, Debug, Default)]
pub struct CachePruneOptions {
    _private: (),
}

#[derive(Clone, Debug, Default)]
pub struct CacheInspection {
    pub total_entries: usize,
}

#[derive(Clone, Debug, Default)]
pub struct CachePruneResult {
    pub removed_entries: usize,
    pub removed_bytes: u64,
}

#[derive(Clone, Copy)]
pub struct CacheStore;

impl CacheStore {
    pub async fn inspect(
        &self,
        _options: CacheInspectOptions,
    ) -> Result<CacheInspection, KrxError> {
        Err(probe_only_error())
    }

    pub async fn prune(&self, _options: CachePruneOptions) -> Result<CachePruneResult, KrxError> {
        Err(probe_only_error())
    }

    pub async fn clear(&self) -> Result<CachePruneResult, KrxError> {
        Err(probe_only_error())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WatchlistMarket {
    Kospi,
    Kosdaq,
    Konex,
}

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
        if isin.len() != 12 || name.trim().is_empty() {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "watchlist entry is invalid",
            ));
        }
        Ok(Self {
            isin: isin.to_owned(),
            security_code: SecurityCode::parse(security_code)?,
            name: name.trim().to_owned(),
            market,
        })
    }
}

#[derive(Clone, Copy)]
pub struct WatchlistStore;

impl WatchlistStore {
    pub async fn list(&self) -> Result<Vec<WatchlistEntry>, KrxError> {
        Err(probe_only_error())
    }

    pub async fn add(&self, _entry: WatchlistEntry) -> Result<bool, KrxError> {
        Err(probe_only_error())
    }

    pub async fn remove(&self, _security_code: &str) -> Result<bool, KrxError> {
        Err(probe_only_error())
    }
}

#[cfg(test)]
mod tests;
