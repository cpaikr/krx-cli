/* eslint-disable @typescript-eslint/no-explicit-any -- Mutants deliberately edit untyped contract documents. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
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
    ["scripts/native-package/compare-reports.mjs", "--reports", reports],
    { cwd: root, encoding: "utf8" },
  );
}

function runModule(program: string) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", program],
    { cwd: root, encoding: "utf8" },
  );
}

function isolatedNativeScriptRepository(
  nativeScripts: string[],
  { packageSmoke = false } = {},
) {
  const repository = realpathSync(
    mkdtempSync(join(tmpdir(), "krx-native-script-")),
  );
  const nativeDirectory = join(repository, "scripts/native-package");
  mkdirSync(nativeDirectory, { recursive: true });
  for (const script of nativeScripts) {
    copyFileSync(
      join(root, "scripts/native-package", script),
      join(nativeDirectory, script),
    );
  }
  if (packageSmoke) {
    copyFileSync(
      join(root, "scripts/package-smoke-command.mjs"),
      join(repository, "scripts/package-smoke-command.mjs"),
    );
  }
  return repository;
}

function mutatedJson(
  source: string,
  mutate: (document: Record<string, any>) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "krx-native-gate-"));
  const target = join(directory, basename(source));
  const document = JSON.parse(readFileSync(join(root, source), "utf8"));
  mutate(document);
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  return target;
}

function mutatedText(source: string, addition: string) {
  const directory = mkdtempSync(join(tmpdir(), "krx-native-gate-"));
  const target = join(directory, basename(source));
  writeFileSync(
    target,
    `${readFileSync(join(root, source), "utf8")}\n${addition}\n`,
  );
  return target;
}

function replacedText(source: string, search: string, replacement: string) {
  const directory = mkdtempSync(join(tmpdir(), "krx-native-gate-"));
  const target = join(directory, basename(source));
  const input = readFileSync(join(root, source), "utf8");
  expect(input).toContain(search);
  writeFileSync(target, input.replace(search, replacement));
  return target;
}

describe("production native package gate", () => {
  it("accepts the production adapters, package, and hosted matrix", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a missing supported target", () => {
    const path = mutatedJson(
      "contracts/product/v1/native-targets.json",
      (document) => document.targets.pop(),
    );
    const result = run("--native-targets", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/four supported targets/u);
  });

  it("rejects drift in Linux continuous certification", () => {
    const path = mutatedJson(
      "contracts/product/v1/native-targets.json",
      (document) =>
        document.distribution.continuousCertificationTargets.push(
          "darwin-arm64",
        ),
    );
    const result = run("--native-targets", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/only the two Linux GNU targets/u);
  });

  it("rejects an uncertified Node major", () => {
    const path = mutatedJson(
      "contracts/product/v1/native-targets.json",
      (document) => document.distribution.nodeMajors.push(26),
    );
    const result = run("--native-targets", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Node 22 and 24/u);
  });

  it("rejects a heavyweight fallback credential database", () => {
    const path = mutatedText(
      "Cargo.lock",
      '[[package]]\nname = "db-keystore"\nversion = "0.5.1"',
    );
    const result = run("--cargo-lock", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must not include db-keystore/u);
  });

  it("rejects a redundant public Rust client cache-age authority", () => {
    const path = mutatedText(
      "crates/krx-sdk/src/client.rs",
      "impl ClientBuilder { pub fn cache_max_age(self) -> Self { self } }",
    );
    const result = run("--sdk-source", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/redundant client cache-age authority/u);
  });

  it("rejects a workspace that omits a production adapter", () => {
    const path = replacedText(
      "Cargo.toml",
      'members = ["crates/krx-sdk", "crates/krx-cli", "crates/krx-node"]',
      'members = ["crates/krx-sdk", "crates/krx-cli"]',
    );
    const result = run("--cargo", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SDK, CLI, and Node binding/u);
  });

  it("rejects adapters detached from the shared SDK", () => {
    for (const [argument, source] of [
      ["--cli-cargo", "crates/krx-cli/Cargo.toml"],
      ["--node-cargo", "crates/krx-node/Cargo.toml"],
    ]) {
      const path = replacedText(
        source,
        'path = "../krx-sdk"',
        'path = "../other-sdk"',
      );
      const result = run(argument, path);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/shared SDK/u);
    }
  });

  it("rejects production SDK drift from the canonical Rust consumer", () => {
    const path = replacedText(
      "crates/krx-sdk/tests/public_contract.rs",
      "../../../contracts/product/v1/rust-sdk-consumer.rs",
      "../../../contracts/product/v1/other-consumer.rs",
    );
    const result = run("--public-consumer", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/canonical public Rust consumer/u);
  });

  it("rejects hosted compilation that narrows the production workspace", () => {
    const path = replacedText(
      ".github/workflows/rust-vertical-slice.yml",
      "cargo check --locked --workspace --all-targets --all-features",
      "cargo check --locked -p krx-sdk --all-targets --all-features",
    );
    const result = run("--workflow", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/complete production workspace/u);
  });

  it("rejects a public native binding subpath", () => {
    const path = mutatedJson("packages/node/package.json", (document) => {
      document.exports["./native"] = "./native/krx.node";
    });
    const result = run("--package", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/package exports must match/u);
  });

  it("launches npm's JavaScript CLI through Node on Windows", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-native-npm-cli-"));
    const npmCli = join(directory, "npm-cli.mjs");
    writeFileSync(
      npmCli,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    const moduleUrl = pathToFileURL(
      join(root, "scripts/native-package/npm-command.mjs"),
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
        [...command.argumentPrefix, "native-argument"],
        { encoding: "utf8" },
      );
      process.stdout.write(JSON.stringify({ command, result }));
    `;
    const result = runModule(program);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: { command: process.execPath, argumentPrefix: [npmCli] },
      result: { status: 0, stdout: '["native-argument"]' },
    });
    for (const caller of ["pack.mjs", "certify.mjs"]) {
      const source = readFileSync(
        join(root, "scripts/native-package", caller),
        "utf8",
      );
      expect(source).toContain('from "./npm-command.mjs"');
      expect(source).toContain("resolveNpmCommand()");
      expect(source).not.toContain('"npm.cmd"');
    }
  });

  it("recognizes declaration containment with Windows separators", () => {
    const moduleUrl = pathToFileURL(
      join(root, "scripts/native-package/path-containment.mjs"),
    ).href;
    const result = runModule(`
      import { win32 } from "node:path";
      import { isPathInside } from ${JSON.stringify(moduleUrl)};
      const root = "D:\\\\a\\\\krx-cli\\\\dist";
      process.stdout.write(JSON.stringify({
        nested: isPathInside(root, win32.join(root, "generated", "types.d.ts"), win32),
        root: isPathInside(root, root, win32),
        sibling: isPathInside(root, win32.join(root, "..", "dist-escape"), win32),
        drive: isPathInside(root, "E:\\\\outside\\\\index.d.ts", win32),
      }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      nested: true,
      root: true,
      sibling: false,
      drive: false,
    });
  });

  it("rejects an out-of-target assembly path before recursive deletion", () => {
    const outside = mkdtempSync(join(tmpdir(), "krx-assemble-outside-"));
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "preserve\n");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/native-package/assemble.mjs",
        "--target",
        "darwin-arm64",
        "--binding",
        "missing-binding",
        "--executable",
        "missing-executable",
        "--out",
        outside,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/output must be a descendant/u);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("rejects a symlinked assembly ancestor before recursive deletion", () => {
    const repository = isolatedNativeScriptRepository([
      "assemble.mjs",
      "path-containment.mjs",
    ]);
    const manifestDirectory = join(repository, "contracts/product/v1");
    const outputRoot = join(repository, "target/native-package");
    const outside = join(repository, "outside");
    const externalPackage = join(outside, "package");
    mkdirSync(manifestDirectory, { recursive: true });
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(externalPackage, { recursive: true });
    const sentinel = join(externalPackage, "sentinel.txt");
    writeFileSync(sentinel, "preserve\n");
    symlinkSync(outside, join(outputRoot, "link"), "dir");
    writeFileSync(
      join(manifestDirectory, "native-targets.json"),
      `${JSON.stringify({
        targets: [
          {
            id: "darwin-arm64",
            nodePlatform: "darwin",
            nodeBinding: "native/krx.darwin-arm64.node",
            executable: "bin/krx",
          },
        ],
      })}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        join(repository, "scripts/native-package/assemble.mjs"),
        "--target",
        "darwin-arm64",
        "--binding",
        "missing-binding",
        "--executable",
        "missing-executable",
        "--out",
        join(outputRoot, "link/package"),
      ],
      { cwd: repository, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/symbolic-link ancestor/u);
    expect(readFileSync(sentinel, "utf8")).toBe("preserve\n");
  });

  it("rejects a symlinked assembly root before recursive deletion", () => {
    const repository = isolatedNativeScriptRepository([
      "assemble.mjs",
      "path-containment.mjs",
    ]);
    const manifestDirectory = join(repository, "contracts/product/v1");
    const targetDirectory = join(repository, "target");
    const outsideRoot = join(repository, "outside-root");
    const externalPackage = join(outsideRoot, "package");
    mkdirSync(manifestDirectory, { recursive: true });
    mkdirSync(targetDirectory, { recursive: true });
    mkdirSync(externalPackage, { recursive: true });
    const sentinel = join(externalPackage, "sentinel.txt");
    writeFileSync(sentinel, "preserve\n");
    symlinkSync(outsideRoot, join(targetDirectory, "native-package"), "dir");
    writeFileSync(
      join(manifestDirectory, "native-targets.json"),
      `${JSON.stringify({
        targets: [
          {
            id: "darwin-arm64",
            nodePlatform: "darwin",
            nodeBinding: "native/krx.darwin-arm64.node",
            executable: "bin/krx",
          },
        ],
      })}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        join(repository, "scripts/native-package/assemble.mjs"),
        "--target",
        "darwin-arm64",
        "--binding",
        "missing-binding",
        "--executable",
        "missing-executable",
        "--out",
        join(targetDirectory, "native-package/package"),
      ],
      { cwd: repository, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/output root.*symbolic-link ancestor/u);
    expect(readFileSync(sentinel, "utf8")).toBe("preserve\n");
  });

  it("rejects manifest binding and executable traversal before mutation", () => {
    for (const field of ["nodeBinding", "executable"] as const) {
      const repository = isolatedNativeScriptRepository([
        "assemble.mjs",
        "path-containment.mjs",
      ]);
      const manifestDirectory = join(repository, "contracts/product/v1");
      const output = join(
        repository,
        "target/native-package/darwin-arm64/package",
      );
      mkdirSync(manifestDirectory, { recursive: true });
      mkdirSync(output, { recursive: true });
      const sentinel = join(output, "sentinel.txt");
      writeFileSync(sentinel, "preserve\n");
      const target = {
        id: "darwin-arm64",
        nodePlatform: "darwin",
        nodeBinding: "native/krx.darwin-arm64.node",
        executable: "bin/krx",
      };
      target[field] = "../escape";
      writeFileSync(
        join(manifestDirectory, "native-targets.json"),
        `${JSON.stringify({ targets: [target] })}\n`,
      );

      const result = spawnSync(
        process.execPath,
        [
          join(repository, "scripts/native-package/assemble.mjs"),
          "--target",
          "darwin-arm64",
          "--binding",
          "missing-binding",
          "--executable",
          "missing-executable",
          "--out",
          output,
        ],
        { cwd: repository, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        new RegExp(
          `${field === "nodeBinding" ? "binding" : "executable"} path must remain inside`,
        ),
      );
      expect(readFileSync(sentinel, "utf8")).toBe("preserve\n");
    }
  });

  it("rejects npm source and native archive destination traversal", () => {
    for (const escape of ["source", "destination"] as const) {
      const repository = isolatedNativeScriptRepository(
        ["npm-command.mjs", "pack.mjs", "path-containment.mjs"],
        { packageSmoke: true },
      );
      const manifestDirectory = join(repository, "contracts/product/v1");
      const packageRoot = join(repository, "package");
      const artifacts = join(repository, "artifacts");
      const fakeBin = join(repository, "fake-bin");
      mkdirSync(manifestDirectory, { recursive: true });
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "krx-cli", version: "1.8.1" })}\n`,
      );
      writeFileSync(
        join(manifestDirectory, "native-targets.json"),
        `${JSON.stringify({
          distribution: {
            assetNameTemplate:
              escape === "destination"
                ? "../escape-destination.tgz"
                : "krx-cli-{version}-{target}.tgz",
          },
          targets: [{ id: "darwin-arm64" }],
        })}\n`,
      );
      const escaped = join(repository, `escape-${escape}.tgz`);
      writeFileSync(escaped, "preserve\n");
      const fakeNpm = join(fakeBin, "npm");
      writeFileSync(
        fakeNpm,
        `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const destination = process.argv[process.argv.indexOf("--pack-destination") + 1];
const filename = process.env.KRX_TEST_PACK_FILENAME;
if (!filename.startsWith("..")) writeFileSync(join(destination, filename), "archive");
process.stdout.write(JSON.stringify([{ filename }]));
`,
      );
      chmodSync(fakeNpm, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          join(repository, "scripts/native-package/pack.mjs"),
          "--package",
          packageRoot,
          "--target",
          "darwin-arm64",
          "--artifacts",
          artifacts,
        ],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            KRX_TEST_PACK_FILENAME:
              escape === "source" ? "../escape-source.tgz" : "packed.tgz",
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        escape === "source"
          ? /npm pack output must remain inside/u
          : /native archive must remain inside/u,
      );
      expect(readFileSync(escaped, "utf8")).toBe("preserve\n");
    }
  });

  it("rejects missing, mismatched, and non-executable native package layouts", () => {
    const fixture = mkdtempSync(join(tmpdir(), "krx-native-layout-"));
    mkdirSync(join(fixture, "native"));
    mkdirSync(join(fixture, "bin"));
    writeFileSync(join(fixture, "native/krx.linux-x64-gnu.node"), "binding");
    writeFileSync(join(fixture, "bin/krx"), "binary");
    chmodSync(join(fixture, "bin/krx"), 0o755);
    const moduleUrl = pathToFileURL(
      join(root, "scripts/native-package/package-layout.mjs"),
    ).href;
    const target = {
      id: "linux-x64-gnu",
      nodePlatform: "linux",
      nodeBinding: "native/krx.linux-x64-gnu.node",
      executable: "bin/krx",
    };
    const packageJson = {
      exports: { ".": {}, "./package.json": "./package.json" },
      bin: { krx: "./bin/krx" },
    };
    const invoke = () =>
      runModule(`
        import { assertPackageLayout } from ${JSON.stringify(moduleUrl)};
        await assertPackageLayout(
          ${JSON.stringify(fixture)},
          ${JSON.stringify(target)},
          ${JSON.stringify(packageJson)},
        );
      `);
    expect(invoke().status).toBe(0);

    rmSync(join(fixture, "native/krx.linux-x64-gnu.node"));
    expect(invoke().stderr).toMatch(/matching native binding is missing/u);
    writeFileSync(join(fixture, "native/krx.linux-x64-gnu.node"), "binding");
    writeFileSync(join(fixture, "native/krx.linux-arm64-gnu.node"), "extra");
    expect(invoke().stderr).toMatch(/exactly one matching native binding/u);
    rmSync(join(fixture, "native/krx.linux-arm64-gnu.node"));

    rmSync(join(fixture, "bin/krx"));
    expect(invoke().stderr).toMatch(/matching native executable is missing/u);
    writeFileSync(join(fixture, "bin/krx"), "binary");
    chmodSync(join(fixture, "bin/krx"), 0o755);
    writeFileSync(join(fixture, "bin/krx-other"), "extra");
    expect(invoke().stderr).toMatch(/exactly one matching native executable/u);
    rmSync(join(fixture, "bin/krx-other"));

    chmodSync(join(fixture, "bin/krx"), 0o644);
    expect(invoke().stderr).toMatch(/execute permission/u);

    const binding = join(fixture, "native/krx.linux-x64-gnu.node");
    const bindingTarget = join(fixture, "binding-target");
    writeFileSync(bindingTarget, "binding");
    rmSync(binding);
    symlinkSync(bindingTarget, binding);
    expect(invoke().stderr).toMatch(/native binding must be a regular file/u);

    rmSync(binding);
    writeFileSync(binding, "binding");
    const executable = join(fixture, "bin/krx");
    const executableTarget = join(fixture, "executable-target");
    writeFileSync(executableTarget, "binary");
    chmodSync(executableTarget, 0o755);
    rmSync(executable);
    symlinkSync(executableTarget, executable);
    expect(invoke().stderr).toMatch(
      /native executable must be a regular file/u,
    );
  });

  it("rejects wrong OS, CPU, libc, and target combinations", () => {
    const moduleUrl = pathToFileURL(
      join(root, "scripts/native-package/package-layout.mjs"),
    ).href;
    const target = { id: "linux-x64-gnu" };
    const invoke = (runtime: object) =>
      runModule(`
        import { assertRuntimeCompatibility } from ${JSON.stringify(moduleUrl)};
        assertRuntimeCompatibility(${JSON.stringify(target)}, ${JSON.stringify(runtime)});
      `);
    expect(
      invoke({
        platform: "linux",
        arch: "x64",
        report: { header: { glibcVersionRuntime: "2.39" } },
      }).status,
    ).toBe(0);
    for (const runtime of [
      { platform: "freebsd", arch: "x64", report: {} },
      { platform: "linux", arch: "riscv64", report: {} },
      { platform: "linux", arch: "x64", report: { header: {} } },
      {
        platform: "linux",
        arch: "arm64",
        report: { header: { glibcVersionRuntime: "2.39" } },
      },
    ]) {
      expect(invoke(runtime).status).toBe(1);
    }
  });

  it("runs installed native runtime in a child before temporary cleanup", () => {
    const certify = readFileSync(
      join(root, "scripts/native-package/certify.mjs"),
      "utf8",
    );
    const runtime = readFileSync(
      join(root, "scripts/native-package/runtime.mjs"),
      "utf8",
    );
    expect(certify).toContain("const runtimeResult = run(");
    expect(certify).toContain("JSON.parse(runtimeResult.stdout)");
    expect(certify).not.toContain("pathToFileURL");
    expect(runtime).toContain("client.capabilities()");
    expect(runtime).toContain('status: "passed"');
  });

  it("certifies a representative installed native CLI schema command", () => {
    const certify = readFileSync(
      join(root, "scripts/native-package/certify.mjs"),
      "utf8",
    );
    expect(certify).toContain(
      'const schemaBin = installedBinCommand(temporary, "krx", [',
    );
    expect(certify).toContain('"schema",\n    "stock_stk_bydd_trd",');
    expect(certify).toMatch(
      /const schema = JSON\.parse\([\s\S]*?run\(schemaBin\.command, schemaBin\.args, temporary\)\.stdout,[\s\S]*?\);/,
    );
    expect(certify).toContain(
      'assert.equal(schema.command, "stock.stk_bydd_trd");',
    );
    expect(certify).toContain("schema.responseFields.length > 0");
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

  it("rejects duplicate branch-push certification", () => {
    const path = replacedText(
      ".github/workflows/rust-vertical-slice.yml",
      "on:\n",
      'on:\n  push: { branches: ["codex/rust-rewrite-*"] }\n',
    );
    const result = run("--workflow", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must not duplicate/u);
  });

  it("rejects a non-Blacksmith continuous runner", () => {
    const path = replacedText(
      ".github/workflows/rust-vertical-slice.yml",
      "runner: blacksmith-2vcpu-ubuntu-2404-arm",
      "runner: ubuntu-24.04-arm",
    );
    const result = run("--workflow", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/expected Blacksmith image/u);
  });

  it("rejects adapter builds that omit the production Node crate", () => {
    const path = replacedText(
      ".github/workflows/rust-vertical-slice.yml",
      "-p krx-cli -p krx-node",
      "-p krx-cli",
    );
    const result = run("--workflow", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/build the production CLI and Node binding/u);
  });

  it("rejects a native workspace version that drifts from the root package", () => {
    const path = replacedText(
      "Cargo.toml",
      'version = "1.8.1"',
      'version = "0.0.0"',
    );
    const result = run("--cargo", path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/workspace version must match/u);
  });

  it("rejects mutable action tags in native certification", () => {
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
    const directory = mkdtempSync(join(tmpdir(), "krx-native-reports-"));
    for (const target of ["linux-x64-gnu", "linux-arm64-gnu"]) {
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
            capability: [{ id: "stock_stk_bydd_trd" }],
          })}\n`,
        );
      }
    }
    expect(runReportComparison(directory).status).toBe(0);
    const mutant = join(directory, "linux-arm64-gnu-node24.json");
    const report = JSON.parse(readFileSync(mutant, "utf8"));
    report.portableSha256 = "divergent";
    writeFileSync(mutant, `${JSON.stringify(report)}\n`);
    const result = runReportComparison(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/divergent JS or declarations/u);
  });
});
