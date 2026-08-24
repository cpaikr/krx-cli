use std::fmt;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::{KrxError, KrxErrorCode, OperationId};

#[derive(Clone, Eq, PartialEq)]
pub struct ApiKey(Zeroizing<String>);

impl ApiKey {
    pub fn parse(value: &str) -> Result<Self, KrxError> {
        let value = value.trim();
        if value.is_empty() || value.chars().any(char::is_whitespace) {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "API key must be a non-empty token",
            ));
        }
        Ok(Self(Zeroizing::new(value.to_owned())))
    }

    pub(crate) fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ApiKey([REDACTED])")
    }
}

#[derive(Clone, Debug)]
pub struct Cancellation(CancellationToken);

impl Cancellation {
    pub fn new() -> Self {
        Self(CancellationToken::new())
    }

    pub fn cancel(&self) {
        self.0.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    pub(crate) async fn cancelled(&self) {
        self.0.cancelled().await;
    }
}

impl Default for Cancellation {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TradingDate(String);

impl TradingDate {
    pub fn parse(value: &str) -> Result<Self, KrxError> {
        if !valid_compact_date(value) {
            return Err(KrxError::new(
                KrxErrorCode::InvalidDate,
                "date must be a valid YYYYMMDD calendar date",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CalendarDate(String);

impl CalendarDate {
    pub fn parse(value: &str) -> Result<Self, KrxError> {
        let bytes = value.as_bytes();
        if bytes.len() != 10
            || bytes[4] != b'-'
            || bytes[7] != b'-'
            || bytes[..4].iter().any(|byte| !byte.is_ascii_digit())
            || bytes[5..7].iter().any(|byte| !byte.is_ascii_digit())
            || bytes[8..].iter().any(|byte| !byte.is_ascii_digit())
        {
            return Err(KrxError::new(
                KrxErrorCode::InvalidDate,
                "calendar date must use YYYY-MM-DD",
            ));
        }
        let compact = [&value[0..4], &value[5..7], &value[8..10]].concat();
        if !valid_compact_date(&compact) {
            return Err(KrxError::new(
                KrxErrorCode::InvalidDate,
                "calendar date must be a valid YYYY-MM-DD date",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn valid_compact_date(value: &str) -> bool {
    if value.len() != 8 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Some(year) = value[0..4].parse::<u32>().ok() else {
        return false;
    };
    let Some(month) = value[4..6].parse::<u32>().ok() else {
        return false;
    };
    let Some(day) = value[6..8].parse::<u32>().ok() else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day > 0 && day <= days
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SecurityCode(String);

impl SecurityCode {
    pub fn parse(value: &str) -> Result<Self, KrxError> {
        if value.len() != 6 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "security code must contain exactly six digits",
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DateRange {
    pub from: TradingDate,
    pub to: TradingDate,
}

impl DateRange {
    pub fn new(from: TradingDate, to: TradingDate) -> Result<Self, KrxError> {
        if from > to {
            return Err(KrxError::new(
                KrxErrorCode::InvalidArgument,
                "range start must not follow range end",
            ));
        }
        Ok(Self { from, to })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CachePolicy {
    Prefer { max_age: Duration },
    Refresh,
    Bypass,
    Offline,
}

#[derive(Clone, Debug)]
pub struct CallOptions {
    pub cache: CachePolicy,
    pub retries: u8,
    pub cancellation: Cancellation,
}

impl Default for CallOptions {
    fn default() -> Self {
        Self {
            cache: CachePolicy::Prefer {
                max_age: Duration::from_secs(168 * 60 * 60),
            },
            retries: 3,
            cancellation: Cancellation::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DirectRequest {
    pub operation: OperationId,
    pub date: TradingDate,
    pub options: CallOptions,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_project_owned_scalar_types() {
        assert!(TradingDate::parse("20240229").is_ok());
        assert!(TradingDate::parse("20230229").is_err());
        assert!(CalendarDate::parse("2026-08-24").is_ok());
        assert!(CalendarDate::parse("2026-02-29").is_err());
        assert!(CalendarDate::parse("2é6-08-24").is_err());
        assert!(SecurityCode::parse("005930").is_ok());
        assert!(SecurityCode::parse("5930").is_err());
    }

    #[test]
    fn secrets_are_trimmed_once_and_redacted() {
        let key = ApiKey::parse("  fixture-token  ").expect("valid key");
        assert_eq!(key.expose(), "fixture-token");
        assert_eq!(format!("{key:?}"), "ApiKey([REDACTED])");
        assert!(ApiKey::parse("embedded space").is_err());
    }

    #[test]
    fn cancellation_is_shared_between_clones() {
        let cancellation = Cancellation::new();
        let clone = cancellation.clone();
        cancellation.cancel();
        assert!(clone.is_cancelled());
        std::mem::drop(clone.cancelled());
    }
}
