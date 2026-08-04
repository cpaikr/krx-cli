import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => path.join(actual.tmpdir(), "krx-cli-auth-test"),
  };
});

vi.mock("../../src/client/client.js", () => ({
  krxFetch: vi.fn(),
}));

import { krxFetch } from "../../src/client/client.js";
const mockedKrxFetch = vi.mocked(krxFetch);

const TEST_HOME = path.join(os.tmpdir(), "krx-cli-auth-test");
const CONFIG_DIR = path.join(TEST_HOME, ".krx-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

describe("KRX credential storage", () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env["KRX_API_KEY"];
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env["KRX_API_KEY"];
    vi.restoreAllMocks();
    mockedKrxFetch.mockReset();
  });

  it("stores a trimmed key without leaving temporary files", async () => {
    const { getApiKey, saveApiKey } = await import("../../src/client/auth.js");

    saveApiKey("  secret-value  ");

    expect(getApiKey()).toBe("secret-value");
    expect(fs.readdirSync(CONFIG_DIR)).toEqual(["config.json"]);
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).not.toContain(
      "secret-value  ",
    );
  });

  it.runIf(process.platform !== "win32")(
    "creates owner-only POSIX permissions",
    async () => {
      const { saveApiKey } = await import("../../src/client/auth.js");
      saveApiKey("secret-value");

      expect(fs.statSync(CONFIG_DIR).mode & 0o777).toBe(0o700);
      expect(fs.statSync(CONFIG_FILE).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== "win32")(
    "repairs unsafe existing permissions with a warning",
    async () => {
      const { getApiKey, saveApiKey } =
        await import("../../src/client/auth.js");
      saveApiKey("secret-value");
      fs.chmodSync(CONFIG_DIR, 0o755);
      fs.chmodSync(CONFIG_FILE, 0o644);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      expect(getApiKey()).toBe("secret-value");
      expect(fs.statSync(CONFIG_DIR).mode & 0o777).toBe(0o700);
      expect(fs.statSync(CONFIG_FILE).mode & 0o777).toBe(0o600);
      expect(stderr).toHaveBeenCalled();
    },
  );

  it("does not overwrite a corrupt existing configuration", async () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, "{not-json", "utf8");
    const { saveApiKey } = await import("../../src/client/auth.js");

    expect(() => saveApiKey("replacement")).toThrow(
      "Cannot update invalid configuration",
    );
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).toBe("{not-json");
  });

  it("gives KRX_API_KEY precedence without persisting it", async () => {
    const { getApiKey, saveApiKey } = await import("../../src/client/auth.js");
    saveApiKey("persisted");
    process.env["KRX_API_KEY"] = "environment";

    expect(getApiKey()).toBe("environment");
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).not.toContain("environment");
  });

  it("removes the persisted key and related service status", async () => {
    const { getApiKey, removeApiKey, saveApiKey } =
      await import("../../src/client/auth.js");
    saveApiKey("persisted");

    expect(removeApiKey()).toBe(true);
    expect(removeApiKey()).toBe(false);
    expect(getApiKey()).toBeUndefined();
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).not.toContain("persisted");
  });

  it("drops legacy unbound service status without hiding the stored API key", async () => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        apiKey: "preserved",
        serviceStatus: {
          stock: { approved: true, checkedAt: "2025-01-01T00:00:00.000Z" },
        },
      }),
    );
    const { getApiKey, getCachedServiceStatus, saveApiKey } =
      await import("../../src/client/auth.js");
    expect(getApiKey()).toBe("preserved");
    expect(getCachedServiceStatus("preserved")).toEqual({});
    saveApiKey("replacement");
    expect(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).apiKey).toBe(
      "replacement",
    );
  });

  it("uses only an official category probe and bypasses market-data cache", async () => {
    mockedKrxFetch.mockResolvedValue({ success: true, data: [{ A: "1" }] });
    const { checkCategoryApproval } = await import("../../src/client/auth.js");
    const status = await checkCategoryApproval("probe-key", "stock");
    expect(mockedKrxFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/svc/apis/sto/stk_bydd_trd",
        cache: false,
        apiKey: "probe-key",
      }),
    );
    expect(status).toMatchObject({ state: "approved", approved: true });
  });

  it("represents no-data and network probe outcomes as inconclusive", async () => {
    const { checkCategoryApproval } = await import("../../src/client/auth.js");
    mockedKrxFetch.mockResolvedValueOnce({ success: true, data: [] });
    await expect(
      checkCategoryApproval("probe-key", "stock"),
    ).resolves.toMatchObject({
      state: "inconclusive",
      failureType: "no_data",
    });
    mockedKrxFetch.mockResolvedValueOnce({
      success: false,
      data: [],
      errorType: "network",
      error: "KRX network request failed",
    });
    await expect(
      checkCategoryApproval("probe-key", "stock"),
    ).resolves.toMatchObject({
      state: "inconclusive",
      failureType: "network",
    });
  });

  it("does not reuse approval records across credential rotation", async () => {
    mockedKrxFetch.mockResolvedValue({ success: true, data: [{ A: "1" }] });
    const { checkCategoryApproval, getCachedServiceStatus } =
      await import("../../src/client/auth.js");
    await checkCategoryApproval("first-key", "stock");
    expect(getCachedServiceStatus("first-key").stock?.state).toBe("approved");
    expect(getCachedServiceStatus("second-key")).toEqual({});
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).not.toContain("first-key");
  });

  it("exposes freshness and failure without exposing credential identity", async () => {
    mockedKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      errorType: "timeout",
      error: "deadline exceeded",
    });
    const { checkCategoryApproval, getCachedServiceStatus } =
      await import("../../src/client/auth.js");
    const checked = new Date("2026-03-12T00:00:00.000Z");
    await checkCategoryApproval("probe-key", "stock", { now: () => checked });
    const cached = getCachedServiceStatus(
      "probe-key",
      new Date("2026-03-12T00:16:00.000Z"),
    );
    expect(cached.stock).toMatchObject({
      fresh: false,
      state: "inconclusive",
      failureType: "timeout",
    });
    expect(JSON.stringify(cached)).not.toContain("credential");
    expect(JSON.stringify(cached)).not.toContain("probe-key");
  });

  it("keeps ambiguous KRX 401 outcomes inconclusive", async () => {
    mockedKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      errorType: "authentication",
      httpStatus: 401,
      error: "Unauthorized API Call",
    });
    const { checkCategoryApproval } = await import("../../src/client/auth.js");
    const status = await checkCategoryApproval("probe-key", "esg");
    expect(status.state).toBe("inconclusive");
    expect(status.error).toContain("cannot distinguish");
  });

  it("represents an explicit KRX 403 approval denial as rejected", async () => {
    mockedKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      errorType: "approval",
      httpStatus: 403,
      error: "Service not approved",
    });
    const { checkCategoryApproval } = await import("../../src/client/auth.js");

    await expect(
      checkCategoryApproval("probe-key", "esg"),
    ).resolves.toMatchObject({
      state: "rejected",
      approved: false,
      failureType: "approval",
    });
  });
});
