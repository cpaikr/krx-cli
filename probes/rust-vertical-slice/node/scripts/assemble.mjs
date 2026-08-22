import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const probe = resolve(here, "../..");
const repository = resolve(probe, "../..");
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}
const targetId = argumentsByName.get("--target");
const bindingArtifact = argumentsByName.get("--binding");
const executableArtifact = argumentsByName.get("--executable");
const output = resolve(
  argumentsByName.get("--out") ?? resolve(probe, "target/package"),
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
if (!target)
  throw new Error(`target ${targetId} is not certified by the manifest`);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(probe, "node/package"), output, { recursive: true });
await mkdir(resolve(output, dirname(target.nodeBinding)), { recursive: true });
await mkdir(resolve(output, dirname(target.executable)), { recursive: true });
await cp(resolve(bindingArtifact), resolve(output, target.nodeBinding));
await cp(resolve(executableArtifact), resolve(output, target.executable));
if (target.nodePlatform !== "win32")
  await chmod(resolve(output, target.executable), 0o755);

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
await writeFile(resolve(output, "dist/index.d.ts"), declarations);
await mkdir(resolve(output, "dist/generated"), { recursive: true });
for (const name of ["node-operations.d.ts", "error-types.d.ts"]) {
  await cp(
    resolve(repository, "contracts/generated", name),
    resolve(output, "dist/generated", name),
  );
}

process.stdout.write(`${output}\n`);
