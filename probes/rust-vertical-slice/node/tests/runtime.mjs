/* global AbortController */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import process from "node:process";
import { setImmediate, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
if (!packageRoot)
  throw new Error("runtime.mjs requires an assembled package directory");
const sdk = await import(pathToFileURL(`${packageRoot}/dist/index.js`));
const probes = await import(pathToFileURL(`${packageRoot}/dist/probe.js`));
const { KrxClient, KrxError } = sdk;
assert.equal(typeof KrxClient, "function");
assert.equal(typeof KrxError, "function");

async function projectError(action, kind, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof KrxError);
    assert.equal(error.kind, kind);
    assert.equal(error.code, code);
    return true;
  });
}

await projectError(
  () =>
    new KrxClient({ apiKey: "fixture" }).query({
      operation: "stock_stk_bydd_trd",
      date: "2026-01-02",
    }),
  "invalid_request",
  "invalid_date",
);

process.env.KRX_API_KEY = "environment-secret-must-not-win";
await projectError(
  () =>
    new KrxClient({ apiKey: "" }).query({
      operation: "stock_stk_bydd_trd",
      date: "20260102",
    }),
  "invalid_request",
  "invalid_argument",
);
delete process.env.KRX_API_KEY;

const wire = probes.probeWireContract();
const row = Object.fromEntries(
  wire.representativeFields.map((field) => [field, `value-${field}`]),
);
let responseDelay = 0;
const server = createServer(async (request, response) => {
  assert.equal(request.method, wire.method);
  assert.equal(request.url, wire.path);
  assert.equal(
    request.headers[wire.authHeader.toLowerCase()],
    "consumer-fixture-secret",
  );
  for await (const _ of request) void _;
  await new Promise((resolve) => setTimeout(resolve, responseDelay));
  const body = JSON.stringify({ [wire.successEnvelope]: [row] });
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
process.env.KRX_PROBE_BASE_URL = `http://127.0.0.1:${address.port}/`;

const client = new KrxClient({ apiKey: "consumer-fixture-secret" });
const resolvedController = new AbortController();
let added = 0;
let removed = 0;
const originalAdd = resolvedController.signal.addEventListener.bind(
  resolvedController.signal,
);
const originalRemove = resolvedController.signal.removeEventListener.bind(
  resolvedController.signal,
);
resolvedController.signal.addEventListener = (...args) => {
  added += 1;
  return originalAdd(...args);
};
resolvedController.signal.removeEventListener = (...args) => {
  removed += 1;
  return originalRemove(...args);
};
const result = await client.query({
  operation: "stock_stk_bydd_trd",
  date: "20260821",
  cache: { mode: "bypass" },
  signal: resolvedController.signal,
});
assert.equal(
  result.data[0][wire.representativeFields[0]],
  `value-${wire.representativeFields[0]}`,
);
const fetchedAt = Date.parse(result.provenance.fetchedAt);
assert.ok(Number.isFinite(fetchedAt));
assert.ok(Math.abs(Date.now() - fetchedAt) < 60_000);
assert.equal(added, 1);
assert.equal(removed, 1);

const rejectedController = new AbortController();
let rejectedAdded = 0;
let rejectedRemoved = 0;
const rejectedAdd = rejectedController.signal.addEventListener.bind(
  rejectedController.signal,
);
const rejectedRemove = rejectedController.signal.removeEventListener.bind(
  rejectedController.signal,
);
rejectedController.signal.addEventListener = (...args) => {
  rejectedAdded += 1;
  return rejectedAdd(...args);
};
rejectedController.signal.removeEventListener = (...args) => {
  rejectedRemoved += 1;
  return rejectedRemove(...args);
};
await projectError(
  () =>
    client.query({
      operation: "stock_stk_bydd_trd",
      date: "bad",
      signal: rejectedController.signal,
    }),
  "invalid_request",
  "invalid_date",
);
assert.equal(rejectedAdded, 1);
assert.equal(rejectedRemoved, 1);

responseDelay = 500;
const controller = new AbortController();
let eventLoopAdvanced = false;
setImmediate(() => {
  eventLoopAdvanced = true;
});
const pending = client.query({
  operation: "stock_stk_bydd_trd",
  date: "20260821",
  signal: controller.signal,
});
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(eventLoopAdvanced, true);
controller.abort();
await projectError(() => pending, "cancelled", "request_cancelled");

await projectError(
  () =>
    client.range({
      operation: "stock_stk_bydd_trd",
      from: "20260102",
      to: "20260130",
      adjusted: true,
    }),
  "invalid_request",
  "conflicting_options",
);
assert.throws(
  () => probes.probeSyncPanic(),
  (error) =>
    error instanceof KrxError &&
    error.kind === "internal" &&
    error.code === "internal_failure",
);
await projectError(
  () => probes.probeAsyncPanic(),
  "internal",
  "internal_failure",
);
assert.throws(
  () => probes.probeUnsupportedTarget(),
  (error) =>
    error instanceof KrxError &&
    error.kind === "local_state" &&
    error.code === "unsupported_platform",
);

try {
  await new KrxClient({ apiKey: "consumer-fixture-secret" }).query({
    operation: "unknown",
    date: "20260821",
  });
  assert.fail("unknown operation should fail");
} catch (error) {
  const rendered = [
    error.message,
    error.stack,
    error.providerCode,
    error.operationId,
    error.cause,
    error.details,
    error.rawBody,
    error.dependencyMessage,
  ].join("\n");
  assert.ok(!rendered.includes("consumer-fixture-secret"));
}

await new Promise((resolve) => server.close(resolve));
delete process.env.KRX_PROBE_BASE_URL;
process.stdout.write(
  `${JSON.stringify({ capability: wire, status: "passed" })}\n`,
);
