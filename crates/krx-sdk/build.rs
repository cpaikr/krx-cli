use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductContract {
    operations: Vec<ProductOperation>,
    operation_sets: ProductOperationSets,
    approval_probes: BTreeMap<String, String>,
    composites: ProductComposites,
    defaults: ProductDefaults,
    errors: ProductErrors,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductDefaults {
    retries: u8,
    attempt_timeout_ms: u64,
    overall_timeout_ms: u64,
    cache_max_age_hours: u64,
    quota_per_kst_day: u32,
    approval_ttl_seconds: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductOperationSets {
    adjusted_daily_stock: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductComposites {
    stock_search: ProductComposite,
    watchlist_prices: ProductComposite,
    market_summary: ProductMarketSummary,
}

#[derive(Deserialize)]
struct ProductComposite {
    #[serde(deserialize_with = "ordered_string_map")]
    components: Vec<(String, String)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductMarketSummary {
    #[serde(deserialize_with = "ordered_string_map")]
    components: Vec<(String, String)>,
    top_count: usize,
}

fn ordered_string_map<'de, D>(deserializer: D) -> Result<Vec<(String, String)>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct OrderedStringMap;

    impl<'de> serde::de::Visitor<'de> for OrderedStringMap {
        type Value = Vec<(String, String)>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an ordered string-to-string map")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0));
            let mut keys = BTreeSet::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if !keys.insert(key.clone()) {
                    return Err(serde::de::Error::custom(format!(
                        "duplicate component key {key}"
                    )));
                }
                entries.push((key, value));
            }
            Ok(entries)
        }
    }

    deserializer.deserialize_map(OrderedStringMap)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductOperation {
    operation_id: String,
    path: String,
    category: String,
    description: String,
    description_ko: String,
    request_fields: Vec<ProductRequestField>,
    response_fields: Vec<ProductResponseField>,
    contract_id: String,
}

#[derive(Deserialize)]
struct ProductRequestField {
    name: String,
    required: bool,
}

#[derive(Deserialize)]
struct ProductResponseField {
    name: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductErrors {
    kinds: BTreeMap<String, ProductErrorKind>,
    http_mappings: Vec<ProductHttpMapping>,
    response_mappings: BTreeMap<String, ProductErrorReference>,
    composite_priority: Vec<String>,
}

#[derive(Deserialize)]
struct ProductErrorKind {
    codes: BTreeMap<String, bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductHttpMapping {
    #[serde(rename = "match")]
    matcher: Value,
    code: String,
    #[serde(default)]
    after_retries: bool,
}

#[derive(Deserialize)]
struct ProductErrorReference {
    code: String,
}

struct WireOperation<'a> {
    product: &'a ProductOperation,
    method: &'a str,
    request_field: &'a str,
    request_description: &'a str,
    envelope: &'a str,
}

fn required<'a>(value: &'a Value, pointer: &str) -> &'a Value {
    value
        .pointer(pointer)
        .unwrap_or_else(|| panic!("canonical artifact is missing {pointer}"))
}

fn required_str<'a>(value: &'a Value, pointer: &str) -> &'a str {
    required(value, pointer)
        .as_str()
        .unwrap_or_else(|| panic!("canonical artifact value at {pointer} is not a string"))
}

fn local_schema<'a>(document: &'a Value, reference: &str) -> &'a Value {
    let name = reference
        .strip_prefix("#/components/schemas/")
        .unwrap_or_else(|| panic!("unsupported non-local schema reference {reference}"));
    required(document, &format!("/components/schemas/{name}"))
}

fn rust_variant(value: &str) -> String {
    value
        .split('_')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect()
}

fn screaming_snake(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            result.push('_');
        }
        result.push(character.to_ascii_uppercase());
    }
    result
}

fn literal(value: &str) -> String {
    format!("{value:?}")
}

