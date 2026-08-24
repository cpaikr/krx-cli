import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { installedBinCommand } from "../package-smoke-command.mjs";
import { resolveNpmCommand } from "./npm-command.mjs";
import {
  assertPackageLayout,
  assertRuntimeCompatibility,
} from "./package-layout.mjs";
import { isPathInside } from "./path-containment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1]);
}
const tarball = resolve(values.get("--tarball") ?? "");
const targetId = values.get("--target");
const reportPath = values.get("--report")
  ? resolve(values.get("--report"))
  : undefined;
if (!values.get("--tarball") || !targetId) {
  throw new Error("usage: certify.mjs --tarball <tgz> --target <id>");
}
const manifest = JSON.parse(
  await readFile(
    resolve(repository, "contracts/product/v1/native-targets.json"),
  ),
);
const target = manifest.targets.find((candidate) => candidate.id === targetId);
if (!target) {
  throw new Error(`target ${targetId} is not certified by the manifest`);
}
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
assert.ok(
  manifest.distribution.nodeMajors.includes(nodeMajor),
  `Node ${nodeMajor} is not in the certified matrix`,
);
assertRuntimeCompatibility(target, {
  platform: process.platform,
  arch: process.arch,
  report: process.report?.getReport?.(),
});

const temporary = await mkdtemp(resolve(tmpdir(), "krx-native-package-"));
try {
  await writeFile(
    resolve(temporary, "package.json"),
    `${JSON.stringify({ name: "krx-native-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  const { command: npm, argumentPrefix: npmArgumentPrefix } =
    resolveNpmCommand();
  run(
    npm,
    [
      ...npmArgumentPrefix,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    temporary,
  );
  const packageRoot = resolve(temporary, "node_modules/krx-cli");
  const packageJson = JSON.parse(
    await readFile(resolve(packageRoot, "package.json")),
  );
  await assertPackageLayout(packageRoot, target, packageJson);
  assert.equal(
    await readFile(resolve(packageRoot, "LICENSE"), "utf8"),
    await readFile(resolve(repository, "LICENSE"), "utf8"),
    "installed package license must exactly match the repository license",
  );
  for (const skillPath of [
    "skills/krx-cli/SKILL.md",
    "skills/krx-cli/references/cli-usage.md",
    "skills/krx-cli/workflows/apply-service-access.md",
  ]) {
    assert.ok(
      existsSync(resolve(packageRoot, skillPath)),
      `installed package is missing ${skillPath}`,
    );
  }

  const declarationRoot = resolve(packageRoot, "dist");
  const declarationFiles = [
    resolve(declarationRoot, "index.d.ts"),
    resolve(declarationRoot, "generated/node-operations.d.ts"),
    resolve(declarationRoot, "generated/error-types.d.ts"),
  ];
  for (const declaration of declarationFiles) {
    const source = await readFile(declaration, "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      assert.ok(
        match[1].startsWith("."),
        `declaration import ${match[1]} is not package-local`,
      );
      const resolved = resolve(dirname(declaration), match[1]).replace(
        /\.js$/,
        ".d.ts",
      );
      assert.ok(
        isPathInside(declarationRoot, resolved),
        `declaration import ${match[1]} escapes the package declaration root`,
      );
      assert.ok(
        existsSync(resolved),
        `declaration import ${match[1]} does not resolve`,
      );
    }
  }

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { KrxClient, KrxError } from 'krx-cli'; const c = new KrxClient({ apiKey: 'fixture' }); if (!KrxError || c.capabilities().length !== 31) process.exit(1)",
    ],
    temporary,
  );
  const privateImport = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import('krx-cli/native/krx.node')",
    ],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.notEqual(privateImport.status, 0);
  assert.match(privateImport.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);

  const runtimeResult = run(
    process.execPath,
    [resolve(repository, "scripts/native-package/runtime.mjs"), packageRoot],
    repository,
  );
  const runtime = JSON.parse(runtimeResult.stdout);
  assert.equal(runtime.status, "passed");
  const capability = runtime.capability;

  const consumer = (
    await readFile(
      resolve(repository, "contracts/product/v1/consumers/node-positive.ts"),
      "utf8",
    )
  ).replace('from "../node-sdk.js"', 'from "krx-cli"');
  const consumerPath = resolve(temporary, "consumer.ts");
  await writeFile(consumerPath, consumer);
  run(
    process.execPath,
    [
      resolve(repository, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "false",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--target",
      "ES2022",
      consumerPath,
    ],
    temporary,
  );

  const helpBin = installedBinCommand(temporary, "krx", ["--help"]);
  const help = run(helpBin.command, helpBin.args, temporary);
  assert.match(help.stdout, /Usage:/i);
  const versionBin = installedBinCommand(temporary, "krx", ["--version"]);
  const version = run(versionBin.command, versionBin.args, temporary);
  assert.equal(version.stdout.trim(), packageJson.version);
  const schemaBin = installedBinCommand(temporary, "krx", [
    "schema",
    "stock_stk_bydd_trd",
  ]);
  const schema = JSON.parse(
    run(schemaBin.command, schemaBin.args, temporary).stdout,
  );
  assert.equal(schema.command, "stock.stk_bydd_trd");
  assert.ok(
    Array.isArray(schema.responseFields) && schema.responseFields.length > 0,
  );
  if (process.platform !== "win32") {
    const installed = resolve(temporary, "node_modules/.bin/krx");
    const destination = await realpath(installed);
    assert.equal(
      destination,
      await realpath(resolve(packageRoot, target.executable)),
    );
    const bytes = await readFile(destination);
    assert.notEqual(bytes.subarray(0, 2).toString(), "#!");
  }

  const certification = {
    node: nodeMajor,
    target: targetId,
    tarball,
    status: "passed",
    portableSha256: await portableDigest(packageRoot),
    packageVersion: packageJson.version,
    packageMetadata: {
      name: packageJson.name,
      type: packageJson.type,
      engines: packageJson.engines,
      exports: packageJson.exports,
      files: packageJson.files,
      license: packageJson.license,
      private: packageJson.private,
      binNames: Object.keys(packageJson.bin),
      dependencies: packageJson.dependencies ?? null,
      scripts: packageJson.scripts ?? null,
    },
    capability,
  };
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(certification, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(certification)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const diagnostics = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}\n${diagnostics}`,
    );
  }
  return result;
}

async function portableDigest(packageRoot) {
  const hash = createHash("sha256");
  for (const directory of ["dist", "skills"]) {
    const root = resolve(packageRoot, directory);
    for (const path of await regularFiles(root)) {
      const relative = path.slice(packageRoot.length + 1).replaceAll("\\", "/");
      const bytes = await readFile(path);
      hash.update(relative);
      hash.update("\0");
      hash.update(String(bytes.length));
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
  }
  const license = await readFile(resolve(packageRoot, "LICENSE"));
  hash.update("LICENSE");
  hash.update("\0");
  hash.update(String(license.length));
  hash.update("\0");
  hash.update(license);
  hash.update("\0");
  return hash.digest("hex");
}

async function regularFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
