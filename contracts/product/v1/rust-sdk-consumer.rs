//! Compile-only public consumer contract for the future `krx-sdk` crate.
//! The disposable vertical slice and production crate must both compile it.

use std::time::{Duration, SystemTime};

use krx_sdk::{
    AdjustmentFactorField, ApiKey, ApprovalCategory, ApprovalObservation, ApprovalState,
    CacheEntryDescription, CacheInspectOptions, CacheInspection, CachePolicy, CachePruneOptions,
    CachePruneResult, CalendarCoverage, CalendarDate, CallOptions, Cancellation,
    CashDividendTreatment, Client, CompletenessState, CompositeResult, CredentialMigrationResult,
    CredentialSource, CredentialStatus, DateRange, DirectRequest, Freshness, KrxError,
    KrxErrorCode, KrxErrorKind, MarketComponent, MarketSummary, MarketSummaryRequest,
    MarketSummaryResult, OperationDescription, OperationId, RangeMode, RangeRequest, RangeResult,
    ResultProvenance, ResultSource, Row, SearchMarket, SecurityCode, StockSearchMatch,
    StockSearchRequest, StockSearchResult, StockStats, TradingDate, WatchlistEntry,
    WatchlistMarket, WatchlistPrices, WatchlistPricesRequest, WatchlistPricesResult,
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
    assert_provenance(&result.provenance);

    let range = DateRange::new(date.clone(), TradingDate::parse("20260130")?)?;
    let range_result: RangeResult = client
        .range(RangeRequest {
            operation: OperationId::StockStkByddTrd,
            range,
            mode: RangeMode::Adjusted {
                security_code: SecurityCode::parse("005930")?,
            },
            options: options.clone(),
        })
        .await?;
    assert_range_result(&range_result);

    let search: StockSearchResult = client
        .search_stocks(StockSearchRequest::new("Samsung", options.clone())?)
        .await?;
    assert_composite_result(&search);
    for market in &search.completeness.requested {
        assert_search_market(*market);
    }
    for stock in &search.data {
        assert_stock_search_match(stock);
    }

    let summary: MarketSummaryResult = client
        .market_summary(MarketSummaryRequest::new(date.clone(), options.clone()))
        .await?;
    assert_composite_result(&summary);
    for component in &summary.completeness.requested {
        assert_market_component(*component);
    }
    assert_market_summary(&summary.data);

    let security_codes: Vec<SecurityCode> = vec![SecurityCode::parse("005930")?];
    let prices: WatchlistPricesResult = client
        .watchlist_prices(WatchlistPricesRequest::new(
            date.clone(),
            security_codes,
            options,
        )?)
        .await?;
    assert_composite_result(&prices);
    for market in &prices.completeness.requested {
        assert_watchlist_market(*market);
    }
    assert_watchlist_prices(&prices.data);
    let _price_market: Option<&krx_sdk::WatchlistMarket> = prices.completeness.requested.first();

    let capabilities: &[OperationDescription] = client.capabilities();
    for capability in capabilities {
        assert_operation_description(capability);
    }
    let _operation_name: &str = OperationId::ALL[0].as_str();
    let credentials = client.credentials();
    let status: CredentialStatus = credentials.status().await?;
    assert_credential_status(&status);
    let approval: Option<ApprovalObservation> =
        credentials.approval_status(ApprovalCategory::Stock).await?;
    if let Some(observation) = &approval {
        assert_approval_observation(observation);
    }
    let checked: ApprovalObservation = credentials
        .check_approval(ApprovalCategory::Stock, Cancellation::new())
        .await?;
    assert_approval_observation(&checked);
    credentials
        .set(ApiKey::parse("test-only-placeholder")?)
        .await?;
    let _removed = credentials.remove().await?;
    let migration: CredentialMigrationResult = credentials.migrate_legacy().await?;
    assert_credential_migration(&migration);

    let cache = client.cache();
    let inspection: CacheInspection = cache
        .inspect(CacheInspectOptions {
            operation: Some(OperationId::StockStkByddTrd),
            date: Some(date),
            limit: Some(100),
        })
        .await?;
    assert_cache_inspection(&inspection);
    let pruned: CachePruneResult = cache
        .prune(CachePruneOptions {
            older_than: Some(SystemTime::UNIX_EPOCH),
            max_entries: Some(100),
        })
        .await?;
    assert_cache_prune_result(&pruned);
    let cleared: CachePruneResult = cache.clear().await?;
    assert_cache_prune_result(&cleared);

    let watchlist = client.watchlist();
    let entries: Vec<WatchlistEntry> = watchlist.list().await?;
    for entry in &entries {
        assert_watchlist_entry(entry);
    }
    let _added: bool = watchlist
        .add(WatchlistEntry::new(
            "KR7005930003",
            "005930",
            "삼성전자",
            krx_sdk::WatchlistMarket::Kospi,
        )?)
        .await?;
    let _konex = WatchlistEntry::new(
        "KR7244690001",
        "244690",
        "올리패스",
        krx_sdk::WatchlistMarket::Konex,
    )?;
    let _removed: bool = watchlist.remove("005930").await?;
    Ok(())
}