fn operation_for<'a>(document: &'a Value, product: &'a ProductOperation) -> WireOperation<'a> {
    let path_item = required(
        document,
        &format!(
            "/paths/{}",
            product.path.replace('~', "~0").replace('/', "~1")
        ),
    );
    let methods = path_item
        .as_object()
        .expect("canonical path item must be an object");
    let (method, operation) = methods
        .iter()
        .find(|(_, candidate)| {
            candidate.get("operationId").and_then(Value::as_str)
                == Some(product.operation_id.as_str())
        })
        .unwrap_or_else(|| panic!("{} is absent at its projected path", product.operation_id));

    let request = local_schema(
        document,
        required_str(
            operation,
            "/requestBody/content/application~1json/schema/$ref",
        ),
    );
    let request_required = required(request, "/required")
        .as_array()
        .expect("request required must be an array");
    let request_properties = required(request, "/properties")
        .as_object()
        .expect("request properties must be an object");
    assert_eq!(request_required.len(), 1, "one request field per operation");
    assert_eq!(
        request_properties.len(),
        1,
        "one request field per operation"
    );
    assert_eq!(
        product.request_fields.len(),
        1,
        "one projected request field"
    );
    assert!(
        product.request_fields[0].required,
        "request field must be required"
    );
    let request_field = request_required[0]
        .as_str()
        .expect("request field must be a string");
    assert_eq!(product.request_fields[0].name, request_field);
    let request_description =
        required_str(request, &format!("/properties/{request_field}/description"));

    let alternatives = required(
        operation,
        "/responses/200/content/application~1json/schema/oneOf",
    )
    .as_array()
    .expect("response oneOf must be an array");
    assert_eq!(
        alternatives.len(),
        2,
        "success and provider error alternatives"
    );
    let success = local_schema(
        document,
        alternatives[0]
            .get("$ref")
            .and_then(Value::as_str)
            .expect("success response reference"),
    );
    let success_required = required(success, "/required")
        .as_array()
        .expect("success required must be an array");
    let success_properties = required(success, "/properties")
        .as_object()
        .expect("success properties must be an object");
    assert_eq!(success_required.len(), 1, "one success envelope");
    assert_eq!(success_properties.len(), 1, "one success envelope");
    let envelope = success_required[0]
        .as_str()
        .expect("success envelope must be a string");
    let row = local_schema(
        document,
        required_str(success, &format!("/properties/{envelope}/items/$ref")),
    );
    let row_required = required(row, "/required")
        .as_array()
        .expect("row required must be an array")
        .iter()
        .map(|field| field.as_str().expect("row field must be a string"))
        .collect::<BTreeSet<_>>();
    let projected = product
        .response_fields
        .iter()
        .map(|field| field.name.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        row_required, projected,
        "projected row fields must match OpenAPI"
    );

    WireOperation {
        product,
        method,
        request_field,
        request_description,
        envelope,
    }
}

fn provider_fields(document: &Value) -> (&str, &str) {
    let error = required(document, "/components/schemas/KrxError/properties")
        .as_object()
        .expect("provider error properties must be an object");
    let code = error
        .iter()
        .find_map(|(name, schema)| {
            (schema.get("x-krx-error-role")?.as_str()? == "code").then_some(name.as_str())
        })
        .expect("provider code role");
    let message = error
        .iter()
        .find_map(|(name, schema)| {
            (schema.get("x-krx-error-role")?.as_str()? == "message").then_some(name.as_str())
        })
        .expect("provider message role");
    (code, message)
}

