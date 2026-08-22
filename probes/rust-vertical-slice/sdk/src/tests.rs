use std::collections::VecDeque;
use std::error::Error as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use super::*;

#[derive(Clone)]
struct MockResponse {
    status: u16,
    body: String,
    delay: Duration,
    body_delay: Duration,
    chunked: bool,
}

struct MockServer {
    base_url: String,
    calls: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl MockServer {
    async fn start(responses: Vec<MockResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock provider");
        let address = listener.local_addr().expect("mock provider address");
        let calls = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let queued = Arc::new(Mutex::new(VecDeque::from(responses)));
        let task_calls = Arc::clone(&calls);
        let task_requests = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                task_calls.fetch_add(1, Ordering::SeqCst);
                let requests = Arc::clone(&task_requests);
                let response = queued
                    .lock()
                    .expect("response queue")
                    .pop_front()
                    .expect("unexpected provider call");
                tokio::spawn(async move {
                    let request = read_http_request(&mut stream).await;
                    requests.lock().expect("request log").push(request);
                    sleep(response.delay).await;
                    let reason = match response.status {
                        200 => "OK",
                        302 => "Found",
                        503 => "Service Unavailable",
                        _ => "Probe",
                    };
                    let headers = if response.chunked {
                        format!(
                            "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                            response.status, reason,
                        )
                    } else {
                        format!(
                            "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            response.status,
                            reason,
                            response.body.len(),
                        )
                    };
                    let _ = stream.write_all(headers.as_bytes()).await;
                    let _ = stream.flush().await;
                    sleep(response.body_delay).await;
                    if response.chunked {
                        for chunk in response.body.as_bytes().chunks(64 * 1024) {
                            let prefix = format!("{:x}\r\n", chunk.len());
                            if stream.write_all(prefix.as_bytes()).await.is_err()
                                || stream.write_all(chunk).await.is_err()
                                || stream.write_all(b"\r\n").await.is_err()
                            {
                                return;
                            }
                        }
                        let _ = stream.write_all(b"0\r\n\r\n").await;
                    } else {
                        let _ = stream.write_all(response.body.as_bytes()).await;
                    }
                    let _ = stream.shutdown().await;
                });
            }
        });
        Self {
            base_url: format!("http://{address}/"),
            calls,
            requests,
            task,
        }
    }

    async fn wait_for_calls(&self, expected: usize) {
        timeout(Duration::from_secs(1), async {
            while self.calls.load(Ordering::SeqCst) != expected {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("provider call count");
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn read_http_request(stream: &mut tokio::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    let mut expected = None;
    loop {
        let read = stream.read(&mut buffer).await.expect("read request");
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if expected.is_none()
            && let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n")
        {
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().expect("content length"))
                })
                .unwrap_or(0);
            expected = Some(header_end + 4 + content_length);
        }
        if expected.is_some_and(|length| bytes.len() >= length) {
            break;
        }
    }
    String::from_utf8(bytes).expect("UTF-8 request")
}

fn mock_response(status: u16, body: impl Into<String>) -> MockResponse {
    MockResponse {
        status,
        body: body.into(),
        delay: Duration::ZERO,
        body_delay: Duration::ZERO,
        chunked: false,
    }
}

fn valid_body() -> String {
    let row = REPRESENTATIVE_FIELDS
        .iter()
        .map(|field| ((*field).to_owned(), Value::String(format!("value-{field}"))))
        .collect::<Map<_, _>>();
    json!({ SUCCESS_ENVELOPE: [Value::Object(row)] }).to_string()
}

fn request(cancellation: Cancellation) -> DirectRequest {
    DirectRequest {
        operation: OperationId::StockStkByddTrd,
        date: TradingDate::parse("20260821").expect("date"),
        options: CallOptions {
            cache: CachePolicy::Bypass,
            retries: 0,
            cancellation,
        },
    }
}

fn client(server: &MockServer, attempt_timeout: Duration) -> Client {
    Client::builder()
        .api_key(ApiKey::parse("fixture-key").expect("API key"))
        .probe_base_url(&server.base_url)
        .expect("mock base URL")
        .probe_attempt_timeout(attempt_timeout)
        .build()
        .expect("client")
}

async fn query_once(status: u16, body: impl Into<String>) -> Result<QueryResult, KrxError> {
    let server = MockServer::start(vec![mock_response(status, body)]).await;
    client(&server, Duration::from_secs(1))
        .query(request(Cancellation::new()))
        .await
}

#[tokio::test]
async fn representative_query_uses_the_generated_wire_contract() {
    let server = MockServer::start(vec![mock_response(200, valid_body())]).await;
    let result = client(&server, Duration::from_secs(1))
        .query(request(Cancellation::new()))
        .await
        .expect("valid response");
    server.wait_for_calls(1).await;

    assert_eq!(result.rows.len(), 1);
    assert_eq!(
        result.rows[0].get(REPRESENTATIVE_FIELDS[0]),
        Some(format!("value-{}", REPRESENTATIVE_FIELDS[0]).as_str())
    );
    assert_eq!(result.provenance.source, ResultSource::Network);
    assert_eq!(
        result.provenance.contract_id,
        GENERATED_CAPABILITIES
            .iter()
            .find(|item| item.operation_id == OperationId::StockStkByddTrd)
            .expect("capability")
            .contract_id,
    );

    let request = server.requests.lock().expect("request log")[0].clone();
    assert!(request.starts_with(&format!("{METHOD} {PROVIDER_PATH} HTTP/1.1\r\n")));
    assert!(request.to_ascii_lowercase().contains(&format!(
        "{}: fixture-key\r\n",
        AUTH_HEADER.to_ascii_lowercase()
    )));
    assert!(request.to_ascii_lowercase().contains(&format!(
        "content-type: {}\r\n",
        CONTENT_TYPE.to_ascii_lowercase()
    )));
    let body: Value =
        serde_json::from_str(request.split_once("\r\n\r\n").expect("HTTP request body").1)
            .expect("JSON request body");
    assert_eq!(body, json!({ REQUEST_DATE_FIELD: "20260821" }));
}

#[tokio::test]
async fn strict_decoder_classifies_json_envelope_provider_and_row_failures() {
    let malformed = query_once(200, "{").await.expect_err("malformed JSON");
    assert_eq!(malformed.code(), KrxErrorCode::InvalidJson);

    for body in [
        json!([]),
        json!({}),
        json!({ SUCCESS_ENVELOPE: {} }),
        json!({ SUCCESS_ENVELOPE: [], "extra": [] }),
    ] {
        let error = query_once(200, body.to_string())
            .await
            .expect_err("invalid envelope");
        assert_eq!(error.code(), KrxErrorCode::InvalidEnvelope);
    }

    let provider = query_once(
        200,
        json!({
            PROVIDER_CODE_FIELD: "E123",
            PROVIDER_MESSAGE_FIELD: "provider-secret-detail",
        })
        .to_string(),
    )
    .await
    .expect_err("provider error");
    assert_eq!(provider.code(), KrxErrorCode::ProviderError);
    assert_eq!(provider.provider_code(), Some("E123"));
    assert!(!provider.message().contains("provider-secret-detail"));

    let mut valid: Value = serde_json::from_str(&valid_body()).expect("valid body");
    let row = valid[SUCCESS_ENVELOPE][0]
        .as_object_mut()
        .expect("valid row");
    row.remove(REPRESENTATIVE_FIELDS[0]);
    let missing = query_once(200, valid.to_string())
        .await
        .expect_err("missing row field");
    assert_eq!(missing.code(), KrxErrorCode::InvalidRow);

    let mut valid: Value = serde_json::from_str(&valid_body()).expect("valid body");
    valid[SUCCESS_ENVELOPE][0][REPRESENTATIVE_FIELDS[0]] = json!(123);
    let wrong_type = query_once(200, valid.to_string())
        .await
        .expect_err("wrong row field type");
    assert_eq!(wrong_type.code(), KrxErrorCode::InvalidRow);

    let mut valid: Value = serde_json::from_str(&valid_body()).expect("valid body");
    valid[SUCCESS_ENVELOPE][0]["EXTRA"] = json!("unexpected");
    let unknown = query_once(200, valid.to_string())
        .await
        .expect_err("unknown row field");
    assert_eq!(unknown.code(), KrxErrorCode::InvalidRow);
}

#[tokio::test]
async fn provider_codes_are_credential_redacted_and_unicode_bounded() {
    let raw = format!("prefix-fixture-key-{}-suffix", "한".repeat(300));
    let provider = query_once(
        200,
        json!({
            PROVIDER_CODE_FIELD: raw,
            PROVIDER_MESSAGE_FIELD: "opaque",
        })
        .to_string(),
    )
    .await
    .expect_err("provider error");
    let code = provider.provider_code().expect("sanitized provider code");
    assert!(!code.contains("fixture-key"));
    assert!(code.contains("[REDACTED]"));
    assert_eq!(code.chars().count(), 240);
    assert!(!provider.to_string().contains("fixture-key"));
    assert!(!format!("{provider:?}").contains("fixture-key"));
}

#[test]
fn probe_transport_rejects_nonfixture_credentials_and_nonloopback_origins() {
    Client::builder()
        .api_key(ApiKey::parse("real-credential").expect("API key"))
        .build()
        .expect("official transport accepts the configured credential");

    for result in [
        Client::builder()
            .api_key(ApiKey::parse("fixture-key").expect("API key"))
            .probe_base_url("https://example.com/"),
        Client::builder()
            .api_key(ApiKey::parse("fixture-key").expect("API key"))
            .probe_base_url("http://127.0.0.1:1234/?redirect=1"),
    ] {
        let error = result.err().expect("unsafe probe origin");
        assert_eq!(error.code(), KrxErrorCode::InvalidArgument);
    }

    for builder in [
        Client::builder()
            .api_key(ApiKey::parse("real-credential").expect("API key"))
            .probe_base_url("http://127.0.0.1:1234/")
            .expect("valid loopback URL"),
        Client::builder()
            .api_key(ApiKey::parse("fixture-key").expect("API key"))
            .probe_base_url("http://127.0.0.1:1234/")
            .expect("valid loopback URL")
            .api_key(ApiKey::parse("real-credential").expect("API key")),
    ] {
        let error = builder.build().err().expect("nonfixture probe credential");
        assert_eq!(error.code(), KrxErrorCode::InvalidArgument);
    }

    Client::builder()
        .probe_base_url("http://127.0.0.1:1234/")
        .expect("valid loopback URL")
        .api_key(ApiKey::parse("fixture-key").expect("API key"))
        .build()
        .expect("builder order must not affect safe probe transport");
}

#[tokio::test]
async fn redirects_are_not_followed_and_retryable_status_is_contract_mapped_once() {
    let redirect_server = MockServer::start(vec![mock_response(302, "")]).await;
    let redirect = client(&redirect_server, Duration::from_secs(1))
        .query(request(Cancellation::new()))
        .await
        .expect_err("redirect must not be followed");
    assert_eq!(redirect.code(), KrxErrorCode::HttpError);
    assert_eq!(redirect.http_status(), Some(302));
    assert_eq!(redirect_server.calls.load(Ordering::SeqCst), 1);

    let unavailable_server = MockServer::start(vec![mock_response(503, "opaque")]).await;
    let unavailable = client(&unavailable_server, Duration::from_secs(1))
        .query(request(Cancellation::new()))
        .await
        .expect_err("503");
    assert_eq!(unavailable.code(), KrxErrorCode::ProviderUnavailable);
    assert_eq!(unavailable.kind(), KrxErrorKind::Upstream);
    assert!(unavailable.retryable());
    assert_eq!(unavailable_server.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancellation_is_prompt_does_not_start_cancelled_work_and_keeps_client_usable() {
    let mut delayed = mock_response(200, valid_body());
    delayed.delay = Duration::from_secs(5);
    let server = MockServer::start(vec![delayed, mock_response(200, valid_body())]).await;
    let client = client(&server, Duration::from_secs(10));

    let pre_cancelled = Cancellation::new();
    pre_cancelled.cancel();
    let error = client
        .query(request(pre_cancelled))
        .await
        .expect_err("pre-cancelled request");
    assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);

    let cancellation = Cancellation::new();
    let pending_client = client.clone();
    let pending_cancellation = cancellation.clone();
    let pending =
        tokio::spawn(async move { pending_client.query(request(pending_cancellation)).await });
    server.wait_for_calls(1).await;
    cancellation.cancel();
    let cancelled = timeout(Duration::from_millis(250), pending)
        .await
        .expect("prompt cancellation")
        .expect("query task")
        .expect_err("cancelled request");
    assert_eq!(cancelled.code(), KrxErrorCode::RequestCancelled);

    let next = client
        .query(request(Cancellation::new()))
        .await
        .expect("client remains usable");
    assert_eq!(next.rows.len(), 1);
    assert_eq!(server.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn attempt_timeout_is_sanitized_and_operation_aware() {
    let mut delayed = mock_response(200, valid_body());
    delayed.delay = Duration::from_secs(5);
    let server = MockServer::start(vec![delayed]).await;
    let error = client(&server, Duration::from_millis(30))
        .query(request(Cancellation::new()))
        .await
        .expect_err("attempt timeout");
    assert_eq!(error.code(), KrxErrorCode::DeadlineExceeded);
    assert_eq!(error.operation_id(), Some(OperationId::StockStkByddTrd));
    assert!(error.retryable());
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancellation_and_timeout_cover_the_streaming_response_body() {
    let mut cancelled_body = mock_response(200, valid_body());
    cancelled_body.body_delay = Duration::from_secs(5);
    let cancellation_server = MockServer::start(vec![cancelled_body]).await;
    let cancellation = Cancellation::new();
    let pending_client = client(&cancellation_server, Duration::from_secs(10));
    let pending_cancellation = cancellation.clone();
    let pending =
        tokio::spawn(async move { pending_client.query(request(pending_cancellation)).await });
    cancellation_server.wait_for_calls(1).await;
    sleep(Duration::from_millis(25)).await;
    cancellation.cancel();
    let error = timeout(Duration::from_millis(250), pending)
        .await
        .expect("prompt body cancellation")
        .expect("query task")
        .expect_err("cancelled response body");
    assert_eq!(error.code(), KrxErrorCode::RequestCancelled);

    let mut timed_out_body = mock_response(200, valid_body());
    timed_out_body.body_delay = Duration::from_secs(5);
    let timeout_server = MockServer::start(vec![timed_out_body]).await;
    let error = client(&timeout_server, Duration::from_millis(30))
        .query(request(Cancellation::new()))
        .await
        .expect_err("response body timeout");
    assert_eq!(error.code(), KrxErrorCode::DeadlineExceeded);
    assert_eq!(error.operation_id(), Some(OperationId::StockStkByddTrd));
}

#[tokio::test]
async fn oversized_chunked_response_is_rejected_at_the_streaming_limit() {
    let mut response = mock_response(200, "x".repeat(8 * 1024 * 1024 + 1));
    response.chunked = true;
    let server = MockServer::start(vec![response]).await;
    let error = client(&server, Duration::from_secs(5))
        .query(request(Cancellation::new()))
        .await
        .expect_err("oversized chunked response");
    assert_eq!(error.code(), KrxErrorCode::InvalidEnvelope);
    assert_eq!(error.operation_id(), Some(OperationId::StockStkByddTrd));
}

#[test]
fn secrets_are_redacted_and_errors_do_not_expose_sources() {
    let api_key = ApiKey::parse("super-secret-probe-value").expect("API key");
    assert_eq!(format!("{api_key:?}"), "ApiKey([REDACTED])");
    let error = KrxError::new(KrxErrorCode::RequestFailed, "provider request failed")
        .for_operation(OperationId::StockStkByddTrd);
    assert!(!format!("{error:?}").contains("super-secret-probe-value"));
    assert!(!error.to_string().contains("super-secret-probe-value"));
    assert!(error.source().is_none());
}

#[derive(Default)]
struct FakeCredentialBackend {
    secret: Mutex<Option<String>>,
    read_override: Mutex<Option<Result<Option<String>, KrxError>>>,
    reads: AtomicUsize,
}

impl CredentialBackend for FakeCredentialBackend {
    fn get(&self) -> Result<Option<String>, KrxError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if let Some(result) = self.read_override.lock().expect("read override").take() {
            return result;
        }
        Ok(self.secret.lock().expect("fake secret").clone())
    }

    fn set(&self, secret: &str) -> Result<(), KrxError> {
        *self.secret.lock().expect("fake secret") = Some(secret.to_owned());
        Ok(())
    }

    fn remove(&self) -> Result<bool, KrxError> {
        Ok(self.secret.lock().expect("fake secret").take().is_some())
    }
}

#[tokio::test]
async fn credential_store_verifies_round_trips_and_preserves_backend_errors() {
    let backend = Arc::new(FakeCredentialBackend::default());
    let store = CredentialStore {
        explicit: false,
        backend: backend.clone(),
    };
    store
        .set(ApiKey::parse("persisted-secret").expect("API key"))
        .await
        .expect("verified credential write");
    assert_eq!(
        backend.secret.lock().expect("fake secret").as_deref(),
        Some("persisted-secret")
    );
    assert!(store.remove().await.expect("credential removal"));
    assert!(!store.remove().await.expect("idempotent credential removal"));

    *backend.read_override.lock().expect("read override") = Some(Err(credential_store_error(
        "headless credential store unavailable",
    )));
    let error = store
        .status_with_environment(Err(VarError::NotPresent))
        .await
        .expect_err("headless backend error");
    assert_eq!(error.code(), KrxErrorCode::CredentialStoreUnavailable);
    assert!(!error.message().contains("persisted-secret"));
}

#[tokio::test]
async fn credential_status_validates_present_environment_before_keychain() {
    for value in ["", "   ", "embedded space"] {
        let backend = Arc::new(FakeCredentialBackend::default());
        let store = CredentialStore {
            explicit: false,
            backend: backend.clone(),
        };
        let error = store
            .status_with_environment(Ok(value.to_owned()))
            .await
            .expect_err("invalid present environment credential");
        assert_eq!(error.code(), KrxErrorCode::InvalidArgument);
        assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
    }

    let environment_backend = Arc::new(FakeCredentialBackend::default());
    let environment_store = CredentialStore {
        explicit: false,
        backend: environment_backend.clone(),
    };
    let environment = environment_store
        .status_with_environment(Ok("valid-token".to_owned()))
        .await
        .expect("valid environment credential");
    assert_eq!(environment.source, CredentialSource::Environment);
    assert!(!environment.persisted);
    assert_eq!(environment_backend.reads.load(Ordering::SeqCst), 0);

    let keychain_backend = Arc::new(FakeCredentialBackend::default());
    *keychain_backend.secret.lock().expect("fake secret") = Some("stored".to_owned());
    let keychain_store = CredentialStore {
        explicit: false,
        backend: keychain_backend.clone(),
    };
    let keychain = keychain_store
        .status_with_environment(Err(VarError::NotPresent))
        .await
        .expect("missing environment falls through");
    assert_eq!(keychain.source, CredentialSource::Keychain);
    assert!(keychain.persisted);
    assert_eq!(keychain_backend.reads.load(Ordering::SeqCst), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn credential_status_rejects_non_unicode_environment_without_keychain() {
    use std::os::unix::ffi::OsStringExt;

    let backend = Arc::new(FakeCredentialBackend::default());
    let store = CredentialStore {
        explicit: false,
        backend: backend.clone(),
    };
    let error = store
        .status_with_environment(Err(VarError::NotUnicode(std::ffi::OsString::from_vec(
            vec![0xff],
        ))))
        .await
        .expect_err("non-Unicode environment credential");
    assert_eq!(error.code(), KrxErrorCode::InvalidArgument);
    assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn watchlist_preserves_the_frozen_konex_market() {
    let entry = WatchlistEntry::new("KR7244690001", "244690", "올리패스", WatchlistMarket::Konex)
        .expect("KONEX watchlist entry");
    assert_eq!(entry.market, WatchlistMarket::Konex);
}

#[tokio::test]
async fn credential_store_rejects_missing_or_mismatched_read_back() {
    for read_back in [None, Some("different-secret".to_owned())] {
        let backend = Arc::new(FakeCredentialBackend::default());
        *backend.read_override.lock().expect("read override") = Some(Ok(read_back));
        let store = CredentialStore {
            explicit: false,
            backend,
        };
        let error = store
            .set(ApiKey::parse("expected-secret").expect("API key"))
            .await
            .expect_err("credential verification");
        assert_eq!(error.code(), KrxErrorCode::CredentialVerifyFailed);
    }
}

#[tokio::test]
#[ignore = "requires KRX_PROBE_NATIVE_KEYRING=1 on a disposable native runner"]
async fn native_keyring_round_trip_or_typed_headless_failure() {
    if std::env::var_os("KRX_PROBE_NATIVE_KEYRING").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return;
    }
    let account = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos()
    );
    let backend = NativeCredentialBackend::for_probe(account);
    let fixture = "disposable-keyring-fixture";
    match backend.set(fixture) {
        Ok(()) => {
            let read_back = backend.get();
            let removed = backend.remove();
            assert_eq!(
                read_back.expect("native keyring read"),
                Some(fixture.to_owned())
            );
            assert!(removed.expect("native keyring cleanup"));
            assert_eq!(backend.get().expect("native keyring cleanup read"), None);
            eprintln!("native keyring probe: round-trip passed");
        }
        Err(error) => {
            let _ = backend.remove();
            assert!(matches!(
                error.code(),
                KrxErrorCode::CredentialStoreUnavailable | KrxErrorCode::CredentialWriteFailed
            ));
            assert!(error.source().is_none());
            assert!(!error.message().contains(fixture));
            eprintln!(
                "native keyring probe: typed headless failure ({})",
                error.code().as_str()
            );
        }
    }
}

#[tokio::test]
#[ignore = "requires KRX_PROBE_LIVE_TLS=1 and external network access"]
async fn official_endpoint_accepts_a_rustls_handshake_without_retaining_payloads() {
    if std::env::var_os("KRX_PROBE_LIVE_TLS").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return;
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("Rustls probe client");
    let response = timeout(Duration::from_secs(15), client.head(OFFICIAL_SERVER).send())
        .await
        .expect("TLS probe timeout")
        .expect("TLS handshake");
    assert!(response.status().as_u16() >= 100);
}
