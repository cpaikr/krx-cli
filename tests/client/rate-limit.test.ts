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

  it("prunes obsolete-day credential entries on the next write", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        credentials: { old: { date: "20260312", count: 50 } },
      }),
    );
    await reserveCall("key-a", { filePath, now });
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(persisted.credentials.old).toBeUndefined();
  });

  it("preserves timeout versus caller cancellation while waiting for a lock", async () => {
    fs.mkdirSync(`${filePath}.lock`);
    fs.writeFileSync(
      path.join(`${filePath}.lock`, "owner"),
      `${process.pid}-active`,
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