fn generate_errors(product: &ProductContract, output: &Path) {
    let mut generated = String::from("// Generated from the checked product contract.\n");
    generated
        .push_str("#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]\npub enum KrxErrorKind {\n");
    for kind in product.errors.kinds.keys() {
        generated.push_str(&format!("    {},\n", rust_variant(kind)));
    }
    generated.push_str("}\nimpl KrxErrorKind {\n    pub const fn as_str(self) -> &'static str {\n        match self {\n");
    for kind in product.errors.kinds.keys() {
        generated.push_str(&format!(
            "            Self::{} => {},\n",
            rust_variant(kind),
            literal(kind)
        ));
    }
    generated.push_str("        }\n    }\n}\n");

    let mut seen = BTreeSet::new();
    generated
        .push_str("#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]\npub enum KrxErrorCode {\n");
    for contract in product.errors.kinds.values() {
        for code in contract.codes.keys() {
            assert!(seen.insert(code), "duplicate error code {code}");
            generated.push_str(&format!("    {},\n", rust_variant(code)));
        }
    }
    generated.push_str("}\nimpl KrxErrorCode {\n    pub const fn as_str(self) -> &'static str {\n        match self {\n");
    for contract in product.errors.kinds.values() {
        for code in contract.codes.keys() {
            generated.push_str(&format!(
                "            Self::{} => {},\n",
                rust_variant(code),
                literal(code)
            ));
        }
    }
    generated.push_str(
        "        }\n    }\n    pub const fn kind(self) -> KrxErrorKind {\n        match self {\n",
    );
    for (kind, contract) in &product.errors.kinds {
        for code in contract.codes.keys() {
            generated.push_str(&format!(
                "            Self::{} => KrxErrorKind::{},\n",
                rust_variant(code),
                rust_variant(kind)
            ));
        }
    }
    generated.push_str(
        "        }\n    }\n    pub const fn retryable(self) -> bool {\n        match self {\n",
    );
    for contract in product.errors.kinds.values() {
        for (code, retryable) in &contract.codes {
            generated.push_str(&format!(
                "            Self::{} => {retryable},\n",
                rust_variant(code)
            ));
        }
    }
    generated.push_str("        }\n    }\n}\n");

    generated.push_str(
        "pub(crate) const fn http_error_code(status: u16) -> KrxErrorCode {\n    match status {\n",
    );
    let mut fallback = None;
    for mapping in &product.errors.http_mappings {
        let variant = rust_variant(&mapping.code);
        match &mapping.matcher {
            Value::Number(status) => generated.push_str(&format!(
                "        {} => KrxErrorCode::{variant},\n",
                status.as_u64().expect("HTTP status integer")
            )),
            Value::Array(statuses) => generated.push_str(&format!(
                "        {} => KrxErrorCode::{variant},\n",
                statuses
                    .iter()
                    .map(|status| status.as_u64().expect("HTTP status integer").to_string())
                    .collect::<Vec<_>>()
                    .join(" | ")
            )),
            Value::String(name) if name == "otherNonSuccess" => fallback = Some(variant),
            Value::String(_) => {}
            _ => panic!("unsupported HTTP error matcher"),
        }
    }
    generated.push_str(&format!(
        "        _ => KrxErrorCode::{},\n    }}\n}}\n",
        fallback.expect("fallback HTTP mapping")
    ));
    let retryable_statuses = product
        .errors
        .http_mappings
        .iter()
        .filter(|mapping| mapping.after_retries)
        .flat_map(|mapping| match &mapping.matcher {
            Value::Number(status) => vec![status.as_u64().expect("HTTP status integer")],
            Value::Array(statuses) => statuses
                .iter()
                .map(|status| status.as_u64().expect("HTTP status integer"))
                .collect(),
            _ => panic!("afterRetries requires numeric HTTP status matchers"),
        })
        .collect::<Vec<_>>();
    assert!(
        !retryable_statuses.is_empty(),
        "contract must declare at least one afterRetries HTTP status"
    );
    generated.push_str(&format!(
        "pub(crate) const fn retryable_http_status(status: u16) -> bool {{\n    matches!(status, {})\n}}\n",
        retryable_statuses
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(" | ")
    ));
    let provider = product
        .errors
        .http_mappings
        .iter()
        .find(|mapping| mapping.matcher == "http200ProviderError")
        .expect("provider error mapping");
    generated.push_str(&format!(
        "pub(crate) const PROVIDER_ERROR_CODE: KrxErrorCode = KrxErrorCode::{};\n",
        rust_variant(&provider.code)
    ));
    for (boundary, mapping) in &product.errors.response_mappings {
        generated.push_str(&format!(
            "pub(crate) const {}: KrxErrorCode = KrxErrorCode::{};\n",
            screaming_snake(boundary),
            rust_variant(&mapping.code)
        ));
    }
    generated.push_str("pub(crate) const COMPOSITE_PRIORITY: &[KrxErrorKind] = &[\n");
    for kind in &product.errors.composite_priority {
        generated.push_str(&format!("    KrxErrorKind::{},\n", rust_variant(kind)));
    }
    generated.push_str("];\n");
    fs::write(output.join("error_contract.rs"), generated).expect("write generated errors");
}

