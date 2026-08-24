use std::collections::BTreeMap;
use std::time::SystemTime;

use crate::{CalendarDate, KrxError, TradingDate};

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
    pub(crate) fn new(fields: BTreeMap<String, String>) -> Self {
        Self(fields)
    }

    pub fn get(&self, field: &str) -> Option<&str> {
        self.0.get(field).map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(field, value)| (field.as_str(), value.as_str()))
    }

    pub(crate) fn insert(&mut self, field: impl Into<String>, value: impl Into<String>) {
        self.0.insert(field.into(), value.into());
    }
}

#[derive(Clone, Debug)]
pub struct QueryResult {
    pub rows: Vec<Row>,
    pub provenance: ResultProvenance,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CalendarCoverage {
    Official,
    Fallback,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CalendarSelection {
    pub version: String,
    pub source: String,
    pub retrieved_at: CalendarDate,
    pub coverage: CalendarCoverage,
    pub unverified_dates: Vec<TradingDate>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdjustmentFactorField {
    AdjFactor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CashDividendTreatment {
    Excluded,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdjustmentMetadata {
    pub method: String,
    pub version: u32,
    pub as_of: TradingDate,
    pub rounding: String,
    pub raw_fields: Vec<String>,
    pub adjusted_fields: Vec<String>,
    pub factor_field: AdjustmentFactorField,
    /// Lossless compact JSON objects in the frozen
    /// `krx-adjustment-transition/v1` field order.
    pub basis_transitions: Vec<String>,
    pub cash_dividends: CashDividendTreatment,
}

#[derive(Clone, Debug)]
pub struct RangeResult {
    pub result: CompositeResult<Vec<Row>, TradingDate>,
    pub fetched_days: usize,
    pub failed_days: usize,
    pub calendar: CalendarSelection,
    pub adjustment: Option<AdjustmentMetadata>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SearchMarket {
    Kospi,
    Kosdaq,
}

#[derive(Clone, Debug, Eq, PartialEq)]
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StockStats {
    pub advancing: u64,
    pub declining: u64,
    pub unchanged: u64,
    pub total_volume: u64,
    pub total_value: u64,
}

#[derive(Clone, Debug)]
pub struct MarketSummary {
    pub date: TradingDate,
    pub kospi_index: Option<Vec<Row>>,
    pub kosdaq_index: Option<Vec<Row>>,
    pub stock_stats: Option<StockStats>,
    pub top_gainers: Option<Vec<Row>>,
    pub top_losers: Option<Vec<Row>>,
}

pub type MarketSummaryResult = CompositeResult<MarketSummary, MarketComponent>;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum WatchlistMarket {
    Kospi,
    Kosdaq,
    Konex,
}

#[derive(Clone, Debug)]
pub struct WatchlistPrices {
    pub date: TradingDate,
    pub stocks: Vec<Row>,
}

pub type WatchlistPricesResult = CompositeResult<WatchlistPrices, WatchlistMarket>;
