import { getCached, setCached } from "../cache/store.js";
import { reserveCall } from "./rate-limit.js";
import {
  parseRetryAfter,
  isNetworkError,
  RequestCancelledError,
  RequestTimeoutError,
  TRANSIENT_HTTP_STATUSES,
  withRetry,
} from "./retry.js";
import { verbose } from "../utils/logger.js";
import { PUBLIC_CONTRACT } from "../user-contract.js";

export const BASE_URL = "https://data-dbg.krx.co.kr";
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;
export const DEFAULT_OVERALL_TIMEOUT_MS = 45_000;

export type KrxErrorType =
  | "timeout"
  | "cancelled"
  | "rate_limit"
  | "authentication"
  | "approval"
  | "network"
  | "upstream"
  | "invalid_response"
  | "local_state";

export interface KrxRequestOptions {
  readonly endpoint: string;
  readonly params: Record<string, string>;
  readonly apiKey: string;
  readonly cache?: boolean;
  /** Bypass a cache read and replace the matching entry after a successful fetch. */
  readonly refresh?: boolean;
  readonly retries?: number;
  readonly signal?: AbortSignal;
  readonly attemptTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
}

export interface KrxResponse<T = Record<string, string>> {
  readonly success: boolean;
  readonly data: readonly T[];
  readonly error?: string;
  readonly errorCode?: string;
  readonly errorType?: KrxErrorType;
  readonly httpStatus?: number;
}

const FAILURE_PRIORITY: readonly KrxErrorType[] = [
  "cancelled",
  "timeout",
  "rate_limit",
  "authentication",
  "approval",
  "local_state",
  "network",
  "upstream",
  "invalid_response",
];

export function selectKrxFailure<T>(
  responses: readonly KrxResponse<T>[],
): KrxResponse<T> | undefined {
  const failures = responses.filter((response) => !response.success);
  return (
    FAILURE_PRIORITY.map((type) =>
      failures.find((failure) => failure.errorType === type),
    ).find((failure) => failure !== undefined) ?? failures[0]
  );
}

export function formatKrxFailure(
  failure: Pick<KrxResponse, "error" | "errorType">,
): string {
  return `${failure.errorType ?? "upstream"}: ${failure.error ?? "KRX request failed"}`;
}

export class KrxRequestError extends Error {
  readonly errorType: KrxErrorType | undefined;

  constructor(readonly response: KrxResponse) {
    super(formatKrxFailure(response));
    this.name = "KrxRequestError";
    this.errorType = response.errorType;
  }
}

interface KrxErrorBody {
  readonly respMsg?: string;
  readonly respCode?: string;
}

