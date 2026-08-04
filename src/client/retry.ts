import { verbose } from "../utils/logger.js";

export const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class RequestCancelledError extends Error {
  constructor(message = "Request cancelled") {
    super(message);
    this.name = "RequestCancelledError";
  }
}

export class RequestTimeoutError extends Error {
  constructor(message = "Request deadline exceeded") {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

export interface RetryContext {
  readonly attempt: number;
  readonly remainingMs: number;
  readonly signal: AbortSignal;
}

interface RetryOptions<T> {
  readonly maxRetries?: number;
  readonly baseDelay?: number;
  readonly maxDelay?: number;
  readonly overallTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly shouldRetryResult?: (result: T) => boolean;
  readonly retryAfterMs?: (result: T) => number | undefined;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 10_000;
const DEFAULT_OVERALL_TIMEOUT = 45_000;

export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("fetch failed") ||
      msg.includes("network")
    );
  }
  return false;
}

function timeoutReason(reason: unknown): RequestTimeoutError | undefined {
  if (reason instanceof RequestTimeoutError) return reason;
  if (
    reason instanceof Error &&
    (reason.name === "TimeoutError" || reason.name === "RequestTimeoutError")
  ) {
    return new RequestTimeoutError(reason.message);
  }
  return undefined;
}

function abortReason(signal: AbortSignal): Error {
  return timeoutReason(signal.reason) ?? new RequestCancelledError();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parse either Retry-After seconds or an HTTP-date. */
export function parseRetryAfter(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

export async function withRetry<T>(
  fn: (context: RetryContext) => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseDelay ?? DEFAULT_BASE_DELAY;
  const maxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT;
  const startedAt = now();
  const deadline = startedAt + overallTimeoutMs;
  const controller = new AbortController();
  const relayAbort = (): void => {
    if (options.signal) controller.abort(abortReason(options.signal));
  };
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  if (options.signal?.aborted) relayAbort();
  const deadlineTimer = setTimeout(
    () => controller.abort(new RequestTimeoutError()),
    overallTimeoutMs,
  );

  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      throwIfAborted(controller.signal);
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw new RequestTimeoutError();

      let result: T | undefined;
      let retryAfterMs: number | undefined;
      try {
        result = await fn({ attempt, remainingMs, signal: controller.signal });
        if (!options.shouldRetryResult?.(result) || attempt === maxRetries) {
          return result;
        }
        retryAfterMs = options.retryAfterMs?.(result);
      } catch (error) {
        if (error instanceof RequestCancelledError) {
          throw error;
        }
        lastError = error;
        if (
          (!(error instanceof RequestTimeoutError) && !isNetworkError(error)) ||
          attempt === maxRetries
        ) {
          throw error;
        }
      }

      const exponential = Math.min(maxDelay, baseDelay * 2 ** attempt);
      const jittered = Math.floor(exponential * (0.5 + random() * 0.5));
      const requestedDelay = retryAfterMs ?? jittered;
      const remainingBeforeSleep = deadline - now();
      if (requestedDelay >= remainingBeforeSleep) {
        throw new RequestTimeoutError(
          "Retry delay would exceed the overall request deadline",
        );
      }
      verbose(`retry ${attempt + 1}/${maxRetries} after ${requestedDelay}ms`);
      try {
        await (options.sleep ?? abortableDelay)(
          requestedDelay,
          controller.signal,
        );
      } catch (error) {
        throwIfAborted(controller.signal);
        throw error;
      }
    }
    throw lastError;
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}
