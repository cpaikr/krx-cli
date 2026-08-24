use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::error::{INVALID_ENVELOPE, INVALID_JSON, INVALID_ROW, PROVIDER_ERROR_CODE};
use crate::operation::{
    AUTH_HEADER, CONTENT_TYPE, PROVIDER_CODE_FIELD, PROVIDER_MESSAGE_FIELD, operation_spec,
};
use crate::{ApiKey, KrxError, OperationId, Row, TradingDate};

pub(crate) struct PreparedRequest {
    pub method: &'static str,
    pub path: &'static str,
    pub auth_header: &'static str,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

pub(crate) fn prepare_request(
    operation: OperationId,
    date: &TradingDate,
) -> Result<PreparedRequest, KrxError> {
    let spec = operation_spec(operation);
    let mut body = Map::new();
    body.insert(
        spec.request_field.to_owned(),
        Value::String(date.as_str().to_owned()),
    );
    let body = serde_json::to_vec(&Value::Object(body)).map_err(|_| {
        KrxError::new(
            crate::KrxErrorCode::InternalFailure,
            "request serialization failed",
        )
        .for_operation(operation)
    })?;
    Ok(PreparedRequest {
        method: spec.method,
        path: spec.path,
        auth_header: AUTH_HEADER,
        content_type: CONTENT_TYPE,
        body,
    })
}

pub(crate) fn decode_response(
    operation: OperationId,
    bytes: &[u8],
    api_key: Option<&ApiKey>,
) -> Result<Vec<Row>, KrxError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        KrxError::new(INVALID_JSON, "provider returned invalid JSON").for_operation(operation)
    })?;
    let object = value.as_object().ok_or_else(|| {
        KrxError::new(INVALID_ENVELOPE, "provider response must be an object")
            .for_operation(operation)
    })?;

    if object.contains_key(PROVIDER_CODE_FIELD) || object.contains_key(PROVIDER_MESSAGE_FIELD) {
        return Err(provider_error(operation, object, api_key));
    }

    let spec = operation_spec(operation);
    if object.len() != 1 {
        return Err(KrxError::new(
            INVALID_ENVELOPE,
            "provider success envelope contains unexpected fields",
        )
        .for_operation(operation));
    }
    let rows = object
        .get(spec.success_envelope)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            KrxError::new(
                INVALID_ENVELOPE,
                "provider success envelope is missing or malformed",
            )
            .for_operation(operation)
        })?;
    let expected = spec
        .response_fields
        .iter()
        .map(|field| field.name)
        .collect::<BTreeSet<_>>();
    decode_rows(operation, rows, &expected)
}

pub(crate) fn decode_cached_rows(
    operation: OperationId,
    rows: &[Value],
) -> Result<Vec<Row>, KrxError> {
    let expected = operation_spec(operation)
        .response_fields
        .iter()
        .map(|field| field.name)
        .collect::<BTreeSet<_>>();
    decode_rows(operation, rows, &expected)
}

fn decode_rows(
    operation: OperationId,
    rows: &[Value],
    expected: &BTreeSet<&str>,
) -> Result<Vec<Row>, KrxError> {
    rows.iter()
        .map(|row| decode_row(operation, row, expected))
        .collect()
}

fn decode_row(
    operation: OperationId,
    value: &Value,
    expected: &BTreeSet<&str>,
) -> Result<Row, KrxError> {
    let object = value.as_object().ok_or_else(|| {
        KrxError::new(INVALID_ROW, "provider row must be an object").for_operation(operation)
    })?;
    if object.len() != expected.len()
        || object
            .keys()
            .any(|field| !expected.contains(field.as_str()))
    {
        return Err(KrxError::new(
            INVALID_ROW,
            "provider row fields do not match the operation contract",
        )
        .for_operation(operation));
    }
    let mut fields = BTreeMap::new();
    for expected_field in expected {
        let value = object
            .get(*expected_field)
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KrxError::new(INVALID_ROW, "provider row values must be strings")
                    .for_operation(operation)
            })?;
        fields.insert((*expected_field).to_owned(), value.to_owned());
    }
    Ok(Row::new(fields))
}

fn provider_error(
    operation: OperationId,
    object: &Map<String, Value>,
    api_key: Option<&ApiKey>,
) -> KrxError {
    let code = object
        .get(PROVIDER_CODE_FIELD)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| bounded_diagnostic(value, api_key));
    let message = object
        .get(PROVIDER_MESSAGE_FIELD)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| bounded_diagnostic(value, api_key))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "provider returned an error envelope".to_owned());
    KrxError::new(PROVIDER_ERROR_CODE, message)
        .with_provider_code(code)
        .for_operation(operation)
}

