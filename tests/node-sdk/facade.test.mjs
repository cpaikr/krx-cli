import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createKrxClientClass } from "../../packages/node/dist/client-factory.js";
import { binding, nativeTarget } from "../../packages/node/dist/binding.js";
import { KrxError } from "../../packages/node/dist/errors.js";

function ok(value) {
  return { ok: true, valueJson: JSON.stringify(value) };
}

function failure(kind, code) {
  return {
    ok: false,
    error: { kind, code, message: "fixture", retryable: false },
  };
}

function fixtureBinding(overrides = {}) {
  class NativeClient {
    constructor(apiKey) {
      this.apiKey = apiKey;
    }
  }
  class NativeCancellation {
    cancelled = false;
    cancel() {
      this.cancelled = true;
    }
  }
  const emptyComposite = {
    success: true,
    data: [],
    completeness: {
      state: "empty",
      requested: [],
      succeeded: [],
      failed: [],
      skipped: [],
    },
    provenance: {},
  };
  return {
    NativeClient,
    NativeCancellation,
    nativeQuery: async () =>
      ok({
        data: [],
        provenance: {
          source: "cache",
          fetchedAt: "2026-01-02T00:00:00Z",
          freshness: "stale",
          contractId: "fixture",
        },
      }),
    nativeRange: async () => ok({ ...emptyComposite, fetchedDays: 0 }),
    nativeSearchStocks: async () => ok(emptyComposite),
    nativeMarketSummary: async () =>
      ok({ ...emptyComposite, data: { date: "20260102" } }),
    nativeWatchlistPrices: async () =>
      ok({ ...emptyComposite, data: { date: "20260102", stocks: [] } }),
    nativeCapabilities: () =>
      ok([
        {
          operationId: "stock_stk_bydd_trd",
          requestFields: [{ name: "basDd", description: "date" }],
          responseFields: [],
        },
      ]),
    nativeCredentialStatus: async () =>
      ok({ source: "explicit", persisted: false }),
    nativeCredentialSet: async () => ok(null),
    nativeCredentialRemove: async () => ok(true),
    nativeCredentialMigrateLegacy: async () =>
      ok({
        migrated: true,
        legacySecretRemoved: true,
        approvalsMigrated: 1,
      }),
    nativeApprovalStatus: async () => ok(null),
    nativeCheckApproval: async () =>
      ok({ category: "stock", state: "approved" }),
    nativeCacheInspect: async () =>
      ok({ entries: [], totalEntries: 0, totalSizeBytes: 0, truncated: false }),
    nativeCachePrune: async () => ok({ removedEntries: 0, removedBytes: 0 }),
    nativeCacheClear: async () => ok({ removedEntries: 0, removedBytes: 0 }),
    ...overrides,
  };
}

test("projects the complete frozen facade without exposing watchlist administration", async () => {
  const binding = fixtureBinding();
  const KrxClient = createKrxClientClass(() => binding);
  const client = new KrxClient({ apiKey: "fixture", cacheMaxAgeHours: 12 });

  await client.query({ operation: "stock_stk_bydd_trd", date: "20260102" });
  await client.range({
    operation: "stock_stk_bydd_trd",
    from: "20260102",
    to: "20260103",
  });
  await client.searchStocks({ query: "삼성" });
  await client.marketSummary({ date: "20260102" });
  await client.watchlistPrices({
    date: "20260102",
    securityCodes: ["005930"],
  });
  await client.credentials.status();
  await client.credentials.set("replacement");
  await client.credentials.remove();
  await client.credentials.migrateLegacy();
  await client.credentials.approvalStatus("stock");
  await client.credentials.checkApproval("stock");
  await client.cache.inspect();
  await client.cache.prune({ olderThan: "2026-01-02T00:00:00.000Z" });
  await client.cache.clear();

  assert.equal(client.watchlist, undefined);
  assert.ok(Object.isFrozen(client.credentials));
  assert.ok(Object.isFrozen(client.cache));
});

test("constructs and reuses exactly one private native client", async () => {
  let constructions = 0;
  const observed = [];
  class NativeClient {
    constructor(apiKey) {
      constructions += 1;
      this.apiKey = apiKey;
    }
  }
  const nativeQuery = async (client) => {
    observed.push(client);
    return ok({ data: [], provenance: {} });
  };
  const nativeCacheInspect = async (client) => {
    observed.push(client);
    return ok({
      entries: [],
      totalEntries: 0,
      totalSizeBytes: 0,
      truncated: false,
    });
  };
  const fixture = fixtureBinding({
    NativeClient,
    nativeQuery,
    nativeCacheInspect,
  });
  const KrxClient = createKrxClientClass(() => fixture);
  const client = new KrxClient({ apiKey: "fixture" });

  await client.query({ operation: "stock_stk_bydd_trd", date: "20260102" });
  await client.cache.inspect();

  assert.equal(constructions, 1);
  assert.equal(observed.length, 2);
  assert.equal(observed[0], observed[1]);
  assert.equal(observed[0].apiKey, "fixture");
});

