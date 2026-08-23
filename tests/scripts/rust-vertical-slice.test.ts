/* eslint-disable @typescript-eslint/no-explicit-any -- Probe mutants deliberately edit untyped contract documents. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

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

  it("rejects a redundant public Rust client cache-age authority", () => {
    const path = mutatedText(
      "probes/rust-vertical-slice/sdk/src/lib.rs",
      "impl ClientBuilder { pub fn cache_max_age(self) -> Self { self } }",
    );
    const result = run("--sdk-source", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/redundant client cache-age authority/u);
  });

  it("rejects a workspace that omits the public Rust consumer", () => {
    const path = replacedText(
      "probes/rust-vertical-slice/Cargo.toml",
      'members = ["sdk", "consumer", "cli", "node"]',
      'members = ["sdk", "cli", "node"]',
    );
    const result = run("--cargo", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must include the public Rust SDK consumer/u);
  });

  it("rejects a consumer detached from the disposable SDK", () => {
    const path = replacedText(
      "probes/rust-vertical-slice/consumer/Cargo.toml",
      'krx-sdk = { path = "../sdk" }',
      'krx-sdk = { path = "../other-sdk" }',
    );
    const result = run("--consumer-cargo", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/depend directly on the disposable SDK/u);
  });

  it("rejects a probe detached from the canonical Rust consumer contract", () => {
    const path = replacedText(
      "probes/rust-vertical-slice/consumer/src/lib.rs",
      "../../../../contracts/product/v1/rust-sdk-consumer.rs",
      "../../../../contracts/product/v1/other-consumer.rs",
    );
    const result = run("--consumer-source", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /compile the canonical public Rust SDK contract/u,
    );
  });

  it("rejects hosted compilation that narrows away from the consumer", () => {
    const path = replacedText(
      ".github/workflows/rust-vertical-slice.yml",
      "cargo check --locked --workspace --all-targets --all-features",
      "cargo check --locked -p krx-sdk --all-targets --all-features",
    );
    const result = run("--workflow", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /compile the complete workspace and public consumer/u,
    );
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

  it("launches npm's JavaScript CLI through Node for both Windows package stages", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-probe-npm-cli-"));
    const npmCli = join(directory, "npm-cli.mjs");
    writeFileSync(
      npmCli,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    const moduleUrl = pathToFileURL(
      join(root, "probes/rust-vertical-slice/node/scripts/npm-command.mjs"),
    ).href;
    const program = `
      import { spawnSync } from "node:child_process";
      import { resolveNpmCommand } from ${JSON.stringify(moduleUrl)};
      const command = resolveNpmCommand({
        platform: "win32",
        execPath: process.execPath,
        npmCliPath: ${JSON.stringify(npmCli)},
      });
      const result = spawnSync(
        command.command,
        [...command.argumentPrefix, "probe-argument"],
        { encoding: "utf8" },
      );
      process.stdout.write(JSON.stringify({ command, result }));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: {
        command: process.execPath,
        argumentPrefix: [npmCli],
      },
      result: {
        status: 0,
        stdout: '["probe-argument"]',
      },
    });
    for (const caller of ["pack.mjs", "certify.mjs"]) {
      const source = readFileSync(
        join(root, "probes/rust-vertical-slice/node/scripts", caller),
        "utf8",
      );
      expect(source).toContain('from "./npm-command.mjs"');
      expect(source).toContain("resolveNpmCommand()");
      expect(source).not.toContain('"npm.cmd"');
    }
  });

  it("recognizes declaration containment with Windows path separators", () => {
    const moduleUrl = pathToFileURL(
      join(
        root,
        "probes/rust-vertical-slice/node/scripts/path-containment.mjs",
      ),
    ).href;
    const program = `
      import { win32 } from "node:path";
      import { isPathInside } from ${JSON.stringify(moduleUrl)};
      const declarationRoot = "D:\\\\a\\\\krx-cli\\\\node_modules\\\\krx-cli\\\\dist";
      process.stdout.write(JSON.stringify({
        nested: isPathInside(
          declarationRoot,
          win32.join(declarationRoot, "generated", "node-operations.d.ts"),
          win32,
        ),
        root: isPathInside(declarationRoot, declarationRoot, win32),
        sibling: isPathInside(
          declarationRoot,
          win32.join(declarationRoot, "..", "dist-escape", "index.d.ts"),
          win32,
        ),
        otherDrive: isPathInside(
          declarationRoot,
          "E:\\\\outside\\\\index.d.ts",
          win32,
        ),
      }));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      nested: true,
      root: true,
      sibling: false,
      otherDrive: false,
    });
  });

  it("releases the installed native binding before temporary cleanup", () => {
    const certify = readFileSync(
      join(root, "probes/rust-vertical-slice/node/scripts/certify.mjs"),
      "utf8",
    );
    const runtime = readFileSync(
      join(root, "probes/rust-vertical-slice/node/tests/runtime.mjs"),
      "utf8",
    );
    expect(certify).toContain("const runtimeResult = run(");
    expect(certify).toContain("JSON.parse(runtimeResult.stdout)");
    expect(certify).not.toContain("pathToFileURL");
    expect(runtime).toContain(
      'JSON.stringify({ capability: wire, status: "passed" })',
    );
  });

  it("rejects platform-dependent portable package line endings", () => {
    const path = mutatedText(".gitattributes", "*.d.ts text eol=crlf");
    const result = run("--attributes", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/exact LF-only attributes policy/u);
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

  it("rejects a native CLI version that drifts from the root package", () => {
    const path = replacedText(
      "probes/rust-vertical-slice/cli/Cargo.toml",
      'version = "1.8.1"',
      'version = "0.0.0"',
    );
    const result = run("--cli-cargo", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/native CLI version must match/u);
  });

  it("rejects mutable action tags in the native certification workflow", () => {
    const path = replacedText(
      ".github/workflows/rust-vertical-slice.yml",
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
      "actions/checkout@v6",
    );
    const result = run("--workflow", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/reviewed immutable revision/u);
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
