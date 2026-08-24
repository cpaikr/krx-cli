import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import YAML from "yaml";

const repository = resolve(import.meta.dirname, "..");
const override = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return resolve(repository, index === -1 ? fallback : process.argv[index + 1]);
};
const packagePath = override("--package", "package.json");
const nodePackagePath = override(
  "--node-package",
  "packages/node/package.json",
);
const ciPath = override("--ci", ".github/workflows/ci.yml");
const releasePath = override("--release", ".github/workflows/release.yml");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repository,
  encoding: "utf8",
})
  .split("\0")
  .filter((path) => path && existsSync(resolve(repository, path)));

invariant(
  tracked.filter((path) => path.startsWith("src/")).join("\n") ===
    "src/calendar/krx-closures.json",
  "only the maintained KRX calendar may remain under src/",
);
invariant(
  !tracked.some((path) => path.startsWith("probes/")),
  "disposable Rust probe sources must be removed at cutover",
);

const rootPackage = JSON.parse(await readFile(packagePath, "utf8"));
invariant(rootPackage.private === true, "root package must be maintainer-only");
invariant(
  rootPackage.license === "MIT",
  "root package must retain the MIT license",
);
invariant(
  rootPackage.bin === undefined,
  "root package must not expose a legacy executable",
);
invariant(
  rootPackage.files === undefined,
  "root package must not be a shipped package",
);
invariant(
  rootPackage.dependencies === undefined,
  "root package must have no runtime dependencies",
);
for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
  invariant(
    rootPackage.scripts?.[hook] === undefined,
    `root package must not define ${hook}`,
  );
}
invariant(
  rootPackage.repository?.url === "git+https://github.com/cpaikr/krx-cli.git" &&
    rootPackage.homepage === "https://github.com/cpaikr/krx-cli#readme" &&
    rootPackage.bugs?.url === "https://github.com/cpaikr/krx-cli/issues",
  "root package metadata must identify cpaikr/krx-cli",
);

const nodePackage = JSON.parse(await readFile(nodePackagePath, "utf8"));
invariant(
  nodePackage.license === "MIT",
  "native package must retain the MIT license",
);
invariant(
  nodePackage.private === true,
  "native archives must remain private release assets",
);
invariant(
  JSON.stringify(nodePackage.exports) ===
    JSON.stringify({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./package.json": "./package.json",
    }),
  "public Node exports must not expose the private native binding",
);
invariant(
  JSON.stringify(nodePackage.bin) === JSON.stringify({ krx: "./bin/krx" }),
  "native package must link npm directly to the native executable",
);
invariant(
  nodePackage.dependencies === undefined && nodePackage.scripts === undefined,
  "native package must be dependency-free and install-script-free",
);

const cliCargo = await readFile(
  resolve(repository, "crates/krx-cli/Cargo.toml"),
  "utf8",
);
const nodeCargo = await readFile(
  resolve(repository, "crates/krx-node/Cargo.toml"),
  "utf8",
);
for (const [name, source] of [
  ["CLI", cliCargo],
  ["Node binding", nodeCargo],
]) {
  invariant(
    /krx-sdk\s*=\s*\{\s*path\s*=\s*"\.\.\/krx-sdk"/u.test(source),
    `${name} must depend directly on the shared Rust SDK`,
  );
}

const maintainedRuntime = tracked.filter((path) =>
  /^(?:crates|packages|scripts)\//u.test(path),
);
const activeText = new Map();
for (const path of maintainedRuntime) {
  if (!/\.(?:json|mjs|js|rs|toml|yaml|yml)$/u.test(path)) continue;
  activeText.set(path, await readFile(resolve(repository, path), "utf8"));
}

const forbiddenActiveFragments = [
  "@modelcontextprotocol/sdk",
  "KRX_MCP_TOKEN",
  "KRX_MCP_ALLOWED_HOSTS",
  "dist/cli.js",
  "dist/mcp.js",
  "src/client/",
  "src/cli/",
  "src/mcp/",
  "src/watchlist/",
  "legacy_mcp_opt_out",
  "allow-build=krx-cli",
  "esbuild.config.js",
];
for (const [path, source] of activeText) {
  if (
    path === "scripts/cutover-gate.mjs" ||
    path === "scripts/product-contracts.mjs"
  ) {
    continue;
  }
  for (const fragment of forbiddenActiveFragments) {
    invariant(
      !source.includes(fragment),
      `cutover residue ${fragment} remains in ${path}`,
    );
  }
}

const transportOwners = [...activeText]
  .filter(
    ([path, source]) =>
      path.endsWith(".rs") && source.includes("reqwest::Client"),
  )
  .map(([path]) => path);
invariant(
  JSON.stringify(transportOwners) ===
    JSON.stringify(["crates/krx-sdk/src/transport.rs"]),
  "the shared Rust SDK transport must be the only provider HTTP conformer",
);

const ci = YAML.parse(await readFile(ciPath, "utf8"));
invariant(
  ci.on?.push === undefined,
  "CI must not duplicate the heavy matrix on branch pushes",
);
invariant(ci.on?.pull_request !== undefined, "CI must run for pull requests");
invariant(
  Object.hasOwn(ci.on ?? {}, "workflow_dispatch"),
  "CI must retain manual dispatch",
);
const ciSource = await readFile(ciPath, "utf8");
invariant(
  ciSource.includes(
    "macOS and Windows are intentionally omitted to reduce CI compute cost",
  ),
  "CI must document the approved macOS and Windows compute-cost omission",
);
for (const job of Object.values(ci.jobs ?? {})) {
  invariant(
    job["runs-on"] === "blacksmith-2vcpu-ubuntu-2404",
    "general CI jobs must use the approved Blacksmith x64 image",
  );
}

const releaseSource = await readFile(releasePath, "utf8");
invariant(
  releaseSource.includes("scripts/native-package/assemble.mjs") &&
    releaseSource.includes("scripts/native-package/certify.mjs"),
  "tag certification must assemble and certify native archives",
);
for (const fragment of ["pnpm build", "npm pack", "git+file:", "allow-build"]) {
  invariant(
    !releaseSource.includes(fragment),
    `release workflow retains source-build path ${fragment}`,
  );
}
invariant(
  releaseSource.includes("macOS ARM64 and Windows x64 remain supported") &&
    releaseSource.includes("omitted from CI to reduce compute cost"),
  "release workflow must document the approved non-Linux omission",
);

const contractWorkflow = await readFile(
  resolve(repository, ".github/workflows/contract-drift.yml"),
  "utf8",
);
invariant(
  rootPackage.scripts?.["contract:check"] ===
    "node scripts/contract-drift.mjs" &&
    contractWorkflow.includes("pnpm contract:check") &&
    contractWorkflow.includes("scripts/native-package/assemble.mjs"),
  "contract drift must execute through the native SDK package",
);

process.stdout.write(
  `Atomic cutover valid (${tracked.length} tracked files; one Rust HTTP conformer)\n`,
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
