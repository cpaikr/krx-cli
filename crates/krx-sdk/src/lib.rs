//! Shared KRX protocol, domain, and local-policy SDK.
//!
//! Public callers use the flat project-owned surface re-exported here. HTTP,
//! filesystem, keychain, and clock seams remain private implementation details.

// These expectations are transitional and self-removing: strict linting will
// fail once a later SDK commit consumes every private seam but leaves one here.
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
        reason = "private accessors are consumed by later SDK modules"
    )
)]
mod request;
mod result;

pub use error::{KrxError, KrxErrorCode, KrxErrorKind};
pub use operation::{
    ApprovalCategory, OperationDescription, OperationFieldDescription, OperationId,
};
pub use request::{
    ApiKey, CachePolicy, CalendarDate, CallOptions, Cancellation, DateRange, DirectRequest,
    SecurityCode, TradingDate,
};
pub use result::{
    Completeness, CompletenessState, CompositeFailure, CompositeResult, Freshness, QueryResult,
    ResultProvenance, ResultSource, Row,
};