fn assert_provenance(provenance: &ResultProvenance) {
    assert_result_source(provenance.source);
    let _fetched_at: &SystemTime = &provenance.fetched_at;
    assert_freshness(provenance.freshness);
    let _contract_id: &str = provenance.contract_id;
}

fn assert_composite_result<Data, Id>(result: &CompositeResult<Data, Id>) {
    let _success: bool = result.success;
    let _data: &Data = &result.data;
    assert_completeness_state(result.completeness.state);
    let _requested: &[Id] = &result.completeness.requested;
    let _succeeded: &[Id] = &result.completeness.succeeded;
    let _skipped: &[Id] = &result.completeness.skipped;
    for failure in &result.completeness.failed {
        let _id: &Id = &failure.id;
        let _error: &KrxError = &failure.error;
    }
    for provenance in result.provenance.values() {
        assert_provenance(provenance);
    }
    let _error: &Option<KrxError> = &result.error;
}

fn assert_range_result(range: &RangeResult) {
    assert_composite_result(&range.result);
    let _fetched_days: usize = range.fetched_days;
    let _failed_days: usize = range.failed_days;
    let _calendar_version: &String = &range.calendar.version;
    let _calendar_source: &String = &range.calendar.source;
    let calendar_retrieved_at: &CalendarDate = &range.calendar.retrieved_at;
    let _calendar_retrieved_at_text: &str = calendar_retrieved_at.as_str();
    assert_calendar_coverage(range.calendar.coverage);
    let _unverified_dates: &[TradingDate] = &range.calendar.unverified_dates;
    if let Some(adjustment) = &range.adjustment {
        let _method: &String = &adjustment.method;
        let _version: u32 = adjustment.version;
        let _as_of: &TradingDate = &adjustment.as_of;
        let _rounding: &String = &adjustment.rounding;
        let _raw_fields: &[String] = &adjustment.raw_fields;
        let _adjusted_fields: &[String] = &adjustment.adjusted_fields;
        assert_adjustment_factor_field(adjustment.factor_field);
        let _basis_transitions: &[String] = &adjustment.basis_transitions;
        assert_cash_dividend_treatment(adjustment.cash_dividends);
    }
}

fn assert_stock_search_match(stock: &StockSearchMatch) {
    let _isu_cd: &String = &stock.isu_cd;
    let _isu_srt_cd: &String = &stock.isu_srt_cd;
    let _isu_nm: &String = &stock.isu_nm;
    assert_search_market(stock.market);
}

fn assert_market_summary(summary: &MarketSummary) {
    let _date: &TradingDate = &summary.date;
    let _kospi_index: &Option<Vec<Row>> = &summary.kospi_index;
    let _kosdaq_index: &Option<Vec<Row>> = &summary.kosdaq_index;
    let _top_gainers: &Option<Vec<Row>> = &summary.top_gainers;
    let _top_losers: &Option<Vec<Row>> = &summary.top_losers;
    if let Some(stats) = &summary.stock_stats {
        assert_stock_stats(stats);
    }
}

fn assert_stock_stats(stats: &StockStats) {
    let _advancing: u64 = stats.advancing;
    let _declining: u64 = stats.declining;
    let _unchanged: u64 = stats.unchanged;
    let _total_volume: u64 = stats.total_volume;
    let _total_value: u64 = stats.total_value;
}

fn assert_watchlist_prices(prices: &WatchlistPrices) {
    let _date: &TradingDate = &prices.date;
    let _stocks: &[Row] = &prices.stocks;
}

