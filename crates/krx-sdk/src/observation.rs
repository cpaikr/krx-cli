use std::sync::{Arc, Mutex};

use crate::{Freshness, OperationId, TradingDate};

/// A cloneable, pull-based stream of sanitized SDK decisions.
///
/// Observations deliberately contain only contract identifiers, validated
/// dates, bounded counters, and timing metadata. Credentials, response bodies,
/// provider messages, filesystem paths, and arbitrary error text never enter
/// this buffer.
#[derive(Clone, Default)]
pub struct ObservationBuffer {
    inner: Option<Arc<Mutex<Vec<Observation>>>>,
}

impl ObservationBuffer {
    /// Create an enabled diagnostic buffer.
    ///
    /// The default buffer is disabled so clients that do not request
    /// observations pay no retention cost. An enabled clone shares one drain
    /// queue; frontends should attach one buffer to one logical command and
    /// call [`Self::take`] after that command completes.
    pub fn new() -> Self {
        Self {
            inner: Some(Arc::new(Mutex::new(Vec::new()))),
        }
    }

    /// Remove and return every currently buffered observation in deterministic
    /// operation/date/phase order. This makes concurrent range output stable.
    pub fn take(&self) -> Vec<Observation> {
        let Some(inner) = &self.inner else {
            return Vec::new();
        };
        let mut values = std::mem::take(&mut *inner.lock().expect("observation buffer"));
        values.sort_by_cached_key(Observation::sort_key);
        values
    }

    pub(crate) fn record(&self, observation: Observation) {
        if let Some(inner) = &self.inner {
            inner.lock().expect("observation buffer").push(observation);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Observation {
    pub operation: OperationId,
    pub date: TradingDate,
    pub phase: ObservationPhase,
}

impl Observation {
    fn sort_key(&self) -> (String, String, u16) {
        (
            self.operation.as_str().to_owned(),
            self.date.as_str().to_owned(),
            self.phase.order(),
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObservationPhase {
    Cache {
        path: &'static str,
        action: CacheObservation,
        freshness: Option<Freshness>,
    },
    Range {
        to: TradingDate,
        requestable_days: u32,
        known_non_trading_days: u32,
        fallback_years: Vec<i16>,
        unverified_days: u32,
    },
    Request {
        method: &'static str,
        url: String,
        body: String,
    },
    Quota {
        attempt: u8,
        count: u32,
        limit: u32,
        warning: bool,
    },
    Retry {
        attempt: u8,
        maximum_retries: u8,
        delay_ms: u64,
        reason: RetryReason,
    },
    Response {
        status: u16,
        rows: Option<u32>,
        elapsed_ms: u64,
    },
}

impl ObservationPhase {
    fn order(&self) -> u16 {
        match self {
            Self::Range { .. } => 0,
            Self::Cache { .. } => 1,
            Self::Request { .. } => 2,
            Self::Quota { attempt, .. } => 10 + u16::from(*attempt).saturating_mul(2),
            Self::Retry { attempt, .. } => 11 + u16::from(*attempt).saturating_mul(2),
            Self::Response { .. } => u16::MAX,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CacheObservation {
    Hit,
    Miss,
    Refresh,
    Bypass,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetryReason {
    HttpStatus(u16),
    Network,
    Timeout,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(date: &str, phase: ObservationPhase) -> Observation {
        Observation {
            operation: OperationId::StockStkByddTrd,
            date: TradingDate::parse(date).expect("date"),
            phase,
        }
    }

    #[test]
    fn take_is_deterministic_and_drains_the_buffer() {
        let buffer = ObservationBuffer::new();
        buffer.record(observation(
            "20260825",
            ObservationPhase::Response {
                status: 200,
                rows: Some(2),
                elapsed_ms: 4,
            },
        ));
        buffer.record(observation(
            "20260824",
            ObservationPhase::Quota {
                attempt: 2,
                count: 2,
                limit: 10_000,
                warning: false,
            },
        ));
        buffer.record(observation(
            "20260824",
            ObservationPhase::Retry {
                attempt: 1,
                maximum_retries: 3,
                delay_ms: 500,
                reason: RetryReason::Network,
            },
        ));
        buffer.record(observation(
            "20260824",
            ObservationPhase::Quota {
                attempt: 1,
                count: 1,
                limit: 10_000,
                warning: false,
            },
        ));
        buffer.record(observation(
            "20260824",
            ObservationPhase::Request {
                method: "POST",
                url: "https://example.invalid/fixture".to_owned(),
                body: "{}".to_owned(),
            },
        ));
        buffer.record(observation(
            "20260824",
            ObservationPhase::Cache {
                path: "/fixture",
                action: CacheObservation::Miss,
                freshness: None,
            },
        ));

        let values = buffer.take();
        assert!(matches!(values[0].phase, ObservationPhase::Cache { .. }));
        assert!(matches!(values[1].phase, ObservationPhase::Request { .. }));
        assert!(matches!(
            values[2].phase,
            ObservationPhase::Quota { attempt: 1, .. }
        ));
        assert!(matches!(
            values[3].phase,
            ObservationPhase::Retry { attempt: 1, .. }
        ));
        assert!(matches!(
            values[4].phase,
            ObservationPhase::Quota { attempt: 2, .. }
        ));
        assert!(matches!(values[5].phase, ObservationPhase::Response { .. }));
        assert!(buffer.take().is_empty());
    }

    #[test]
    fn default_buffer_is_disabled() {
        let buffer = ObservationBuffer::default();
        buffer.record(observation(
            "20260824",
            ObservationPhase::Cache {
                path: "/fixture",
                action: CacheObservation::Miss,
                freshness: None,
            },
        ));
        assert!(buffer.take().is_empty());
    }
}
