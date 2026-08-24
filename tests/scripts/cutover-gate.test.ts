/* eslint-disable @typescript-eslint/no-explicit-any -- Mutants edit untyped package documents. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function run(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/cutover-gate.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function mutateJson(
  path: string,
  mutation: (value: Record<string, any>) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "krx-cutover-gate-"));
  const destination = join(directory, basename(path));
  const value = JSON.parse(readFileSync(join(root, path), "utf8"));
  mutation(value);
  writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
  return destination;
}

function mutateText(path: string, mutation: (value: string) => string) {
  const directory = mkdtempSync(join(tmpdir(), "krx-cutover-gate-"));
  const destination = join(directory, basename(path));
  writeFileSync(destination, mutation(readFileSync(join(root, path), "utf8")));
  return destination;
}

describe("atomic cutover gate", () => {
  it("accepts the single Rust transport and native package topology", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a root install hook", () => {
    const packagePath = mutateJson("package.json", (value) => {
      value.scripts.prepare = "cargo build --release";
    });
    const result = run("--package", packagePath);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must not define prepare/u);
  });

  it("rejects a public native binding export", () => {
    const packagePath = mutateJson("packages/node/package.json", (value) => {
      value.exports["./native"] = "./native/krx.node";
    });
    const result = run("--node-package", packagePath);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /must not expose the private native binding/u,
    );
  });

  it("rejects a branch-push CI trigger", () => {
    const ciPath = mutateText(".github/workflows/ci.yml", (value) =>
      value.replace("on:\n", "on:\n  push:\n    branches: [main]\n"),
    );
    const result = run("--ci", ciPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must not duplicate the heavy matrix/u);
  });
});
