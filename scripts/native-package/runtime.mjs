/* global AbortController */
import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
if (!packageRoot) {
  throw new Error("runtime.mjs requires an installed package directory");
}

const { KrxClient, KrxError } = await import(
  pathToFileURL(`${packageRoot}/dist/index.js`)
);
assert.equal(typeof KrxClient, "function");
assert.equal(typeof KrxError, "function");

const client = new KrxClient({ apiKey: "certification-fixture" });
for (const apiKey of [null, 42]) {
  assert.throws(
    () => new KrxClient({ apiKey }),
    (error) =>
      error instanceof KrxError &&
      error.kind === "invalid_request" &&
      error.code === "invalid_argument",
  );
}
await assert.rejects(
  client.query({
    operation: "stock_stk_bydd_trd",
    date: "20260821",
    cache: "offline",
  }),
  (error) =>
    error instanceof KrxError &&
    error.kind === "invalid_request" &&
    error.code === "invalid_argument",
  "plain JavaScript consumers must not bypass the closed CachePolicy union",
);
const capability = client.capabilities();
assert.ok(Array.isArray(capability));
assert.equal(capability.length, 31);
assert.equal(
  new Set(capability.map((operation) => operation.operationId)).size,
  capability.length,
  "native capabilities must contain every operation exactly once",
);

const previousEnvironmentKey = process.env.KRX_API_KEY;
process.env.KRX_API_KEY = "must-not-be-used";
try {
  const emptyExplicit = new KrxClient({ apiKey: "" });
  await assert.rejects(
    emptyExplicit.query({
      operation: "stock_stk_bydd_trd",
      date: "20260821",
    }),
    (error) =>
      error instanceof KrxError &&
      error.kind === "invalid_request" &&
      error.code === "invalid_argument",
    "an explicitly empty API key must fail instead of falling through",
  );
} finally {
  if (previousEnvironmentKey === undefined) delete process.env.KRX_API_KEY;
  else process.env.KRX_API_KEY = previousEnvironmentKey;
}

const secret = "consumer-fixture-\nsecret";
await assert.rejects(
  new KrxClient({ apiKey: secret }).query({
    operation: "stock_stk_bydd_trd",
    date: "20260821",
  }),
  (error) => {
    assert.ok(error instanceof KrxError);
    for (const value of [error.message, error.stack, ...Object.values(error)]) {
      assert.doesNotMatch(String(value), /consumer-fixture-/u);
    }
    return true;
  },
);

let eventLoopAdvanced = false;
const invalidDateRequest = client.query({
  operation: "stock_stk_bydd_trd",
  date: "2026-01-02",
});
invalidDateRequest.then(
  () => {
    eventLoopAdvanced = true;
  },
  () => {
    eventLoopAdvanced = true;
  },
);
await new Promise((resolve) => globalThis.queueMicrotask(resolve));
assert.equal(
  eventLoopAdvanced,
  false,
  "native calls must remain unsettled for at least one microtask",
);
await assert.rejects(
  invalidDateRequest,
  (error) =>
    error instanceof KrxError &&
    error.kind === "invalid_request" &&
    error.code === "invalid_date",
);

await assert.rejects(
  client.range({
    operation: "stock_stk_bydd_trd",
    from: "20260820",
    to: "20260821",
    adjusted: true,
  }),
  (error) =>
    error instanceof KrxError &&
    error.kind === "invalid_request" &&
    error.code === "conflicting_options",
);

await assert.rejects(
  client.range({
    operation: "index_kospi_dd_trd",
    from: "2026-08-20",
    to: "2026-08-21",
    securityCode: "005930",
  }),
  (error) =>
    error instanceof KrxError &&
    error.kind === "invalid_request" &&
    error.code === "invalid_argument",
  "the packed addon must reject securityCode for ineligible range operations",
);
await assert.rejects(
  client.range({
    operation: "stock_stk_bydd_trd",
    from: "2026-08-20",
    to: "2026-08-21",
    adjusted: false,
    securityCode: "005930",
  }),
  (error) =>
    error instanceof KrxError &&
    error.kind === "invalid_request" &&
    error.code === "invalid_date",
  "the packed addon must accept securityCode for eligible raw ranges",
);

await assert.rejects(
  client.cache.prune({ olderThan: "0", maxEntries: 0 }),
  (error) =>
    error instanceof KrxError &&
    error.kind === "invalid_request" &&
    error.code === "invalid_argument",
  "cache prune timestamps must be parsed as strict RFC 3339 instants",
);

const listenerController = new AbortController();
let added = 0;
let removed = 0;
const addListener = listenerController.signal.addEventListener.bind(
  listenerController.signal,
);
const removeListener = listenerController.signal.removeEventListener.bind(
  listenerController.signal,
);
listenerController.signal.addEventListener = (...args) => {
  added += 1;
  return addListener(...args);
};
listenerController.signal.removeEventListener = (...args) => {
  removed += 1;
  return removeListener(...args);
};
await assert.rejects(
  client.query({
    operation: "stock_stk_bydd_trd",
    date: "2026-01-02",
    signal: listenerController.signal,
  }),
  KrxError,
);
assert.equal(added, 1);
assert.equal(removed, 1);

const controller = new AbortController();
controller.abort();
await assert.rejects(
  client.query({
    operation: "stock_stk_bydd_trd",
    date: "20260821",
    cache: { mode: "bypass" },
    signal: controller.signal,
  }),
  (error) =>
    error instanceof KrxError &&
    error.kind === "cancelled" &&
    error.code === "request_cancelled",
);

process.stdout.write(`${JSON.stringify({ capability, status: "passed" })}\n`);