fn assert_operation_description(description: &OperationDescription) {
    let _operation_id: OperationId = description.operation_id;
    let _category: ApprovalCategory = description.category;
    let _description: &str = description.description;
    let _description_ko: &str = description.description_ko;
    let _contract_id: &str = description.contract_id;
    for field in description.request_fields {
        let _name: &str = field.name;
        let _description: &str = field.description;
    }
    for field in description.response_fields {
        let _name: &str = field.name;
        let _description: &str = field.description;
    }
}

fn assert_credential_status(status: &CredentialStatus) {
    assert_credential_source(status.source);
    let _persisted: bool = status.persisted;
}

fn assert_approval_observation(observation: &ApprovalObservation) {
    let _category: ApprovalCategory = observation.category;
    assert_approval_state(observation.state);
    let _checked_at: &SystemTime = &observation.checked_at;
    let _valid_until: &SystemTime = &observation.valid_until;
    let _fresh: bool = observation.fresh;
    let _error: &Option<KrxError> = &observation.error;
}

fn assert_credential_migration(migration: &CredentialMigrationResult) {
    let _migrated: bool = migration.migrated;
    let _legacy_secret_removed: bool = migration.legacy_secret_removed;
    let _approvals_migrated: usize = migration.approvals_migrated;
}

fn assert_cache_inspection(inspection: &CacheInspection) {
    let _entries: &[CacheEntryDescription] = &inspection.entries;
    let _total_entries: usize = inspection.total_entries;
    let _total_size_bytes: u64 = inspection.total_size_bytes;
    let _truncated: bool = inspection.truncated;
    for entry in &inspection.entries {
        let _operation: OperationId = entry.operation;
        let _date: &TradingDate = &entry.date;
        let _fetched_at: &SystemTime = &entry.fetched_at;
        assert_freshness(entry.freshness);
        let _size_bytes: u64 = entry.size_bytes;
        let _contract_id: &String = &entry.contract_id;
    }
}

fn assert_cache_prune_result(result: &CachePruneResult) {
    let _removed_entries: usize = result.removed_entries;
    let _removed_bytes: u64 = result.removed_bytes;
}

fn assert_watchlist_entry(entry: &WatchlistEntry) {
    let _isin: &String = &entry.isin;
    let _security_code: &SecurityCode = &entry.security_code;
    let _name: &String = &entry.name;
    assert_watchlist_market(entry.market);
}

fn assert_result_source(source: ResultSource) {
    match source {
        ResultSource::Network => {}
        ResultSource::Cache => {}
    }
}

fn assert_completeness_state(state: CompletenessState) {
    match state {
        CompletenessState::Complete => {}
        CompletenessState::Partial => {}
        CompletenessState::Empty => {}
        CompletenessState::Failed => {}
    }
}

fn assert_credential_source(source: CredentialSource) {
    match source {
        CredentialSource::Explicit => {}
        CredentialSource::Environment => {}
        CredentialSource::Keychain => {}
        CredentialSource::Missing => {}
    }
}

fn assert_search_market(market: SearchMarket) {
    match market {
        SearchMarket::Kospi => {}
        SearchMarket::Kosdaq => {}
    }
}

fn assert_market_component(component: MarketComponent) {
    match component {
        MarketComponent::KospiIndex => {}
        MarketComponent::KosdaqIndex => {}
        MarketComponent::KospiStocks => {}
        MarketComponent::KosdaqStocks => {}
    }
}

fn assert_watchlist_market(market: WatchlistMarket) {
    match market {
        WatchlistMarket::Kospi => {}
        WatchlistMarket::Kosdaq => {}
        WatchlistMarket::Konex => {}
    }
}

fn assert_calendar_coverage(coverage: CalendarCoverage) {
    match coverage {
        CalendarCoverage::Official => {}
        CalendarCoverage::Fallback => {}
    }
}

fn assert_adjustment_factor_field(field: AdjustmentFactorField) {
    match field {
        AdjustmentFactorField::AdjFactor => {}
    }
}

fn assert_cash_dividend_treatment(treatment: CashDividendTreatment) {
    match treatment {
        CashDividendTreatment::Excluded => {}
    }
}

fn assert_approval_state(state: ApprovalState) {
    match state {
        ApprovalState::Approved => {}
        ApprovalState::Rejected => {}
        ApprovalState::Inconclusive => {}
    }
}

fn assert_freshness(freshness: Freshness) {
    match freshness {
        Freshness::Fresh => {}
        Freshness::Stale => {}
    }
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
        .build()
}

fn bypass_cache() -> CachePolicy {
    CachePolicy::Bypass
}
