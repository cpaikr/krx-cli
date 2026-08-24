import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export function runtimeTarget({ platform, arch, report }) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64-msvc";
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return report?.header?.glibcVersionRuntime ? `linux-${arch}-gnu` : null;
  }
  return null;
}

export function assertRuntimeCompatibility(target, runtime) {
  const actual = runtimeTarget(runtime);
  assert.notEqual(
    actual,
    null,
    `runtime ${runtime.platform}/${runtime.arch} is not a supported GNU target`,
  );
  assert.equal(
    actual,
    target.id,
    `artifact ${target.id} does not match runtime ${String(actual)}`,
  );
}

export async function assertPackageLayout(packageRoot, target, packageJson) {
  assert.deepEqual(Object.keys(packageJson.exports), [".", "./package.json"]);
  assert.equal(packageJson.scripts, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.bin.krx, `./${target.executable}`);
  assert.ok(
    existsSync(resolve(packageRoot, target.nodeBinding)),
    "matching native binding is missing",
  );
  assert.ok(
    existsSync(resolve(packageRoot, target.executable)),
    "matching native executable is missing",
  );
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

  const binding = await lstat(resolve(packageRoot, target.nodeBinding));
  const executable = await lstat(resolve(packageRoot, target.executable));
  assert.ok(binding.isFile(), "native binding must be a regular file");
  assert.ok(executable.isFile(), "native executable must be a regular file");
  if (target.nodePlatform !== "win32") {
    assert.notEqual(
      executable.mode & 0o111,
      0,
      "native executable must retain Unix execute permission",
    );
  }
}
