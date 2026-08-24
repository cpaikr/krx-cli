use std::collections::{BTreeMap, BTreeSet};

use crate::calendar::TradingDaySelection;
use crate::completeness::{self, CompletenessInput};
use crate::{
    CompletenessState, CompositeFailure, CompositeResult, KrxError, KrxErrorKind, QueryResult,
    RangeMode, RangeResult, TradingDate,
};

pub(crate) struct RangeOutcome {
    pub date: TradingDate,
    pub result: Result<QueryResult, KrxError>,
}

fn is_call_wide(error: &KrxError) -> bool {
    matches!(
        error.kind(),
        KrxErrorKind::Cancelled
            | KrxErrorKind::InvalidRequest
            | KrxErrorKind::LocalState
            | KrxErrorKind::Internal
    )
}

fn adjustment_failure(mut range: RangeResult, error: KrxError) -> RangeResult {
    // The frozen failure identifier is a trading date. Adjustment is a
    // range-wide integrity step, so inventing a date would corrupt the
    // mutually exclusive upstream outcome partitions.
    range.result.success = false;
    range.result.data.clear();
    range.result.completeness.state = CompletenessState::Failed;
    range.result.error = Some(error);
    range.adjustment = None;
    range
}

fn apply_adjustment(mut range: RangeResult, security_code: &crate::SecurityCode) -> RangeResult {
    if range.result.completeness.state == CompletenessState::Empty
        && range.result.completeness.succeeded.is_empty()
        && range.result.data.is_empty()
        && range.fetched_days == 0
    {
        return range;
    }
    // An all-provider failure already carries the primary typed upstream
    // error. Adjustment did not run and must not erase that diagnosis.
    if range.result.completeness.state == CompletenessState::Failed {
        return range;
    }
    if range.fetched_days > range.result.completeness.succeeded.len() {
        return adjustment_failure(
            range,
            KrxError::new(
                crate::KrxErrorCode::AdjustmentIncomplete,
                "adjusted prices cannot verify requestable dates with empty upstream responses",
            ),
        );
    }
    if range.result.completeness.state != CompletenessState::Complete {
        return adjustment_failure(
            range,
            KrxError::new(
                crate::KrxErrorCode::AdjustmentIncomplete,
                "adjusted prices require a complete upstream date range",
            ),
        );
    }

    let rows = std::mem::take(&mut range.result.data)
        .into_iter()
        .filter(|row| {
            [row.get("ISU_CD"), row.get("ISU_SRT_CD")]
                .into_iter()
                .flatten()
                .any(|code| code == security_code.as_str())
        })
        .collect::<Vec<_>>();
    let observed = rows
        .iter()
        .filter_map(|row| row.get("BAS_DD"))
        .collect::<BTreeSet<_>>();
    let missing = range
        .result
        .completeness
        .succeeded
        .iter()
        .filter(|date| !observed.contains(date.as_str()))
        .map(|date| date.as_str().to_owned())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return adjustment_failure(
            range,
            KrxError::new(
                crate::KrxErrorCode::AdjustmentIncomplete,
                format!(
                    "requested security is missing on successful market date(s): {}",
                    missing.join(", ")
                ),
            ),
        );
    }
    match crate::adjustment::adjust_stock_rows(rows, security_code) {
        Ok((rows, metadata)) => {
            range.result.data = rows;
            range.adjustment = Some(metadata);
            range
        }
        Err(error) => adjustment_failure(range, error),
    }
}

