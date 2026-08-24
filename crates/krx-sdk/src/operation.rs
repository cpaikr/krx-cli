include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/generated/operation-id.rs"
));

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ApprovalCategory {
    Index,
    Stock,
    Etp,
    Bond,
    Derivative,
    Commodity,
    Esg,
}

impl ApprovalCategory {
    /// Frozen service-category order used by approval probes and adapters.
    pub const ALL: [Self; 7] = [
        Self::Index,
        Self::Stock,
        Self::Etp,
        Self::Bond,
        Self::Derivative,
        Self::Commodity,
        Self::Esg,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Index => "index",
            Self::Stock => "stock",
            Self::Etp => "etp",
            Self::Bond => "bond",
            Self::Derivative => "derivative",
            Self::Commodity => "commodity",
            Self::Esg => "esg",
        }
    }

    /// Stable Korean display name used by the legacy-compatible CLI table.
    pub const fn display_name_ko(self) -> &'static str {
        match self {
            Self::Index => "지수",
            Self::Stock => "주식",
            Self::Etp => "증권상품",
            Self::Bond => "채권",
            Self::Derivative => "파생상품",
            Self::Commodity => "일반상품",
            Self::Esg => "ESG",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|category| category.as_str() == value)
    }
}

pub(crate) fn parse_operation_id(value: &str) -> Option<OperationId> {
    OperationId::ALL
        .into_iter()
        .find(|operation| operation.as_str() == value)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationFieldDescription {
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DerivedOutputFieldDescription {
    pub name: &'static str,
    pub field_type: &'static str,
    pub description: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DerivedOutputDescription {
    pub provenance: &'static str,
    pub eligible_endpoints: &'static [&'static str],
    pub default_for_eligible_single_security_ranges: bool,
    pub cli_opt_out: &'static str,
    pub fields: &'static [DerivedOutputFieldDescription],
    pub envelope_field: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationDescription {
    pub operation_id: OperationId,
    pub category: ApprovalCategory,
    /// Canonical HTTP method generated from the frozen OpenAPI contract.
    pub method: &'static str,
    /// Canonical endpoint path generated from the frozen OpenAPI contract.
    pub path: &'static str,
    /// Canonical authentication header generated from the frozen OpenAPI contract.
    pub auth_header: &'static str,
    /// Canonical request date field generated from the frozen OpenAPI contract.
    pub request_field: &'static str,
    pub description: &'static str,
    pub description_ko: &'static str,
    pub contract_id: &'static str,
    pub request_fields: &'static [OperationFieldDescription],
    pub response_fields: &'static [OperationFieldDescription],
    /// SDK-owned metadata for output derived from multiple raw responses.
    pub derived_output: Option<&'static DerivedOutputDescription>,
}

static ADJUSTED_DAILY_STOCK_FIELDS: &[DerivedOutputFieldDescription] = &[
    DerivedOutputFieldDescription {
        name: crate::adjustment::ADJUSTED_OUTPUT_FIELDS[0],
        field_type: "string",
        description: "Adjusted opening price",
    },
    DerivedOutputFieldDescription {
        name: crate::adjustment::ADJUSTED_OUTPUT_FIELDS[1],
        field_type: "string",
        description: "Adjusted high price",
    },
    DerivedOutputFieldDescription {
        name: crate::adjustment::ADJUSTED_OUTPUT_FIELDS[2],
        field_type: "string",
        description: "Adjusted low price",
    },
    DerivedOutputFieldDescription {
        name: crate::adjustment::ADJUSTED_OUTPUT_FIELDS[3],
        field_type: "string",
        description: "Adjusted closing price",
    },
    DerivedOutputFieldDescription {
        name: crate::adjustment::ADJUSTED_OUTPUT_FIELDS[4],
        field_type: "string",
        description: "Exact reduced backward factor as numerator/denominator",
    },
];

static ADJUSTED_DAILY_STOCK_OUTPUT: DerivedOutputDescription = DerivedOutputDescription {
    provenance: "krx-cli-derived",
    eligible_endpoints: ADJUSTED_DAILY_STOCK_PATHS,
    default_for_eligible_single_security_ranges: true,
    cli_opt_out: "--no-adjusted",
    fields: ADJUSTED_DAILY_STOCK_FIELDS,
    envelope_field: "adjustment",
};

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
        assert_eq!(DEFAULT_RETRIES, 3);
        assert_eq!(ATTEMPT_TIMEOUT_MS, 15_000);
        assert_eq!(OVERALL_TIMEOUT_MS, 45_000);
        assert_eq!(DEFAULT_CACHE_MAX_AGE_HOURS, 168);
        assert_eq!(QUOTA_PER_KST_DAY, 10_000);
        let descriptions = capabilities();
        assert_eq!(descriptions.len(), OperationId::ALL.len());
        for (expected, actual) in OperationId::ALL.iter().zip(descriptions) {
            assert_eq!(actual.operation_id, *expected);
            let spec = operation_spec(*expected);
            assert_eq!(spec.operation_id, *expected);
            assert_eq!(spec.contract_id, actual.contract_id);
            assert_eq!(actual.method, spec.method);
            assert_eq!(actual.path, spec.path);
            assert_eq!(actual.auth_header, super::AUTH_HEADER);
            assert_eq!(actual.request_field, spec.request_field);
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

        let adjusted = descriptions
            .iter()
            .filter_map(|description| description.derived_output)
            .collect::<Vec<_>>();
        assert_eq!(adjusted.len(), 3);
        for derived in adjusted {
            assert_eq!(derived.provenance, "krx-cli-derived");
            assert_eq!(derived.eligible_endpoints.len(), 3);
            assert!(derived.default_for_eligible_single_security_ranges);
            assert_eq!(derived.cli_opt_out, "--no-adjusted");
            assert_eq!(derived.fields.len(), 5);
            assert_eq!(derived.envelope_field, "adjustment");
        }
    }
}