fn generate_operations(document: &Value, product: &ProductContract, output: &Path) {
    let server = required_str(document, "/servers/0/url");
    let content_type = required_str(document, "/x-krx-content-type");
    let auth_header = required_str(document, "/components/securitySchemes/KrxApiKey/name");
    let (provider_code, provider_message) = provider_fields(document);
    let operations = product
        .operations
        .iter()
        .map(|operation| operation_for(document, operation))
        .collect::<Vec<_>>();

    let mut generated =
        String::from("// Generated from canonical OpenAPI and product artifacts.\n");
    generated.push_str(&format!(
        "pub(crate) const OFFICIAL_SERVER: &str = {};\n",
        literal(server)
    ));
    generated.push_str(&format!(
        "pub(crate) const CONTENT_TYPE: &str = {};\n",
        literal(content_type)
    ));
    generated.push_str(&format!(
        "pub(crate) const AUTH_HEADER: &str = {};\n",
        literal(auth_header)
    ));
    generated.push_str(&format!(
        "pub(crate) const PROVIDER_CODE_FIELD: &str = {};\n",
        literal(provider_code)
    ));
    generated.push_str(&format!(
        "pub(crate) const PROVIDER_MESSAGE_FIELD: &str = {};\n",
        literal(provider_message)
    ));
    generated.push_str(&format!(
        "pub(crate) const DEFAULT_RETRIES: u8 = {};\n",
        product.defaults.retries
    ));
    generated.push_str(&format!(
        "pub(crate) const ATTEMPT_TIMEOUT_MS: u64 = {};\n",
        product.defaults.attempt_timeout_ms
    ));
    generated.push_str(&format!(
        "pub(crate) const OVERALL_TIMEOUT_MS: u64 = {};\n",
        product.defaults.overall_timeout_ms
    ));
    generated.push_str(&format!(
        "pub(crate) const DEFAULT_CACHE_MAX_AGE_HOURS: u64 = {};\n",
        product.defaults.cache_max_age_hours
    ));
    generated.push_str(&format!(
        "pub(crate) const QUOTA_PER_KST_DAY: u32 = {};\n",
        product.defaults.quota_per_kst_day
    ));

    for (index, operation) in operations.iter().enumerate() {
        generated.push_str(&format!(
            "static REQUEST_FIELDS_{index}: &[OperationFieldDescription] = &[\n"
        ));
        generated.push_str(&format!(
            "    OperationFieldDescription {{ name: {}, description: {} }},\n",
            literal(operation.request_field),
            literal(operation.request_description)
        ));
        generated.push_str("];\n");
        generated.push_str(&format!(
            "static RESPONSE_FIELDS_{index}: &[OperationFieldDescription] = &[\n"
        ));
        for field in &operation.product.response_fields {
            generated.push_str(&format!(
                "    OperationFieldDescription {{ name: {}, description: {} }},\n",
                literal(&field.name),
                literal(&field.description)
            ));
        }
        generated.push_str("];\n");
    }

    let adjusted_operations = product
        .operation_sets
        .adjusted_daily_stock
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    generated.push_str("pub(crate) static ADJUSTED_DAILY_STOCK_PATHS: &[&str] = &[\n");
    for operation in &operations {
        if adjusted_operations.contains(operation.product.operation_id.as_str()) {
            generated.push_str(&format!("    {},\n", literal(&operation.product.path)));
        }
    }
    generated.push_str("];\n");

    generated.push_str("pub(crate) static GENERATED_CAPABILITIES: &[OperationDescription] = &[\n");
    for (index, operation) in operations.iter().enumerate() {
        let derived_output =
            if adjusted_operations.contains(operation.product.operation_id.as_str()) {
                "Some(&ADJUSTED_DAILY_STOCK_OUTPUT)"
            } else {
                "None"
            };
        generated.push_str(&format!(
            "    OperationDescription {{ operation_id: OperationId::{variant}, category: ApprovalCategory::{category}, method: {method}, path: {path}, auth_header: AUTH_HEADER, request_field: {request}, description: {description}, description_ko: {description_ko}, contract_id: {contract}, request_fields: REQUEST_FIELDS_{index}, response_fields: RESPONSE_FIELDS_{index}, derived_output: {derived_output} }},\n",
            variant = rust_variant(&operation.product.operation_id),
            category = rust_variant(&operation.product.category),
            method = literal(&operation.method.to_ascii_uppercase()),
            path = literal(&operation.product.path),
            request = literal(operation.request_field),
            description = literal(&operation.product.description),
            description_ko = literal(&operation.product.description_ko),
            contract = literal(&operation.product.contract_id),
            derived_output = derived_output,
        ));
    }
    generated.push_str("];\n");

    generated.push_str("pub(crate) static OPERATION_SPECS: &[OperationSpec] = &[\n");
    for (index, operation) in operations.iter().enumerate() {
        generated.push_str(&format!(
            "    OperationSpec {{ operation_id: OperationId::{variant}, method: {method}, path: {path}, request_field: {request}, success_envelope: {envelope}, contract_id: {contract}, response_fields: RESPONSE_FIELDS_{index} }},\n",
            variant = rust_variant(&operation.product.operation_id),
            method = literal(&operation.method.to_ascii_uppercase()),
            path = literal(&operation.product.path),
            request = literal(operation.request_field),
            envelope = literal(operation.envelope),
            contract = literal(&operation.product.contract_id),
        ));
    }
    generated.push_str("];\n");
    generated.push_str("pub(crate) fn operation_spec(operation: OperationId) -> &'static OperationSpec {\n    match operation {\n");
    for (index, operation) in operations.iter().enumerate() {
        generated.push_str(&format!(
            "        OperationId::{} => &OPERATION_SPECS[{index}],\n",
            rust_variant(&operation.product.operation_id)
        ));
    }
    generated.push_str("    }\n}\n");

    let operation_ids = product
        .operations
        .iter()
        .map(|operation| operation.operation_id.as_str())
        .collect::<BTreeSet<_>>();
    generated.push_str("pub(crate) static ADJUSTED_DAILY_STOCK: &[OperationId] = &[\n");
    for operation in &product.operation_sets.adjusted_daily_stock {
        assert!(
            operation_ids.contains(operation.as_str()),
            "unknown adjusted operation"
        );
        generated.push_str(&format!("    OperationId::{},\n", rust_variant(operation)));
    }
    generated.push_str("];\n");

    for (name, components) in [
        (
            "STOCK_SEARCH_COMPONENTS",
            &product.composites.stock_search.components,
        ),
        (
            "WATCHLIST_PRICE_COMPONENTS",
            &product.composites.watchlist_prices.components,
        ),
        (
            "MARKET_SUMMARY_COMPONENTS",
            &product.composites.market_summary.components,
        ),
    ] {
        generated.push_str(&format!(
            "pub(crate) static {name}: &[(&str, OperationId)] = &[\n"
        ));
        for (component, operation) in components {
            assert!(
                operation_ids.contains(operation.as_str()),
                "unknown composite operation"
            );
            generated.push_str(&format!(
                "    ({}, OperationId::{}),\n",
                literal(component),
                rust_variant(operation)
            ));
        }
        generated.push_str("];\n");
    }
    generated.push_str(&format!(
        "pub(crate) const MARKET_SUMMARY_TOP_COUNT: usize = {};\n",
        product.composites.market_summary.top_count
    ));
    fs::write(output.join("operation_contract.rs"), generated).expect("write generated operations");
}

