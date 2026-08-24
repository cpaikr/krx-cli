use std::collections::BTreeMap;

use crate::completeness::{self, CompletenessInput};
use crate::{
    CompletenessState, CompositeFailure, CompositeResult, KrxError, KrxErrorKind, MarketComponent,
    MarketSummary, QueryResult, Row, SearchMarket, StockSearchMatch, StockSearchResult, StockStats,
    TradingDate, WatchlistMarket, WatchlistPrices, WatchlistPricesResult,
};

pub(crate) struct ComponentOutcome<Id> {
    pub id: Id,
    pub result: Result<QueryResult, KrxError>,
}

struct Partition<Id> {
    successes: Vec<(Id, QueryResult)>,
    failures: Vec<CompositeFailure<Id>>,
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

fn partition<Id>(
    requested: &[Id],
    outcomes: Vec<ComponentOutcome<Id>>,
) -> Result<Partition<Id>, KrxError>
where
    Id: Clone + Eq,
{
    if outcomes.len() != requested.len()
        || outcomes
            .iter()
            .zip(requested)
            .any(|(outcome, expected)| outcome.id != *expected)
    {
        return Err(KrxError::new(
            crate::KrxErrorCode::InternalFailure,
            "composite outcomes do not match the frozen component order",
        ));
    }
    let mut successes = Vec::new();
    let mut failures = Vec::new();
    let mut call_wide_errors = Vec::new();
    for outcome in outcomes {
        match outcome.result {
            Ok(result) => successes.push((outcome.id, result)),
            Err(error) if is_call_wide(&error) => call_wide_errors.push(error),
            Err(error) => failures.push(CompositeFailure {
                id: outcome.id,
                error,
            }),
        }
    }
    if let Some(error) = completeness::primary_call_wide_error(&call_wide_errors) {
        return Err(error);
    }
    Ok(Partition {
        successes,
        failures,
    })
}

fn finish<Data, Id>(
    data: Data,
    requested: &[Id],
    partition: &Partition<Id>,
    has_data: bool,
) -> CompositeResult<Data, Id>
where
    Id: Clone + Ord,
{
    let succeeded = partition
        .successes
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    let provenance = partition
        .successes
        .iter()
        .map(|(id, result)| (id.clone(), result.provenance.clone()))
        .collect::<BTreeMap<_, _>>();
    let completeness = completeness::reduce(CompletenessInput {
        requested: requested.to_vec(),
        succeeded,
        failed: partition.failures.clone(),
        skipped: Vec::new(),
        has_data,
    });
    let failed = completeness.state == CompletenessState::Failed;
    let error = failed
        .then(|| completeness::primary_error(&completeness.failed))
        .flatten();
    CompositeResult {
        success: !failed,
        data,
        completeness,
        provenance,
        error,
    }
}

pub(crate) fn reduce_stock_search(
    query: &str,
    outcomes: Vec<ComponentOutcome<SearchMarket>>,
) -> Result<StockSearchResult, KrxError> {
    const REQUESTED: [SearchMarket; 2] = [SearchMarket::Kospi, SearchMarket::Kosdaq];
    let partition = partition(&REQUESTED, outcomes)?;
    let query = query.to_lowercase();
    let mut data = Vec::new();
    for (market, result) in &partition.successes {
        for row in &result.rows {
            let name = row.get("ISU_NM").unwrap_or_default();
            let abbreviated = row.get("ISU_ABBRV").unwrap_or_default();
            if !name.to_lowercase().contains(&query) && !abbreviated.to_lowercase().contains(&query)
            {
                continue;
            }
            data.push(StockSearchMatch {
                isu_cd: row.get("ISU_CD").unwrap_or_default().to_owned(),
                isu_srt_cd: row.get("ISU_SRT_CD").unwrap_or_default().to_owned(),
                isu_nm: if name.is_empty() { abbreviated } else { name }.to_owned(),
                market: *market,
            });
        }
    }
    let has_data = !data.is_empty();
    Ok(finish(data, &REQUESTED, &partition, has_data))
}

fn parse_krx_f64(value: Option<&str>) -> f64 {
    value
        .map(|value| value.replace(',', ""))
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn parse_krx_u64(value: Option<&str>) -> u64 {
    value
        .map(|value| value.replace(',', ""))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn stock_stats(rows: &[Row]) -> StockStats {
    rows.iter().fold(
        StockStats {
            advancing: 0,
            declining: 0,
            unchanged: 0,
            total_volume: 0,
            total_value: 0,
        },
        |mut stats, row| {
            let rate = parse_krx_f64(row.get("FLUC_RT"));
            if rate > 0.0 {
                stats.advancing += 1;
            } else if rate < 0.0 {
                stats.declining += 1;
            } else {
                stats.unchanged += 1;
            }
            stats.total_volume = stats
                .total_volume
                .saturating_add(parse_krx_u64(row.get("ACC_TRDVOL")));
            stats.total_value = stats
                .total_value
                .saturating_add(parse_krx_u64(row.get("ACC_TRDVAL")));
            stats
        },
    )
}

fn stock_movers(rows: &[Row]) -> (Vec<Row>, Vec<Row>) {
    let mut sorted = rows.to_vec();
    sorted.sort_by(|left, right| {
        parse_krx_f64(right.get("FLUC_RT")).total_cmp(&parse_krx_f64(left.get("FLUC_RT")))
    });
    let top = crate::operation::MARKET_SUMMARY_TOP_COUNT;
    let gainers = sorted.iter().take(top).cloned().collect();
    let losers = sorted.iter().rev().take(top).cloned().collect();
    (gainers, losers)
}

pub(crate) fn reduce_market_summary(
    date: TradingDate,
    outcomes: Vec<ComponentOutcome<MarketComponent>>,
) -> Result<crate::MarketSummaryResult, KrxError> {
    const REQUESTED: [MarketComponent; 4] = [
        MarketComponent::KospiIndex,
        MarketComponent::KosdaqIndex,
        MarketComponent::KospiStocks,
        MarketComponent::KosdaqStocks,
    ];
    let partition = partition(&REQUESTED, outcomes)?;
    let rows = |component| {
        partition
            .successes
            .iter()
            .find(|(id, _)| *id == component)
            .map(|(_, result)| result.rows.clone())
    };
    let kospi_index = rows(MarketComponent::KospiIndex);
    let kosdaq_index = rows(MarketComponent::KosdaqIndex);
    let kospi_stocks = rows(MarketComponent::KospiStocks);
    let kosdaq_stocks = rows(MarketComponent::KosdaqStocks);
    let combined = kospi_stocks.zip(kosdaq_stocks).map(|(mut kospi, kosdaq)| {
        kospi.extend(kosdaq);
        kospi
    });
    let (stats, gainers, losers) = match combined {
        Some(rows) => {
            let stats = stock_stats(&rows);
            let (gainers, losers) = stock_movers(&rows);
            (Some(stats), Some(gainers), Some(losers))
        }
        None => (None, None, None),
    };
    let has_data = kospi_index.as_ref().is_some_and(|rows| !rows.is_empty())
        || kosdaq_index.as_ref().is_some_and(|rows| !rows.is_empty())
        || gainers.as_ref().is_some_and(|rows| !rows.is_empty());
    let data = MarketSummary {
        date,
        kospi_index,
        kosdaq_index,
        stock_stats: stats,
        top_gainers: gainers,
        top_losers: losers,
    };
    Ok(finish(data, &REQUESTED, &partition, has_data))
}

pub(crate) fn reduce_watchlist_prices(
    date: TradingDate,
    security_codes: &[crate::SecurityCode],
    outcomes: Vec<ComponentOutcome<WatchlistMarket>>,
) -> Result<WatchlistPricesResult, KrxError> {
    const REQUESTED: [WatchlistMarket; 3] = [
        WatchlistMarket::Kospi,
        WatchlistMarket::Kosdaq,
        WatchlistMarket::Konex,
    ];
    let partition = partition(&REQUESTED, outcomes)?;
    let mut stocks = Vec::new();
    for (_, result) in &partition.successes {
        stocks.extend(
            result
                .rows
                .iter()
                .filter(|row| {
                    [row.get("ISU_CD"), row.get("ISU_SRT_CD")]
                        .into_iter()
                        .flatten()
                        .any(|observed| {
                            observed.len() == 6
                                && security_codes
                                    .iter()
                                    .any(|requested| requested.as_str() == observed)
                        })
                })
                .cloned(),
        );
    }
    let data = WatchlistPrices { date, stocks };
    let has_data = !data.stocks.is_empty();
    Ok(finish(data, &REQUESTED, &partition, has_data))
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;
    use crate::{Freshness, KrxErrorCode, ResultProvenance, ResultSource, SecurityCode};

    fn row(fields: &[(&str, &str)]) -> Row {
        Row::new(
            fields
                .iter()
                .map(|(field, value)| ((*field).to_owned(), (*value).to_owned()))
                .collect(),
        )
    }

    fn result(rows: Vec<Row>) -> Result<QueryResult, KrxError> {
        Ok(QueryResult {
            rows,
            provenance: ResultProvenance {
                source: ResultSource::Network,
                fetched_at: SystemTime::UNIX_EPOCH,
                freshness: Freshness::Fresh,
                contract_id: "fixture",
            },
        })
    }

    #[test]
    fn search_preserves_market_and_row_order_with_explicit_partiality() {
        let output = reduce_stock_search(
            "sam",
            vec![
                ComponentOutcome {
                    id: SearchMarket::Kospi,
                    result: result(vec![row(&[
                        ("ISU_CD", "KR7005930003"),
                        ("ISU_SRT_CD", "005930"),
                        ("ISU_NM", "Samsung"),
                        ("ISU_ABBRV", "Samsung"),
                    ])]),
                },
                ComponentOutcome {
                    id: SearchMarket::Kosdaq,
                    result: Err(KrxError::new(KrxErrorCode::RequestFailed, "network")),
                },
            ],
        )
        .expect("search");
        assert_eq!(output.data.len(), 1);
        assert_eq!(output.data[0].market, SearchMarket::Kospi);
        assert_eq!(output.completeness.state, CompletenessState::Partial);
    }

    #[test]
    fn summary_hides_stock_derivations_until_both_markets_succeed() {
        let output = reduce_market_summary(
            TradingDate::parse("20260102").expect("date"),
            vec![
                ComponentOutcome {
                    id: MarketComponent::KospiIndex,
                    result: result(Vec::new()),
                },
                ComponentOutcome {
                    id: MarketComponent::KosdaqIndex,
                    result: result(Vec::new()),
                },
                ComponentOutcome {
                    id: MarketComponent::KospiStocks,
                    result: result(vec![row(&[("FLUC_RT", "1.00")])]),
                },
                ComponentOutcome {
                    id: MarketComponent::KosdaqStocks,
                    result: Err(KrxError::new(KrxErrorCode::RequestFailed, "network")),
                },
            ],
        )
        .expect("summary");
        assert!(output.data.stock_stats.is_none());
        assert!(output.data.top_gainers.is_none());
        assert_eq!(output.completeness.state, CompletenessState::Partial);
    }

    #[test]
    fn watchlist_requests_and_returns_konex_without_silent_omission() {
        let date = TradingDate::parse("20260102").expect("date");
        let output = reduce_watchlist_prices(
            date,
            &[SecurityCode::parse("244690").expect("code")],
            vec![
                ComponentOutcome {
                    id: WatchlistMarket::Kospi,
                    result: result(Vec::new()),
                },
                ComponentOutcome {
                    id: WatchlistMarket::Kosdaq,
                    result: result(Vec::new()),
                },
                ComponentOutcome {
                    id: WatchlistMarket::Konex,
                    result: result(vec![row(&[("ISU_SRT_CD", "244690")])]),
                },
            ],
        )
        .expect("watchlist prices");
        assert_eq!(
            output.completeness.requested,
            [
                WatchlistMarket::Kospi,
                WatchlistMarket::Kosdaq,
                WatchlistMarket::Konex
            ]
        );
        assert_eq!(output.data.stocks.len(), 1);
        assert_eq!(output.completeness.state, CompletenessState::Complete);
    }

    #[test]
    fn cancellation_is_a_rejected_call_not_a_failed_composite() {
        let error = reduce_stock_search(
            "x",
            vec![
                ComponentOutcome {
                    id: SearchMarket::Kospi,
                    result: Err(KrxError::new(KrxErrorCode::RequestCancelled, "cancelled")),
                },
                ComponentOutcome {
                    id: SearchMarket::Kosdaq,
                    result: result(Vec::new()),
                },
            ],
        )
        .expect_err("cancellation");
        assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
    }

    #[test]
    fn call_wide_errors_use_contract_priority_not_component_order() {
        let error = reduce_stock_search(
            "x",
            vec![
                ComponentOutcome {
                    id: SearchMarket::Kospi,
                    result: Err(KrxError::new(KrxErrorCode::CacheReadFailed, "local")),
                },
                ComponentOutcome {
                    id: SearchMarket::Kosdaq,
                    result: Err(KrxError::new(KrxErrorCode::RequestCancelled, "cancelled")),
                },
            ],
        )
        .expect_err("call-wide failure");
        assert_eq!(error.code(), KrxErrorCode::RequestCancelled);
    }
}
