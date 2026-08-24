use num_bigint::{BigInt, BigUint, Sign};

use crate::{
    AdjustmentFactorField, AdjustmentMetadata, CashDividendTreatment, KrxError, KrxErrorCode, Row,
    SecurityCode, TradingDate,
};

const RAW_PRICE_FIELDS: [&str; 4] = ["TDD_OPNPRC", "TDD_HGPRC", "TDD_LWPRC", "TDD_CLSPRC"];
pub(crate) const ADJUSTED_OUTPUT_FIELDS: [&str; 5] = [
    "ADJ_TDD_OPNPRC",
    "ADJ_TDD_HGPRC",
    "ADJ_TDD_LWPRC",
    "ADJ_TDD_CLSPRC",
    "ADJ_FACTOR",
];
const ADJUSTED_PRICE_FIELDS: [&str; 4] = [
    ADJUSTED_OUTPUT_FIELDS[0],
    ADJUSTED_OUTPUT_FIELDS[1],
    ADJUSTED_OUTPUT_FIELDS[2],
    ADJUSTED_OUTPUT_FIELDS[3],
];

#[derive(Clone, Debug)]
struct Rational {
    numerator: BigUint,
    denominator: BigUint,
}

#[derive(Debug)]
struct ParsedRow {
    row: Row,
    date: TradingDate,
    code: String,
    name: String,
    market: String,
    close: BigUint,
    reference: BigUint,
    open: BigUint,
    high: BigUint,
    low: BigUint,
    volume: Option<BigUint>,
    shares: Option<BigUint>,
}

fn inconsistent(message: impl Into<String>) -> KrxError {
    KrxError::new(KrxErrorCode::AdjustmentInconsistent, message)
}

fn gcd(left: &BigUint, right: &BigUint) -> BigUint {
    let mut a = left.clone();
    let mut b = right.clone();
    while b != BigUint::from(0_u8) {
        let remainder = &a % &b;
        a = b;
        b = remainder;
    }
    a
}

fn rational(numerator: BigUint, denominator: BigUint) -> Result<Rational, KrxError> {
    if numerator == BigUint::from(0_u8) || denominator == BigUint::from(0_u8) {
        return Err(inconsistent("adjustment ratios must be positive"));
    }
    let divisor = gcd(&numerator, &denominator);
    Ok(Rational {
        numerator: numerator / &divisor,
        denominator: denominator / divisor,
    })
}

fn one() -> Rational {
    Rational {
        numerator: BigUint::from(1_u8),
        denominator: BigUint::from(1_u8),
    }
}

fn multiply(left: &Rational, right: &Rational) -> Result<Rational, KrxError> {
    let a = gcd(&left.numerator, &right.denominator);
    let b = gcd(&right.numerator, &left.denominator);
    rational(
        (&left.numerator / &a) * (&right.numerator / &b),
        (&left.denominator / &b) * (&right.denominator / &a),
    )
}

fn canonical_digits(value: &str) -> bool {
    if value == "0" {
        return true;
    }
    if value.is_empty() || value.starts_with('0') {
        return false;
    }
    if !value.contains(',') {
        return value.bytes().all(|byte| byte.is_ascii_digit());
    }
    let mut groups = value.split(',');
    let Some(first) = groups.next() else {
        return false;
    };
    (1..=3).contains(&first.len())
        && !first.starts_with('0')
        && first.bytes().all(|byte| byte.is_ascii_digit())
        && groups.all(|group| group.len() == 3 && group.bytes().all(|byte| byte.is_ascii_digit()))
}

fn exact_integer(
    value: Option<&str>,
    field: &str,
    allow_negative: bool,
) -> Result<BigInt, KrxError> {
    let value = value.ok_or_else(|| inconsistent(format!("{field} must be a string integer")))?;
    let (negative, magnitude) = match value.strip_prefix('-') {
        Some(magnitude) if allow_negative => (true, magnitude),
        Some(_) => return Err(inconsistent(format!("{field} cannot be negative"))),
        None => (false, value),
    };
    if !canonical_digits(magnitude) {
        return Err(inconsistent(format!(
            "{field} is not a canonical KRX integer: {value}"
        )));
    }
    let digits = magnitude.replace(',', "");
    let parsed = BigInt::parse_bytes(digits.as_bytes(), 10)
        .ok_or_else(|| inconsistent(format!("{field} is outside the integer domain")))?;
    Ok(if negative { -parsed } else { parsed })
}