fn generate_local_state(product: &ProductContract, migrations: &Value, output: &Path) {
    let service = required_str(migrations, "/credential/keychain/service");
    let account = required_str(migrations, "/credential/keychain/account");
    let environment = required(migrations, "/credential/resolutionPrecedence")
        .as_array()
        .expect("credential precedence array")
        .iter()
        .find_map(|source| {
            let source = source.as_str()?;
            (source == "KRX_API_KEY").then_some(source)
        })
        .expect("credential environment source");
    let mut generated = String::from("// Generated from checked product contracts.\n");
    generated.push_str(&format!(
        "pub(crate) const KEYRING_SERVICE: &str = {};\n",
        literal(service)
    ));
    generated.push_str(&format!(
        "pub(crate) const KEYRING_ACCOUNT: &str = {};\n",
        literal(account)
    ));
    generated.push_str(&format!(
        "pub(crate) const CREDENTIAL_ENVIRONMENT: &str = {};\n",
        literal(environment)
    ));
    generated.push_str(&format!(
        "pub(crate) const APPROVAL_TTL_SECONDS: u64 = {};\n",
        product.defaults.approval_ttl_seconds
    ));
    let cache_entry_read_bytes = required(migrations, "/bounds/cacheEntryReadBytes")
        .as_u64()
        .expect("cache entry read bound integer");
    let cache_lease_owner_dead_ms =
        required(migrations, "/cacheRefresh/lease/stale/ownerDeadAfterMs")
            .as_u64()
            .expect("cache lease dead-owner duration integer");
    let cache_lease_absolute_age_ms =
        required(migrations, "/cacheRefresh/lease/stale/absoluteAgeMs")
            .as_u64()
            .expect("cache lease absolute-age duration integer");
    let inspect_default_entries = required(migrations, "/bounds/inspectDefaultEntries")
        .as_u64()
        .expect("cache inspect default bound integer");
    let inspect_maximum_entries = required(migrations, "/bounds/inspectMaximumEntries")
        .as_u64()
        .expect("cache inspect maximum bound integer");
    let prune_scan_maximum_files = required(migrations, "/bounds/pruneScanMaximumFiles")
        .as_u64()
        .expect("cache prune file scan bound integer");
    let prune_scan_maximum_metadata_bytes =
        required(migrations, "/bounds/pruneScanMaximumMetadataBytes")
            .as_u64()
            .expect("cache prune metadata scan bound integer");
    let prune_delete_batch_maximum = required(migrations, "/bounds/pruneDeleteBatchMaximum")
        .as_u64()
        .expect("cache prune delete batch bound integer");
    let migration = required(migrations, "/transitions")
        .as_array()
        .and_then(|transitions| {
            transitions.iter().find(|transition| {
                transition.get("id").and_then(Value::as_str) == Some("cache-v1-to-v2")
            })
        })
        .expect("cache v1-to-v2 transition");
    assert!(
        required(migration, "/preconditions")
            .as_array()
            .expect("cache migration preconditions")
            .iter()
            .any(|value| {
                value.as_str() == Some("fetchedAt-is-no-more-than-five-minutes-in-future")
            }),
        "cache future-skew contract changed"
    );
    for (name, value) in [
        ("CACHE_ENTRY_READ_BYTES", cache_entry_read_bytes),
        ("CACHE_FUTURE_SKEW_SECONDS", 5 * 60),
        ("CACHE_LEASE_OWNER_DEAD_MS", cache_lease_owner_dead_ms),
        ("CACHE_LEASE_ABSOLUTE_AGE_MS", cache_lease_absolute_age_ms),
        ("CACHE_INSPECT_DEFAULT_ENTRIES", inspect_default_entries),
        ("CACHE_INSPECT_MAXIMUM_ENTRIES", inspect_maximum_entries),
        ("CACHE_PRUNE_SCAN_MAXIMUM_FILES", prune_scan_maximum_files),
        (
            "CACHE_PRUNE_SCAN_MAXIMUM_METADATA_BYTES",
            prune_scan_maximum_metadata_bytes,
        ),
        (
            "CACHE_PRUNE_DELETE_BATCH_MAXIMUM",
            prune_delete_batch_maximum,
        ),
    ] {
        generated.push_str(&format!("pub(crate) const {name}: u64 = {value};\n"));
    }
    generated
        .push_str("pub(crate) static APPROVAL_PROBES: &[(ApprovalCategory, OperationId)] = &[\n");
    for (category, operation) in &product.approval_probes {
        generated.push_str(&format!(
            "    (ApprovalCategory::{}, OperationId::{}),\n",
            rust_variant(category),
            rust_variant(operation)
        ));
    }
    generated.push_str("];\n");
    fs::write(output.join("local_state_contract.rs"), generated)
        .expect("write generated local state contract");
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let repository = manifest.join("../..");
    let openapi_path = repository.join("contracts/krx/openapi.yaml");
    let product_path = repository.join("contracts/generated/product-v1.json");
    let migrations_path = repository.join("contracts/product/v1/migrations.yaml");
    println!("cargo:rerun-if-changed={}", openapi_path.display());
    println!("cargo:rerun-if-changed={}", product_path.display());
    println!("cargo:rerun-if-changed={}", migrations_path.display());

    let document: Value =
        serde_saphyr::from_str(&fs::read_to_string(openapi_path).expect("read canonical OpenAPI"))
            .expect("parse canonical OpenAPI");
    let product: ProductContract =
        serde_json::from_slice(&fs::read(product_path).expect("read generated product contract"))
            .expect("parse generated product contract");
    let migrations: Value = serde_saphyr::from_str(
        &fs::read_to_string(migrations_path).expect("read migration contract"),
    )
    .expect("parse migration contract");
    assert_eq!(
        product.operations.len(),
        31,
        "all supported operations are generated"
    );

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    generate_errors(&product, &output);
    generate_operations(&document, &product, &output);
    generate_local_state(&product, &migrations, &output);
}
