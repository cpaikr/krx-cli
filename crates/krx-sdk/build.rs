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
    errors: ProductErrors,
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

    generated.push_str("pub(crate) static GENERATED_CAPABILITIES: &[OperationDescription] = &[\n");
    for (index, operation) in operations.iter().enumerate() {
        generated.push_str(&format!(
            "    OperationDescription {{ operation_id: OperationId::{variant}, category: ApprovalCategory::{category}, description: {description}, description_ko: {description_ko}, contract_id: {contract}, request_fields: REQUEST_FIELDS_{index}, response_fields: RESPONSE_FIELDS_{index} }},\n",
            variant = rust_variant(&operation.product.operation_id),
            category = rust_variant(&operation.product.category),
            description = literal(&operation.product.description),
            description_ko = literal(&operation.product.description_ko),
            contract = literal(&operation.product.contract_id),
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
    fs::write(output.join("operation_contract.rs"), generated).expect("write generated operations");
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let repository = manifest.join("../..");
    let openapi_path = repository.join("contracts/krx/openapi.yaml");
    let product_path = repository.join("contracts/generated/product-v1.json");
    println!("cargo:rerun-if-changed={}", openapi_path.display());
    println!("cargo:rerun-if-changed={}", product_path.display());

    let document: Value =
        serde_saphyr::from_str(&fs::read_to_string(openapi_path).expect("read canonical OpenAPI"))
            .expect("parse canonical OpenAPI");
    let product: ProductContract =
        serde_json::from_slice(&fs::read(product_path).expect("read generated product contract"))
            .expect("parse generated product contract");
    assert_eq!(
        product.operations.len(),
        31,
        "all supported operations are generated"
    );

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    generate_errors(&product, &output);
    generate_operations(&document, &product, &output);
}