fn exact_nonnegative(value: Option<&str>, field: &str) -> Result<BigUint, KrxError> {
    exact_integer(value, field, false)?
        .to_biguint()
        .ok_or_else(|| inconsistent(format!("{field} cannot be negative")))
}

fn parse_rate_hundredths(value: &str, field: &str) -> Result<BigInt, KrxError> {
    let (sign, unsigned) = match value.as_bytes().first() {
        Some(b'+') => (Sign::Plus, &value[1..]),
        Some(b'-') => (Sign::Minus, &value[1..]),
        _ => (Sign::Plus, value),
    };
    let Some((whole, fraction)) = unsigned.split_once('.') else {
        return Err(inconsistent(format!(
            "{field} must have exactly two decimal places"
        )));
    };
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() != 2
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(inconsistent(format!(
            "{field} must have exactly two decimal places"
        )));
    }
    let magnitude = BigUint::parse_bytes(format!("{whole}{fraction}").as_bytes(), 10)
        .ok_or_else(|| inconsistent(format!("{field} is outside the integer domain")))?;
    Ok(BigInt::from_biguint(sign, magnitude))
}

fn rounded_signed_ratio(numerator: BigInt, denominator: &BigUint) -> BigInt {
    let magnitude = (numerator.magnitude() + (denominator / 2_u8)) / denominator;
    BigInt::from_biguint(numerator.sign(), magnitude)
}

fn rounded_product(value: &BigUint, factor: &Rational) -> BigUint {
    if value == &BigUint::from(0_u8) {
        return BigUint::from(0_u8);
    }
    ((value * &factor.numerator) + (&factor.denominator / 2_u8)) / &factor.denominator
}

fn validate_ohlc(
    open: &BigUint,
    high: &BigUint,
    low: &BigUint,
    close: &BigUint,
    volume: Option<&BigUint>,
    label: &str,
) -> Result<(), KrxError> {
    let zero = BigUint::from(0_u8);
    if close == &zero {
        return Err(inconsistent(format!("{label} close must be positive")));
    }
    if open == &zero || high == &zero || low == &zero {
        if open != &zero || high != &zero || low != &zero || volume != Some(&zero) {
            return Err(inconsistent(format!(
                "{label} zero OHLC is valid only for a zero-volume suspension row"
            )));
        }
        return Ok(());
    }
    if low > open || low > close || high < open || high < close || low > high {
        return Err(inconsistent(format!("{label} violates OHLC ordering")));
    }
    Ok(())
}