test("forwards the frozen adjusted-range argument shape", async () => {
  let arguments_;
  const fixture = fixtureBinding({
    nativeRange: async (...received) => {
      arguments_ = received;
      return ok({ success: true, data: [], fetchedDays: 0 });
    },
  });
  const KrxClient = createKrxClientClass(() => fixture);
  const client = new KrxClient({ cacheMaxAgeHours: 8 });

  await client.range({
    operation: "stock_stk_bydd_trd",
    from: "20260102",
    to: "20260103",
    adjusted: true,
    securityCode: "005930",
    cache: { mode: "prefer", maxAgeHours: 3 },
    retries: 2,
  });

  assert.equal(arguments_[0] instanceof fixture.NativeClient, true);
  assert.deepEqual(arguments_.slice(1, -1), [
    "stock_stk_bydd_trd",
    "20260102",
    "20260103",
    true,
    "005930",
    "prefer",
    3,
    2,
  ]);
  assert.equal(arguments_.at(-1) instanceof fixture.NativeCancellation, true);
});

test("removes AbortSignal listeners after resolve and reject", async () => {
  for (const outcome of [
    ok({ data: [], provenance: {} }),
    failure("cancelled", "request_cancelled"),
  ]) {
    const binding = fixtureBinding({ nativeQuery: async () => outcome });
    const KrxClient = createKrxClientClass(() => binding);
    const controller = new globalThis.AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    controller.signal.addEventListener = (...args) => {
      added += 1;
      return add(...args);
    };
    controller.signal.removeEventListener = (...args) => {
      removed += 1;
      return remove(...args);
    };
    const pending = new KrxClient().query({
      operation: "stock_stk_bydd_trd",
      date: "20260102",
      signal: controller.signal,
    });
    if (outcome.ok) await pending;
    else await assert.rejects(pending, KrxError);
    assert.equal(added, 1);
    assert.equal(removed, 1);
  }
});

test("propagates abort to the native cancellation token", async () => {
  let observed;
  const binding = fixtureBinding({
    nativeQuery: async (...args) => {
      const cancellation = args.at(-1);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      observed = cancellation.cancelled;
      return failure("cancelled", "request_cancelled");
    },
  });
  const KrxClient = createKrxClientClass(() => binding);
  const controller = new globalThis.AbortController();
  const pending = new KrxClient().query({
    operation: "stock_stk_bydd_trd",
    date: "20260102",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof KrxError);
    assert.equal(error.code, "request_cancelled");
    return true;
  });
  assert.equal(observed, true);
});

test("cancels a pre-aborted signal without attaching a listener", async () => {
  let observed;
  const binding = fixtureBinding({
    nativeQuery: async (...args) => {
      observed = args.at(-1).cancelled;
      return failure("cancelled", "request_cancelled");
    },
  });
  const KrxClient = createKrxClientClass(() => binding);
  const controller = new globalThis.AbortController();
  controller.abort();
  let added = 0;
  let removed = 0;
  controller.signal.addEventListener = () => {
    added += 1;
  };
  controller.signal.removeEventListener = () => {
    removed += 1;
  };

  await assert.rejects(
    new KrxClient().query({
      operation: "stock_stk_bydd_trd",
      date: "20260102",
      signal: controller.signal,
    }),
    (error) => error instanceof KrxError && error.code === "request_cancelled",
  );
  assert.equal(observed, true);
  assert.equal(added, 0);
  assert.equal(removed, 0);
});

test("returns fresh deeply immutable capability copies", () => {
  const KrxClient = createKrxClientClass(() => fixtureBinding());
  const client = new KrxClient();
  const first = client.capabilities();
  const second = client.capabilities();
  assert.notEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first[0]));
  assert.ok(Object.isFrozen(first[0].requestFields));
  assert.ok(Object.isFrozen(first[0].requestFields[0]));
});

