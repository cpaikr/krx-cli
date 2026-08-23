use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

const REPRESENTATIVE_OPERATION: &str = "stock_stk_bydd_trd";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductContract {
    operations: Vec<ProductOperation>,
    errors: ProductErrors,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductErrors {
    kinds: BTreeMap<String, ProductErrorKind>,
    http_mappings: Vec<ProductHttpMapping>,
    response_mappings: BTreeMap<String, ProductErrorReference>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductOperation {
    operation_id: String,
    category: String,
    description: String,
    description_ko: String,
    contract_id: String,
    response_fields: Vec<ProductField>,
}

#[derive(Deserialize)]
struct ProductField {
    name: String,
    description: String,
}

fn required<'a>(value: &'a Value, pointer: &str) -> &'a Value {
    value
        .pointer(pointer)
        .unwrap_or_else(|| panic!("canonical OpenAPI is missing {pointer}"))
}

fn required_str<'a>(value: &'a Value, pointer: &str) -> &'a str {
    required(value, pointer)
        .as_str()
        .unwrap_or_else(|| panic!("canonical OpenAPI value at {pointer} is not a string"))
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

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let repository = manifest_dir.join("../../..");
    let openapi_path = repository.join("contracts/krx/openapi.yaml");
    let product_path = repository.join("contracts/generated/product-v1.json");
    let migrations_path = repository.join("contracts/product/v1/migrations.yaml");
    println!("cargo:rerun-if-changed={}", openapi_path.display());
    println!("cargo:rerun-if-changed={}", product_path.display());
    println!("cargo:rerun-if-changed={}", migrations_path.display());

    let openapi_source = fs::read_to_string(&openapi_path).expect("read canonical OpenAPI");
    let document: Value = serde_saphyr::from_str(&openapi_source).expect("parse canonical OpenAPI");
    let product: ProductContract =
        serde_json::from_slice(&fs::read(&product_path).expect("read generated product contract"))
            .expect("parse generated product contract");
    let migrations: Value = serde_saphyr::from_str(
        &fs::read_to_string(&migrations_path).expect("read migration contract"),
    )
    .expect("parse migration contract");

    let server = required_str(&document, "/servers/0/url");
    let content_type = required_str(&document, "/x-krx-content-type");
    let auth_header = required_str(&document, "/components/securitySchemes/KrxApiKey/name");
    let keyring_service = required_str(&migrations, "/credential/keychain/service");
    let keyring_account = required_str(&migrations, "/credential/keychain/account");

    let paths = required(&document, "/paths")
        .as_object()
        .expect("OpenAPI paths object");
    let (provider_path, method, operation) = paths
        .iter()
        .find_map(|(provider_path, path_item)| {
            path_item
                .as_object()?
                .iter()
                .find_map(|(method, operation)| {
                    (operation.get("operationId")?.as_str()? == REPRESENTATIVE_OPERATION)
                        .then_some((provider_path.as_str(), method.as_str(), operation))
                })
        })
        .expect("representative operation in canonical OpenAPI");

    let request_reference = required_str(
        operation,
        "/requestBody/content/application~1json/schema/$ref",
    );
    let request_schema = local_schema(&document, request_reference);
    let request_required = required(request_schema, "/required")
        .as_array()
        .expect("representative request required fields");
    assert_eq!(
        request_required.len(),
        1,
        "representative request schema must require exactly one field"
    );
    let request_properties = required(request_schema, "/properties")
        .as_object()
        .expect("representative request properties");
    assert_eq!(
        request_properties.len(),
        1,
        "representative request schema must expose exactly one field"
    );
    let request_field = request_required[0]
        .as_str()
        .expect("representative request field string");
    assert!(
        request_properties.contains_key(request_field),
        "representative required request field must name its sole property"
    );
    let request_description = required_str(
        request_schema,
        &format!("/properties/{request_field}/description"),
    );

    let response_schema = required(
        operation,
        "/responses/200/content/application~1json/schema/oneOf",
    )
    .as_array()
    .expect("representative response oneOf");
    assert_eq!(
        response_schema.len(),
        2,
        "success and provider error responses"
    );
    let success = local_schema(
        &document,
        response_schema[0]
            .get("$ref")
            .and_then(Value::as_str)
            .expect("success response reference"),
    );
    let success_required = required(success, "/required")
        .as_array()
        .expect("success response required fields");
    assert_eq!(
        success_required.len(),
        1,
        "representative success response must require exactly one envelope"
    );
    let success_properties = required(success, "/properties")
        .as_object()
        .expect("success response properties");
    assert_eq!(
        success_properties.len(),
        1,
        "representative success response must expose exactly one envelope"
    );
    let envelope = success_required[0]
        .as_str()
        .expect("success envelope field string");
    assert!(
        success_properties.contains_key(envelope),
        "required success envelope must name the sole response property"
    );
    let row_reference = required_str(success, &format!("/properties/{envelope}/items/$ref"));
    let row_schema = local_schema(&document, row_reference);
    let row_fields = row_schema
        .get("required")
        .and_then(Value::as_array)
        .expect("representative row required fields")
        .iter()
        .map(|field| field.as_str().expect("row field string"))
        .collect::<Vec<_>>();

    let provider_error = local_schema(
        &document,
        response_schema[1]
            .get("$ref")
            .and_then(Value::as_str)
            .expect("provider error reference"),
    );
    let provider_properties = provider_error
        .get("properties")
        .and_then(Value::as_object)
        .expect("provider error properties");
    let provider_code = provider_properties
        .iter()
        .find_map(|(name, value)| {
            (value.get("x-krx-error-role")?.as_str()? == "code").then_some(name.as_str())
        })
        .expect("provider error code field");
    let provider_message = provider_properties
        .iter()
        .find_map(|(name, value)| {
            (value.get("x-krx-error-role")?.as_str()? == "message").then_some(name.as_str())
        })
        .expect("provider error message field");

    let mut generated = String::new();
    generated.push_str("// Generated at build time from canonical contract artifacts.\n");
    generated.push_str(&format!(
        "pub(crate) const OFFICIAL_SERVER: &str = {};\n",
        literal(server)
    ));
    generated.push_str(&format!(
        "pub(crate) const METHOD: &str = {};\n",
        literal(&method.to_ascii_uppercase())
    ));
    generated.push_str(&format!(
        "pub(crate) const PROVIDER_PATH: &str = {};\n",
        literal(provider_path)
    ));
    generated.push_str(&format!(
        "pub(crate) const AUTH_HEADER: &str = {};\n",
        literal(auth_header)
    ));
    generated.push_str(&format!(
        "pub(crate) const KEYRING_SERVICE: &str = {};\n",
        literal(keyring_service)
    ));
    generated.push_str(&format!(
        "pub(crate) const KEYRING_ACCOUNT: &str = {};\n",
        literal(keyring_account)
    ));
    generated.push_str(&format!(
        "pub(crate) const CONTENT_TYPE: &str = {};\n",
        literal(content_type)
    ));
    generated.push_str(&format!(
        "pub(crate) const REQUEST_DATE_FIELD: &str = {};\n",
        literal(request_field)
    ));
    generated.push_str(&format!(
        "pub(crate) const SUCCESS_ENVELOPE: &str = {};\n",
        literal(envelope)
    ));
    generated.push_str(&format!(
        "pub(crate) const PROVIDER_CODE_FIELD: &str = {};\n",
        literal(provider_code)
    ));
    generated.push_str(&format!(
        "pub(crate) const PROVIDER_MESSAGE_FIELD: &str = {};\n",
        literal(provider_message)
    ));
    generated.push_str("pub(crate) const REPRESENTATIVE_FIELDS: &[&str] = &[\n");
    for field in &row_fields {
        generated.push_str(&format!("    {},\n", literal(field)));
    }
    generated.push_str("];\n");
    generated.push_str(&format!(
        "static REQUEST_FIELDS: &[OperationFieldDescription] = &[OperationFieldDescription {{ name: {}, description: {} }}];\n",
        literal(request_field),
        literal(request_description),
    ));

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
            literal(kind),
        ));
    }
    generated.push_str("        }\n    }\n}\n");

    let mut seen_codes = BTreeMap::new();
    for (kind, contract) in &product.errors.kinds {
        for code in contract.codes.keys() {
            if let Some(previous) = seen_codes.insert(code, kind) {
                panic!("error code {code} is mapped to both {previous} and {kind}");
            }
        }
    }
    generated
        .push_str("#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]\npub enum KrxErrorCode {\n");
    for contract in product.errors.kinds.values() {
        for code in contract.codes.keys() {
            generated.push_str(&format!("    {},\n", rust_variant(code)));
        }
    }
    generated.push_str("}\nimpl KrxErrorCode {\n    pub const fn as_str(self) -> &'static str {\n        match self {\n");
    for contract in product.errors.kinds.values() {
        for code in contract.codes.keys() {
            generated.push_str(&format!(
                "            Self::{} => {},\n",
                rust_variant(code),
                literal(code),
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
                rust_variant(kind),
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
                rust_variant(code),
            ));
        }
    }
    generated.push_str("        }\n    }\n}\n");

    generated.push_str(
        "pub(crate) fn http_error_code(status: u16) -> KrxErrorCode {\n    match status {\n",
    );
    let mut fallback = None;
    for mapping in &product.errors.http_mappings {
        let variant = rust_variant(&mapping.code);
        match &mapping.matcher {
            Value::Number(status) => generated.push_str(&format!(
                "        {} => KrxErrorCode::{variant},\n",
                status.as_u64().expect("HTTP status integer"),
            )),
            Value::Array(statuses) => generated.push_str(&format!(
                "        {} => KrxErrorCode::{variant},\n",
                statuses
                    .iter()
                    .map(|status| status.as_u64().expect("HTTP status integer").to_string())
                    .collect::<Vec<_>>()
                    .join(" | "),
            )),
            Value::String(name) if name == "otherNonSuccess" => fallback = Some(variant),
            Value::String(_) => {}
            _ => panic!("unsupported product HTTP match"),
        }
    }
    generated.push_str(&format!(
        "        _ => KrxErrorCode::{},\n    }}\n}}\n",
        fallback.expect("otherNonSuccess mapping"),
    ));
    let provider_error_code = product
        .errors
        .http_mappings
        .iter()
        .find(|mapping| mapping.matcher == "http200ProviderError")
        .expect("provider error mapping");
    generated.push_str(&format!(
        "pub(crate) const PROVIDER_ERROR: KrxErrorCode = KrxErrorCode::{};\n",
        rust_variant(&provider_error_code.code),
    ));
    for (boundary, mapping) in &product.errors.response_mappings {
        generated.push_str(&format!(
            "pub(crate) const {}: KrxErrorCode = KrxErrorCode::{};\n",
            screaming_snake(boundary),
            rust_variant(&mapping.code),
        ));
    }

    for (index, operation) in product.operations.iter().enumerate() {
        generated.push_str(&format!(
            "static RESPONSE_FIELDS_{index}: &[OperationFieldDescription] = &[\n"
        ));
        for field in &operation.response_fields {
            generated.push_str(&format!(
                "    OperationFieldDescription {{ name: {}, description: {} }},\n",
                literal(&field.name),
                literal(&field.description),
            ));
        }
        generated.push_str("];\n");
    }

    generated.push_str("pub(crate) static GENERATED_CAPABILITIES: &[OperationDescription] = &[\n");
    for (index, operation) in product.operations.iter().enumerate() {
        generated.push_str(&format!(
            "    OperationDescription {{ operation_id: OperationId::{}, category: ApprovalCategory::{}, description: {}, description_ko: {}, contract_id: {}, request_fields: REQUEST_FIELDS, response_fields: RESPONSE_FIELDS_{index} }},\n",
            rust_variant(&operation.operation_id),
            rust_variant(&operation.category),
            literal(&operation.description),
            literal(&operation.description_ko),
            literal(&operation.contract_id),
        ));
    }
    generated.push_str("];\n");

    let output = Path::new(&env::var_os("OUT_DIR").expect("out dir")).join("wire_contract.rs");
    fs::write(output, generated).expect("write generated probe wire contract");
}