fn parse_row(row: Row, index: usize, security_code: &SecurityCode) -> Result<ParsedRow, KrxError> {
    let date_text = row
        .get("BAS_DD")
        .ok_or_else(|| inconsistent(format!("row {index} has an invalid BAS_DD")))?;
    let date = TradingDate::parse(date_text)
        .map_err(|_| inconsistent(format!("row {index} has an invalid BAS_DD")))?;
    let code = row
        .get("ISU_CD")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| inconsistent(format!("row {index} has an incomplete security identity")))?
        .to_owned();
    let name = row
        .get("ISU_NM")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| inconsistent(format!("row {index} has an incomplete security identity")))?
        .to_owned();
    let market = row
        .get("MKT_NM")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| inconsistent(format!("row {index} has an incomplete security identity")))?
        .to_owned();
    if code != security_code.as_str() {
        return Err(inconsistent(format!(
            "{} does not match the requested security",
            date.as_str()
        )));
    }

    let close = exact_nonnegative(row.get("TDD_CLSPRC"), &format!("{date_text}.TDD_CLSPRC"))?;
    let change = exact_integer(
        row.get("CMPPREVDD_PRC"),
        &format!("{date_text}.CMPPREVDD_PRC"),
        true,
    )?;
    let reference = (BigInt::from(close.clone()) - &change)
        .to_biguint()
        .filter(|value| value != &BigUint::from(0_u8))
        .ok_or_else(|| {
            inconsistent(format!(
                "{date_text} implied reference price must be positive"
            ))
        })?;
    if let Some(rate) = row.get("FLUC_RT") {
        let actual = parse_rate_hundredths(rate, &format!("{date_text}.FLUC_RT"))?;
        let expected = rounded_signed_ratio(change * 10_000_u16, &reference);
        if actual != expected {
            return Err(inconsistent(format!(
                "{date_text} FLUC_RT is inconsistent with change and reference price"
            )));
        }
    }
    let open = exact_nonnegative(row.get("TDD_OPNPRC"), &format!("{date_text}.TDD_OPNPRC"))?;
    let high = exact_nonnegative(row.get("TDD_HGPRC"), &format!("{date_text}.TDD_HGPRC"))?;
    let low = exact_nonnegative(row.get("TDD_LWPRC"), &format!("{date_text}.TDD_LWPRC"))?;
    let volume = row
        .get("ACC_TRDVOL")
        .map(|value| exact_nonnegative(Some(value), &format!("{date_text}.ACC_TRDVOL")))
        .transpose()?;
    validate_ohlc(&open, &high, &low, &close, volume.as_ref(), date_text)?;
    let shares = row
        .get("LIST_SHRS")
        .map(|value| exact_nonnegative(Some(value), &format!("{date_text}.LIST_SHRS")))
        .transpose()?;
    let market_cap = row
        .get("MKTCAP")
        .map(|value| exact_nonnegative(Some(value), &format!("{date_text}.MKTCAP")))
        .transpose()?;
    if let (Some(shares), Some(market_cap)) = (&shares, &market_cap)
        && &close * shares != *market_cap
    {
        return Err(inconsistent(format!(
            "{date_text} market capitalization does not equal close times listed shares"
        )));
    }

    Ok(ParsedRow {
        row,
        date,
        code,
        name,
        market,
        close,
        reference,
        open,
        high,
        low,
        volume,
        shares,
    })
}

fn transition_string(previous: &ParsedRow, current: &ParsedRow, ratio: &Rational) -> String {
    // Frozen `krx-adjustment-transition/v1`: compact JSON with this exact field
    // order. The public string stays lossless without exposing another type.
    format!(
        "{{\"date\":\"{}\",\"previousClose\":\"{}\",\"previousDate\":\"{}\",\"ratio\":{{\"denominator\":\"{}\",\"numerator\":\"{}\"}},\"referencePrice\":\"{}\"}}",
        current.date.as_str(),
        previous.close,
        previous.date.as_str(),
        ratio.denominator,
        ratio.numerator,
        current.reference,
    )
}