test("rejects unsafe cache ages and malformed native outcomes with stable errors", async () => {
  const KrxClient = createKrxClientClass(() => fixtureBinding());
  assert.throws(
    () => new KrxClient({ cacheMaxAgeHours: Number.NaN }),
    (error) => error instanceof KrxError && error.code === "invalid_argument",
  );

  const malformed = createKrxClientClass(() =>
    fixtureBinding({ nativeQuery: async () => ({ ok: true, valueJson: "{" }) }),
  );
  await assert.rejects(
    new malformed().query({
      operation: "stock_stk_bydd_trd",
      date: "20260102",
    }),
    (error) => error instanceof KrxError && error.code === "internal_failure",
  );
  await assert.rejects(
    new KrxClient().query({
      operation: "stock_stk_bydd_trd",
      date: "20260102",
      cache: { mode: "prefer", maxAgeHours: Number.POSITIVE_INFINITY },
    }),
    (error) => error instanceof KrxError && error.code === "invalid_argument",
  );
  await assert.rejects(
    new KrxClient().cache.prune({ olderThan: 0 }),
    (error) => error instanceof KrxError && error.code === "invalid_argument",
  );
});

test("rejects malformed plain-JavaScript options without changing policy", async () => {
  const KrxClient = createKrxClientClass(() => fixtureBinding());
  for (const apiKey of [null, 42, {}, []]) {
    assert.throws(
      () => new KrxClient({ apiKey }),
      (error) => error instanceof KrxError && error.code === "invalid_argument",
    );
  }
  for (const apiKey of [undefined, null, 42, {}, []]) {
    await assert.rejects(
      new KrxClient().credentials.set(apiKey),
      (error) => error instanceof KrxError && error.code === "invalid_argument",
    );
  }
  for (const cache of [
    "offline",
    null,
    [],
    {},
    { mode: "prefer", maxAgeHours: undefined },
    { mode: "prefer", maxAgeHours: null },
    { mode: "prefer", maxAgeHours: "1" },
    { mode: "offline", maxAgeHours: 1 },
  ]) {
    await assert.rejects(
      new KrxClient().query({
        operation: "stock_stk_bydd_trd",
        date: "20260102",
        cache,
      }),
      (error) => error instanceof KrxError && error.code === "invalid_argument",
    );
  }
  await assert.rejects(
    new KrxClient().query({
      operation: "stock_stk_bydd_trd",
      date: "20260102",
      retries: -1,
    }),
    (error) => error instanceof KrxError && error.code === "invalid_argument",
  );
});

test("inherits the client cache age only when prefer maxAgeHours is absent", async () => {
  let arguments_;
  const fixture = fixtureBinding({
    nativeQuery: async (...received) => {
      arguments_ = received;
      return ok({ data: [], provenance: {} });
    },
  });
  const KrxClient = createKrxClientClass(() => fixture);

  await new KrxClient({ cacheMaxAgeHours: 7 }).query({
    operation: "stock_stk_bydd_trd",
    date: "20260102",
    cache: { mode: "prefer" },
  });

  assert.equal(arguments_[4], 7);
});

test("keeps the event loop responsive and contains sync and async binding failures", async () => {
  let timerAdvanced = false;
  const responsive = createKrxClientClass(() =>
    fixtureBinding({
      nativeQuery: async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
        return ok({ data: [], provenance: {} });
      },
    }),
  );
  const pending = new responsive().query({
    operation: "stock_stk_bydd_trd",
    date: "20260102",
  });
  globalThis.setTimeout(() => {
    timerAdvanced = true;
  }, 0);
  await pending;
  assert.equal(timerAdvanced, true);

  const secret = "consumer-secret-dependency-detail";
  for (const nativeQuery of [
    () => {
      throw new Error(secret);
    },
    async () => {
      throw new Error(secret);
    },
  ]) {
    const PanickingClient = createKrxClientClass(() =>
      fixtureBinding({ nativeQuery }),
    );
    await assert.rejects(
      new PanickingClient().query({
        operation: "stock_stk_bydd_trd",
        date: "20260102",
      }),
      (error) => {
        assert.ok(error instanceof KrxError);
        assert.equal(error.code, "internal_failure");
        for (const value of [
          error.message,
          error.stack,
          ...Object.values(error),
        ]) {
          assert.doesNotMatch(String(value), /consumer-secret/u);
        }
        return true;
      },
    );
  }
});

test("classifies unsupported native targets without exposing binding paths", () => {
  assert.equal(nativeTarget("linux", "x64", { header: {} }), null);
  assert.equal(nativeTarget("freebsd", "x64", { header: {} }), null);
  assert.throws(
    () => binding(null),
    (error) =>
      error instanceof KrxError &&
      error.kind === "local_state" &&
      error.code === "unsupported_platform",
  );
});

test("package template keeps the native binding private and ESM-only", async () => {
  const packageJson = JSON.parse(
    await readFile(
      new globalThis.URL("../../packages/node/package.json", import.meta.url),
    ),
  );
  assert.equal(packageJson.type, "module");
  assert.deepEqual(Object.keys(packageJson.exports), [".", "./package.json"]);
  assert.equal(packageJson.exports["."].require, undefined);
  assert.equal(packageJson.scripts, undefined);
  assert.equal(packageJson.dependencies, undefined);
});
