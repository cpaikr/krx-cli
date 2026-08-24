export class KrxError extends Error {
  constructor(failure) {
    super(
      typeof failure?.message === "string"
        ? failure.message
        : "native operation failed internally",
    );
    this.name = "KrxError";
    this.kind = failure?.kind ?? "internal";
    this.code = failure?.code ?? "internal_failure";
    this.retryable = failure?.retryable === true;
    for (const field of ["httpStatus", "providerCode", "operationId"]) {
      if (failure?.[field] !== undefined && failure[field] !== null) {
        this[field] = failure[field];
      }
    }
    Error.captureStackTrace?.(this, KrxError);
  }
}

export function invalidArgument(message) {
  return new KrxError({
    kind: "invalid_request",
    code: "invalid_argument",
    message,
    retryable: false,
  });
}

export function internalFailure(
  message = "native operation failed internally",
) {
  return new KrxError({
    kind: "internal",
    code: "internal_failure",
    message,
    retryable: false,
  });
}

export function outcomeValue(outcome) {
  if (
    !outcome ||
    typeof outcome !== "object" ||
    typeof outcome.ok !== "boolean"
  ) {
    throw internalFailure();
  }
  if (!outcome.ok) {
    if (!validFailure(outcome.error)) throw internalFailure();
    throw new KrxError(outcome.error);
  }
  if (typeof outcome.valueJson !== "string") throw internalFailure();
  try {
    return JSON.parse(outcome.valueJson);
  } catch {
    throw internalFailure();
  }
}

function validFailure(failure) {
  return (
    failure !== null &&
    typeof failure === "object" &&
    typeof failure.kind === "string" &&
    typeof failure.code === "string" &&
    typeof failure.message === "string" &&
    typeof failure.retryable === "boolean"
  );
}