pub(crate) fn adjust_stock_rows(
    rows: Vec<Row>,
    security_code: &SecurityCode,
) -> Result<(Vec<Row>, AdjustmentMetadata), KrxError> {
    if rows.is_empty() {
        return Err(KrxError::new(
            KrxErrorCode::AdjustmentIncomplete,
            "no rows remain for the requested security",
        ));
    }
    let parsed = rows
        .into_iter()
        .enumerate()
        .map(|(index, row)| parse_row(row, index, security_code))
        .collect::<Result<Vec<_>, _>>()?;
    let first = &parsed[0];
    for (index, current) in parsed.iter().enumerate() {
        if current.code != first.code
            || current.name != first.name
            || current.market != first.market
        {
            return Err(inconsistent(
                "rows do not resolve to one stable security identity",
            ));
        }
        if let Some(previous) = index.checked_sub(1).and_then(|index| parsed.get(index))
            && current.date <= previous.date
        {
            return Err(inconsistent(
                "observation dates must be unique and strictly increasing",
            ));
        }
    }

    let mut boundary_ratios = vec![one(); parsed.len()];
    let mut transitions = Vec::new();
    for index in 1..parsed.len() {
        let previous = &parsed[index - 1];
        let current = &parsed[index];
        if current.reference == previous.close {
            continue;
        }
        let ratio = rational(current.reference.clone(), previous.close.clone())?;
        let follows_suspension = previous.open == BigUint::from(0_u8)
            && previous.high == BigUint::from(0_u8)
            && previous.low == BigUint::from(0_u8);
        if follows_suspension {
            let (Some(previous_shares), Some(current_shares)) = (&previous.shares, &current.shares)
            else {
                return Err(inconsistent(format!(
                    "{} suspended transition lacks listed-share evidence",
                    current.date.as_str()
                )));
            };
            let left = &ratio.numerator * current_shares;
            let right = &ratio.denominator * previous_shares;
            let difference = if left >= right {
                left - right
            } else {
                right - left
            };
            if difference >= ratio.numerator {
                return Err(inconsistent(format!(
                    "{} suspended transition is ambiguous against listed shares",
                    current.date.as_str()
                )));
            }
        }
        transitions.push(transition_string(previous, current, &ratio));
        boundary_ratios[index] = ratio;
    }

    let mut factors = vec![one(); parsed.len()];
    let mut accumulated = one();
    for index in (0..parsed.len()).rev() {
        factors[index] = accumulated.clone();
        if index > 0 {
            accumulated = multiply(&accumulated, &boundary_ratios[index])?;
        }
    }

    let mut adjusted = Vec::with_capacity(parsed.len());
    for (entry, factor) in parsed.into_iter().zip(factors) {
        let open = rounded_product(&entry.open, &factor);
        let high = rounded_product(&entry.high, &factor);
        let low = rounded_product(&entry.low, &factor);
        let close = rounded_product(&entry.close, &factor);
        validate_ohlc(
            &open,
            &high,
            &low,
            &close,
            entry.volume.as_ref(),
            &format!("{} adjusted", entry.date.as_str()),
        )?;
        let mut row = entry.row;
        row.insert(ADJUSTED_OUTPUT_FIELDS[0], open.to_string());
        row.insert(ADJUSTED_OUTPUT_FIELDS[1], high.to_string());
        row.insert(ADJUSTED_OUTPUT_FIELDS[2], low.to_string());
        row.insert(ADJUSTED_OUTPUT_FIELDS[3], close.to_string());
        row.insert(
            ADJUSTED_OUTPUT_FIELDS[4],
            format!("{}/{}", factor.numerator, factor.denominator),
        );
        adjusted.push(row);
    }

    let as_of = adjusted
        .last()
        .and_then(|row| row.get("BAS_DD"))
        .ok_or_else(|| inconsistent("adjusted history has no final observation date"))?;
    let metadata = AdjustmentMetadata {
        method: "krx-backward-reference-ratio".to_owned(),
        version: 1,
        as_of: TradingDate::parse(as_of)
            .map_err(|_| inconsistent("adjusted history has an invalid final observation date"))?,
        rounding: "nearest-integer-half-up".to_owned(),
        raw_fields: RAW_PRICE_FIELDS
            .iter()
            .map(|field| (*field).to_owned())
            .collect(),
        adjusted_fields: ADJUSTED_PRICE_FIELDS
            .iter()
            .map(|field| (*field).to_owned())
            .collect(),
        factor_field: AdjustmentFactorField::AdjFactor,
        basis_transitions: transitions,
        cash_dividends: CashDividendTreatment::Excluded,
    };
    Ok((adjusted, metadata))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use jiff::{ToSpan, civil::Date};
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct OracleFile {
        cases: Vec<OracleCase>,
    }

    #[derive(Deserialize)]
    struct OracleCase {
        raw: Vec<BTreeMap<String, String>>,
        #[serde(rename = "adjustedOhlc")]
        adjusted_ohlc: Vec<Vec<String>>,
    }

    fn row(date: &str, overrides: &[(&str, &str)]) -> Row {
        let mut fields = BTreeMap::from([
            ("BAS_DD".to_owned(), date.to_owned()),
            ("ISU_CD".to_owned(), "000001".to_owned()),
            ("ISU_NM".to_owned(), "fixture".to_owned()),
            ("MKT_NM".to_owned(), "KOSPI".to_owned()),
            ("TDD_OPNPRC".to_owned(), "100".to_owned()),
            ("TDD_HGPRC".to_owned(), "110".to_owned()),
            ("TDD_LWPRC".to_owned(), "90".to_owned()),
            ("TDD_CLSPRC".to_owned(), "100".to_owned()),
            ("CMPPREVDD_PRC".to_owned(), "0".to_owned()),
            ("ACC_TRDVOL".to_owned(), "1".to_owned()),
            ("MKTCAP".to_owned(), "1000".to_owned()),
            ("LIST_SHRS".to_owned(), "10".to_owned()),
        ]);
        for (field, value) in overrides {
            fields.insert((*field).to_owned(), (*value).to_owned());
        }
        Row::new(fields)
    }

    #[test]
    fn matches_every_frozen_official_adjustment_oracle() {
        let oracle: OracleFile = serde_json::from_str(include_str!(
            "../../../tests/fixtures/adjusted-stock-prices/oracles.json"
        ))
        .expect("oracle fixture");
        assert_eq!(oracle.cases.len(), 6, "oracle fixture coverage changed");
        let mut checked_transitions = false;
        for case in oracle.cases {
            let code = SecurityCode::parse(case.raw[0].get("ISU_CD").expect("security code"))
                .expect("valid security code");
            let rows = case.raw.into_iter().map(Row::new).collect();
            let (adjusted, metadata) = adjust_stock_rows(rows, &code).expect("adjusted rows");
            let actual = adjusted
                .iter()
                .map(|row| {
                    ADJUSTED_PRICE_FIELDS
                        .iter()
                        .map(|field| row.get(field).expect("adjusted field").to_owned())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            assert_eq!(actual, case.adjusted_ohlc);
            assert_eq!(
                adjusted.last().and_then(|row| row.get("ADJ_FACTOR")),
                Some("1/1")
            );
            assert_eq!(metadata.cash_dividends, CashDividendTreatment::Excluded);
            if metadata.as_of.as_str() == "20180504" {
                checked_transitions = true;
                assert_eq!(
                    metadata.basis_transitions,
                    [
                        "{\"date\":\"20180504\",\"previousClose\":\"2650000\",\"previousDate\":\"20180503\",\"ratio\":{\"denominator\":\"50\",\"numerator\":\"1\"},\"referencePrice\":\"53000\"}"
                    ]
                );
            }
        }
        assert!(checked_transitions, "split transition case is missing");
    }

    #[test]
    fn accumulates_exact_unbounded_factors() {
        let rows = (0..400)
            .map(|index| {
                let date = Date::new(2024, 1, 1)
                    .expect("start date")
                    .checked_add(index.days())
                    .expect("fixture date")
                    .strftime("%Y%m%d")
                    .to_string();
                row(
                    &date,
                    if index == 0 {
                        &[]
                    } else {
                        &[("CMPPREVDD_PRC", "-1")]
                    },
                )
            })
            .collect();
        let (adjusted, _) = adjust_stock_rows(rows, &SecurityCode::parse("000001").expect("code"))
            .expect("unbounded adjustment");
        assert_eq!(
            adjusted[0].get("ADJ_FACTOR"),
            Some(
                format!(
                    "{}/{}",
                    BigUint::from(101_u8).pow(399),
                    BigUint::from(100_u8).pow(399)
                )
                .as_str()
            )
        );
    }

    #[test]
    fn rejects_inconsistent_rate_identity_order_and_suspension_evidence() {
        let code = SecurityCode::parse("000001").expect("code");
        for rows in [
            vec![row(
                "20240101",
                &[
                    ("TDD_CLSPRC", "90"),
                    ("CMPPREVDD_PRC", "-10"),
                    ("FLUC_RT", "-9.99"),
                    ("MKTCAP", "900"),
                ],
            )],
            vec![row("20240102", &[]), row("20240101", &[])],
            vec![
                row("20240101", &[]),
                row("20240102", &[("ISU_NM", "other")]),
            ],
            vec![
                row(
                    "20240101",
                    &[
                        ("TDD_OPNPRC", "0"),
                        ("TDD_HGPRC", "0"),
                        ("TDD_LWPRC", "0"),
                        ("ACC_TRDVOL", "0"),
                    ],
                ),
                row(
                    "20240102",
                    &[
                        ("TDD_LWPRC", "80"),
                        ("TDD_CLSPRC", "90"),
                        ("CMPPREVDD_PRC", "40"),
                        ("MKTCAP", "900"),
                    ],
                ),
            ],
        ] {
            assert_eq!(
                adjust_stock_rows(rows, &code)
                    .expect_err("inconsistent rows")
                    .code(),
                KrxErrorCode::AdjustmentInconsistent
            );
        }
    }

    #[test]
    fn rejects_noncanonical_grouped_integers() {
        let error = adjust_stock_rows(
            vec![row("20240101", &[("TDD_CLSPRC", "001,000")])],
            &SecurityCode::parse("000001").expect("code"),
        )
        .expect_err("noncanonical grouping");
        assert_eq!(error.code(), KrxErrorCode::AdjustmentInconsistent);
    }
}
