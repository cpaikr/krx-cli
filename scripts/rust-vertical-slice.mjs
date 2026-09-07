import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return resolve(root, index === -1 ? fallback : process.argv[index + 1]);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\nexpected ${JSON.stringify(expected)}\nreceived ${JSON.stringify(actual)}`,
  );
}

const paths = {
  attributes: argument("--attributes", ".gitattributes"),
  targets: argument(
    "--native-targets",
    "contracts/product/v1/native-targets.json",
  ),
  nodePackage: argument(
    "--node-package",
    "contracts/product/v1/node-package-surface.json",
  ),
  workflow: argument("--workflow", ".github/workflows/rust-vertical-slice.yml"),
  cargoLock: argument("--cargo-lock", "Cargo.lock"),
  cargo: argument("--cargo", "Cargo.toml"),
  cliCargo: argument("--cli-cargo", "crates/krx-cli/Cargo.toml"),
  nodeCargo: argument("--node-cargo", "crates/krx-node/Cargo.toml"),
  publicConsumer: argument(
    "--public-consumer",
    "crates/krx-sdk/tests/public_contract.rs",
  ),
  rootPackage: argument("--root-package", "package.json"),
  certifier: argument("--certifier", "scripts/native-package/certify.mjs"),
  assembler: argument("--assembler", "scripts/native-package/assemble.mjs"),
  runtime: argument("--runtime", "scripts/native-package/runtime.mjs"),
  toolchain: argument("--toolchain", "rust-toolchain.toml"),
  package: argument("--package", "packages/node/package.json"),
  packageIndex: argument("--package-index", "packages/node/dist/index.js"),
  runtimeCases: argument(
    "--runtime-cases",
    "contracts/product/v1/consumers/node-runtime-cases.json",
  ),
  sdkSource: argument("--sdk-source", "crates/krx-sdk/src/client.rs"),
};

const [
  attributes,
  targets,
  nodePackage,
  workflow,
  cargoLock,
  cargo,
  cliCargo,
  nodeCargo,
  publicConsumer,
  rootPackage,
  certifier,
  assembler,
  runtime,
  toolchain,
  packageJson,
  packageIndex,
  runtimeCases,
  sdkSource,
] = await Promise.all([
  readFile(paths.attributes, "utf8"),
  readJson(paths.targets),
  readJson(paths.nodePackage),
  readYaml(paths.workflow),
  readFile(paths.cargoLock, "utf8"),
  readFile(paths.cargo, "utf8"),
  readFile(paths.cliCargo, "utf8"),
  readFile(paths.nodeCargo, "utf8"),
  readFile(paths.publicConsumer, "utf8"),
  readJson(paths.rootPackage),
  readFile(paths.certifier, "utf8"),
  readFile(paths.assembler, "utf8"),
  readFile(paths.runtime, "utf8"),
  readFile(paths.toolchain, "utf8"),
  readJson(paths.package),
  readFile(paths.packageIndex, "utf8"),
  readJson(paths.runtimeCases),
  readFile(paths.sdkSource, "utf8"),
]);

equal(
  targets.distribution.nodeMajors,
  [22, 24],
  "native certification must remain pinned to Node 22 and 24",
);
const targetIds = targets.targets.map((target) => target.id);
equal(
  targetIds,
  ["darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"],
  "native target manifest must contain the four supported targets in stable order",
);
const continuousTargetIds = targets.distribution.continuousCertificationTargets;
equal(
  continuousTargetIds,
  ["linux-x64-gnu", "linux-arm64-gnu"],
  "continuous certification must cover only the two Linux GNU targets",
);
equal(
  targets.targets.map((target) => target.rustTarget),
  [
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
  ],
  "native manifest Rust targets must remain complete",
);

const buildTargets = workflow.jobs?.build?.strategy?.matrix?.include;
const actionRefs = {
  "actions/checkout": "d23441a48e516b6c34aea4fa41551a30e30af803",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact": "634f93cb2916e3fdff6788551b99b062d0335ce0",
  "pnpm/action-setup": "b906affcce14559ad1aafd4ab0e942779e9f58b1",
  "EmbarkStudios/cargo-deny-action": "3c6349835b2b7b196a839186cb8b78e02f7b5f25",
};
for (const job of Object.values(workflow.jobs ?? {})) {
  for (const step of job.steps ?? []) {
    if (typeof step.uses !== "string") continue;
    const [action, revision] = step.uses.split("@");
    equal(
      revision,
      actionRefs[action],
      `workflow action ${action} must use its reviewed immutable revision`,
    );
  }
}
const requiredWorkflowPaths = [
  ".gitattributes",
  ".github/workflows/rust-vertical-slice.yml",
  "Cargo.lock",
  "Cargo.toml",
  "contracts/**",
  "crates/krx-cli/**",
  "crates/krx-node/**",
  "crates/krx-sdk/**",
  "deny.toml",
  "package.json",
  "packages/node/**",
  "pnpm-lock.yaml",
  "rust-toolchain.toml",
  "scripts/native-package/**",
  "scripts/compat-certify.mjs",
  "scripts/compat-judge.mjs",
  "scripts/package-smoke-command.mjs",
  "scripts/rust-vertical-slice.mjs",
  "skills/krx-cli/**",
  "src/calendar/krx-closures.json",
  "tests/compat/**",
  "tests/fixtures/adjusted-stock-prices/oracles.json",
  "tests/scripts/release-policy.test.ts",
  "tests/scripts/rust-vertical-slice.test.ts",
];
equal(
  attributes.split(/\r?\n/u).filter(Boolean),
  [
    "/LICENSE text eol=lf",
    "/contracts/generated/*.d.ts text eol=lf",
    "/contracts/product/v1/node-sdk.d.ts text eol=lf",
    "/packages/node/dist/*.js text eol=lf",
    "/skills/krx-cli/** text eol=lf",
  ],
  "portable package sources must have an exact LF-only attributes policy",
);
invariant(
  workflow.on?.push === undefined,
  "workflow must not duplicate the certification matrix on branch pushes",
);
equal(
  workflow.on?.pull_request?.paths,
  requiredWorkflowPaths,
  "workflow pull-request paths must cover every production certification input",
);
invariant(
  Object.hasOwn(workflow.on ?? {}, "workflow_dispatch"),
  "workflow must retain manual certification dispatch",
);
invariant(
  Array.isArray(buildTargets),
  "workflow build matrix must use an explicit include list",
);
equal(
  buildTargets.map((target) => target.id),
  continuousTargetIds,
  "workflow build matrix must match the continuous certification targets",
);
const expectedRunners = {
  "linux-x64-gnu": "blacksmith-2vcpu-ubuntu-2404",
  "linux-arm64-gnu": "blacksmith-2vcpu-ubuntu-2404-arm",
};
for (const targetId of continuousTargetIds) {
  const target = targets.targets.find((candidate) => candidate.id === targetId);
  invariant(target, `native manifest is missing continuous target ${targetId}`);
  const workflowTarget = buildTargets.find(
    (candidate) => candidate.id === target.id,
  );
  invariant(workflowTarget, `workflow is missing target ${target.id}`);
  equal(
    workflowTarget["rust-target"],
    target.rustTarget,
    `workflow Rust target for ${target.id} must match the manifest`,
  );
  equal(
    workflowTarget.runner,
    expectedRunners[target.id],
    `workflow runner for ${target.id} must use the expected Blacksmith image`,
  );
  invariant(
    workflowTarget.binding.endsWith(bindingFilename(target)),
    `workflow binding artifact for ${target.id} must match the production crate`,
  );
  invariant(
    workflowTarget.executable.endsWith(target.executable.split("/").at(-1)),
    `workflow executable artifact for ${target.id} must match the manifest`,
  );
}
equal(
  workflow.jobs?.consume?.strategy?.matrix?.node,
  targets.distribution.nodeMajors,
  "workflow consumer Node matrix must match the manifest",
);
equal(
  workflow.jobs?.consume?.strategy?.matrix?.target?.map((target) => target.id),
  continuousTargetIds,
  "workflow consumer target matrix must match the continuous certification targets",
);
for (const target of workflow.jobs?.consume?.strategy?.matrix?.target ?? []) {
  equal(
    target.runner,
    expectedRunners[target.id],
    `workflow consumer for ${target.id} must use the expected Blacksmith image`,
  );
}
equal(
  workflow.jobs?.certification?.needs,
  ["build", "consume"],
  "workflow must aggregate every build and consumer result",
);
equal(
  workflow.jobs?.certification?.["runs-on"],
  "blacksmith-2vcpu-ubuntu-2404",
  "workflow aggregator must use the expected Blacksmith image",
);
const rustInstall = workflow.jobs?.build?.steps?.find(
  (step) => step.name === "Install pinned Rust toolchain and target",
);
invariant(
  typeof rustInstall?.run === "string" &&
    rustInstall.run.includes("rustup toolchain install 1.92.0") &&
    rustInstall.run.includes("--component rustfmt,clippy") &&
    rustInstall.run.includes("--target ${{ matrix.rust-target }}"),
  "workflow must install the pinned Rust toolchain, components, and matrix target",
);
const workspaceCheck = workflow.jobs?.build?.steps?.find(
  (step) => step.name === "Compile the production workspace",
);
equal(
  workspaceCheck?.run,
  "cargo check --locked --workspace --all-targets --all-features",
  "hosted certification must compile the complete production workspace",
);
const packageBuild = workflow.jobs?.build?.steps?.find(
  (step) => step.name === "Build the native package members once",
);
invariant(
  typeof packageBuild?.run === "string" &&
    packageBuild.run.includes("-p krx-cli -p krx-node"),
  "workflow must build the production CLI and Node binding together",
);
invariant(
  workflow.jobs?.certification?.steps?.some(
    (step) =>
      step.name === "Compare target-independent package identity" &&
      step.run.includes("scripts/native-package/compare-reports.mjs"),
  ),
  "workflow must compare target-independent identity across all consumer reports",
);
const consumerCertify = workflow.jobs?.consume?.steps?.find(
  (step) => step.name === "Certify the exact packed artifact",
);
invariant(
  workflow.jobs?.consume?.steps?.some(
    (step) => step.run === "pnpm install --frozen-lockfile --ignore-scripts",
  ),
  "consumer setup must not run legacy or dependency install scripts",
);
invariant(
  typeof consumerCertify?.run === "string" &&
    consumerCertify.run.includes("scripts/native-package/certify.mjs") &&
    consumerCertify.run.includes("--report "),
  "each consumer must certify the production tarball and emit a report",
);
invariant(
  workflow.jobs?.consume?.steps?.some(
    (step) =>
      step.uses ===
        `actions/upload-artifact@${actionRefs["actions/upload-artifact"]}` &&
      String(step.with?.name).startsWith("krx-native-report-"),
  ),
  "each consumer must upload its cross-target certification report",
);
invariant(
  !JSON.stringify(workflow).includes("probes/rust-vertical-slice"),
  "production certification must not execute disposable probe code",
);

invariant(
  toolchain.includes('channel = "1.92.0"'),
  "production Rust toolchain must remain pinned to 1.92.0",
);
invariant(
  cargo.includes(
    'members = ["crates/krx-sdk", "crates/krx-cli", "crates/krx-node"]',
  ),
  "production workspace must contain the SDK, CLI, and Node binding",
);
invariant(
  cliCargo.includes('name = "krx-cli"') &&
    /krx-sdk\s*=\s*\{\s*path\s*=\s*"\.\.\/krx-sdk"/u.test(cliCargo),
  "production CLI must depend directly on the shared SDK",
);
invariant(
  nodeCargo.includes('name = "krx-node"') &&
    nodeCargo.includes('crate-type = ["cdylib"]') &&
    /krx-sdk\s*=\s*\{\s*path\s*=\s*"\.\.\/krx-sdk"/u.test(nodeCargo),
  "production Node binding must be a cdylib over the shared SDK",
);
invariant(
  publicConsumer.includes(
    '#[path = "../../../contracts/product/v1/rust-sdk-consumer.rs"]',
  ) && publicConsumer.includes("mod frozen_public_consumer;"),
  "production SDK must compile the canonical public Rust consumer contract",
);
invariant(
  !/\bpub\s+fn\s+cache_max_age\b/u.test(sdkSource),
  "Rust public SDK must not expose a redundant client cache-age authority",
);
const workspaceVersion = cargo.match(/^version = "([^"]+)"$/mu)?.[1];
equal(
  workspaceVersion,
  rootPackage.version,
  "native workspace version must match the root package version",
);
invariant(
  certifier.includes(
    "assert.equal(version.stdout.trim(), packageJson.version)",
  ),
  "clean-install certification must assert the native CLI package version",
);
invariant(
  certifier.includes('readFile(resolve(packageRoot, "LICENSE"), "utf8")') &&
    certifier.includes('readFile(resolve(repository, "LICENSE"), "utf8")'),
  "clean-install certification must assert the exact repository license",
);
invariant(
  certifier.includes("assertPackageLayout") &&
    certifier.includes("assertRuntimeCompatibility") &&
    certifier.includes("runtime.mjs"),
  "clean-install certification must enforce exact layout, runtime target, and public runtime behavior",
);
invariant(
  assembler.includes('resolve(repository, "packages/node")') &&
    assembler.includes('resolve(repository, "LICENSE")') &&
    assembler.includes('resolve(repository, "skills/krx-cli")') &&
    !assembler.includes("probes/rust-vertical-slice"),
  "package assembly must copy the production Node facade, license, and skill without probe runtime reuse",
);
invariant(
  runtime.includes("client.capabilities()") &&
    runtime.includes("AbortController") &&
    !runtime.includes("probeWireContract"),
  "runtime certification must cover public capabilities and cancellation without probe hooks",
);

const requiredVersions = {
  clap: "4.6.6",
  napi: "3.12.2",
  "napi-build": "2.4.1",
  "napi-derive": "3.6.3",
};
const locked = new Map(
  [
    ...cargoLock.matchAll(
      /\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"/g,
    ),
  ].map((match) => [match[1], match[2]]),
);
for (const [name, version] of Object.entries(requiredVersions)) {
  equal(locked.get(name), version, `Cargo.lock must pin ${name}`);
  invariant(
    cargo.includes(`${name} = "=${version}"`) ||
      cargo.includes(`${name} = { version = "=${version}"`),
    `workspace dependency ${name} must use an exact version`,
  );
}
for (const forbidden of ["db-keystore", "turso", "libsql"]) {
  invariant(
    !locked.has(forbidden),
    `production lockfile must not include ${forbidden}`,
  );
}

equal(
  packageJson.name,
  nodePackage.packageName,
  "production package name must match the public surface",
);
equal(packageJson.type, "module", "production package must be ESM-only");
equal(
  packageJson.engines?.node,
  nodePackage.nodeEngine,
  "production package Node engine must match the certified public surface",
);
equal(
  packageJson.exports,
  nodePackage.exports,
  "production package exports must match the public surface",
);
equal(
  packageJson.bin,
  { krx: "./bin/krx" },
  "production package template must point npm directly at the native CLI",
);
invariant(
  packageJson.dependencies === undefined,
  "production package must not require install dependencies",
);
invariant(
  packageJson.scripts === undefined,
  "production package must not run install scripts",
);
invariant(
  packageJson.private === true,
  "production native package template must remain private",
);
invariant(
  packageJson.files?.includes("skills"),
  "production native package must include the portable skill directory",
);
invariant(
  packageJson.files?.includes("LICENSE"),
  "production native package must include the MIT license file",
);
invariant(
  !Object.keys(packageJson.exports).some((key) => key.includes("native")),
  "native binding must not have a public package subpath",
);
invariant(
  packageIndex.includes("KrxClient") && packageIndex.includes("KrxError"),
  "production facade must export the frozen public Node entry points",
);

const runtimeIds = runtimeCases.cases.map((runtimeCase) => runtimeCase.id);
for (const required of [
  "async-event-loop",
  "abort-listener-cleanup",
  "sync-panic-contained",
  "async-panic-contained",
  "declaration-package-locality",
  "private-native-binding",
]) {
  invariant(
    runtimeIds.includes(required),
    `Node runtime contract must include ${required}`,
  );
}

process.stdout.write(
  `Native package contract valid (${targetIds.length} supported targets, ${continuousTargetIds.length} continuously certified, ${targets.distribution.nodeMajors.length} Node majors)\n`,
);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readYaml(path) {
  return YAML.parse(await readFile(path, "utf8"));
}

function bindingFilename(target) {
  if (target.nodePlatform === "darwin") return "libkrx_node.dylib";
  if (target.nodePlatform === "linux") return "libkrx_node.so";
  if (target.nodePlatform === "win32") return "krx_node.dll";
  throw new Error(`unsupported manifest platform ${target.nodePlatform}`);
}
