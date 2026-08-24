//! Shared KRX protocol, domain, and local-policy SDK.
//!
//! Public callers use the flat project-owned surface re-exported here. HTTP,
//! filesystem, keychain, and clock seams remain private implementation details.

// These expectations are transitional and self-removing: strict linting will
// fail once a later SDK commit consumes every private seam but leaves one here.
mod adjustment;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "calendar selection is consumed by ranges and default-date resolution"
    )
)]
mod calendar;
mod completeness;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "composite reducers are consumed by the private client engine"
    )
)]
mod composites;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "consumed by the private client engine in this SDK PR"
    )
)]
mod conformer;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "generated mappings are consumed by later SDK modules"
    )
)]
mod error;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "catalog access is consumed by the private client engine"
    )
)]
mod operation;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "quota reservation is consumed by the private transport in this SDK PR"
    )
)]
#[cfg(any(unix, windows))]
mod quota;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "range reduction is consumed by the private client engine"
    )
)]
mod range;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "private accessors are consumed by later SDK modules"
    )
)]
mod request;
mod result;
#[cfg(unix)]
mod state;
#[cfg(windows)]
#[path = "state_windows.rs"]
mod state;

pub use error::{KrxError, KrxErrorCode, KrxErrorKind};
pub use operation::{
    ApprovalCategory, OperationDescription, OperationFieldDescription, OperationId,
};
pub use request::{
    ApiKey, CachePolicy, CalendarDate, CallOptions, Cancellation, DateRange, DirectRequest,
    MarketSummaryRequest, RangeMode, RangeRequest, SecurityCode, StockSearchRequest, TradingDate,
    WatchlistPricesRequest,
};
pub use result::{
    AdjustmentFactorField, AdjustmentMetadata, CalendarCoverage, CalendarSelection,
    CashDividendTreatment, Completeness, CompletenessState, CompositeFailure, CompositeResult,
    Freshness, MarketComponent, MarketSummary, MarketSummaryResult, QueryResult, RangeResult,
    ResultProvenance, ResultSource, Row, SearchMarket, StockSearchMatch, StockSearchResult,
    StockStats, WatchlistMarket, WatchlistPrices, WatchlistPricesResult,
};
