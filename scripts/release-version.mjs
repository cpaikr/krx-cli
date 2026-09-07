import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const [mode, tag] = process.argv.slice(2);
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

if (mode === "upstream") {
  assert.equal(run("git", ["branch", "--show-current"]), "main");
  assert.equal(
    run("git", ["rev-parse", "--abbrev-ref", "@{upstream}"]),
    "origin/main",
  );
  run("git", ["fetch", "origin", "main"]);
  assert.equal(
    run("git", ["rev-parse", "HEAD"]),
    run("git", ["rev-parse", "origin/main"]),
    "release preparation requires main synchronized with freshly fetched origin/main",
  );
} else if (mode === "sync" || mode === "check") {
  const { version } = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  assert.match(
    version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    "invalid release version",
  );
  const manifest = resolve(root, "Cargo.toml");
  if (mode === "sync") {
    const source = readFileSync(manifest, "utf8");
    const workspaceVersion =
      /(\[workspace\.package\][^[]*?^version = ")[^"]+("$)/m;
    assert.match(
      source,
      workspaceVersion,
      "Cargo workspace version is missing",
    );
    writeFileSync(manifest, source.replace(workspaceVersion, `$1${version}$2`));
  }
  // Cargo owns lockfile updates; locked checks must never repair a stale release.
  const metadata = JSON.parse(
    run("cargo", [
      "metadata",
      "--offline",
      ...(mode === "check" ? ["--locked"] : []),
      "--format-version",
      "1",
    ]),
  );
  for (const member of metadata.packages.filter(({ id }) =>
    metadata.workspace_members.includes(id),
  )) {
    assert.equal(
      member.version,
      version,
      `${member.name} must match the release version`,
    );
  }
  if (tag) {
    assert.equal(
      tag,
      `v${version}`,
      "release tag must match the package version",
    );
    assert.equal(
      run("git", ["rev-parse", "HEAD"]),
      run("git", ["rev-parse", `refs/tags/${tag}^{commit}`]),
      "release tag must identify the checked-out commit",
    );
    run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  }
  process.stdout.write(`Release version ${version}: ${mode} passed\n`);
} else {
  throw new Error("usage: release-version.mjs upstream | sync | check [tag]");
}
