import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isPathInside } from "./path-containment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const outputRoot = resolve(repository, "target/native-package");

async function nearestExistingAncestor(path) {
  let ancestor = path;
  for (;;) {
    try {
      await lstat(ancestor);
      return ancestor;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}
const targetId = argumentsByName.get("--target");
const bindingArtifact = argumentsByName.get("--binding");
const executableArtifact = argumentsByName.get("--executable");
const output = resolve(
  argumentsByName.get("--out") ?? resolve(outputRoot, "package"),
);
if (!targetId || !bindingArtifact || !executableArtifact) {
  throw new Error(
    "usage: assemble.mjs --target <id> --binding <path> --executable <path> [--out <path>]",
  );
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
if (output === outputRoot || !isPathInside(outputRoot, output)) {
  throw new Error(
    `assembled package output must be a descendant of ${outputRoot}`,
  );
}
const canonicalRepository = await realpath(repository);
const outputRootAncestor = await nearestExistingAncestor(outputRoot);
const canonicalOutputRootAncestor = await realpath(outputRootAncestor);
const expectedCanonicalOutputRootAncestor = resolve(
  canonicalRepository,
  relative(repository, outputRootAncestor),
);
if (canonicalOutputRootAncestor !== expectedCanonicalOutputRootAncestor) {
  throw new Error(
    "assembled package output root must not traverse a symbolic-link ancestor",
  );
}
await mkdir(outputRoot, { recursive: true });
const canonicalOutputRoot = await realpath(outputRoot);
if (
  canonicalOutputRoot !== resolve(canonicalRepository, "target/native-package")
) {
  throw new Error(
    "assembled package output root must retain its exact repository identity",
  );
}
const existingOutputAncestor = await nearestExistingAncestor(output);
const canonicalOutputAncestor = await realpath(existingOutputAncestor);
if (
  canonicalOutputAncestor !== canonicalOutputRoot &&
  !isPathInside(canonicalOutputRoot, canonicalOutputAncestor)
) {
  throw new Error(
    "assembled package output must not traverse a symbolic-link ancestor outside the output root",
  );
}
const bindingDestination = resolve(output, target.nodeBinding);
const executableDestination = resolve(output, target.executable);
for (const [kind, destination] of [
  ["binding", bindingDestination],
  ["executable", executableDestination],
]) {
  if (destination === output || !isPathInside(output, destination)) {
    throw new Error(`${kind} path must remain inside the assembled package`);
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(repository, "packages/node"), output, { recursive: true });
const licenseDestination = resolve(output, "LICENSE");
if (
  licenseDestination === output ||
  !isPathInside(output, licenseDestination)
) {
  throw new Error("license path must remain inside the assembled package");
}
await cp(resolve(repository, "LICENSE"), licenseDestination);
await cp(
  resolve(repository, "skills/krx-cli"),
  resolve(output, "skills/krx-cli"),
  {
    recursive: true,
  },
);
await rm(resolve(output, "native"), { recursive: true, force: true });
await rm(resolve(output, "bin"), { recursive: true, force: true });
await mkdir(dirname(bindingDestination), { recursive: true });
await mkdir(dirname(executableDestination), { recursive: true });
await cp(resolve(bindingArtifact), bindingDestination);
await cp(resolve(executableArtifact), executableDestination);
if (target.nodePlatform !== "win32") {
  await chmod(executableDestination, 0o755);
}

const rootPackage = JSON.parse(
  await readFile(resolve(repository, "package.json")),
);
const packageJsonPath = resolve(output, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath));
packageJson.version = rootPackage.version;
packageJson.bin.krx = `./${target.executable}`;
await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const declarations = (
  await readFile(
    resolve(repository, "contracts/product/v1/node-sdk.d.ts"),
    "utf8",
  )
).replaceAll("../../generated/", "./generated/");
await mkdir(resolve(output, "dist/generated"), { recursive: true });
await writeFile(resolve(output, "dist/index.d.ts"), declarations);
for (const name of ["node-operations.d.ts", "error-types.d.ts"]) {
  await cp(
    resolve(repository, "contracts/generated", name),
    resolve(output, "dist/generated", name),
  );
}

process.stdout.write(`${output}\n`);
