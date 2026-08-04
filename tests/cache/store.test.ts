import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock the cache directory
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => path.join(os.tmpdir(), "krx-cli-test-home"),
  };
});

// Mock date to control "today"
vi.mock("../../src/utils/date.js", () => ({
  formatDateToYYYYMMDD: () => "20260312",
}));

import {
  CACHE_FORMAT_VERSION,
  DEFAULT_CACHE_MAX_AGE_HOURS,
  getCached,
  setCached,
  clearCache,
  getCacheStatus,
} from "../../src/cache/store.js";

const TEST_HOME = path.join(os.tmpdir(), "krx-cli-test-home");
const TEST_CACHE = path.join(TEST_HOME, ".krx-cli", "cache");

function cacheFiles(date = "20260310"): string[] {
  const directory = path.join(TEST_CACHE, date);
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).map((file) => path.join(directory, file))
    : [];
}

function cacheEntryPath(date = "20260310"): string {
  const entry = cacheFiles(date).find((file) => file.endsWith(".json"));
  if (!entry) throw new Error(`No cache entry found for ${date}`);
  return entry;
}

describe("cache store", () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe("getCached", () => {
    it("returns null when no cache exists", () => {
      const result = getCached("/svc/apis/sto/stk_bydd_trd", {
        basDd: "20260310",
      });
      expect(result).toBeNull();
    });

    it("returns null for today's date (no cache)", () => {
      // Today is mocked as 20260312
      const result = getCached("/svc/apis/sto/stk_bydd_trd", {
        basDd: "20260312",
      });
      expect(result).toBeNull();
    });

    it("returns cached data for past dates", () => {
      const data = [{ ISU_NM: "삼성전자", TDD_CLSPRC: "75000" }];
      setCached("/svc/apis/sto/stk_bydd_trd", { basDd: "20260310" }, data);

      const result = getCached("/svc/apis/sto/stk_bydd_trd", {
        basDd: "20260310",
      });
      expect(result).toEqual(data);
    });

    it("ignores stale historical data after the default seven-day window", () => {
      const endpoint = "/svc/apis/sto/stk_bydd_trd";
      const params = { basDd: "20260310" };
      setCached(endpoint, params, [{ value: "old" }], {
        now: new Date("2026-03-13T00:00:00.000Z"),
      });

      expect(DEFAULT_CACHE_MAX_AGE_HOURS).toBe(168);
      expect(
        getCached(endpoint, params, {
          now: new Date("2026-03-20T00:00:00.000Z"),
        }),
      ).toBeNull();
    });

    it("honors an explicit freshness window", () => {
      const endpoint = "/svc/apis/sto/stk_bydd_trd";
      const params = { basDd: "20260310" };
      setCached(endpoint, params, [{ value: "fresh" }], {
        now: new Date("2026-03-13T00:00:00.000Z"),
      });

      expect(
        getCached(endpoint, params, {
          now: new Date("2026-03-13T02:00:00.000Z"),
          maxAgeMs: 3 * 60 * 60 * 1_000,
        }),
      ).toEqual([{ value: "fresh" }]);
      expect(
        getCached(endpoint, params, {
          now: new Date("2026-03-13T04:00:00.000Z"),
          maxAgeMs: 3 * 60 * 60 * 1_000,
        }),
      ).toBeNull();
    });

    it("honors the configured historical freshness window", () => {
      vi.stubEnv("KRX_CACHE_MAX_AGE_HOURS", "1");
      const endpoint = "/svc/apis/sto/stk_bydd_trd";
      const params = { basDd: "20260310" };
      setCached(endpoint, params, [{ value: "configured" }], {
        now: new Date("2026-03-13T00:00:00.000Z"),
      });

      expect(
        getCached(endpoint, params, {
          now: new Date("2026-03-13T02:00:00.000Z"),
        }),
      ).toBeNull();
    });

    it("quarantines legacy and incompatible cache formats", () => {
      const endpoint = "/svc/apis/sto/stk_bydd_trd";
      const params = { basDd: "20260310" };
      const diagnostic = vi
        .spyOn(process.stderr, "write")
        .mockReturnValue(true);
      setCached(endpoint, params, [{ value: "current" }]);
      fs.writeFileSync(cacheEntryPath(), "[]\n", "utf8");

      expect(getCached(endpoint, params)).toBeNull();
      expect(cacheFiles().some((file) => file.includes(".corrupt-"))).toBe(
        true,
      );
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining("unsupported cache format"),
      );

      setCached(endpoint, params, [{ value: "current" }]);
      const entry = JSON.parse(
        fs.readFileSync(cacheEntryPath(), "utf8"),
      ) as Record<string, unknown>;
      fs.writeFileSync(
        cacheEntryPath(),
        JSON.stringify({ ...entry, version: 999 }),
        "utf8",
      );

      expect(getCached(endpoint, params)).toBeNull();
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining("unsupported cache version 999"),
      );
    });

    it("quarantines corrupt JSON with an actionable path", () => {
      const endpoint = "/svc/apis/sto/stk_bydd_trd";
      const params = { basDd: "20260310" };
      const diagnostic = vi
        .spyOn(process.stderr, "write")
        .mockReturnValue(true);
      setCached(endpoint, params, [{ value: "current" }]);
      const entryPath = cacheEntryPath();
      fs.writeFileSync(entryPath, "{partial", "utf8");

      expect(getCached(endpoint, params)).toBeNull();
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringMatching(/ignored invalid cache entry .* quarantined at/),
      );
      expect(fs.existsSync(entryPath)).toBe(false);
    });

    it("returns null when params don't match", () => {
      const data = [{ ISU_NM: "삼성전자" }];
      setCached("/svc/apis/sto/stk_bydd_trd", { basDd: "20260310" }, data);

      const result = getCached("/svc/apis/sto/stk_bydd_trd", {
        basDd: "20260309",
      });
      expect(result).toBeNull();
    });

    it("rejects invalid date format (path traversal prevention)", () => {
      const result = getCached("/svc/apis/sto/stk_bydd_trd", {
        basDd: "../../../etc",
      });
      expect(result).toBeNull();
    });
  });

  describe("setCached", () => {
    it("does not cache today's data", () => {
      const data = [{ ISU_NM: "test" }];
      setCached("/svc/apis/sto/stk_bydd_trd", { basDd: "20260312" }, data);

      const result = getCached("/svc/apis/sto/stk_bydd_trd", {
        basDd: "20260312",
      });
      expect(result).toBeNull();
    });

    it("does not cache when no basDd param", () => {
      const data = [{ ISU_NM: "test" }];
      setCached("/svc/apis/sto/stk_isu_base_info", {}, data);

      const result = getCached("/svc/apis/sto/stk_isu_base_info", {});
      expect(result).toBeNull();
    });

    it("rejects invalid date format for setCached", () => {
      const data = [{ ISU_NM: "test" }];
      setCached("/svc/apis/sto/stk_bydd_trd", { basDd: "../../hack" }, data);

      const datePath = path.join(TEST_CACHE, "../../hack");
      expect(fs.existsSync(datePath)).toBe(false);
    });

    it("creates cache directory structure", () => {
      const data = [{ ISU_NM: "test" }];
      setCached("/svc/apis/sto/stk_bydd_trd", { basDd: "20260310" }, data);

      const datePath = path.join(TEST_CACHE, "20260310");
      expect(fs.existsSync(datePath)).toBe(true);
    });

    it("records version, fetch time, endpoint, parameters, and data", () => {
      const now = new Date("2026-03-13T01:02:03.000Z");
      const endpoint = "/svc/apis/sto/stk_bydd_trd";
      const params = { isuCd: "005930", basDd: "20260310" };
      setCached(endpoint, params, [{ value: "1" }], { now });

      expect(JSON.parse(fs.readFileSync(cacheEntryPath(), "utf8"))).toEqual({
        version: CACHE_FORMAT_VERSION,
        fetchedAt: now.toISOString(),
        endpoint,
        params: [
          ["basDd", "20260310"],
          ["isuCd", "005930"],
        ],
        data: [{ value: "1" }],
      });
    });

    it("leaves the prior entry readable when an interrupted temp file remains", () => {
      const endpoint = "/svc/apis/sto/stk_bydd_trd";
      const params = { basDd: "20260310" };
      const data = [{ value: "complete" }];
      setCached(endpoint, params, data);
      fs.writeFileSync(
        `${cacheEntryPath()}.interrupted.tmp`,
        "{partial",
        "utf8",
      );

      expect(getCached(endpoint, params)).toEqual(data);
    });

    it("keeps entries valid across interleaved writers and readers", async () => {
      const endpoint = "/svc/apis/sto/stk_bydd_trd";
      const params = { basDd: "20260310" };
      const payloads = Array.from({ length: 40 }, (_, index) => [
        { value: String(index) },
      ]);

      await Promise.all(
        payloads.map(
          (payload) =>
            new Promise<void>((resolve, reject) => {
              setImmediate(() => {
                try {
                  setCached(endpoint, params, payload);
                  expect(getCached(endpoint, params)).not.toBeNull();
                  expect(() =>
                    JSON.parse(fs.readFileSync(cacheEntryPath(), "utf8")),
                  ).not.toThrow();
                  resolve();
                } catch (error) {
                  reject(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                }
              });
            }),
        ),
      );

      expect(payloads).toContainEqual(getCached(endpoint, params));
      expect(cacheFiles().filter((file) => file.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("clearCache", () => {
    it("returns zero counts when no cache exists", () => {
      const result = clearCache();
      expect(result).toEqual({ files: 0, directories: 0 });
    });

    it("clears all cached data", () => {
      setCached("/endpoint1", { basDd: "20260310" }, [{ a: "1" }]);
      setCached("/endpoint2", { basDd: "20260309" }, [{ b: "2" }]);

      const result = clearCache();
      expect(result.files).toBeGreaterThan(0);
      expect(result.directories).toBeGreaterThan(0);

      // Verify cache is empty
      const status = getCacheStatus();
      expect(status.totalFiles).toBe(0);
    });
  });

  describe("getCacheStatus", () => {
    it("returns zero when no cache", () => {
      const status = getCacheStatus();
      expect(status).toEqual({ totalFiles: 0, totalSize: 0, dates: 0 });
    });

    it("reports correct counts", () => {
      setCached("/endpoint1", { basDd: "20260310" }, [{ a: "1" }]);
      setCached("/endpoint2", { basDd: "20260310" }, [{ b: "2" }]);
      setCached("/endpoint3", { basDd: "20260309" }, [{ c: "3" }]);

      const status = getCacheStatus();
      expect(status.totalFiles).toBe(3);
      expect(status.dates).toBe(2);
      expect(status.totalSize).toBeGreaterThan(0);
    });
  });
});
