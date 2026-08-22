//! Compile-only public consumer contract for the future `krx-sdk` crate.
//! The disposable vertical slice and production crate must both compile it.

use std::time::Duration;

use krx_sdk::{
    ApiKey, ApprovalCategory, ApprovalObservation, CacheInspectOptions, CacheInspection,
    CachePolicy, CachePruneOptions, CachePruneResult, CallOptions, Cancellation, Client,
    CredentialMigrationResult, CredentialStatus, DateRange, DirectRequest, KrxError, KrxErrorCode,
    KrxErrorKind, MarketSummaryRequest, MarketSummaryResult, OperationId, RangeMode, RangeRequest,
    RangeResult, SecurityCode, StockSearchRequest, StockSearchResult, TradingDate, WatchlistEntry,
    WatchlistPricesRequest, WatchlistPricesResult,
};

async fn consume_public_sdk(client: &Client) -> Result<(), krx_sdk::KrxError> {
    let date = TradingDate::parse("20260102")?;
    let options = CallOptions {
        cache: CachePolicy::Prefer {
            max_age: Duration::from_secs(168 * 60 * 60),
        },
        retries: 3,
        cancellation: Cancellation::new(),
    };
    let result = client
        .query(DirectRequest {
            operation: OperationId::StockStkByddTrd,
            date: date.clone(),
            options: options.clone(),
        })
        .await?;
    let _fields: Vec<(&str, &str)> = result.rows[0].iter().collect();
    let _optional_field: Option<&str> = result.rows[0].get("ISU_CD");
    let _source = result.provenance.source;

    let range = DateRange::new(date.clone(), TradingDate::parse("20260130")?)?;
    let _range: RangeResult = client
        .range(RangeRequest {
            operation: OperationId::StockStkByddTrd,
            range,
            mode: RangeMode::Adjusted {
                security_code: SecurityCode::parse("005930")?,
            },
            options: options.clone(),
        })
        .await?;
    let _search: StockSearchResult = client
        .search_stocks(StockSearchRequest::new("Samsung", options.clone())?)
        .await?;
    let _summary: MarketSummaryResult = client
        .market_summary(MarketSummaryRequest::new(date.clone(), options.clone()))
        .await?;
    let security_codes: Vec<SecurityCode> = vec![SecurityCode::parse("005930")?];
    let _prices: WatchlistPricesResult = client
        .watchlist_prices(WatchlistPricesRequest::new(date, security_codes, options)?)
        .await?;

    let _capabilities = client.capabilities();
    let _operation_name: &str = OperationId::ALL[0].as_str();
    let credentials = client.credentials();
    let _status: CredentialStatus = credentials.status().await?;
    let _approval: Option<ApprovalObservation> =
        credentials.approval_status(ApprovalCategory::Stock).await?;
    let _checked: ApprovalObservation = credentials
        .check_approval(ApprovalCategory::Stock, Cancellation::new())
        .await?;
    credentials
        .set(ApiKey::parse("test-only-placeholder")?)
        .await?;
    let _removed = credentials.remove().await?;
    let _migration: CredentialMigrationResult = credentials.migrate_legacy().await?;

    let cache = client.cache();
    let _inspection: CacheInspection = cache.inspect(CacheInspectOptions::default()).await?;
    let _pruned: CachePruneResult = cache.prune(CachePruneOptions::default()).await?;
    let _cleared: CachePruneResult = cache.clear().await?;

    let watchlist = client.watchlist();
    let _entries: Vec<WatchlistEntry> = watchlist.list().await?;
    let _added: bool = watchlist
        .add(WatchlistEntry::new(
            "KR7005930003",
            "005930",
            "삼성전자",
            krx_sdk::WatchlistMarket::Kospi,
        )?)
        .await?;
    let _removed: bool = watchlist.remove("005930").await?;
    Ok(())
}

fn assert_public_traits() {
    fn assert_error<T: std::error::Error + Send + Sync>() {}
    fn assert_send_sync<T: Send + Sync>() {}

    assert_error::<KrxError>();
    assert_send_sync::<Client>();
    let cancellation = Cancellation::new();
    let shared = cancellation.clone();
    cancellation.cancel();
    let _cancelled: bool = shared.is_cancelled();
    let key = ApiKey::parse("test-only-placeholder").expect("fixture key is valid");
    let _redacted_debug_boundary = format!("{key:?}");
}

fn assert_error_projection(error: &KrxError) {
    let _kind: KrxErrorKind = error.kind();
    let _code: KrxErrorCode = error.code();
    let _message: &str = error.message();
    let _retryable: bool = error.retryable();
    let _http_status: Option<u16> = error.http_status();
    let _provider_code: Option<&str> = error.provider_code();
    let _operation: Option<OperationId> = error.operation_id();
}

fn assert_query_future_is_send(client: &Client, request: DirectRequest) {
    fn assert_send<T: Send>(_: T) {}
    assert_send(client.query(request));
}

fn construct_client() -> Result<Client, krx_sdk::KrxError> {
    Client::builder().build()
}

fn construct_explicit_client() -> Result<Client, krx_sdk::KrxError> {
    Client::builder()
        .api_key(ApiKey::parse("test-only-placeholder")?)
        .cache_max_age(Duration::from_secs(168 * 60 * 60))
        .build()
}

fn bypass_cache() -> CachePolicy {
    CachePolicy::Bypass
}