interface HttpAttempt {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly invalidJson: boolean;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<HttpAttempt> {
  if (callerSignal?.aborted) {
    if (callerSignal.reason instanceof RequestTimeoutError) {
      throw callerSignal.reason;
    }
    throw new RequestCancelledError();
  }
  const controller = new AbortController();
  let timedOut = false;
  let rejectBoundary: ((error: Error) => void) | undefined;
  const onCallerAbort = (): void => {
    controller.abort();
    rejectBoundary?.(
      callerSignal?.reason instanceof RequestTimeoutError
        ? callerSignal.reason
        : new RequestCancelledError(),
    );
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectBoundary?.(new RequestTimeoutError("KRX request attempt timed out"));
  }, timeoutMs);
  try {
    const request = (async (): Promise<HttpAttempt> => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      let body: unknown;
      let invalidJson = false;
      if (typeof response.text === "function") {
        // Keep transport/body-stream failures retryable. Only JSON syntax
        // errors are classified as invalid responses.
        const text = await response.text();
        try {
          body = text ? (JSON.parse(text) as unknown) : undefined;
        } catch {
          invalidJson = true;
        }
      } else {
        try {
          body = await response.json();
        } catch {
          invalidJson = true;
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers ?? new Headers(),
        body,
        invalidJson,
      };
    })();
    return await Promise.race([request, boundary]);
  } catch (error) {
    if (callerSignal?.aborted) {
      if (callerSignal.reason instanceof RequestTimeoutError) {
        throw callerSignal.reason;
      }
      throw new RequestCancelledError();
    }
    if (timedOut) {
      throw new RequestTimeoutError("KRX request attempt timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function responseErrorType(status: number): KrxErrorType {
  if (status === 401) return "authentication";
  if (status === 403) return "approval";
  if (status === 429) return "rate_limit";
  return "upstream";
}

function failure(
  errorType: KrxErrorType,
  error: string,
  errorCode?: string,
): KrxResponse<never> {
  return {
    success: false,
    data: [],
    error,
    errorType,
    ...(errorCode ? { errorCode } : {}),
  };
}

function redactCredential(message: string, apiKey: string): string {
  return apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message;
}

export async function krxFetch<T = Record<string, string>>(
  options: KrxRequestOptions,
): Promise<KrxResponse<T>> {
  const writeCache = options.cache !== false;
  const readCache = writeCache && options.refresh !== true;

  if (readCache) {
    const cached = getCached<T>(options.endpoint, options.params);
    if (cached) {
      verbose(`cache hit — ${options.endpoint}`);
      return { success: true, data: cached };
    }
    verbose(`cache miss — ${options.endpoint}`);
  } else if (options.refresh && writeCache) {
    verbose(`cache refresh — ${options.endpoint}`);
  }

  const url = `${BASE_URL}${options.endpoint}`;
  verbose(`POST ${url} ${JSON.stringify(options.params)}`);
  const startTime = Date.now();

  let response: HttpAttempt;
  try {
    response = await withRetry(
      async ({ remainingMs, signal }) => {
        let quota: Awaited<ReturnType<typeof reserveCall>>;
        try {
          quota = await reserveCall(options.apiKey, { signal });
        } catch (error) {
          if (
            error instanceof RequestCancelledError ||
            error instanceof RequestTimeoutError
          ) {
            throw error;
          }
          throw new LocalQuotaStateError(error);
        }
        if (!quota.reserved) {
          throw new LocalQuotaError(quota.count, quota.limit);
        }
        if (quota.warning) {
          process.stderr.write(
            `Warning: ${quota.count}/${quota.limit} advisory KRX API calls reserved today (KST)\n`,
          );
        }
        verbose(
          `advisory rate limit: ${quota.count}/${quota.limit} calls reserved today (KST)`,
        );
        return fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              AUTH_KEY: options.apiKey,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify(options.params),
          },
          Math.min(
            options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
            remainingMs,
          ),
          signal,
        );
      },
      {
        maxRetries: options.retries ?? PUBLIC_CONTRACT.requests.maxRetries,
        overallTimeoutMs:
          options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS,
        signal: options.signal,
        shouldRetryResult: (candidate) =>
          TRANSIENT_HTTP_STATUSES.has(candidate.status),
        retryAfterMs: (candidate) =>
          parseRetryAfter(candidate.headers.get("retry-after")),
      },
    );
  } catch (error) {
    if (error instanceof LocalQuotaError) {
      return failure(
        "rate_limit",
        `Local advisory daily rate limit reached (${error.count}/${error.limit})`,
        "RATE_LIMIT",
      ) as KrxResponse<T>;
    }
    if (error instanceof RequestTimeoutError) {
      return failure(
        "timeout",
        "KRX request deadline exceeded",
        "TIMEOUT",
      ) as KrxResponse<T>;
    }
    if (error instanceof RequestCancelledError || options.signal?.aborted) {
      return failure(
        "cancelled",
        "KRX request was cancelled",
        "CANCELLED",
      ) as KrxResponse<T>;
    }
    if (isNetworkError(error)) {
      return failure(
        "network",
        "KRX network request failed",
        "NETWORK",
      ) as KrxResponse<T>;
    }
    if (error instanceof LocalQuotaStateError) {
      return failure(
        "local_state",
        "Local quota state is unavailable or invalid; inspect ~/.krx-cli/rate-limit.json",
        "LOCAL_STATE",
      ) as KrxResponse<T>;
    }
    return failure(
      "upstream",
      "Unexpected failure while communicating with KRX",
      "UPSTREAM",
    ) as KrxResponse<T>;
  }

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status}: ${response.statusText}`;
    let errorCode: string | undefined;
    try {
      const errorBody = response.body as KrxErrorBody;
      if (errorBody.respMsg) {
        errorMsg = redactCredential(errorBody.respMsg, options.apiKey);
      }
      errorCode = errorBody.respCode;
    } catch {
      // Non-JSON upstream errors retain the status-only diagnostic.
    }
    return {
      success: false,
      data: [],
      error: errorMsg,
      errorCode,
      errorType: responseErrorType(response.status),
      httpStatus: response.status,
    };
  }

  if (response.invalidJson) {
    return failure(
      "invalid_response",
      "Unexpected KRX response: invalid JSON",
      "INVALID_RESPONSE",
    ) as KrxResponse<T>;
  }
  const body = response.body as Record<string, unknown>;
  const elapsed = Date.now() - startTime;
  const outBlock = body["OutBlock_1"];
  if (!Array.isArray(outBlock)) {
    verbose(`response: unexpected format (no OutBlock_1) in ${elapsed}ms`);
    return failure(
      "invalid_response",
      "Unexpected KRX response: missing OutBlock_1",
      "INVALID_RESPONSE",
    ) as KrxResponse<T>;
  }

  verbose(`response: ${outBlock.length} rows in ${elapsed}ms`);
  if (writeCache) setCached(options.endpoint, options.params, outBlock as T[]);
  return { success: true, data: outBlock as T[] };
}

class LocalQuotaError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number,
  ) {
    super("Local advisory quota reached");
  }
}

class LocalQuotaStateError extends Error {
  constructor(cause: unknown) {
    super("Local quota state is unavailable", { cause });
    this.name = "LocalQuotaStateError";
  }
}