pub(crate) fn reduce(
    selection: TradingDaySelection,
    outcomes: Vec<RangeOutcome>,
    mode: &RangeMode,
) -> Result<RangeResult, KrxError> {
    if outcomes.len() != selection.trading_days.len()
        || outcomes
            .iter()
            .zip(&selection.trading_days)
            .any(|(outcome, expected)| outcome.date != *expected)
    {
        return Err(KrxError::new(
            crate::KrxErrorCode::InternalFailure,
            "range outcomes do not match the selected trading dates",
        ));
    }

    let mut rows = Vec::new();
    let mut succeeded = Vec::new();
    let mut skipped = selection.skipped_days;
    let mut failed = Vec::new();
    let mut provenance = BTreeMap::new();
    let mut fetched_days = 0;
    let mut call_wide_errors = Vec::new();

    for outcome in outcomes {
        match outcome.result {
            Ok(result) => {
                fetched_days += 1;
                provenance.insert(outcome.date.clone(), result.provenance);
                if result.rows.is_empty() {
                    skipped.push(outcome.date);
                } else {
                    succeeded.push(outcome.date);
                    rows.extend(result.rows);
                }
            }
            Err(error) if is_call_wide(&error) => call_wide_errors.push(error),
            Err(error) => failed.push(CompositeFailure {
                id: outcome.date,
                error,
            }),
        }
    }

    if let Some(error) = completeness::primary_call_wide_error(&call_wide_errors) {
        return Err(error);
    }

    let completeness = completeness::reduce(CompletenessInput {
        requested: selection.requested_dates,
        succeeded,
        failed,
        skipped,
        has_data: !rows.is_empty(),
    });
    let primary = completeness::primary_error(&completeness.failed);
    let failed_days = completeness.failed.len();
    let failed_state = completeness.state == CompletenessState::Failed;
    let result = CompositeResult {
        success: !failed_state,
        data: if failed_state { Vec::new() } else { rows },
        completeness,
        provenance,
        error: failed_state.then_some(primary).flatten(),
    };
    let range = RangeResult {
        result,
        fetched_days: if failed_state { 0 } else { fetched_days },
        failed_days,
        calendar: selection.calendar,
        adjustment: None,
    };
    Ok(match mode {
        RangeMode::Raw => range,
        RangeMode::Adjusted { security_code } => apply_adjustment(range, security_code),
    })
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;
    use crate::{
        CalendarCoverage, Freshness, KrxErrorCode, ResultProvenance, ResultSource, Row,
        SecurityCode,
    };

    fn date(value: &str) -> TradingDate {
        TradingDate::parse(value).expect("date")
    }

    fn provenance() -> ResultProvenance {
        ResultProvenance {
            source: ResultSource::Network,
            fetched_at: SystemTime::UNIX_EPOCH,
            freshness: Freshness::Fresh,
            contract_id: "fixture".to_owned(),
        }
    }

    fn row(date: &str) -> Row {
        Row::new(BTreeMap::from([
            ("BAS_DD".to_owned(), date.to_owned()),
            ("ISU_CD".to_owned(), "005930".to_owned()),
            ("ISU_NM".to_owned(), "Samsung".to_owned()),
            ("MKT_NM".to_owned(), "KOSPI".to_owned()),
            ("TDD_OPNPRC".to_owned(), "100".to_owned()),
            ("TDD_HGPRC".to_owned(), "110".to_owned()),
            ("TDD_LWPRC".to_owned(), "90".to_owned()),
            ("TDD_CLSPRC".to_owned(), "100".to_owned()),
            ("CMPPREVDD_PRC".to_owned(), "0".to_owned()),
            ("ACC_TRDVOL".to_owned(), "1".to_owned()),
        ]))
    }

    fn selection(dates: &[&str]) -> TradingDaySelection {
        TradingDaySelection {
            requested_dates: dates.iter().map(|value| date(value)).collect(),
            trading_days: dates.iter().map(|value| date(value)).collect(),
            skipped_days: Vec::new(),
            calendar: crate::CalendarSelection {
                version: "1".to_owned(),
                source: "fixture".to_owned(),
                retrieved_at: crate::CalendarDate::parse("2026-08-22").expect("calendar date"),
                coverage: CalendarCoverage::Official,
                unverified_dates: Vec::new(),
            },
        }
    }

    #[test]
    fn preserves_order_and_accounts_for_empty_and_failed_days() {
        let outcomes = vec![
            RangeOutcome {
                date: date("20260102"),
                result: Ok(QueryResult {
                    rows: vec![row("20260102")],
                    provenance: provenance(),
                }),
            },
            RangeOutcome {
                date: date("20260103"),
                result: Ok(QueryResult {
                    rows: Vec::new(),
                    provenance: provenance(),
                }),
            },
            RangeOutcome {
                date: date("20260104"),
                result: Err(KrxError::new(KrxErrorCode::RequestFailed, "network")),
            },
        ];
        let range = reduce(
            selection(&["20260102", "20260103", "20260104"]),
            outcomes,
            &RangeMode::Raw,
        )
        .expect("range");
        assert!(range.result.success);
        assert_eq!(range.result.completeness.state, CompletenessState::Partial);
        assert_eq!(range.fetched_days, 2);
        assert_eq!(range.failed_days, 1);
        assert_eq!(range.result.completeness.skipped, [date("20260103")]);
    }

    #[test]
    fn rejects_call_wide_cancellation_instead_of_returning_a_composite() {
        let error = reduce(
            selection(&["20260102"]),
            vec![RangeOutcome {
                date: date("20260102"),
                result: Err(KrxError::new(KrxErrorCode::RequestCancelled, "cancelled")),
            }],
            &RangeMode::Raw,
        )
        .expect_err("call-wide cancellation");
        assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
    }

    #[test]
    fn range_call_wide_errors_use_contract_priority_not_date_order() {
        let error = reduce(
            selection(&["20260102", "20260103"]),
            vec![
                RangeOutcome {
                    date: date("20260102"),
                    result: Err(KrxError::new(KrxErrorCode::CacheReadFailed, "local")),
                },
                RangeOutcome {
                    date: date("20260103"),
                    result: Err(KrxError::new(KrxErrorCode::RequestCancelled, "cancelled")),
                },
            ],
            &RangeMode::Raw,
        )
        .expect_err("call-wide failure");
        assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
    }

    #[test]
    fn failed_session_beside_known_closure_is_partial_by_frozen_contract() {
        let mut selection = selection(&["20260923"]);
        selection.requested_dates.push(date("20260924"));
        selection.skipped_days.push(date("20260924"));
        let range = reduce(
            selection,
            vec![RangeOutcome {
                date: date("20260923"),
                result: Err(KrxError::new(KrxErrorCode::RequestFailed, "network")),
            }],
            &RangeMode::Raw,
        )
        .expect("range");
        assert_eq!(range.result.completeness.state, CompletenessState::Partial);
        assert!(range.result.success);
        assert_eq!(range.result.completeness.skipped, [date("20260924")]);
    }

    #[test]
    fn adjustment_is_fail_closed_for_empty_probes_and_missing_security_dates() {
        let code = SecurityCode::parse("005930").expect("code");
        let range = reduce(
            selection(&["20260102", "20260103"]),
            vec![
                RangeOutcome {
                    date: date("20260102"),
                    result: Ok(QueryResult {
                        rows: vec![row("20260102")],
                        provenance: provenance(),
                    }),
                },
                RangeOutcome {
                    date: date("20260103"),
                    result: Ok(QueryResult {
                        rows: Vec::new(),
                        provenance: provenance(),
                    }),
                },
            ],
            &RangeMode::Adjusted {
                security_code: code,
            },
        )
        .expect("range result");
        assert!(!range.result.success);
        assert!(range.result.data.is_empty());
        assert!(range.result.completeness.failed.is_empty());
        assert_eq!(range.result.completeness.succeeded, [date("20260102")]);
        assert_eq!(range.result.completeness.skipped, [date("20260103")]);
        assert_eq!(
            range.result.error.as_ref().map(KrxError::code),
            Some(KrxErrorCode::AdjustmentIncomplete)
        );
    }

    #[test]
    fn adjusted_all_provider_failure_retains_the_upstream_primary_error() {
        let code = SecurityCode::parse("005930").expect("code");
        let range = reduce(
            selection(&["20260102"]),
            vec![RangeOutcome {
                date: date("20260102"),
                result: Err(KrxError::new(KrxErrorCode::DeadlineExceeded, "deadline")),
            }],
            &RangeMode::Adjusted {
                security_code: code,
            },
        )
        .expect("range result");
        assert_eq!(range.result.completeness.state, CompletenessState::Failed);
        assert_eq!(range.result.completeness.failed.len(), 1);
        assert_eq!(
            range.result.error.as_ref().map(KrxError::code),
            Some(KrxErrorCode::DeadlineExceeded)
        );
    }
}
