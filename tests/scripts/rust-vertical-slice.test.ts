/* eslint-disable @typescript-eslint/no-explicit-any -- Probe mutants deliberately edit untyped contract documents. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/rust-vertical-slice.mjs", ...args],
    { cwd: root, encoding: "utf8" },
  );
}

function runReportComparison(reports: string) {
  return spawnSync(
    process.execPath,
    [
      "probes/rust-vertical-slice/node/scripts/compare-reports.mjs",
      "--reports",
      reports,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function mutatedJson(
  source: string,
  mutate: (document: Record<string, any>) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "krx-rust-probe-"));
  const target = join(directory, basename(source));
  const document = JSON.parse(readFileSync(join(root, source), "utf8"));
  mutate(document);
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  return target;
}

function mutatedText(source: string, addition: string) {
  const directory = mkdtempSync(join(tmpdir(), "krx-rust-probe-"));
  const target = join(directory, basename(source));
  writeFileSync(
    target,
    `${readFileSync(join(root, source), "utf8")}\n${addition}\n`,
  );
  return target;
}

function replacedText(source: string, search: string, replacement: string) {
  const directory = mkdtempSync(join(tmpdir(), "krx-rust-probe-"));
  const target = join(directory, basename(source));
  const input = readFileSync(join(root, source), "utf8");
  expect(input).toContain(search);
  writeFileSync(target, input.replace(search, replacement));
  return target;
}

describe("Rust vertical-slice gate", () => {
  it("accepts the canonical probe, package, and hosted matrix", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a missing certified target", () => {
    const path = mutatedJson(
      "contracts/product/v1/native-targets.json",
      (document) => {
        document.targets.pop();
      },
    );
    const result = run("--native-targets", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/four certified targets/u);
  });

  it("rejects an uncertified Node major", () => {
    const path = mutatedJson(
      "contracts/product/v1/native-targets.json",
      (document) => {
        document.distribution.nodeMajors.push(26);
      },
    );
    const result = run("--native-targets", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Node 22 and 24/u);
  });

  it("rejects a heavyweight fallback credential database", () => {
    const path = mutatedText(
      "probes/rust-vertical-slice/Cargo.lock",
      '[[package]]\nname = "db-keystore"\nversion = "0.5.1"',
    );
    const result = run("--cargo-lock", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must not include db-keystore/u);
  });

  it("rejects a public native binding subpath", () => {
    const path = mutatedJson(
      "probes/rust-vertical-slice/node/package/package.json",
      (document) => {
        document.exports["./native"] = "./native/krx.node";
      },
    );
    const result = run("--package", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/package exports must match/u);
  });

  it("rejects a hosted matrix that does not install the pinned toolchain", () => {
    const path = replacedText(
      ".github/workflows/rust-vertical-slice.yml",
      "rustup toolchain install 1.92.0",
      "rustup target add",
    );
    const result = run("--workflow", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/install the pinned Rust toolchain/u);
  });

  it("rejects cross-target portable payload divergence", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-probe-reports-"));
    const targets = [
      "darwin-arm64",
      "linux-x64-gnu",
      "linux-arm64-gnu",
      "win32-x64-msvc",
    ];
    for (const target of targets) {
      for (const node of [22, 24]) {
        writeFileSync(
          join(directory, `${target}-node${node}.json`),
          `${JSON.stringify({
            node,
            target,
            status: "passed",
            portableSha256: "canonical",
            packageVersion: "1.8.1",
            packageMetadata: { exports: ["."] },
            capability: { operation: "stock_stk_bydd_trd" },
          })}\n`,
        );
      }
    }
    expect(runReportComparison(directory).status).toBe(0);
    const mutant = join(directory, "win32-x64-msvc-node24.json");
    const report = JSON.parse(readFileSync(mutant, "utf8"));
    report.portableSha256 = "divergent";
    writeFileSync(mutant, `${JSON.stringify(report)}\n`);
    const result = runReportComparison(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/divergent JS or declarations/u);
  });
});
