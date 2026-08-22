import { binding } from "./binding.js";
import { KrxError, internalFailure, outcomeValue } from "./errors.js";

export { KrxError };

function probeOnly() {
  return Promise.reject(internalFailure());
}

export class KrxClient {
  #apiKey;
  #binding;

  constructor(options = {}) {
    this.#apiKey = Object.hasOwn(options, "apiKey") ? options.apiKey : undefined;
    this.#binding = binding();
  }

  async query(request) {
    const cancellation = new this.#binding.NativeCancellation();
    const signal = request?.signal;
    const abort = () => cancellation.cancel();
    if (signal?.aborted) abort();
    else signal?.addEventListener?.("abort", abort, { once: true });
    try {
      const outcome = await this.#binding.nativeQuery(
        this.#apiKey,
        request?.operation,
        request?.date,
        request?.cache?.mode,
        request?.retries,
        cancellation,
      );
      const value = outcomeValue(outcome);
      if (typeof value?.provenance?.fetchedAt === "number") {
        value.provenance.fetchedAt = new Date(
          value.provenance.fetchedAt,
        ).toISOString();
      }
      return value;
    } catch (error) {
      if (error instanceof KrxError) throw error;
      throw internalFailure();
    } finally {
      signal?.removeEventListener?.("abort", abort);
    }
  }

  range(request) {
    if (request?.adjusted === true && !request?.securityCode) {
      return Promise.reject(
        new KrxError({
          kind: "invalid_request",
          code: "conflicting_options",
          message: "adjusted ranges require one exact eligible security code",
          retryable: false,
        }),
      );
    }
    return probeOnly();
  }

  searchStocks() {
    return probeOnly();
  }

  marketSummary() {
    return probeOnly();
  }

  watchlistPrices() {
    return probeOnly();
  }

  capabilities() {
    return [];
  }

  get credentials() {
    return {
      status: probeOnly,
      set: probeOnly,
      remove: probeOnly,
      migrateLegacy: probeOnly,
      approvalStatus: probeOnly,
      checkApproval: probeOnly,
    };
  }

  get cache() {
    return { inspect: probeOnly, prune: probeOnly, clear: probeOnly };
  }
}
