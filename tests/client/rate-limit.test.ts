import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import {
  RequestCancelledError,
  RequestTimeoutError,
} from "../../src/client/retry.js";
import {
  credentialFingerprint,
  getRateLimitStatus,
  kstDate,
  reserveCall,
} from "../../src/client/rate-limit.js";

describe("persistent advisory rate limit", () => {
  let directory: string;
  let filePath: string;
  const now = () => new Date("2026-03-12T15:30:00.000Z");

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "krx-rate-test-"));
    filePath = path.join(directory, "rate-limit.json");
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("uses the KST calendar date", () => {
    expect(kstDate(now())).toBe("20260313");
  });

  it("atomically reserves exactly once under concurrent calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, () => reserveCall("key-a", { filePath, now })),
    );
    expect(results.every((result) => result.reserved)).toBe(true);
    expect(getRateLimitStatus("key-a", { filePath, now }).count).toBe(40);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toBeTruthy();
  });

  it("isolates counters by non-reversible credential identity", async () => {
    await reserveCall("key-a", { filePath, now });
    await reserveCall("key-a", { filePath, now });
    await reserveCall("key-b", { filePath, now });
    expect(getRateLimitStatus("key-a", { filePath, now }).count).toBe(2);
    expect(getRateLimitStatus("key-b", { filePath, now }).count).toBe(1);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).not.toContain("key-a");
    expect(raw).not.toContain("key-b");
  });

  it("conservatively migrates a legacy counter to the current credential", async () => {
    fs.writeFileSync(filePath, JSON.stringify({ date: "20260313", count: 9 }));
    const result = await reserveCall("current-key", { filePath, now });
    expect(result.count).toBe(10);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(
      persisted.credentials[credentialFingerprint("current-key")].count,
    ).toBe(10);
  });

  it("fails closed on corrupt state instead of silently undercounting", async () => {
    fs.writeFileSync(filePath, "{not-json");
    await expect(reserveCall("key-a", { filePath, now })).rejects.toThrow(
      "Cannot safely read local quota state",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe("{not-json");
  });

  it.each([
    {
      label: "impossible date",
      state: {
        version: 1,
        credentials: {
          [credentialFingerprint("existing")]: {
            date: "20260230",
            count: 1,
          },
        },
      },
    },
    {
      label: "over-limit count",
      state: {
        version: 1,
        credentials: {
          [credentialFingerprint("existing")]: {
            date: "20260313",
            count: 10_001,
          },
        },
      },
    },
    {
      label: "non-fingerprint key",
      state: {
        version: 1,
        credentials: { arbitrary: { date: "20260313", count: 1 } },
      },
    },
    {
      label: "extra entry field",
      state: {
        version: 1,
        credentials: {
          [credentialFingerprint("existing")]: {
            date: "20260313",
            count: 1,
            extra: true,
          },
        },
      },
    },
    {
      label: "extra root field",
      state: { version: 1, credentials: {}, extra: true },
    },
  ])("preserves exact bytes for $label quota state", async ({ state }) => {
    const original = `${JSON.stringify(state)}\n`;
    fs.writeFileSync(filePath, original);
    await expect(reserveCall("key-a", { filePath, now })).rejects.toThrow(
      "Cannot safely read local quota state",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  it("does not admit another attempt once the daily limit is reserved", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        credentials: {
          [credentialFingerprint("key-a")]: {
            date: "20260313",
            count: 9999,
          },
        },
      }),
    );
    const last = await reserveCall("key-a", { filePath, now });
    const blocked = await reserveCall("key-a", { filePath, now });
    expect(last.reserved).toBe(true);
    expect(last.count).toBe(10000);
    expect(blocked.reserved).toBe(false);
    expect(blocked.count).toBe(10000);
  });

  it("preserves exact bytes when credential capacity is exhausted", async () => {
    const fingerprint = credentialFingerprint("new-credential");
    const credentials = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => {
        const existing = index.toString(16).padStart(64, "0");
        expect(existing).not.toBe(fingerprint);
        return [existing, { date: "20260313", count: 1 }];
      }),
    );
    const original = `${JSON.stringify({ version: 1, credentials })}\n`;
    fs.writeFileSync(filePath, original);

    await expect(
      reserveCall("new-credential", { filePath, now }),
    ).rejects.toThrow("Cannot safely reserve another credential quota entry");
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  it("prunes obsolete-day credential entries on the next write", async () => {
    const oldFingerprint = credentialFingerprint("old-key");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        credentials: {
          [oldFingerprint]: { date: "20260312", count: 50 },
        },
      }),
    );
    await reserveCall("key-a", { filePath, now });
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(persisted.credentials[oldFingerprint]).toBeUndefined();
  });

  it("preserves timeout versus caller cancellation while waiting for a lock", async () => {
    fs.mkdirSync(`${filePath}.lock`, { mode: 0o700 });
    fs.writeFileSync(
      path.join(`${filePath}.lock`, "owner"),
      `${process.pid}-00000000-0000-4000-8000-000000000000`,
      { mode: 0o600 },
    );

    const deadline = new AbortController();
    const timedOut = reserveCall("key-a", {
      filePath,
      signal: deadline.signal,
    });
    deadline.abort(new RequestTimeoutError());
    await expect(timedOut).rejects.toBeInstanceOf(RequestTimeoutError);

    const caller = new AbortController();
    const cancelled = reserveCall("key-a", {
      filePath,
      signal: caller.signal,
    });
    caller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked lock owner without reading or stealing it",
    async () => {
      const lockPath = `${filePath}.lock`;
      const ownerTarget = path.join(directory, "owner-target");
      const deadOwner = "2147483647-00000000-0000-4000-8000-000000000000";
      fs.writeFileSync(ownerTarget, deadOwner, { mode: 0o600 });
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.symlinkSync(ownerTarget, path.join(lockPath, "owner"));
      const stale = new Date(Date.now() - 31_000);
      fs.utimesSync(lockPath, stale, stale);

      await expect(reserveCall("key-a", { filePath, now })).rejects.toThrow(
        "Local quota owner is unsafe",
      );
      expect(fs.lstatSync(path.join(lockPath, "owner")).isSymbolicLink()).toBe(
        true,
      );
      expect(fs.existsSync(filePath)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a non-owner-only lock directory fail-closed",
    async () => {
      const lockPath = `${filePath}.lock`;
      const deadOwner = "2147483647-00000000-0000-4000-8000-000000000000";
      fs.mkdirSync(lockPath, { mode: 0o755 });
      fs.writeFileSync(path.join(lockPath, "owner"), deadOwner, {
        mode: 0o600,
      });
      const stale = new Date(Date.now() - 31_000);
      fs.utimesSync(lockPath, stale, stale);

      await expect(reserveCall("key-a", { filePath, now })).rejects.toThrow(
        "Local quota lock directory is unsafe",
      );
      expect(fs.statSync(lockPath).mode & 0o777).toBe(0o755);
      expect(fs.existsSync(filePath)).toBe(false);
    },
  );

  it("bounds lock-owner reads before inspecting their contents", async () => {
    const lockPath = `${filePath}.lock`;
    const oversizedOwner = Buffer.alloc(129, "x");
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, "owner"), oversizedOwner, {
      mode: 0o600,
    });
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(lockPath, stale, stale);

    await expect(reserveCall("key-a", { filePath, now })).rejects.toThrow(
      "Local quota owner is unsafe",
    );
    expect(fs.readFileSync(path.join(lockPath, "owner"))).toEqual(
      oversizedOwner,
    );
  });

  it("recovers a dead published steal claim as the stale-directory fence", async () => {
    const lockPath = `${filePath}.lock`;
    const deadOwner = "2147483647-00000000-0000-4000-8000-000000000000";
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, "owner"), deadOwner, { mode: 0o600 });
    fs.writeFileSync(path.join(lockPath, "steal"), deadOwner, { mode: 0o600 });
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(lockPath, stale, stale);

    const reservation = await reserveCall("key-a", { filePath, now });
    expect(reservation.reserved).toBe(true);
    expect(reservation.count).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
    const tombstone = `${lockPath}.stale-${deadOwner}`;
    expect(fs.readFileSync(path.join(tombstone, "owner"), "utf8")).toBe(
      deadOwner,
    );
    expect(fs.readFileSync(path.join(tombstone, "steal"), "utf8")).toBe(
      deadOwner,
    );
  });

  it("leaves a live published steal claimant fail-closed", async () => {
    const lockPath = `${filePath}.lock`;
    const deadOwner = "2147483647-00000000-0000-4000-8000-000000000000";
    const liveClaim = `${process.pid}-00000000-0000-4000-8000-000000000000`;
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, "owner"), deadOwner, { mode: 0o600 });
    fs.writeFileSync(path.join(lockPath, "steal"), liveClaim, { mode: 0o600 });
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(lockPath, stale, stale);

    await expect(
      reserveCall("key-a", { filePath, now, lockTimeoutMs: 30 }),
    ).rejects.toThrow("Timed out waiting for the local quota lock");
    expect(fs.readFileSync(path.join(lockPath, "steal"), "utf8")).toBe(
      liveClaim,
    );
  });

  it("bounds published steal claims before reading their contents", async () => {
    const lockPath = `${filePath}.lock`;
    const deadOwner = "2147483647-00000000-0000-4000-8000-000000000000";
    const oversizedClaim = Buffer.alloc(129, "x");
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, "owner"), deadOwner, { mode: 0o600 });
    fs.writeFileSync(path.join(lockPath, "steal"), oversizedClaim, {
      mode: 0o600,
    });
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(lockPath, stale, stale);

    await expect(
      reserveCall("key-a", { filePath, now, lockTimeoutMs: 30 }),
    ).rejects.toThrow("Local quota steal claim is unsafe");
    expect(fs.readFileSync(path.join(lockPath, "steal"))).toEqual(
      oversizedClaim,
    );
  });

  it("fails closed instead of recursively deleting unexpected lock contents", async () => {
    const lockPath = `${filePath}.lock`;
    const deadOwner = "2147483647-00000000-0000-4000-8000-000000000000";
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, "owner"), deadOwner, { mode: 0o600 });
    fs.writeFileSync(path.join(lockPath, "unexpected"), "preserve-me", {
      mode: 0o600,
    });
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(lockPath, stale, stale);

    await expect(reserveCall("key-a", { filePath, now })).rejects.toThrow(
      "Retained stale local quota lock contains unexpected entries",
    );
    const staleLocks = fs
      .readdirSync(directory)
      .filter((entry) => entry.startsWith("rate-limit.json.lock.stale-"));
    expect(staleLocks).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(directory, staleLocks[0]!, "unexpected"),
        "utf8",
      ),
    ).toBe("preserve-me");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("serializes reservations across independent Node processes", async () => {
    const workerPath = path.join(directory, "quota-worker.mjs");
    const modulePath = path.resolve("src/client/rate-limit.ts");
    buildSync({
      stdin: {
        contents: `
          import { reserveCall } from ${JSON.stringify(modulePath)};
          const [filePath, apiKey, calls] = process.argv.slice(2);
          let reserved = 0;
          for (let i = 0; i < Number(calls); i += 1) {
            const result = await reserveCall(apiKey, {
              filePath,
              now: () => new Date("2026-03-12T15:30:00.000Z"),
            });
            if (result.reserved) reserved += 1;
          }
          process.stdout.write(String(reserved));
        `,
        resolveDir: process.cwd(),
        sourcefile: "quota-worker.ts",
        loader: "ts",
      },
      outfile: workerPath,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });

    const runWorker = (calls: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [workerPath, filePath, "shared-key", String(calls)],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(Number(stdout));
          else reject(new Error(`quota worker exited ${code}: ${stderr}`));
        });
      });

    const perWorker = 15;
    const totals = await Promise.all(
      Array.from({ length: 4 }, () => runWorker(perWorker)),
    );
    expect(totals.reduce((sum, count) => sum + count, 0)).toBe(60);
    expect(getRateLimitStatus("shared-key", { filePath, now }).count).toBe(60);
    expect(() => JSON.parse(fs.readFileSync(filePath, "utf8"))).not.toThrow();

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        credentials: {
          [credentialFingerprint("shared-key")]: {
            date: "20260313",
            count: 9_990,
          },
        },
      }),
    );
    const nearLimit = await Promise.all(
      Array.from({ length: 4 }, () => runWorker(5)),
    );
    expect(nearLimit.reduce((sum, count) => sum + count, 0)).toBe(10);
    expect(getRateLimitStatus("shared-key", { filePath, now }).count).toBe(
      10_000,
    );
  });
});
