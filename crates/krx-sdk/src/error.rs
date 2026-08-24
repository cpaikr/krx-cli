use std::fmt;

use crate::OperationId;

include!(concat!(env!("OUT_DIR"), "/error_contract.rs"));

/// Stable project-owned failure exposed by every SDK boundary.
#[derive(Clone, Debug)]
pub struct KrxError {
    code: KrxErrorCode,
    message: String,
    http_status: Option<u16>,
    provider_code: Option<String>,
    operation_id: Option<OperationId>,
}

impl KrxError {
    pub(crate) fn new(code: KrxErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            http_status: None,
            provider_code: None,
            operation_id: None,
        }
    }

    pub(crate) fn for_operation(mut self, operation_id: OperationId) -> Self {
        self.operation_id = Some(operation_id);
        self
    }

    pub(crate) fn with_http_status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }

    pub(crate) fn with_provider_code(mut self, code: Option<String>) -> Self {
        self.provider_code = code;
        self
    }

    pub fn kind(&self) -> KrxErrorKind {
        self.code.kind()
    }

    pub fn code(&self) -> KrxErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn retryable(&self) -> bool {
        self.code.retryable()
    }

    pub fn http_status(&self) -> Option<u16> {
        self.http_status
    }

    pub fn provider_code(&self) -> Option<&str> {
        self.provider_code.as_deref()
    }

    pub fn operation_id(&self) -> Option<OperationId> {
        self.operation_id
    }
}

impl fmt::Display for KrxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for KrxError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_taxonomy_is_complete_and_stable() {
        assert_eq!(
            KrxErrorCode::InvalidDate.kind(),
            KrxErrorKind::InvalidRequest
        );
        assert!(!KrxErrorCode::InvalidDate.retryable());
        assert!(KrxErrorCode::DeadlineExceeded.retryable());
        assert_eq!(
            http_error_code(401),
            KrxErrorCode::CredentialOrApprovalRejected
        );
        assert_eq!(http_error_code(418), KrxErrorCode::HttpError);
        assert_eq!(COMPOSITE_PRIORITY.first(), Some(&KrxErrorKind::Cancelled));
        assert_eq!(PROVIDER_ERROR_CODE, KrxErrorCode::ProviderError);
        assert_eq!(INVALID_JSON, KrxErrorCode::InvalidJson);
        assert_eq!(INVALID_ENVELOPE, KrxErrorCode::InvalidEnvelope);
        assert_eq!(INVALID_ROW, KrxErrorCode::InvalidRow);
    }

    #[test]
    fn public_error_has_no_dependency_source() {
        let error = KrxError::new(KrxErrorCode::RequestFailed, "provider request failed")
            .with_http_status(503)
            .for_operation(OperationId::StockStkByddTrd);
        assert_eq!(error.kind(), KrxErrorKind::Network);
        assert_eq!(error.http_status(), Some(503));
        assert!(std::error::Error::source(&error).is_none());
    }
}
