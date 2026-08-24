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
        reason = "approval persistence is consumed by the private client engine in this SDK PR"
    )
)]
mod approval;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "cache policy is consumed by the private client engine in this SDK PR"
    )
)]
mod cache;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "calendar selection is consumed by ranges and default-date resolution"
    )
)]
mod calendar;
mod client;
mod completeness;
mod composites;
mod conformer;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "credential resolution is consumed by the private client engine in this SDK PR"
    )
)]
mod credential;
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
mod range;
mod request;
mod result;
#[cfg(unix)]
mod state;
#[cfg(windows)]
#[path = "state_windows.rs"]
mod state;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the private transport is consumed by the client engine in this SDK PR"
    )
)]
#[cfg_attr(test, allow(dead_code))]
mod transport;
mod watchlist;

pub use approval::{ApprovalObservation, ApprovalState};
pub use cache::{
    CacheEntryDescription, CacheInspectOptions, CacheInspection, CachePruneOptions,
    CachePruneResult,
};
pub use client::{CacheHandle, Client, ClientBuilder, CredentialHandle, WatchlistHandle};
pub use credential::{CredentialMigrationResult, CredentialSource, CredentialStatus};
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
pub use watchlist::WatchlistEntry;
