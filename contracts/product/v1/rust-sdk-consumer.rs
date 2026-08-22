//! Compile-only public consumer contract for the future `krx-sdk` crate.
//! The disposable vertical slice and production crate must both compile it.

use std::time::Duration;

use krx_sdk::{
    ApiKey, ApprovalCategory, CacheInspectOptions, CachePolicy, CachePruneOptions, CallOptions,
    Cancellation, Client, CredentialMigrationResult, DateRange, DirectRequest,
    MarketSummaryRequest, OperationId, RangeMode, RangeRequest, SecurityCode, StockSearchRequest,
    TradingDate, WatchlistEntry, WatchlistPricesRequest,
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
    let _ = client
        .range(RangeRequest {
            operation: OperationId::StockStkByddTrd,
            range,
            mode: RangeMode::Adjusted {
                security_code: SecurityCode::parse("005930")?,
            },
            options: options.clone(),
        })
        .await?;
    let _ = client
        .search_stocks(StockSearchRequest::new("Samsung", options.clone())?)
        .await?;
    let _ = client
        .market_summary(MarketSummaryRequest::new(date.clone(), options.clone()))
        .await?;
    let _ = client
        .watchlist_prices(WatchlistPricesRequest::new(
            date,
            vec!["005930".to_owned()],
            options,
        )?)
        .await?;

    let _capabilities = client.capabilities();
    let credentials = client.credentials();
    let _status = credentials.status().await?;
    let _approval = credentials.approval_status(ApprovalCategory::Stock).await?;
    let _checked = credentials
        .check_approval(ApprovalCategory::Stock, Cancellation::new())
        .await?;
    credentials
        .set(ApiKey::parse("test-only-placeholder")?)
        .await?;
    let _removed = credentials.remove().await?;
    let _migration: CredentialMigrationResult = credentials.migrate_legacy().await?;

    let cache = client.cache();
    let _inspection = cache.inspect(CacheInspectOptions::default()).await?;
    let _pruned = cache.prune(CachePruneOptions::default()).await?;
    let _cleared = cache.clear().await?;

    let watchlist = client.watchlist();
    let _entries = watchlist.list().await?;
    let _added = watchlist
        .add(WatchlistEntry::new(
            "KR7005930003",
            "005930",
            "삼성전자",
            krx_sdk::WatchlistMarket::Kospi,
        )?)
        .await?;
    let _removed = watchlist.remove("005930").await?;
    Ok(())
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
