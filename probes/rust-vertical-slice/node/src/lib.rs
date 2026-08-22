use std::panic::AssertUnwindSafe;
use std::time::{Duration, UNIX_EPOCH};

use futures_util::FutureExt;
use krx_sdk::{
    ApiKey, CachePolicy, CallOptions, Cancellation, Client, DirectRequest, Freshness, KrxError,
    KrxErrorCode, OperationId, ResultSource, TradingDate,
};
use napi::Result;
use napi_derive::napi;
use serde_json::{Map, Value, json};

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

#[napi(object)]
pub struct NativeWireContract {
    pub method: String,
    pub path: String,
    pub auth_header: String,
    pub request_date_field: String,
    pub success_envelope: String,
    pub provider_code_field: String,
    pub provider_message_field: String,
    pub representative_fields: Vec<String>,
}

#[napi]
pub fn probe_wire_contract() -> NativeWireContract {
    let contract = krx_sdk::probe_wire_contract();
    NativeWireContract {
        method: contract.method.to_owned(),
        path: contract.path.to_owned(),
        auth_header: contract.auth_header.to_owned(),
        request_date_field: contract.request_date_field.to_owned(),
        success_envelope: contract.success_envelope.to_owned(),
        provider_code_field: contract.provider_code_field.to_owned(),
        provider_message_field: contract.provider_message_field.to_owned(),
        representative_fields: contract
            .representative_fields
            .iter()
            .map(|field| (*field).to_owned())
            .collect(),
    }
}

#[napi(catch_unwind)]
pub async fn native_query(
    api_key: Option<String>,
    operation: String,
    date: String,
    cache_mode: Option<String>,
    retries: Option<u32>,
    cancellation: &NativeCancellation,
) -> Result<NativeOutcome> {
    let cancellation = cancellation.inner.clone();
    let future = native_query_inner(api_key, operation, date, cache_mode, retries, cancellation);
    Ok(match AssertUnwindSafe(future).catch_unwind().await {
        Ok(outcome) => outcome,
        Err(_) => internal_failure(),
    })
}

async fn native_query_inner(
    api_key: Option<String>,
    operation: String,
    date: String,
    cache_mode: Option<String>,
    retries: Option<u32>,
    cancellation: Cancellation,
) -> NativeOutcome {
    let Some(operation) = OperationId::ALL
        .iter()
        .copied()
        .find(|candidate| candidate.as_str() == operation)
    else {
        return contract_error(
            "invalid_request",
            "invalid_operation",
            "operation is not part of the canonical KRX contract",
            false,
        );
    };
    let date = match TradingDate::parse(&date) {
        Ok(date) => date,
        Err(error) => return error_outcome(error),
    };
    let retries = retries.unwrap_or(3);
    if retries > 3 {
        return contract_error(
            "invalid_request",
            "invalid_argument",
            "retry count must be between zero and three",
            false,
        );
    }
    let cache = match cache_mode.as_deref().unwrap_or("prefer") {
        "prefer" => CachePolicy::Prefer {
            max_age: Duration::from_secs(168 * 60 * 60),
        },
        "refresh" => CachePolicy::Refresh,
        "bypass" => CachePolicy::Bypass,
        "offline" => CachePolicy::Offline,
        _ => {
            return contract_error(
                "invalid_request",
                "invalid_argument",
                "cache mode is invalid",
                false,
            );
        }
    };

    let mut builder = Client::builder();
    let explicit = match api_key {
        Some(value) => match ApiKey::parse(&value) {
            Ok(api_key) => Some(api_key),
            Err(error) => return error_outcome(error),
        },
        None => match std::env::var("KRX_API_KEY") {
            Ok(value) => match ApiKey::parse(&value) {
                Ok(api_key) => Some(api_key),
                Err(error) => return error_outcome(error),
            },
            Err(_) => None,
        },
    };
    if let Some(api_key) = explicit {
        builder = builder.api_key(api_key);
    }
    if let Ok(base_url) = std::env::var("KRX_PROBE_BASE_URL") {
        builder = match builder.probe_base_url(&base_url) {
            Ok(builder) => builder,
            Err(error) => return error_outcome(error),
        };
    }
    if let Ok(milliseconds) = std::env::var("KRX_PROBE_TIMEOUT_MS") {
        let Ok(milliseconds) = milliseconds.parse::<u64>() else {
            return contract_error(
                "invalid_request",
                "invalid_argument",
                "KRX_PROBE_TIMEOUT_MS must be an integer",
                false,
            );
        };
        builder = builder.probe_attempt_timeout(Duration::from_millis(milliseconds));
    }
    let client = match builder.build() {
        Ok(client) => client,
        Err(error) => return error_outcome(error),
    };
    match client
        .query(DirectRequest {
            operation,
            date,
            options: CallOptions {
                cache,
                retries: retries as u8,
                cancellation,
            },
        })
        .await
    {
        Ok(result) => {
            let rows = result
                .rows
                .iter()
                .map(|row| {
                    Value::Object(
                        row.iter()
                            .map(|(key, value)| (key.to_owned(), Value::String(value.to_owned())))
                            .collect::<Map<_, _>>(),
                    )
                })
                .collect::<Vec<_>>();
            let source = match result.provenance.source {
                ResultSource::Network => "network",
                ResultSource::Cache => "cache",
            };
            let freshness = match result.provenance.freshness {
                Freshness::Fresh => "fresh",
                Freshness::Stale => "stale",
            };
            let fetched_at = result
                .provenance
                .fetched_at
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::ZERO)
                .as_millis() as u64;
            success(json!({
                "data": rows,
                "provenance": {
                    "source": source,
                    "fetchedAt": fetched_at,
                    "freshness": freshness,
                    "contractId": result.provenance.contract_id,
                }
            }))
        }
        Err(error) => error_outcome(error),
    }
}

fn success(value: Value) -> NativeOutcome {
    NativeOutcome {
        ok: true,
        value_json: Some(value.to_string()),
        error: None,
    }
}

fn error_outcome(error: KrxError) -> NativeOutcome {
    NativeOutcome {
        ok: false,
        value_json: None,
        error: Some(NativeError {
            kind: error.kind().as_str().to_owned(),
            code: error.code().as_str().to_owned(),
            message: error.message().to_owned(),
            retryable: error.retryable(),
            http_status: error.http_status().map(u32::from),
            provider_code: error.provider_code().map(str::to_owned),
            operation_id: error.operation_id().map(|value| value.as_str().to_owned()),
        }),
    }
}

fn contract_error(kind: &str, code: &str, message: &str, retryable: bool) -> NativeOutcome {
    NativeOutcome {
        ok: false,
        value_json: None,
        error: Some(NativeError {
            kind: kind.to_owned(),
            code: code.to_owned(),
            message: message.to_owned(),
            retryable,
            http_status: None,
            provider_code: None,
            operation_id: None,
        }),
    }
}

fn internal_failure() -> NativeOutcome {
    contract_error(
        "internal",
        KrxErrorCode::InternalFailure.as_str(),
        "native operation failed internally",
        false,
    )
}

#[napi(catch_unwind)]
pub fn probe_sync_panic() -> Result<()> {
    panic!("disposable synchronous panic fixture")
}

#[napi]
pub async fn probe_async_panic() -> Result<NativeOutcome> {
    let future = async {
        tokio::task::yield_now().await;
        panic!("disposable asynchronous panic fixture")
    };
    Ok(match AssertUnwindSafe(future).catch_unwind().await {
        Ok(()) => internal_failure(),
        Err(_) => internal_failure(),
    })
}

#[napi]
pub fn probe_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
