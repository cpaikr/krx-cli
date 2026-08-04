import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRetryAfter,
  RequestCancelledError,
  RequestTimeoutError,
  TRANSIENT_HTTP_STATUSES,
  withRetry,
} from "../../src/client/retry.js";

describe("bounded retry policy", () => {
  beforeEach(() => vi.useRealTimers());

  it("retries network failures and exhausts the configured attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      withRetry(fn, { maxRetries: 2, sleep: async () => undefined }),
    ).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries only the documented transient HTTP statuses", async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const fn = vi
        .fn()
        .mockResolvedValueOnce(status)
        .mockResolvedValueOnce(200);
      await expect(
        withRetry(fn, {
          maxRetries: 1,
          shouldRetryResult: (value) => TRANSIENT_HTTP_STATUSES.has(value),
          sleep: async () => undefined,
        }),
      ).resolves.toBe(200);
      expect(fn).toHaveBeenCalledTimes(2);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const fn = vi.fn().mockResolvedValue(status);
      await expect(
        withRetry(fn, {
          maxRetries: 2,
          shouldRetryResult: (value) => TRANSIENT_HTTP_STATUSES.has(value),
        }),
      ).resolves.toBe(status);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("applies bounded exponential jitter", async () => {
    const sleeps: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValue("ok");
    await withRetry(fn, {
      maxRetries: 2,
      baseDelay: 100,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([50, 100]);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("3", 0)).toBe(3_000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });

  it("honors Retry-After when it fits and rejects it beyond the deadline", async () => {
    const sleeps: number[] = [];
    await withRetry(vi.fn().mockResolvedValueOnce(429).mockResolvedValue(200), {
      maxRetries: 1,
      overallTimeoutMs: 1_000,
      shouldRetryResult: (status) => status === 429,
      retryAfterMs: () => 500,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([500]);

    await expect(
      withRetry(vi.fn().mockResolvedValue(429), {
        maxRetries: 1,
        overallTimeoutMs: 100,
        shouldRetryResult: () => true,
        retryAfterMs: () => 100,
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("retries per-attempt timeouts until exhausted", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new RequestTimeoutError("attempt timeout"));
    await expect(
      withRetry(fn, { maxRetries: 2, sleep: async () => undefined }),
    ).rejects.toThrow("attempt timeout");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("aborts retry sleep on caller cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = withRetry(
      vi.fn().mockRejectedValue(new TypeError("network")),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it("preserves a caller-provided timeout reason before dispatch", async () => {
    const controller = new AbortController();
    controller.abort(new RequestTimeoutError("caller deadline"));
    const fn = vi.fn();

    await expect(withRetry(fn, { signal: controller.signal })).rejects.toThrow(
      "caller deadline",
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("normalizes a platform TimeoutError during an in-flight attempt", async () => {
    const controller = new AbortController();
    const pending = withRetry(
      vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
      { signal: controller.signal },
    );

    controller.abort(new DOMException("caller deadline", "TimeoutError"));
    await expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("enforces the overall deadline during before-attempt work", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const pending = withRetry(fn, { overallTimeoutMs: 25 });
    const expectation =
      expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
