use std::cell::Cell;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::pin;
use std::sync::Once;
use std::time::{Duration, SystemTime};

#[cfg(test)]
use std::time::UNIX_EPOCH;

use futures_util::FutureExt;
use krx_sdk::{
    AdjustmentFactorField, AdjustmentMetadata, ApiKey, ApprovalCategory, ApprovalObservation,
    ApprovalState, CacheEntryDescription, CacheInspectOptions, CacheInspection, CachePolicy,
    CachePruneOptions, CachePruneResult, CalendarCoverage, CalendarSelection, CallOptions,
    Cancellation, CashDividendTreatment, Client, Completeness, CompletenessState, CompositeFailure,
    CompositeResult, CredentialMigrationResult, CredentialSource, CredentialStatus, DateRange,
    DirectRequest, Freshness, KrxError, KrxErrorCode, MarketComponent, MarketSummary,
    MarketSummaryRequest, OperationDescription, OperationId, QueryResult, RangeMode, RangeRequest,
    RangeResult, ResultProvenance, ResultSource, Row, SearchMarket, SecurityCode, StockSearchMatch,
    StockSearchRequest, StockSearchResult, StockStats, TradingDate, WatchlistMarket,
    WatchlistPrices, WatchlistPricesRequest, WatchlistPricesResult,
};
use napi::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

const INTERNAL_MESSAGE: &str = "native operation failed internally";

static INSTALL_PANIC_HOOK: Once = Once::new();

thread_local! {
    static REDACT_BOUNDARY_PANIC: Cell<bool> = const { Cell::new(false) };
}

struct BoundaryPanicGuard {
    previous: bool,
}

impl BoundaryPanicGuard {
    fn enter() -> Self {
        let previous = REDACT_BOUNDARY_PANIC.with(|active| active.replace(true));
        Self { previous }
    }
}

impl Drop for BoundaryPanicGuard {
    fn drop(&mut self) {
        let _ = REDACT_BOUNDARY_PANIC.try_with(|active| active.set(self.previous));
    }
}

fn ensure_boundary_panic_hook() {
    INSTALL_PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |information| {
            let redact = REDACT_BOUNDARY_PANIC.try_with(Cell::get).unwrap_or(false);
            if !redact {
                previous(information);
            }
        }));
    });
}

enum BoundaryError {
    Project(KrxError),
    Contract(Box<NativeError>),
}

impl From<KrxError> for BoundaryError {
    fn from(error: KrxError) -> Self {
        Self::Project(error)
    }
}

type BoundaryResult<T> = Result<T, BoundaryError>;

enum NativeClientState {
    Ready(Client),
    Failed(NativeError),
}

#[napi]
pub struct NativeClient {
    state: NativeClientState,
}

#[napi]
impl NativeClient {
    #[napi(constructor)]
    pub fn new(api_key: Option<String>) -> Self {
        ensure_boundary_panic_hook();
        let result = {
            let _guard = BoundaryPanicGuard::enter();
            catch_unwind(AssertUnwindSafe(|| build_client(api_key)))
        };
        let state = match result {
            Ok(Ok(client)) => NativeClientState::Ready(client),
            Ok(Err(error)) => NativeClientState::Failed(native_error(&error)),
            Err(_) => NativeClientState::Failed(internal_error()),
        };
        Self { state }
    }
}

impl NativeClient {
    fn client(&self) -> BoundaryResult<&Client> {
        match &self.state {
            NativeClientState::Ready(client) => Ok(client),
            NativeClientState::Failed(error) => {
                Err(BoundaryError::Contract(Box::new(error.clone())))
            }
        }
    }
}

#[napi]
pub struct NativeCancellation {
    inner: Cancellation,
}

#[napi]
impl NativeCancellation {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Cancellation::new(),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.inner.cancel();
    }

    #[napi(getter)]
    pub fn is_cancelled(&self) -> bool {
        self.inner.is_cancelled()
    }
}

impl Default for NativeCancellation {
    fn default() -> Self {
        Self::new()
    }
}

#[napi(object)]
pub struct NativeOutcome {
    pub ok: bool,
    pub value_json: Option<String>,
    pub error: Option<NativeError>,
}

#[derive(Clone)]
#[napi(object)]
pub struct NativeError {
    pub kind: String,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub http_status: Option<u32>,
    pub provider_code: Option<String>,
    pub operation_id: Option<String>,
}

