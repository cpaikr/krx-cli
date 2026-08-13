import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalContractEnvironment } from "../../src/contracts/local-env.js";

const VARIABLE = "KRX_CONTRACT_LOCAL_ENV_TEST";

afterEach(() => {
  delete process.env[VARIABLE];
});

describe("local contract environment", () => {
  it("loads variables from an existing local env file", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-contract-env-"));
    const path = join(directory, ".env.local");
    writeFileSync(path, `${VARIABLE}=from-file\n`, { mode: 0o600 });

    try {
      loadLocalContractEnvironment(path);
      expect(process.env[VARIABLE]).toBe("from-file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not override a variable already set by the shell", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-contract-env-"));
    const path = join(directory, ".env.local");
    writeFileSync(path, `${VARIABLE}=from-file\n`, { mode: 0o600 });
    process.env[VARIABLE] = "from-shell";

    try {
      loadLocalContractEnvironment(path);
      expect(process.env[VARIABLE]).toBe("from-shell");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows CI and packaged runs without a local env file", () => {
    expect(() =>
      loadLocalContractEnvironment(
        join(tmpdir(), "krx-contract-env-file-does-not-exist"),
      ),
    ).not.toThrow();
  });
});
