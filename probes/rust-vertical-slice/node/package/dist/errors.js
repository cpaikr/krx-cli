export class KrxError extends Error {
  constructor(failure) {
    super(failure.message);
    this.name = "KrxError";
    this.kind = failure.kind;
    this.code = failure.code;
    this.retryable = failure.retryable;
    for (const field of ["httpStatus", "providerCode", "operationId"]) {
      if (failure[field] !== undefined && failure[field] !== null) {
        this[field] = failure[field];
      }
    }
    Error.captureStackTrace?.(this, KrxError);
  }
}

export function internalFailure() {
  return new KrxError({
    kind: "internal",
    code: "internal_failure",
    message: "native operation failed internally",
    retryable: false,
  });
}

export function outcomeValue(outcome) {
  if (!outcome?.ok) {
    throw new KrxError(
      outcome?.error ?? {
        kind: "internal",
        code: "internal_failure",
        message: "native operation failed internally",
        retryable: false,
      },
    );
  }
  return JSON.parse(outcome.valueJson);
}
