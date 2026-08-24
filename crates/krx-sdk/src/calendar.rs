use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use jiff::ToSpan;
use jiff::civil::{Date, Weekday};
use serde::Deserialize;

use crate::{
    CalendarCoverage, CalendarDate, CalendarSelection, DateRange, KrxError, KrxErrorCode,
    TradingDate,
};

const SNAPSHOT_JSON: &str = include_str!("../../../src/calendar/krx-closures.json");
const SNAPSHOT_VERSION: u32 = 1;
const SNAPSHOT_SOURCE: &str =
    "https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarSnapshot {
    version: u32,
    source: String,
    retrieved_at: String,
    years: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DateStatus {
    Trading,
    NonTrading,
    Unknown,
}

#[derive(Debug)]
pub(crate) struct TradingDaySelection {
    pub requested_dates: Vec<TradingDate>,
    pub trading_days: Vec<TradingDate>,
    pub skipped_days: Vec<TradingDate>,
    pub calendar: CalendarSelection,
}

#[derive(Debug)]
pub(crate) struct RecentTradingDate {
    pub date: TradingDate,
    pub calendar: CalendarSelection,
}

fn snapshot() -> Result<&'static CalendarSnapshot, KrxError> {
    static SNAPSHOT: OnceLock<Result<CalendarSnapshot, String>> = OnceLock::new();
    match SNAPSHOT.get_or_init(|| {
        let snapshot = serde_json::from_str::<CalendarSnapshot>(SNAPSHOT_JSON)
            .map_err(|error| error.to_string())?;
        validate_snapshot(&snapshot)?;
        Ok(snapshot)
    }) {
        Ok(snapshot) => Ok(snapshot),
        Err(_) => Err(KrxError::new(
            KrxErrorCode::CalendarInvalid,
            "checked KRX calendar snapshot is invalid",
        )),
    }
}

fn validate_snapshot(snapshot: &CalendarSnapshot) -> Result<(), String> {
    if snapshot.version != SNAPSHOT_VERSION {
        return Err("unsupported calendar snapshot version".to_owned());
    }
    if snapshot.source != SNAPSHOT_SOURCE {
        return Err("calendar snapshot source is not the canonical KRX page".to_owned());
    }
    CalendarDate::parse(&snapshot.retrieved_at)
        .map_err(|_| "invalid calendar retrieval date".to_owned())?;
    if snapshot.years.is_empty() {
        return Err("calendar snapshot has no covered years".to_owned());
    }

    for (year, closures) in &snapshot.years {
        if year.len() != 4 || !year.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("calendar snapshot contains an invalid year".to_owned());
        }
        if closures.is_empty() {
            return Err(format!("calendar year {year} has no closures"));
        }
        for (date, reason) in closures {
            if !date.starts_with(year) {
                return Err(format!("calendar closure {date} belongs to the wrong year"));
            }
            TradingDate::parse(date)
                .map_err(|_| format!("calendar closure {date} is not a real date"))?;
            if reason.trim().is_empty() {
                return Err(format!("calendar closure {date} has no reason"));
            }
        }
    }
    Ok(())
}

fn civil(date: &TradingDate) -> Result<Date, KrxError> {
    Date::strptime("%Y%m%d", date.as_str()).map_err(|_| {
        KrxError::new(
            KrxErrorCode::CalendarInvalid,
            "trading date is outside the supported calendar range",
        )
    })
}

fn trading_date(date: Date) -> Result<TradingDate, KrxError> {
    TradingDate::parse(&date.strftime("%Y%m%d").to_string())
}

fn is_weekend(date: Date) -> bool {
    matches!(date.weekday(), Weekday::Saturday | Weekday::Sunday)
}

fn year_end_closure(year: i16) -> Result<Date, KrxError> {
    let mut date = Date::new(year, 12, 31).map_err(|_| {
        KrxError::new(
            KrxErrorCode::CalendarInvalid,
            "calendar year is outside the supported range",
        )
    })?;
    while is_weekend(date) {
        date = date.checked_add(-1.day()).map_err(|_| {
            KrxError::new(
                KrxErrorCode::CalendarInvalid,
                "calendar year-end calculation overflowed",
            )
        })?;
    }
    Ok(date)
}

