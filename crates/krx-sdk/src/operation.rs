include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/generated/operation-id.rs"
));

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ApprovalCategory {
    Index,
    Stock,
    Etp,
    Bond,
    Derivative,
    Commodity,
    Esg,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationFieldDescription {
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationDescription {
    pub operation_id: OperationId,
    pub category: ApprovalCategory,
    pub description: &'static str,
    pub description_ko: &'static str,
    pub contract_id: &'static str,
    pub request_fields: &'static [OperationFieldDescription],
    pub response_fields: &'static [OperationFieldDescription],
}

pub(crate) struct OperationSpec {
    pub operation_id: OperationId,
    pub method: &'static str,
    pub path: &'static str,
    pub request_field: &'static str,
    pub success_envelope: &'static str,
    pub contract_id: &'static str,
    pub response_fields: &'static [OperationFieldDescription],
}

include!(concat!(env!("OUT_DIR"), "/operation_contract.rs"));

pub(crate) fn capabilities() -> &'static [OperationDescription] {
    GENERATED_CAPABILITIES
}

pub(crate) fn supports_adjustment(operation: OperationId) -> bool {
    ADJUSTED_DAILY_STOCK.contains(&operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_catalog_covers_every_closed_operation_once() {
        assert!(!OFFICIAL_SERVER.is_empty());
        let descriptions = capabilities();
        assert_eq!(descriptions.len(), OperationId::ALL.len());
        for (expected, actual) in OperationId::ALL.iter().zip(descriptions) {
            assert_eq!(actual.operation_id, *expected);
            let spec = operation_spec(*expected);
            assert_eq!(spec.operation_id, *expected);
            assert_eq!(spec.contract_id, actual.contract_id);
            assert_eq!(actual.request_fields.len(), 1);
            assert!(!actual.response_fields.is_empty());
            assert_eq!(actual.contract_id.len(), 64);
        }
        assert_eq!(ADJUSTED_DAILY_STOCK.len(), 3);
        assert_eq!(
            STOCK_SEARCH_COMPONENTS,
            [
                ("KOSPI", OperationId::StockStkIsuBaseInfo),
                ("KOSDAQ", OperationId::StockKsqIsuBaseInfo),
            ]
        );
        assert_eq!(
            WATCHLIST_PRICE_COMPONENTS,
            [
                ("KOSPI", OperationId::StockStkByddTrd),
                ("KOSDAQ", OperationId::StockKsqByddTrd),
                ("KONEX", OperationId::StockKnxByddTrd),
            ]
        );
        assert_eq!(
            MARKET_SUMMARY_COMPONENTS,
            [
                ("kospiIndex", OperationId::IndexKospiDdTrd),
                ("kosdaqIndex", OperationId::IndexKosdaqDdTrd),
                ("kospiStocks", OperationId::StockStkByddTrd),
                ("kosdaqStocks", OperationId::StockKsqByddTrd),
            ]
        );
        assert_eq!(MARKET_SUMMARY_TOP_COUNT, 5);
        assert!(supports_adjustment(OperationId::StockKnxByddTrd));
        assert!(!supports_adjustment(OperationId::IndexKospiDdTrd));
    }
}
