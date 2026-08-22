import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parseNpmPackReport } from "../../../../scripts/package-smoke-command.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../..");
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1]);
}
const packageRoot = resolve(values.get("--package") ?? "");
const targetId = values.get("--target");
const artifacts = resolve(
  values.get("--artifacts") ?? resolve(packageRoot, "../artifacts"),
);
if (!values.get("--package") || !targetId) {
  throw new Error(
    "usage: pack.mjs --package <directory> --target <id> [--artifacts <directory>]",
  );
}
const manifest = JSON.parse(
  await readFile(
    resolve(repository, "contracts/product/v1/native-targets.json"),
  ),
);
if (!manifest.targets.some((target) => target.id === targetId)) {
  throw new Error(`target ${targetId} is not certified by the manifest`);
}
const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json")),
);
await mkdir(artifacts, { recursive: true });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npm,
  [
    "pack",
    "--json",
    "--ignore-scripts",
    "--silent",
    "--pack-destination",
    artifacts,
  ],
  { cwd: packageRoot, encoding: "utf8" },
);
if (result.status !== 0) throw new Error(`npm pack failed\n${result.stderr}`);
const report = parseNpmPackReport(result.stdout);
if (report.length !== 1 || !report[0].filename)
  throw new Error("npm pack returned an invalid report");
const source = resolve(artifacts, report[0].filename);
const name = manifest.distribution.assetNameTemplate
  .replace("{version}", packageJson.version)
  .replace("{target}", targetId);
const destination = resolve(artifacts, name);
if (source !== destination) {
  await rm(destination, { force: true });
  await rename(source, destination);
}
process.stdout.write(`${destination}\n`);
