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
import { fileURLToPath, pathToFileURL } from "node:url";

import { installedBinCommand } from "../../../../scripts/package-smoke-command.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const probe = resolve(here, "../..");
const repository = resolve(probe, "../..");
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
if (!target)
  throw new Error(`target ${targetId} is not certified by the manifest`);
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
assert.ok(
  manifest.distribution.nodeMajors.includes(nodeMajor),
  `Node ${nodeMajor} is not in the certified matrix`,
);

const temporary = await mkdtemp(resolve(tmpdir(), "krx-rust-probe-"));
try {
  await writeFile(
    resolve(temporary, "package.json"),
    `${JSON.stringify({ name: "krx-probe-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    temporary,
  );
  const packageRoot = resolve(temporary, "node_modules/krx-cli");
  const packageJson = JSON.parse(
    await readFile(resolve(packageRoot, "package.json")),
  );
  assert.deepEqual(Object.keys(packageJson.exports), [".", "./package.json"]);
  assert.equal(packageJson.scripts, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.bin.krx, `./${target.executable}`);
  assert.ok(existsSync(resolve(packageRoot, target.nodeBinding)));
  assert.ok(existsSync(resolve(packageRoot, target.executable)));
  assert.deepEqual(
    await readdir(resolve(packageRoot, "native")),
    [target.nodeBinding.split("/").at(-1)],
    "packed artifact must contain exactly one matching native binding",
  );
  assert.deepEqual(
    await readdir(resolve(packageRoot, "bin")),
    [target.executable.split("/").at(-1)],
    "packed artifact must contain exactly one matching native executable",
  );

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
        resolved.startsWith(`${declarationRoot}/`) ||
          resolved === declarationRoot,
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
      "import { KrxClient, KrxError } from 'krx-cli'; if (!KrxClient || !KrxError) process.exit(1)",
    ],
    temporary,
  );
  const privateImport = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import('krx-cli/native/fixture.node')",
    ],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.notEqual(privateImport.status, 0);
  assert.match(privateImport.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);

  run(
    process.execPath,
    [resolve(probe, "node/tests/runtime.mjs"), packageRoot],
    repository,
  );
  const probeModule = await import(
    pathToFileURL(resolve(packageRoot, "dist/probe.js")).href
  );
  const capability = probeModule.probeWireContract();

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

  const bin = installedBinCommand(temporary, "krx", ["--help"]);
  const cli = run(bin.command, bin.args, temporary);
  assert.match(cli.stdout, /Native CLI probe/);
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
    portableSha256: await directoryDigest(resolve(packageRoot, "dist")),
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
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result;
}

async function directoryDigest(root) {
  const hash = createHash("sha256");
  for (const path of await regularFiles(root)) {
    const relative = path.slice(root.length + 1).replaceAll("\\", "/");
    const bytes = await readFile(path);
    hash.update(relative);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
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