fn fallback_closure(date: Date, last_covered_year: i16) -> Result<bool, KrxError> {
    if date.year() <= last_covered_year {
        return Ok(false);
    }
    let month_day = (date.month(), date.day());
    if matches!(
        month_day,
        (1, 1) | (3, 1) | (5, 1) | (5, 5) | (6, 6) | (8, 15) | (10, 3) | (12, 25)
    ) || (date.year() >= 2013 && month_day == (10, 9))
        || (date.year() >= 2026 && month_day == (7, 17))
    {
        return Ok(true);
    }
    Ok(date == year_end_closure(date.year())?)
}

fn classify(date: &TradingDate, snapshot: &CalendarSnapshot) -> Result<DateStatus, KrxError> {
    let civil = civil(date)?;
    if is_weekend(civil) {
        return Ok(DateStatus::NonTrading);
    }
    let year = civil.year().to_string();
    if let Some(closures) = snapshot.years.get(&year) {
        return Ok(if closures.contains_key(date.as_str()) {
            DateStatus::NonTrading
        } else {
            DateStatus::Trading
        });
    }
    let last_covered_year = snapshot
        .years
        .keys()
        .filter_map(|year| year.parse::<i16>().ok())
        .max()
        .ok_or_else(|| {
            KrxError::new(
                KrxErrorCode::CalendarInvalid,
                "checked KRX calendar snapshot has no covered years",
            )
        })?;
    if fallback_closure(civil, last_covered_year)? {
        Ok(DateStatus::NonTrading)
    } else {
        Ok(DateStatus::Unknown)
    }
}

fn selection(
    snapshot: &CalendarSnapshot,
    fallback_years: &BTreeSet<i16>,
    unverified_dates: Vec<TradingDate>,
) -> Result<CalendarSelection, KrxError> {
    Ok(CalendarSelection {
        version: snapshot.version.to_string(),
        source: snapshot.source.clone(),
        retrieved_at: CalendarDate::parse(&snapshot.retrieved_at).map_err(|_| {
            KrxError::new(
                KrxErrorCode::CalendarInvalid,
                "checked KRX calendar retrieval date is invalid",
            )
        })?,
        coverage: if fallback_years.is_empty() {
            CalendarCoverage::Official
        } else {
            CalendarCoverage::Fallback
        },
        unverified_dates,
    })
}

pub(crate) fn select_range(range: &DateRange) -> Result<TradingDaySelection, KrxError> {
    let snapshot = snapshot()?;
    let mut current = civil(&range.from)?;
    let end = civil(&range.to)?;
    let mut requested_dates = Vec::new();
    let mut trading_days = Vec::new();
    let mut skipped_days = Vec::new();
    let mut unverified_dates = Vec::new();
    let mut fallback_years = BTreeSet::new();

    while current <= end {
        let date = trading_date(current)?;
        if !snapshot.years.contains_key(&current.year().to_string()) {
            fallback_years.insert(current.year());
        }
        requested_dates.push(date.clone());
        match classify(&date, snapshot)? {
            DateStatus::Trading => trading_days.push(date),
            DateStatus::NonTrading => skipped_days.push(date),
            DateStatus::Unknown => {
                unverified_dates.push(date.clone());
                trading_days.push(date);
            }
        }
        current = current.checked_add(1.day()).map_err(|_| {
            KrxError::new(
                KrxErrorCode::CalendarInvalid,
                "date range exceeds the supported calendar",
            )
        })?;
    }

    Ok(TradingDaySelection {
        requested_dates,
        trading_days,
        skipped_days,
        calendar: selection(snapshot, &fallback_years, unverified_dates)?,
    })
}

