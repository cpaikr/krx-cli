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
});
