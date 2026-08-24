import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const workspaceDependencyLines = [
  'clap = { version = "=4.6.6", features = ["derive"] }',
  'futures-util = "=0.3.34"',
  'jiff = { version = "=0.2.35", features = ["serde"] }',
  'keyring = "=4.1.6"',
  'napi = { version = "=3.12.2", default-features = false, features = ["async", "napi8", "tokio_rt"] }',
  'napi-build = "=2.4.1"',
  'napi-derive = "=3.6.3"',
  'reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls", "stream"] }',
  'serde = { version = "=1.0.229", features = ["derive"] }',
  'serde_json = "=1.0.151"',
  'serde-saphyr = { version = "=1.1.0", default-features = false, features = ["deserialize"] }',
  'sha2 = "=0.11.0"',
  'thiserror = "=2.0.20"',
  'tokio = { version = "=1.53.1", features = ["fs", "io-util", "macros", "net", "rt-multi-thread", "signal", "sync", "time"] }',
  'tokio-util = "=0.7.19"',
  'url = "=2.5.8"',
  'uuid = { version = "=1.25.0", features = ["serde", "v4"] }',
  'zeroize = { version = "=1.9.0", features = ["derive"] }',
] as const;

function assertWorkspaceDependencyPins(source: string): void {
  for (const line of workspaceDependencyLines) {
    if (!source.includes(line)) {
      throw new Error(`workspace dependency contract is missing ${line}`);
    }
  }
}

describe("production Rust SDK gate", () => {
  it("owns a pinned workspace without probe or adapter dependencies", () => {
    const workspace = read("Cargo.toml");
    const sdk = read("crates/krx-sdk/Cargo.toml");
    const lock = read("Cargo.lock");

    expect(workspace).toContain('members = ["crates/krx-sdk"]');
    expect(workspace).toContain('rust-version = "1.92"');
    expect(sdk).not.toMatch(/probes|clap|napi/u);
    assertWorkspaceDependencyPins(workspace);
    for (const [name, version] of [
      ["serde", "1.0.229"],
      ["serde_json", "1.0.151"],
      ["serde-saphyr", "1.1.0"],
      ["tokio-util", "0.7.19"],
      ["zeroize", "1.9.0"],
    ]) {
      expect(lock).toMatch(
        new RegExp(
          `name = "${name}"\\nversion = "${version.replaceAll(".", "\\.")}"`,
          "u",
        ),
      );
    }

    expect(() =>
      assertWorkspaceDependencyPins(
        workspace.replace('sha2 = "=0.11.0"', 'sha2 = "0.11"'),
      ),
    ).toThrow(/workspace dependency contract is missing sha2/u);
  });

  it("derives production wire tables into Cargo output from canonical artifacts", () => {
    const build = read("crates/krx-sdk/build.rs");
    const source = read("crates/krx-sdk/src/operation.rs");

    expect(build).toContain('join("contracts/krx/openapi.yaml")');
    expect(build).toContain('join("contracts/generated/product-v1.json")');
    expect(build).toContain('env::var_os("OUT_DIR")');
    expect(build).toContain("product.operations.len()");
    expect(source).toContain(
      'concat!(env!("OUT_DIR"), "/operation_contract.rs")',
    );
    expect(source).not.toContain("probes/");
  });

  it("runs locked strict validation on both Blacksmith Linux architectures", () => {
    const workflow = YAML.parse(read(".github/workflows/rust-sdk.yml"));
    const paths = workflow.on.pull_request.paths as string[];
    const job = workflow.jobs.sdk;

    expect(workflow.on.push).toBeUndefined();
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(true);
    expect(paths).toEqual([
      ".github/workflows/rust-sdk.yml",
      "Cargo.lock",
      "Cargo.toml",
      "contracts/generated/**",
      "contracts/krx/**",
      "contracts/product/**",
      "crates/krx-sdk/**",
      "rust-toolchain.toml",
      "tests/scripts/release-policy.test.ts",
      "tests/scripts/rust-sdk.test.ts",
    ]);
    expect(job.strategy.matrix.include).toEqual([
      { arch: "x64", runner: "blacksmith-2vcpu-ubuntu-2404" },
      { arch: "arm64", runner: "blacksmith-2vcpu-ubuntu-2404-arm" },
    ]);
    expect(
      job.steps.map((step: { run?: string }) => step.run).filter(Boolean),
    ).toEqual(
      expect.arrayContaining([
        "cargo fmt --all --check",
        "cargo check --locked --workspace --all-targets --all-features",
        "cargo clippy --locked --workspace --all-targets --all-features -- -D warnings",
        "cargo test --locked --workspace --all-features",
      ]),
    );
  });
});
