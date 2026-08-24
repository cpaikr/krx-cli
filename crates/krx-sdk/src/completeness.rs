use crate::{Completeness, CompletenessState, CompositeFailure, KrxError};

pub(crate) struct CompletenessInput<Id> {
    pub requested: Vec<Id>,
    pub succeeded: Vec<Id>,
    pub failed: Vec<CompositeFailure<Id>>,
    pub skipped: Vec<Id>,
    pub has_data: bool,
}

pub(crate) fn reduce<Id>(input: CompletenessInput<Id>) -> Completeness<Id> {
    let state = if input.failed.is_empty() {
        if input.has_data {
            CompletenessState::Complete
        } else {
            CompletenessState::Empty
        }
    } else if input.succeeded.is_empty() && input.skipped.is_empty() {
        CompletenessState::Failed
    } else {
        CompletenessState::Partial
    };

    Completeness {
        state,
        requested: input.requested,
        succeeded: input.succeeded,
        failed: input.failed,
        skipped: input.skipped,
    }
}

pub(crate) fn primary_error<Id>(failures: &[CompositeFailure<Id>]) -> Option<KrxError> {
    crate::error::COMPOSITE_PRIORITY.iter().find_map(|kind| {
        failures
            .iter()
            .find(|failure| failure.error.kind() == *kind)
            .map(|failure| failure.error.clone())
    })
}

pub(crate) fn primary_call_wide_error(errors: &[KrxError]) -> Option<KrxError> {
    crate::error::COMPOSITE_PRIORITY
        .iter()
        .find_map(|kind| errors.iter().find(|error| error.kind() == *kind).cloned())
        // Invalid requests are rejected before fan-out in production. Keep a
        // deterministic fallback for defensive reducer validation.
        .or_else(|| errors.first().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KrxErrorCode;

    fn failure(id: &str, code: KrxErrorCode) -> CompositeFailure<String> {
        CompositeFailure {
            id: id.to_owned(),
            error: KrxError::new(code, code.as_str()),
        }
    }

    #[test]
    fn derives_the_four_frozen_states() {
        let cases = [
            (
                vec!["a"],
                Vec::new(),
                Vec::new(),
                true,
                CompletenessState::Complete,
            ),
            (
                vec!["a"],
                Vec::new(),
                Vec::new(),
                false,
                CompletenessState::Empty,
            ),
            (
                vec!["a"],
                vec![failure("b", KrxErrorCode::RequestFailed)],
                Vec::new(),
                true,
                CompletenessState::Partial,
            ),
            (
                Vec::new(),
                vec![failure("a", KrxErrorCode::RequestFailed)],
                Vec::new(),
                false,
                CompletenessState::Failed,
            ),
        ];

        for (succeeded, failed, skipped, has_data, expected) in cases {
            let result = reduce(CompletenessInput {
                requested: vec!["a".to_owned(), "b".to_owned()],
                succeeded: succeeded.into_iter().map(str::to_owned).collect(),
                failed,
                skipped: skipped.into_iter().map(str::to_owned).collect(),
                has_data,
            });
            assert_eq!(result.state, expected);
        }
    }

    #[test]
    fn chooses_the_primary_failure_by_the_frozen_priority() {
        let failures = vec![
            failure("network", KrxErrorCode::RequestFailed),
            failure("timeout", KrxErrorCode::DeadlineExceeded),
            failure("cancelled", KrxErrorCode::RequestCancelled),
        ];
        assert_eq!(
            primary_error(&failures).map(|error| error.code()),
            Some(KrxErrorCode::RequestCancelled)
        );
    }

    #[test]
    fn call_wide_priority_is_not_input_order() {
        let errors = [
            KrxError::new(KrxErrorCode::CacheReadFailed, "local state"),
            KrxError::new(KrxErrorCode::RequestCancelled, "cancelled"),
        ];
        assert_eq!(
            primary_call_wide_error(&errors).map(|error| error.code()),
            Some(KrxErrorCode::RequestCancelled)
        );
    }
}