fn bounded_diagnostic(value: &str, api_key: Option<&ApiKey>) -> String {
    let redacted = api_key.map_or_else(
        || value.to_owned(),
        |key| value.replace(key.expose(), "[REDACTED]"),
    );
    redacted.chars().take(240).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::KrxErrorCode;

    fn valid_body(operation: OperationId) -> Vec<u8> {
        let spec = operation_spec(operation);
        let row = spec
            .response_fields
            .iter()
            .map(|field| (field.name.to_owned(), Value::String("fixture".to_owned())))
            .collect::<Map<_, _>>();
        serde_json::to_vec(&json!({ spec.success_envelope: [Value::Object(row)] }))
            .expect("fixture JSON")
    }

    #[test]
    fn prepares_and_decodes_every_supported_operation() {
        let date = TradingDate::parse("20260824").expect("fixture date");
        for operation in OperationId::ALL {
            let prepared = prepare_request(operation, &date).expect("prepared request");
            assert_eq!(prepared.method, "POST");
            assert!(prepared.path.starts_with('/'));
            assert_eq!(prepared.auth_header, AUTH_HEADER);
            assert_eq!(prepared.content_type, CONTENT_TYPE);
            let expected_body = format!(
                "{{{:?}:{:?}}}",
                operation_spec(operation).request_field,
                date.as_str()
            );
            assert_eq!(prepared.body, expected_body.as_bytes());

            let rows =
                decode_response(operation, &valid_body(operation), None).expect("strict response");
            assert_eq!(rows.len(), 1);
            assert_eq!(
                rows[0].iter().count(),
                operation_spec(operation).response_fields.len()
            );
        }
    }

    #[test]
    fn accepts_an_observed_empty_success_envelope() {
        let operation = OperationId::StockStkByddTrd;
        let envelope = operation_spec(operation).success_envelope;
        let body = serde_json::to_vec(&json!({ envelope: [] })).expect("fixture JSON");
        assert!(
            decode_response(operation, &body, None)
                .expect("empty success")
                .is_empty()
        );
    }

    #[test]
    fn rejects_missing_extra_and_non_string_row_fields() {
        let operation = OperationId::StockStkByddTrd;
        let spec = operation_spec(operation);
        let mut valid: Map<String, Value> = spec
            .response_fields
            .iter()
            .map(|field| (field.name.to_owned(), Value::String("fixture".to_owned())))
            .collect();

        let removed = spec.response_fields[0].name;
        valid.remove(removed);
        let body =
            serde_json::to_vec(&json!({ spec.success_envelope: [valid] })).expect("fixture JSON");
        assert_eq!(
            decode_response(operation, &body, None)
                .expect_err("missing field")
                .code(),
            KrxErrorCode::InvalidRow
        );

        let mut extra: Map<String, Value> = spec
            .response_fields
            .iter()
            .map(|field| (field.name.to_owned(), Value::String("fixture".to_owned())))
            .collect();
        extra.insert("UNKNOWN".to_owned(), Value::String("fixture".to_owned()));
        let body =
            serde_json::to_vec(&json!({ spec.success_envelope: [extra] })).expect("fixture JSON");
        assert_eq!(
            decode_response(operation, &body, None)
                .expect_err("extra field")
                .code(),
            KrxErrorCode::InvalidRow
        );

        let mut wrong_type: Map<String, Value> = spec
            .response_fields
            .iter()
            .map(|field| (field.name.to_owned(), Value::String("fixture".to_owned())))
            .collect();
        wrong_type.insert(removed.to_owned(), Value::Number(1.into()));
        let body = serde_json::to_vec(&json!({ spec.success_envelope: [wrong_type] }))
            .expect("fixture JSON");
        assert_eq!(
            decode_response(operation, &body, None)
                .expect_err("wrong type")
                .code(),
            KrxErrorCode::InvalidRow
        );
    }

    #[test]
    fn classifies_and_sanitizes_provider_errors() {
        let operation = OperationId::StockStkByddTrd;
        let key = ApiKey::parse("fixture-secret").expect("fixture key");
        let long = format!("fixture-secret{}", "가".repeat(300));
        let body = serde_json::to_vec(&json!({
            PROVIDER_CODE_FIELD: long,
            PROVIDER_MESSAGE_FIELD: "credential fixture-secret was rejected"
        }))
        .expect("fixture JSON");
        let error = decode_response(operation, &body, Some(&key)).expect_err("provider error");
        assert_eq!(error.code(), KrxErrorCode::ProviderError);
        assert!(!error.message().contains("fixture-secret"));
        assert!(
            !error
                .provider_code()
                .expect("provider code")
                .contains("fixture-secret")
        );
        assert!(
            error
                .provider_code()
                .expect("provider code")
                .chars()
                .count()
                <= 240
        );
    }

    #[test]
    fn distinguishes_json_envelope_and_row_failures() {
        let operation = OperationId::StockStkByddTrd;
        assert_eq!(
            decode_response(operation, b"not-json", None)
                .expect_err("invalid JSON")
                .code(),
            KrxErrorCode::InvalidJson
        );
        assert_eq!(
            decode_response(operation, b"[]", None)
                .expect_err("invalid envelope")
                .code(),
            KrxErrorCode::InvalidEnvelope
        );
        let envelope = operation_spec(operation).success_envelope;
        let body =
            serde_json::to_vec(&json!({ envelope: ["not-an-object"] })).expect("fixture JSON");
        assert_eq!(
            decode_response(operation, &body, None)
                .expect_err("invalid row")
                .code(),
            KrxErrorCode::InvalidRow
        );
    }
}