pub(crate) fn resolve_recent(today_kst: &TradingDate) -> Result<RecentTradingDate, KrxError> {
    let snapshot = snapshot()?;
    let mut current = civil(today_kst)?.checked_add(-1.day()).map_err(|_| {
        KrxError::new(
            KrxErrorCode::CalendarInvalid,
            "recent-date resolution exceeds the supported calendar",
        )
    })?;
    let mut fallback_years = BTreeSet::new();
    let mut unverified_dates = Vec::new();

    for _ in 0..370 {
        let date = trading_date(current)?;
        if !snapshot.years.contains_key(&current.year().to_string()) {
            fallback_years.insert(current.year());
        }
        match classify(&date, snapshot)? {
            DateStatus::Trading => {
                return Ok(RecentTradingDate {
                    date,
                    calendar: selection(snapshot, &fallback_years, unverified_dates)?,
                });
            }
            DateStatus::Unknown => unverified_dates.push(date),
            DateStatus::NonTrading => {}
        }
        current = current.checked_add(-1.day()).map_err(|_| {
            KrxError::new(
                KrxErrorCode::CalendarInvalid,
                "recent-date resolution exceeds the supported calendar",
            )
        })?;
    }
    Err(KrxError::new(
        KrxErrorCode::CalendarInvalid,
        "no verified KRX session is available within 370 days",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> TradingDate {
        TradingDate::parse(value).expect("fixture date")
    }

    fn valid_snapshot() -> CalendarSnapshot {
        CalendarSnapshot {
            version: SNAPSHOT_VERSION,
            source: SNAPSHOT_SOURCE.to_owned(),
            retrieved_at: "2026-08-22".to_owned(),
            years: BTreeMap::from([(
                "2026".to_owned(),
                BTreeMap::from([("20260101".to_owned(), "New Year's Day".to_owned())]),
            )]),
        }
    }

    #[test]
    fn rejects_semantically_invalid_snapshots() {
        let mut snapshot = valid_snapshot();
        snapshot.version += 1;
        assert!(validate_snapshot(&snapshot).is_err());

        let mut snapshot = valid_snapshot();
        snapshot.source = "https://example.invalid/calendar".to_owned();
        assert!(validate_snapshot(&snapshot).is_err());

        let mut snapshot = valid_snapshot();
        snapshot.years = BTreeMap::from([(
            "2025".to_owned(),
            BTreeMap::from([("20260101".to_owned(), "wrong year".to_owned())]),
        )]);
        assert!(validate_snapshot(&snapshot).is_err());

        let mut snapshot = valid_snapshot();
        snapshot.years = BTreeMap::from([(
            "2026".to_owned(),
            BTreeMap::from([("20260230".to_owned(), "impossible".to_owned())]),
        )]);
        assert!(validate_snapshot(&snapshot).is_err());

        let mut snapshot = valid_snapshot();
        snapshot.years = BTreeMap::from([(
            "2026".to_owned(),
            BTreeMap::from([("20260101".to_owned(), "  ".to_owned())]),
        )]);
        assert!(validate_snapshot(&snapshot).is_err());
    }

    #[test]
    fn selects_verified_sessions_and_skips_known_closures() {
        let selection =
            select_range(&DateRange::new(date("20260923"), date("20260928")).expect("range"))
                .expect("calendar selection");
        assert_eq!(
            selection
                .trading_days
                .iter()
                .map(TradingDate::as_str)
                .collect::<Vec<_>>(),
            ["20260923", "20260928"]
        );
        assert_eq!(selection.skipped_days.len(), 4);
        assert_eq!(selection.calendar.coverage, CalendarCoverage::Official);
    }

    #[test]
    fn preserves_uncovered_weekdays_as_observable_probes() {
        let selection =
            select_range(&DateRange::new(date("20150101"), date("20150104")).expect("range"))
                .expect("calendar selection");
        assert_eq!(selection.trading_days, [date("20150101"), date("20150102")]);
        assert_eq!(selection.skipped_days, [date("20150103"), date("20150104")]);
        assert_eq!(selection.calendar.coverage, CalendarCoverage::Fallback);
        assert_eq!(selection.calendar.unverified_dates, selection.trading_days);
        assert_eq!(selection.requested_dates.len(), 4);
    }

    #[test]
    fn applies_conservative_future_closures_without_guessing_weekdays() {
        let selection =
            select_range(&DateRange::new(date("20270101"), date("20270104")).expect("range"))
                .expect("calendar selection");
        assert_eq!(selection.trading_days, [date("20270104")]);
        assert_eq!(selection.skipped_days.len(), 3);
        assert_eq!(selection.calendar.unverified_dates, [date("20270104")]);
    }

    #[test]
    fn recent_defaults_skip_unknown_dates_and_full_holiday_periods() {
        assert_eq!(
            resolve_recent(&date("20260219")).expect("recent").date,
            date("20260213")
        );
        let fallback = resolve_recent(&date("20270105")).expect("recent fallback");
        assert_eq!(fallback.date, date("20261230"));
        assert_eq!(fallback.calendar.coverage, CalendarCoverage::Fallback);
        assert_eq!(fallback.calendar.unverified_dates, [date("20270104")]);
    }
}
