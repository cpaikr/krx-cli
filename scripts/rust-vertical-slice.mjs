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
  cargoLock: argument("--cargo-lock", "probes/rust-vertical-slice/Cargo.lock"),
  cargo: argument("--cargo", "probes/rust-vertical-slice/Cargo.toml"),
  toolchain: argument(
    "--toolchain",
    "probes/rust-vertical-slice/rust-toolchain.toml",
  ),
  package: argument(
    "--package",
    "probes/rust-vertical-slice/node/package/package.json",
  ),
  runtimeCases: argument(
    "--runtime-cases",
    "contracts/product/v1/consumers/node-runtime-cases.json",
  ),
};

const [
  attributes,
  targets,
  nodePackage,
  workflow,
  cargoLock,
  cargo,
  toolchain,
  packageJson,
  runtimeCases,
] = await Promise.all([
  readFile(paths.attributes, "utf8"),
  readJson(paths.targets),
  readJson(paths.nodePackage),
  readYaml(paths.workflow),
  readFile(paths.cargoLock, "utf8"),
  readFile(paths.cargo, "utf8"),
  readFile(paths.toolchain, "utf8"),
  readJson(paths.package),
  readJson(paths.runtimeCases),
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
  "native target manifest must contain the four certified targets in stable order",
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
const requiredWorkflowPaths = [
  ".gitattributes",
  ".github/workflows/rust-vertical-slice.yml",
  "contracts/**",
  "package.json",
  "pnpm-lock.yaml",
  "probes/rust-vertical-slice/**",
  "scripts/package-smoke-command.mjs",
  "scripts/rust-vertical-slice.mjs",
];
equal(
  attributes.split(/\r?\n/u).filter(Boolean),
  [
    "/contracts/generated/*.d.ts text eol=lf",
    "/contracts/product/v1/node-sdk.d.ts text eol=lf",
    "/probes/rust-vertical-slice/node/package/dist/*.js text eol=lf",
  ],
  "portable package sources must have an exact LF-only attributes policy",
);
equal(
  workflow.on?.push?.paths,
  requiredWorkflowPaths,
  "workflow push paths must cover every certification input",
);
equal(
  workflow.on?.pull_request?.paths,
  requiredWorkflowPaths,
  "workflow pull-request paths must cover every certification input",
);
invariant(
  Array.isArray(buildTargets),
  "workflow build matrix must use an explicit include list",
);
equal(
  buildTargets.map((target) => target.id),
  targetIds,
  "workflow build matrix must match the native manifest",
);
for (const target of targets.targets) {
  const workflowTarget = buildTargets.find(
    (candidate) => candidate.id === target.id,
  );
  invariant(workflowTarget, `workflow is missing target ${target.id}`);
  equal(
    workflowTarget["rust-target"],
    target.rustTarget,
    `workflow Rust target for ${target.id} must match the manifest`,
  );
  invariant(
    workflowTarget.binding.endsWith(bindingFilename(target)),
    `workflow binding artifact for ${target.id} must match the manifest`,
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
  targetIds,
  "workflow consumer target matrix must match the manifest",
);
equal(
  workflow.jobs?.certification?.needs,
  ["build", "consume"],
  "workflow must aggregate every build and consumer result",
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
for (const stepName of [
  "Verify official Rustls handshake without credentials",
  "Verify native keyring behavior",
]) {
  invariant(
    workflow.jobs?.build?.steps?.some((step) => step.name === stepName),
    `workflow must include ${stepName}`,
  );
}
invariant(
  workflow.jobs?.certification?.steps?.some(
    (step) =>
      step.name === "Compare target-independent package identity" &&
      step.run.includes("compare-reports.mjs"),
  ),
  "workflow must compare target-independent identity across all consumer reports",
);
const consumerCertify = workflow.jobs?.consume?.steps?.find(
  (step) => step.name === "Certify the exact packed artifact",
);
invariant(
  typeof consumerCertify?.run === "string" &&
    consumerCertify.run.includes("--report "),
  "each consumer must emit a cross-target certification report",
);
invariant(
  workflow.jobs?.consume?.steps?.some(
    (step) =>
      step.uses === "actions/upload-artifact@v4" &&
      String(step.with?.name).startsWith("rust-probe-report-"),
  ),
  "each consumer must upload its cross-target certification report",
);

invariant(
  toolchain.includes('channel = "1.92.0"'),
  "probe Rust toolchain must remain pinned to 1.92.0",
);
const requiredVersions = {
  clap: "4.6.6",
  "futures-util": "0.3.34",
  keyring: "4.1.6",
  napi: "3.12.2",
  "napi-build": "2.4.1",
  "napi-derive": "3.6.3",
  reqwest: "0.13.4",
  serde: "1.0.229",
  "serde-saphyr": "1.1.0",
  serde_json: "1.0.151",
  thiserror: "2.0.20",
  tokio: "1.53.1",
  "tokio-util": "0.7.19",
  url: "2.5.8",
  zeroize: "1.9.0",
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
    `probe lockfile must not include ${forbidden}`,
  );
}

equal(
  packageJson.name,
  nodePackage.packageName,
  "probe package name must match the public surface",
);
equal(packageJson.type, "module", "probe package must be ESM-only");
equal(
  packageJson.engines?.node,
  nodePackage.nodeEngine,
  "probe package Node engine must match the certified public surface",
);
equal(
  packageJson.exports,
  nodePackage.exports,
  "probe package exports must match the public surface",
);
equal(
  packageJson.bin,
  { krx: "./bin/krx" },
  "probe package must point npm directly at the native CLI",
);
invariant(
  packageJson.dependencies === undefined,
  "probe package must not require install dependencies",
);
invariant(
  packageJson.scripts === undefined,
  "probe package must not run install scripts",
);
invariant(
  !Object.keys(packageJson.exports).some((key) => key.includes("native")),
  "native binding must not have a public package subpath",
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
  `Rust vertical-slice contract valid (${targetIds.length} targets, ${targets.distribution.nodeMajors.length} Node majors)\n`,
);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readYaml(path) {
  return YAML.parse(await readFile(path, "utf8"));
}

function bindingFilename(target) {
  if (target.nodePlatform === "darwin") return "libkrx_node_probe.dylib";
  if (target.nodePlatform === "linux") return "libkrx_node_probe.so";
  if (target.nodePlatform === "win32") return "krx_node_probe.dll";
  throw new Error(`unsupported manifest platform ${target.nodePlatform}`);
}