#[napi(catch_unwind)]
pub async fn native_query(
    native_client: &NativeClient,
    operation: String,
    date: String,
    cache_mode: Option<String>,
    cache_max_age_hours: Option<f64>,
    retries: Option<u32>,
    cancellation: &NativeCancellation,
) -> NapiResult<NativeOutcome> {
    let cancellation = cancellation.inner.clone();
    Ok(run(async move {
        let client = native_client.client()?;
        let operation = parse_operation(&operation)?;
        let date = TradingDate::parse(&date)?;
        let options = call_options(cache_mode, cache_max_age_hours, retries, cancellation)?;
        let result = client
            .query(DirectRequest {
                operation,
                date,
                options,
            })
            .await?;
        Ok(query_result_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
#[allow(clippy::too_many_arguments)]
pub async fn native_range(
    native_client: &NativeClient,
    operation: String,
    from: String,
    to: String,
    adjusted: bool,
    security_code: Option<String>,
    cache_mode: Option<String>,
    cache_max_age_hours: Option<f64>,
    retries: Option<u32>,
    cancellation: &NativeCancellation,
) -> NapiResult<NativeOutcome> {
    let cancellation = cancellation.inner.clone();
    Ok(run(async move {
        let client = native_client.client()?;
        let operation = parse_operation(&operation)?;
        let range = DateRange::new(TradingDate::parse(&from)?, TradingDate::parse(&to)?)?;
        let mode = if adjusted {
            let security_code = security_code.ok_or_else(|| {
                invalid(
                    KrxErrorCode::ConflictingOptions,
                    "adjusted ranges require one exact eligible security code",
                )
            })?;
            RangeMode::Adjusted {
                security_code: SecurityCode::parse(&security_code)?,
            }
        } else {
            RangeMode::Raw
        };
        let options = call_options(cache_mode, cache_max_age_hours, retries, cancellation)?;
        let result = client
            .range(RangeRequest {
                operation,
                range,
                mode,
                options,
            })
            .await?;
        Ok(range_result_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_search_stocks(
    native_client: &NativeClient,
    query: String,
    cache_mode: Option<String>,
    cache_max_age_hours: Option<f64>,
    cancellation: &NativeCancellation,
) -> NapiResult<NativeOutcome> {
    let cancellation = cancellation.inner.clone();
    Ok(run(async move {
        let client = native_client.client()?;
        let options = call_options(cache_mode, cache_max_age_hours, None, cancellation)?;
        let result = client
            .search_stocks(StockSearchRequest::new(&query, options)?)
            .await?;
        Ok(stock_search_result_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_market_summary(
    native_client: &NativeClient,
    date: String,
    cache_mode: Option<String>,
    cache_max_age_hours: Option<f64>,
    cancellation: &NativeCancellation,
) -> NapiResult<NativeOutcome> {
    let cancellation = cancellation.inner.clone();
    Ok(run(async move {
        let client = native_client.client()?;
        let date = TradingDate::parse(&date)?;
        let options = call_options(cache_mode, cache_max_age_hours, None, cancellation)?;
        let result = client
            .market_summary(MarketSummaryRequest::new(date, options))
            .await?;
        Ok(market_summary_result_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_watchlist_prices(
    native_client: &NativeClient,
    date: String,
    security_codes: Vec<String>,
    cache_mode: Option<String>,
    cache_max_age_hours: Option<f64>,
    cancellation: &NativeCancellation,
) -> NapiResult<NativeOutcome> {
    let cancellation = cancellation.inner.clone();
    Ok(run(async move {
        let client = native_client.client()?;
        let date = TradingDate::parse(&date)?;
        let security_codes = security_codes
            .iter()
            .map(|value| SecurityCode::parse(value))
            .collect::<Result<Vec<_>, _>>()?;
        let options = call_options(cache_mode, cache_max_age_hours, None, cancellation)?;
        let result = client
            .watchlist_prices(WatchlistPricesRequest::new(date, security_codes, options)?)
            .await?;
        Ok(watchlist_prices_result_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
pub fn native_capabilities(native_client: &NativeClient) -> NapiResult<NativeOutcome> {
    Ok(run_sync(|| {
        let client = native_client.client()?;
        Ok(capabilities_value(client.capabilities()))
    }))
}

#[napi(catch_unwind)]
pub async fn native_credential_status(native_client: &NativeClient) -> NapiResult<NativeOutcome> {
    Ok(run(async move {
        let client = native_client.client()?;
        let status = client.credentials().status().await?;
        Ok(credential_status_value(&status))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_credential_set(
    native_client: &NativeClient,
    api_key: String,
) -> NapiResult<NativeOutcome> {
    Ok(run(async move {
        let api_key = Zeroizing::new(api_key);
        let api_key = ApiKey::parse(api_key.as_str())?;
        let client = native_client.client()?;
        client.credentials().set(api_key).await?;
        Ok(Value::Null)
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_credential_remove(native_client: &NativeClient) -> NapiResult<NativeOutcome> {
    Ok(run(async move {
        let client = native_client.client()?;
        Ok(Value::Bool(client.credentials().remove().await?))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_credential_migrate_legacy(
    native_client: &NativeClient,
) -> NapiResult<NativeOutcome> {
    Ok(run(async move {
        let client = native_client.client()?;
        let result = client.credentials().migrate_legacy().await?;
        Ok(credential_migration_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_approval_status(
    native_client: &NativeClient,
    category: String,
) -> NapiResult<NativeOutcome> {
    Ok(run(async move {
        let client = native_client.client()?;
        let category = parse_approval_category(&category)?;
        let result = client.credentials().approval_status(category).await?;
        Ok(result
            .as_ref()
            .map(approval_observation_value)
            .unwrap_or(Value::Null))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_check_approval(
    native_client: &NativeClient,
    category: String,
    cancellation: &NativeCancellation,
) -> NapiResult<NativeOutcome> {
    let cancellation = cancellation.inner.clone();
    Ok(run(async move {
        let client = native_client.client()?;
        let category = parse_approval_category(&category)?;
        let result = client
            .credentials()
            .check_approval(category, cancellation)
            .await?;
        Ok(approval_observation_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_cache_inspect(
    native_client: &NativeClient,
    operation: Option<String>,
    date: Option<String>,
    limit: Option<u32>,
) -> NapiResult<NativeOutcome> {
    Ok(run(async move {
        let client = native_client.client()?;
        let operation = operation.as_deref().map(parse_operation).transpose()?;
        let date = date.as_deref().map(TradingDate::parse).transpose()?;
        let result = client
            .cache()
            .inspect(CacheInspectOptions {
                operation,
                date,
                limit: limit.map(|value| value as usize),
            })
            .await?;
        Ok(cache_inspection_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_cache_prune(
    native_client: &NativeClient,
    older_than: Option<String>,
    max_entries: Option<u32>,
) -> NapiResult<NativeOutcome> {
    Ok(run(async move {
        let client = native_client.client()?;
        let older_than = older_than
            .as_deref()
            .map(system_time_from_timestamp)
            .transpose()?;
        let result = client
            .cache()
            .prune(CachePruneOptions {
                older_than,
                max_entries: max_entries.map(|value| value as usize),
            })
            .await?;
        Ok(cache_prune_value(&result))
    })
    .await)
}

#[napi(catch_unwind)]
pub async fn native_cache_clear(native_client: &NativeClient) -> NapiResult<NativeOutcome> {
    Ok(run(async move {
        let client = native_client.client()?;
        let result = client.cache().clear().await?;
        Ok(cache_prune_value(&result))
    })
    .await)
}

async fn run<F>(future: F) -> NativeOutcome
where
    F: Future<Output = BoundaryResult<Value>>,
{
    ensure_boundary_panic_hook();
    let mut future = pin!(future);
    let guarded = std::future::poll_fn(move |context| {
        let _guard = BoundaryPanicGuard::enter();
        future.as_mut().poll(context)
    });
    match AssertUnwindSafe(guarded).catch_unwind().await {
        Ok(Ok(value)) => success(value),
        Ok(Err(error)) => boundary_error_outcome(error),
        Err(_) => internal_failure(),
    }
}

fn run_sync<F>(operation: F) -> NativeOutcome
where
    F: FnOnce() -> BoundaryResult<Value>,
{
    ensure_boundary_panic_hook();
    let result = {
        let _guard = BoundaryPanicGuard::enter();
        catch_unwind(AssertUnwindSafe(operation))
    };
    match result {
        Ok(Ok(value)) => success(value),
        Ok(Err(error)) => boundary_error_outcome(error),
        Err(_) => internal_failure(),
    }
}

fn build_client(api_key: Option<String>) -> Result<Client, KrxError> {
    let mut builder = Client::builder();
    if let Some(api_key) = api_key {
        let api_key = Zeroizing::new(api_key);
        builder = builder.api_key(ApiKey::parse(api_key.as_str())?);
    }
    builder.build()
}

fn call_options(
    cache_mode: Option<String>,
    cache_max_age_hours: Option<f64>,
    retries: Option<u32>,
    cancellation: Cancellation,
) -> BoundaryResult<CallOptions> {
    let defaults = CallOptions::default();
    let retries = retries.unwrap_or(u32::from(defaults.retries));
    let retries = u8::try_from(retries).map_err(|_| {
        invalid(
            KrxErrorCode::InvalidArgument,
            "retry count must be between zero and three",
        )
    })?;
    let cache = match cache_mode.as_deref().unwrap_or("prefer") {
        "prefer" => CachePolicy::Prefer {
            max_age: match cache_max_age_hours {
                Some(hours) => duration_from_hours(hours)?,
                None => match defaults.cache {
                    CachePolicy::Prefer { max_age } => max_age,
                    _ => unreachable!("SDK default cache policy is Prefer"),
                },
            },
        },
        "refresh" => CachePolicy::Refresh,
        "bypass" => CachePolicy::Bypass,
        "offline" => CachePolicy::Offline,
        _ => {
            return Err(invalid(
                KrxErrorCode::InvalidArgument,
                "cache mode is invalid",
            ));
        }
    };
    Ok(CallOptions {
        cache,
        retries,
        cancellation,
    })
}

fn duration_from_hours(hours: f64) -> BoundaryResult<Duration> {
    if !hours.is_finite() || hours < 0.0 {
        return Err(invalid(
            KrxErrorCode::InvalidArgument,
            "cache max age must be a finite non-negative number of hours",
        ));
    }
    Duration::try_from_secs_f64(hours * 60.0 * 60.0).map_err(|_| {
        invalid(
            KrxErrorCode::InvalidArgument,
            "cache max age is outside the supported duration range",
        )
    })
}

fn parse_operation(value: &str) -> BoundaryResult<OperationId> {
    OperationId::ALL
        .iter()
        .copied()
        .find(|operation| operation.as_str() == value)
        .ok_or_else(|| {
            invalid(
                KrxErrorCode::InvalidOperation,
                "operation is not part of the canonical KRX contract",
            )
        })
}

fn parse_approval_category(value: &str) -> BoundaryResult<ApprovalCategory> {
    match value {
        "index" => Ok(ApprovalCategory::Index),
        "stock" => Ok(ApprovalCategory::Stock),
        "etp" => Ok(ApprovalCategory::Etp),
        "bond" => Ok(ApprovalCategory::Bond),
        "derivative" => Ok(ApprovalCategory::Derivative),
        "commodity" => Ok(ApprovalCategory::Commodity),
        "esg" => Ok(ApprovalCategory::Esg),
        _ => Err(invalid(
            KrxErrorCode::InvalidArgument,
            "approval category is invalid",
        )),
    }
}

fn success(value: Value) -> NativeOutcome {
    match serde_json::to_string(&value) {
        Ok(value_json) => NativeOutcome {
            ok: true,
            value_json: Some(value_json),
            error: None,
        },
        Err(_) => internal_failure(),
    }
}

fn error_outcome(error: &KrxError) -> NativeOutcome {
    NativeOutcome {
        ok: false,
        value_json: None,
        error: Some(native_error(error)),
    }
}

fn boundary_error_outcome(error: BoundaryError) -> NativeOutcome {
    match error {
        BoundaryError::Project(error) => error_outcome(&error),
        BoundaryError::Contract(error) => NativeOutcome {
            ok: false,
            value_json: None,
            error: Some(*error),
        },
    }
}

fn native_error(error: &KrxError) -> NativeError {
    NativeError {
        kind: error.kind().as_str().to_owned(),
        code: error.code().as_str().to_owned(),
        message: error.message().to_owned(),
        retryable: error.retryable(),
        http_status: error.http_status().map(u32::from),
        provider_code: error.provider_code().map(str::to_owned),
        operation_id: error.operation_id().map(|value| value.as_str().to_owned()),
    }
}

fn internal_failure() -> NativeOutcome {
    NativeOutcome {
        ok: false,
        value_json: None,
        error: Some(internal_error()),
    }
}

fn internal_error() -> NativeError {
    NativeError {
        kind: "internal".to_owned(),
        code: "internal_failure".to_owned(),
        message: INTERNAL_MESSAGE.to_owned(),
        retryable: false,
        http_status: None,
        provider_code: None,
        operation_id: None,
    }
}

fn invalid(code: KrxErrorCode, message: &str) -> BoundaryError {
    BoundaryError::Contract(Box::new(NativeError {
        kind: code.kind().as_str().to_owned(),
        code: code.as_str().to_owned(),
        message: message.to_owned(),
        retryable: code.retryable(),
        http_status: None,
        provider_code: None,
        operation_id: None,
    }))
}

fn query_result_value(result: &QueryResult) -> Value {
    json!({
        "data": rows_value(&result.rows),
        "provenance": provenance_value(&result.provenance),
    })
}

fn range_result_value(result: &RangeResult) -> Value {
    let mut value = composite_value(
        &result.result,
        |rows| rows_value(rows),
        |date| date.as_str().to_owned(),
    );
    let object = value
        .as_object_mut()
        .expect("composite projection is an object");
    object.insert("fetchedDays".to_owned(), json!(result.fetched_days));
    object.insert("failedDays".to_owned(), json!(result.failed_days));
    object.insert("calendar".to_owned(), calendar_value(&result.calendar));
    if let Some(adjustment) = &result.adjustment {
        object.insert("adjustment".to_owned(), adjustment_value(adjustment));
    }
    value
}

fn stock_search_result_value(result: &StockSearchResult) -> Value {
    composite_value(
        result,
        |matches| stock_search_matches_value(matches.as_slice()),
        |market| search_market(market).to_owned(),
    )
}

fn market_summary_result_value(result: &krx_sdk::MarketSummaryResult) -> Value {
    composite_value(result, market_summary_value, |component| {
        market_component(component).to_owned()
    })
}

fn watchlist_prices_result_value(result: &WatchlistPricesResult) -> Value {
    composite_value(result, watchlist_prices_value, |market| {
        watchlist_market(market).to_owned()
    })
}

fn composite_value<Data, Id, DataValue, IdValue>(
    result: &CompositeResult<Data, Id>,
    data_value: DataValue,
    id_value: IdValue,
) -> Value
where
    Id: Ord,
    DataValue: Fn(&Data) -> Value,
    IdValue: Fn(&Id) -> String,
{
    let provenance = result
        .provenance
        .iter()
        .map(|(id, provenance)| (id_value(id), provenance_value(provenance)))
        .collect::<Map<_, _>>();
    let mut object = Map::from_iter([
        ("success".to_owned(), Value::Bool(result.success)),
        ("data".to_owned(), data_value(&result.data)),
        (
            "completeness".to_owned(),
            completeness_value(&result.completeness, &id_value),
        ),
        ("provenance".to_owned(), Value::Object(provenance)),
    ]);
    if let Some(error) = &result.error {
        object.insert("error".to_owned(), failure_value(error));
    }
    Value::Object(object)
}

fn completeness_value<Id, IdValue>(completeness: &Completeness<Id>, id_value: &IdValue) -> Value
where
    IdValue: Fn(&Id) -> String,
{
    json!({
        "state": completeness_state(completeness.state),
        "requested": ids_value(&completeness.requested, id_value),
        "succeeded": ids_value(&completeness.succeeded, id_value),
        "failed": completeness.failed.iter().map(|failure| composite_failure_value(failure, id_value)).collect::<Vec<_>>(),
        "skipped": ids_value(&completeness.skipped, id_value),
    })
}

fn ids_value<Id, IdValue>(ids: &[Id], id_value: &IdValue) -> Vec<String>
where
    IdValue: Fn(&Id) -> String,
{
    ids.iter().map(id_value).collect()
}

fn composite_failure_value<Id, IdValue>(failure: &CompositeFailure<Id>, id_value: &IdValue) -> Value
where
    IdValue: Fn(&Id) -> String,
{
    json!({ "id": id_value(&failure.id), "error": failure_value(&failure.error) })
}

fn failure_value(error: &KrxError) -> Value {
    let mut value = Map::from_iter([
        ("name".to_owned(), Value::String("KrxError".to_owned())),
        (
            "kind".to_owned(),
            Value::String(error.kind().as_str().to_owned()),
        ),
        (
            "code".to_owned(),
            Value::String(error.code().as_str().to_owned()),
        ),
        (
            "message".to_owned(),
            Value::String(error.message().to_owned()),
        ),
        ("retryable".to_owned(), Value::Bool(error.retryable())),
    ]);
    if let Some(status) = error.http_status() {
        value.insert("httpStatus".to_owned(), json!(status));
    }
    if let Some(code) = error.provider_code() {
        value.insert("providerCode".to_owned(), Value::String(code.to_owned()));
    }
    if let Some(operation) = error.operation_id() {
        value.insert(
            "operationId".to_owned(),
            Value::String(operation.as_str().to_owned()),
        );
    }
    Value::Object(value)
}

fn rows_value(rows: &[Row]) -> Value {
    Value::Array(rows.iter().map(row_value).collect())
}

fn row_value(row: &Row) -> Value {
    Value::Object(
        row.iter()
            .map(|(field, value)| (field.to_owned(), Value::String(value.to_owned())))
            .collect(),
    )
}

fn provenance_value(provenance: &ResultProvenance) -> Value {
    json!({
        "source": match provenance.source { ResultSource::Network => "network", ResultSource::Cache => "cache" },
        "fetchedAt": system_time_string(provenance.fetched_at),
        "freshness": freshness(provenance.freshness),
        "contractId": provenance.contract_id,
    })
}

fn calendar_value(calendar: &CalendarSelection) -> Value {
    json!({
        "version": calendar.version,
        "source": calendar.source,
        "retrievedAt": calendar.retrieved_at.as_str(),
        "coverage": match calendar.coverage { CalendarCoverage::Official => "official", CalendarCoverage::Fallback => "fallback" },
        "unverifiedDates": calendar.unverified_dates.iter().map(TradingDate::as_str).collect::<Vec<_>>(),
    })
}

fn adjustment_value(adjustment: &AdjustmentMetadata) -> Value {
    json!({
        "method": adjustment.method,
        "version": adjustment.version,
        "asOf": adjustment.as_of.as_str(),
        "rounding": adjustment.rounding,
        "rawFields": adjustment.raw_fields,
        "adjustedFields": adjustment.adjusted_fields,
        "factorField": match adjustment.factor_field { AdjustmentFactorField::AdjFactor => "ADJ_FACTOR" },
        "basisTransitions": adjustment.basis_transitions,
        "cashDividends": match adjustment.cash_dividends { CashDividendTreatment::Excluded => "excluded" },
    })
}

fn stock_search_matches_value(matches: &[StockSearchMatch]) -> Value {
    Value::Array(
        matches
            .iter()
            .map(|stock| {
                json!({
                    "ISU_CD": stock.isu_cd,
                    "ISU_SRT_CD": stock.isu_srt_cd,
                    "ISU_NM": stock.isu_nm,
                    "market": search_market(&stock.market),
                })
            })
            .collect(),
    )
}

fn market_summary_value(summary: &MarketSummary) -> Value {
    json!({
        "date": summary.date.as_str(),
        "kospiIndex": summary.kospi_index.as_ref().map(|rows| rows_value(rows)),
        "kosdaqIndex": summary.kosdaq_index.as_ref().map(|rows| rows_value(rows)),
        "stockStats": summary.stock_stats.as_ref().map(stock_stats_value),
        "topGainers": summary.top_gainers.as_ref().map(|rows| rows_value(rows)),
        "topLosers": summary.top_losers.as_ref().map(|rows| rows_value(rows)),
    })
}

fn stock_stats_value(stats: &StockStats) -> Value {
    json!({
        "advancing": stats.advancing,
        "declining": stats.declining,
        "unchanged": stats.unchanged,
        "totalVolume": stats.total_volume,
        "totalValue": stats.total_value,
    })
}

fn watchlist_prices_value(prices: &WatchlistPrices) -> Value {
    json!({ "date": prices.date.as_str(), "stocks": rows_value(&prices.stocks) })
}

fn capabilities_value(capabilities: &[OperationDescription]) -> Value {
    Value::Array(
        capabilities
            .iter()
            .map(operation_description_value)
            .collect(),
    )
}

fn operation_description_value(description: &OperationDescription) -> Value {
    json!({
        "operationId": description.operation_id.as_str(),
        "category": approval_category(description.category),
        "description": description.description,
        "descriptionKo": description.description_ko,
        "contractId": description.contract_id,
        "requestFields": description.request_fields.iter().map(|field| json!({ "name": field.name, "description": field.description })).collect::<Vec<_>>(),
        "responseFields": description.response_fields.iter().map(|field| json!({ "name": field.name, "description": field.description })).collect::<Vec<_>>(),
    })
}

fn credential_status_value(status: &CredentialStatus) -> Value {
    json!({
        "source": match status.source {
            CredentialSource::Explicit => "explicit",
            CredentialSource::Environment => "environment",
            CredentialSource::Keychain => "keychain",
            CredentialSource::Missing => "missing",
        },
        "persisted": status.persisted,
    })
}

fn credential_migration_value(result: &CredentialMigrationResult) -> Value {
    json!({
        "migrated": result.migrated,
        "legacySecretRemoved": result.legacy_secret_removed,
        "approvalsMigrated": result.approvals_migrated,
    })
}

fn approval_observation_value(observation: &ApprovalObservation) -> Value {
    let mut value = Map::from_iter([
        (
            "category".to_owned(),
            Value::String(approval_category(observation.category).to_owned()),
        ),
        (
            "state".to_owned(),
            Value::String(
                match observation.state {
                    ApprovalState::Approved => "approved",
                    ApprovalState::Rejected => "rejected",
                    ApprovalState::Inconclusive => "inconclusive",
                }
                .to_owned(),
            ),
        ),
        (
            "checkedAt".to_owned(),
            Value::String(system_time_string(observation.checked_at)),
        ),
        (
            "validUntil".to_owned(),
            Value::String(system_time_string(observation.valid_until)),
        ),
        ("fresh".to_owned(), Value::Bool(observation.fresh)),
    ]);
    if let Some(error) = &observation.error {
        value.insert("error".to_owned(), failure_value(error));
    }
    Value::Object(value)
}

fn cache_inspection_value(inspection: &CacheInspection) -> Value {
    json!({
        "entries": inspection.entries.iter().map(cache_entry_value).collect::<Vec<_>>(),
        "totalEntries": inspection.total_entries,
        "totalSizeBytes": inspection.total_size_bytes,
        "truncated": inspection.truncated,
    })
}

fn cache_entry_value(entry: &CacheEntryDescription) -> Value {
    json!({
        "operation": entry.operation.as_str(),
        "date": entry.date.as_str(),
        "fetchedAt": system_time_string(entry.fetched_at),
        "freshness": freshness(entry.freshness),
        "sizeBytes": entry.size_bytes,
        "contractId": entry.contract_id,
    })
}

fn cache_prune_value(result: &CachePruneResult) -> Value {
    json!({ "removedEntries": result.removed_entries, "removedBytes": result.removed_bytes })
}

fn system_time_string(time: SystemTime) -> String {
    jiff::Timestamp::try_from(time)
        .map(|timestamp| timestamp.to_string())
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn system_time_from_timestamp(value: &str) -> BoundaryResult<SystemTime> {
    let timestamp = value.parse::<jiff::Timestamp>().map_err(|_| {
        invalid(
            KrxErrorCode::InvalidArgument,
            "cache prune timestamp must be an RFC 3339 instant",
        )
    })?;
    Ok(SystemTime::from(timestamp))
}

fn completeness_state(state: CompletenessState) -> &'static str {
    match state {
        CompletenessState::Complete => "complete",
        CompletenessState::Partial => "partial",
        CompletenessState::Empty => "empty",
        CompletenessState::Failed => "failed",
    }
}

fn freshness(value: Freshness) -> &'static str {
    match value {
        Freshness::Fresh => "fresh",
        Freshness::Stale => "stale",
    }
}

fn search_market(value: &SearchMarket) -> &'static str {
    match value {
        SearchMarket::Kospi => "KOSPI",
        SearchMarket::Kosdaq => "KOSDAQ",
    }
}

fn market_component(value: &MarketComponent) -> &'static str {
    match value {
        MarketComponent::KospiIndex => "kospiIndex",
        MarketComponent::KosdaqIndex => "kosdaqIndex",
        MarketComponent::KospiStocks => "kospiStocks",
        MarketComponent::KosdaqStocks => "kosdaqStocks",
    }
}

fn watchlist_market(value: &WatchlistMarket) -> &'static str {
    match value {
        WatchlistMarket::Kospi => "KOSPI",
        WatchlistMarket::Kosdaq => "KOSDAQ",
        WatchlistMarket::Konex => "KONEX",
    }
}

fn approval_category(value: ApprovalCategory) -> &'static str {
    match value {
        ApprovalCategory::Index => "index",
        ApprovalCategory::Stock => "stock",
        ApprovalCategory::Etp => "etp",
        ApprovalCategory::Bond => "bond",
        ApprovalCategory::Derivative => "derivative",
        ApprovalCategory::Commodity => "commodity",
        ApprovalCategory::Esg => "esg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANIC_PROBE_ENV: &str = "KRX_NODE_PANIC_REDACTION_PROBE";
    const SYNC_PANIC_SENTINEL: &str = "sync addon boundary secret";
    const ASYNC_PANIC_SENTINEL: &str = "async addon boundary secret";
    const OUTSIDE_PANIC_SENTINEL: &str = "unrelated panic remains visible";

    fn boundary_ok<T>(result: BoundaryResult<T>) -> T {
        match result {
            Ok(value) => value,
            Err(_) => panic!("expected boundary success"),
        }
    }

    fn assert_internal_failure(outcome: NativeOutcome) {
        assert!(!outcome.ok);
        assert!(outcome.value_json.is_none());
        let error = outcome.error.expect("failure has a stable error");
        assert_eq!(error.kind, "internal");
        assert_eq!(error.code, "internal_failure");
        assert_eq!(error.message, INTERNAL_MESSAGE);
        assert!(!error.message.contains("dependency detail"));
        assert!(!error.retryable);
        assert!(error.http_status.is_none());
        assert!(error.provider_code.is_none());
        assert!(error.operation_id.is_none());
    }

    #[test]
    fn cache_age_validation_is_total() {
        assert_eq!(boundary_ok(duration_from_hours(0.0)).as_secs(), 0);
        assert_eq!(boundary_ok(duration_from_hours(1.5)).as_secs(), 5_400);
        assert!(duration_from_hours(-1.0).is_err());
        assert!(duration_from_hours(f64::NAN).is_err());
        assert!(duration_from_hours(f64::INFINITY).is_err());
    }

    #[test]
    fn generated_operations_are_all_accepted() {
        for operation in OperationId::ALL {
            assert_eq!(boundary_ok(parse_operation(operation.as_str())), operation);
        }
        assert!(parse_operation("unknown").is_err());
    }

    #[test]
    fn timestamps_are_stable_strings() {
        assert_eq!(system_time_string(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            boundary_ok(system_time_from_timestamp("1970-01-01T00:00:00Z")),
            UNIX_EPOCH
        );
        assert!(system_time_from_timestamp("01/02/2026").is_err());
        assert!(system_time_from_timestamp("0").is_err());
    }

    #[test]
    fn explicit_empty_api_key_is_retained_as_a_stable_client_failure() {
        let client = NativeClient::new(Some(String::new()));
        let outcome = run_sync(|| {
            client.client()?;
            Ok(Value::Null)
        });

        assert!(!outcome.ok);
        let error = outcome.error.expect("invalid API key has an error");
        assert_eq!(error.kind, "invalid_request");
        assert_eq!(error.code, "invalid_argument");
    }

    #[test]
    fn synchronous_panics_are_contained() {
        assert_internal_failure(run_sync(|| {
            panic!("dependency detail must not cross the native boundary")
        }));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn asynchronous_panics_are_contained() {
        assert_internal_failure(
            run(async { panic!("dependency detail must not cross the native boundary") }).await,
        );
    }

    #[test]
    fn panic_redaction_subprocess_probe() {
        if std::env::var(PANIC_PROBE_ENV).as_deref() != Ok("child") {
            return;
        }

        std::panic::set_hook(Box::new(|information| {
            eprintln!("delegated prior hook: {information}");
        }));

        assert_internal_failure(run_sync(|| panic!("{SYNC_PANIC_SENTINEL}")));

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("panic probe runtime builds");
        assert_internal_failure(runtime.block_on(run(async { panic!("{ASYNC_PANIC_SENTINEL}") })));

        let unrelated = catch_unwind(AssertUnwindSafe(|| panic!("{OUTSIDE_PANIC_SENTINEL}")));
        assert!(unrelated.is_err());
        println!("panic probe retained generic internal outcomes");
    }

    #[test]
    fn panic_redaction_suppresses_only_boundary_panics() {
        let output = std::process::Command::new(
            std::env::current_exe().expect("current Rust test executable is available"),
        )
        .args([
            "--exact",
            "tests::panic_redaction_subprocess_probe",
            "--nocapture",
        ])
        .env(PANIC_PROBE_ENV, "child")
        .output()
        .expect("panic redaction subprocess starts");

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "panic redaction subprocess failed\nstdout:\n{stdout}\nstderr:\n{stderr}"
        );
        assert!(
            !stderr.contains(SYNC_PANIC_SENTINEL),
            "sync boundary panic leaked to stderr:\n{stderr}"
        );
        assert!(
            !stderr.contains(ASYNC_PANIC_SENTINEL),
            "async boundary panic leaked to stderr:\n{stderr}"
        );
        assert!(
            stderr.contains(OUTSIDE_PANIC_SENTINEL),
            "unrelated panic did not reach the prior hook:\n{stderr}"
        );
        assert!(
            stdout.contains("panic probe retained generic internal outcomes"),
            "boundary outcomes were not retained:\n{stdout}"
        );
    }
}
