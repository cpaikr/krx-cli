import {
  KrxError,
  internalFailure,
  invalidArgument,
  outcomeValue,
} from "./errors.js";

const MAX_CACHE_AGE_HOURS = Number.MAX_SAFE_INTEGER / 3_600_000;

export function createKrxClientClass(loadBinding) {
  return class KrxClient {
    #binding;
    #cacheMaxAgeHours;
    #nativeClient;

    constructor(options = {}) {
      if (
        options === null ||
        typeof options !== "object" ||
        Array.isArray(options)
      ) {
        throw invalidArgument("client options must be an object");
      }
      rejectUnknownFields(
        options,
        ["apiKey", "cacheMaxAgeHours"],
        "client options",
      );
      const apiKey = Object.hasOwn(options, "apiKey")
        ? options.apiKey
        : undefined;
      validateApiKeyType(apiKey);
      this.#cacheMaxAgeHours = validateCacheAge(
        options.cacheMaxAgeHours,
        "cacheMaxAgeHours",
      );
      this.#binding = loadBinding();
      this.#nativeClient = createNativeClient(this.#binding, apiKey);

      Object.defineProperties(this, {
        credentials: {
          enumerable: true,
          configurable: false,
          writable: false,
          value: Object.freeze({
            status: () =>
              invoke(this.#binding, "nativeCredentialStatus", [
                this.#nativeClient,
              ]),
            set: async (replacement) => {
              validateRequiredString(replacement, "apiKey");
              return await invoke(this.#binding, "nativeCredentialSet", [
                this.#nativeClient,
                replacement,
              ]);
            },
            remove: () =>
              invoke(this.#binding, "nativeCredentialRemove", [
                this.#nativeClient,
              ]),
            migrateLegacy: () =>
              invoke(this.#binding, "nativeCredentialMigrateLegacy", [
                this.#nativeClient,
              ]),
            approvalStatus: (category) =>
              invokeApprovalStatus(this.#binding, this.#nativeClient, category),
            checkApproval: async (category, options = {}) => {
              validateRequiredString(category, "approval category");
              validateOptionsObject(options, ["signal"], "approval options");
              return await withCancellation(
                this.#binding,
                options?.signal,
                "nativeCheckApproval",
                [this.#nativeClient, category],
              );
            },
          }),
        },
        cache: {
          enumerable: true,
          configurable: false,
          writable: false,
          value: Object.freeze({
            inspect: async (options = {}) => {
              validateOptionsObject(
                options,
                ["operation", "date", "limit"],
                "cache inspect options",
              );
              validateOptionalU32(options.limit, "cache inspect limit");
              validateOptionalString(
                options.operation,
                "cache inspect operation",
              );
              validateOptionalString(options.date, "cache inspect date");
              return await invoke(this.#binding, "nativeCacheInspect", [
                this.#nativeClient,
                options?.operation,
                options?.date,
                options?.limit,
              ]);
            },
            prune: async (options = {}) => {
              validateOptionsObject(
                options,
                ["olderThan", "maxEntries"],
                "cache prune options",
              );
              validateOptionalU32(options.maxEntries, "cache prune maxEntries");
              return await invoke(this.#binding, "nativeCachePrune", [
                this.#nativeClient,
                parseTimestamp(options?.olderThan),
                options?.maxEntries,
              ]);
            },
            clear: () =>
              invoke(this.#binding, "nativeCacheClear", [this.#nativeClient]),
          }),
        },
      });
    }

    async query(request) {
      validateOptionsObject(
        request,
        ["operation", "date", "cache", "retries", "signal"],
        "query request",
      );
      validateRequiredString(request.operation, "operation");
      validateRequiredString(request.date, "date");
      validateRetryCount(request.retries);
      const cache = cacheArguments(request?.cache, this.#cacheMaxAgeHours);
      return await withCancellation(
        this.#binding,
        request?.signal,
        "nativeQuery",
        [
          this.#nativeClient,
          request?.operation,
          request?.date,
          ...cache,
          request?.retries,
        ],
      );
    }

    async range(request) {
      validateOptionsObject(
        request,
        [
          "operation",
          "from",
          "to",
          "adjusted",
          "securityCode",
          "cache",
          "retries",
          "signal",
        ],
        "range request",
      );
      validateRequiredString(request.operation, "operation");
      validateRequiredString(request.from, "from");
      validateRequiredString(request.to, "to");
      if (
        request.adjusted !== undefined &&
        typeof request.adjusted !== "boolean"
      ) {
        throw invalidArgument("adjusted must be a boolean");
      }
      validateOptionalString(request.securityCode, "securityCode");
      validateRetryCount(request.retries);
      const cache = cacheArguments(request?.cache, this.#cacheMaxAgeHours);
      return await withCancellation(
        this.#binding,
        request?.signal,
        "nativeRange",
        [
          this.#nativeClient,
          request?.operation,
          request?.from,
          request?.to,
          request?.adjusted === true,
          request?.securityCode,
          ...cache,
          request?.retries,
        ],
      );
    }

    async searchStocks(request) {
      validateOptionsObject(
        request,
        ["query", "cache", "signal"],
        "stock search request",
      );
      validateRequiredString(request.query, "query");
      const cache = cacheArguments(request?.cache, this.#cacheMaxAgeHours);
      return await withCancellation(
        this.#binding,
        request?.signal,
        "nativeSearchStocks",
        [this.#nativeClient, request?.query, ...cache],
      );
    }

    async marketSummary(request) {
      validateOptionsObject(
        request,
        ["date", "cache", "signal"],
        "market summary request",
      );
      validateRequiredString(request.date, "date");
      const cache = cacheArguments(request?.cache, this.#cacheMaxAgeHours);
      return await withCancellation(
        this.#binding,
        request?.signal,
        "nativeMarketSummary",
        [this.#nativeClient, request?.date, ...cache],
      );
    }

    async watchlistPrices(request) {
      validateOptionsObject(
        request,
        ["date", "securityCodes", "cache", "signal"],
        "watchlist prices request",
      );
      validateRequiredString(request.date, "date");
      if (
        !Array.isArray(request.securityCodes) ||
        request.securityCodes.some((value) => typeof value !== "string")
      ) {
        throw invalidArgument("securityCodes must be an array of strings");
      }
      const cache = cacheArguments(request?.cache, this.#cacheMaxAgeHours);
      return await withCancellation(
        this.#binding,
        request?.signal,
        "nativeWatchlistPrices",
        [this.#nativeClient, request?.date, request?.securityCodes, ...cache],
      );
    }

    capabilities() {
      try {
        const method = this.#binding.nativeCapabilities;
        if (typeof method !== "function") throw internalFailure();
        return deepFreeze(
          globalThis.structuredClone(
            outcomeValue(method.call(this.#binding, this.#nativeClient)),
          ),
        );
      } catch (error) {
        if (error instanceof KrxError) throw error;
        throw internalFailure();
      }
    }
  };
}

function createNativeClient(binding, apiKey) {
  try {
    if (typeof binding?.NativeClient !== "function") throw internalFailure();
    return new binding.NativeClient(apiKey);
  } catch (error) {
    if (error instanceof KrxError) throw error;
    throw internalFailure();
  }
}

async function invokeApprovalStatus(binding, nativeClient, category) {
  validateRequiredString(category, "approval category");
  return await invoke(binding, "nativeApprovalStatus", [
    nativeClient,
    category,
  ]);
}

async function invoke(binding, methodName, arguments_) {
  try {
    const method = binding?.[methodName];
    if (typeof method !== "function") throw internalFailure();
    return outcomeValue(await method.apply(binding, arguments_));
  } catch (error) {
    if (error instanceof KrxError) throw error;
    throw internalFailure();
  }
}

async function withCancellation(binding, signal, methodName, arguments_) {
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw invalidArgument("signal must be an AbortSignal");
  }
  let cancellation;
  try {
    cancellation = new binding.NativeCancellation();
  } catch {
    throw internalFailure();
  }
  const abort = () => cancellation.cancel();
  let listening = false;
  if (signal?.aborted) {
    abort();
  } else if (signal) {
    signal.addEventListener("abort", abort, { once: true });
    listening = true;
  }
  try {
    return await invoke(binding, methodName, [...arguments_, cancellation]);
  } finally {
    if (listening) signal.removeEventListener("abort", abort);
  }
}

function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function cacheArguments(policy, clientDefault) {
  if (policy === undefined) {
    return ["prefer", clientDefault];
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw invalidArgument("cache policy must be an object");
  }
  if (!Object.hasOwn(policy, "mode")) {
    throw invalidArgument("cache policy mode is required");
  }
  const mode = policy.mode;
  if (!new Set(["prefer", "refresh", "bypass", "offline"]).has(mode)) {
    throw invalidArgument("cache mode is invalid");
  }
  const allowed = mode === "prefer" ? ["mode", "maxAgeHours"] : ["mode"];
  if (Object.keys(policy).some((field) => !allowed.includes(field))) {
    throw invalidArgument("cache policy contains an unsupported field");
  }
  if (mode !== "prefer") return [mode, undefined];
  if (!Object.hasOwn(policy, "maxAgeHours")) {
    return [mode, clientDefault];
  }
  return [
    mode,
    validateRequiredCacheAge(policy.maxAgeHours, "cache maxAgeHours"),
  ];
}

function validateApiKeyType(value) {
  if (value !== undefined && typeof value !== "string") {
    throw invalidArgument("apiKey must be a string");
  }
}

function validateOptionsObject(value, allowedFields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument(`${label} must be an object`);
  }
  rejectUnknownFields(value, allowedFields, label);
}

function rejectUnknownFields(value, allowedFields, label) {
  if (Object.keys(value).some((field) => !allowedFields.includes(field))) {
    throw invalidArgument(`${label} contains an unsupported field`);
  }
}

function validateOptionalU32(value, label) {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
  ) {
    throw invalidArgument(`${label} must be a non-negative 32-bit integer`);
  }
}

function validateRetryCount(value) {
  if (value !== undefined && ![0, 1, 2, 3].includes(value)) {
    throw invalidArgument("retries must be an integer between zero and three");
  }
}

function validateRequiredString(value, label) {
  if (typeof value !== "string") {
    throw invalidArgument(`${label} must be a string`);
  }
}

function validateOptionalString(value, label) {
  if (value !== undefined) validateRequiredString(value, label);
}

function validateCacheAge(value, field) {
  if (value === undefined) return undefined;
  return validateRequiredCacheAge(value, field);
}

function validateRequiredCacheAge(value, field) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_CACHE_AGE_HOURS
  ) {
    throw invalidArgument(
      `${field} must be a finite non-negative number within the supported range`,
    );
  }
  return value;
}

function parseTimestamp(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidArgument("olderThan must be an ISO timestamp string");
  }
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
