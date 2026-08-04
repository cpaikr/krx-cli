import type { KrxErrorType, KrxResponse } from "./client.js";

export type CompletenessState = "complete" | "partial" | "empty" | "failed";

export interface CompositeFailure<Id extends string = string> {
  readonly id: Id;
  readonly error: string;
  readonly errorType?: KrxErrorType;
}

export interface Completeness<Id extends string = string> {
  readonly state: CompletenessState;
  readonly requested: readonly Id[];
  readonly succeeded: readonly Id[];
  readonly failed: readonly CompositeFailure<Id>[];
  readonly skipped: readonly Id[];
}

interface CompletenessInput<Id extends string> {
  readonly requested: readonly Id[];
  readonly succeeded?: readonly Id[];
  readonly failed?: readonly CompositeFailure<Id>[];
  readonly skipped?: readonly Id[];
  readonly hasData: boolean;
  readonly forceFailed?: boolean;
}

export function createCompleteness<Id extends string>(
  input: CompletenessInput<Id>,
): Completeness<Id> {
  const succeeded = input.succeeded ?? [];
  const failed = input.failed ?? [];
  const skipped = input.skipped ?? [];
  const state: CompletenessState = input.forceFailed
    ? "failed"
    : failed.length > 0
      ? succeeded.length > 0 || skipped.length > 0
        ? "partial"
        : "failed"
      : input.hasData
        ? "complete"
        : "empty";

  return {
    state,
    requested: input.requested,
    succeeded,
    failed,
    skipped,
  };
}

export function componentFailure<Id extends string>(
  id: Id,
  response: Pick<KrxResponse, "error" | "errorType">,
): CompositeFailure<Id> {
  return {
    id,
    error: response.error ?? "KRX request failed",
    ...(response.errorType ? { errorType: response.errorType } : {}),
  };
}

export interface CompositeResult<Data, Id extends string = string> {
  readonly success: boolean;
  readonly data: Data;
  readonly completeness: Completeness<Id>;
  readonly error?: string;
  readonly errorType?: KrxErrorType;
}

export function completenessForOutput<Id extends string>(
  completeness: Completeness<Id>,
  hasData: boolean,
): Completeness<Id> {
  if (completeness.failed.length > 0 || completeness.state === "failed") {
    return completeness;
  }
  return {
    ...completeness,
    state: hasData ? "complete" : "empty",
  };
}
