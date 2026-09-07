import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const [directory, tag] = process.argv.slice(2);
assert.ok(
  directory && tag,
  "usage: publish-release.mjs <bundle-directory> <tag>",
);
const repository = process.env.GITHUB_REPOSITORY;
assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const root = resolve(directory);
const manifest = JSON.parse(
  await readFile(resolve(root, "release-manifest.json")),
);
assert.equal(manifest.tag, tag);
assert.equal(tag, `v${manifest.version}`);
assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/);
const files = [
  ...manifest.targets.map(({ archive }) => archive),
  "SHA256SUMS",
  "release-manifest.json",
].sort();
assert.deepEqual(
  (await readdir(root)).sort(),
  files,
  "unexpected release bundle inventory",
);
for (const { archive, sha256 } of manifest.targets) {
  assert.match(archive, /^krx-cli-[0-9A-Za-z.-]+\.tgz$/);
  assert.equal(
    await digest(resolve(root, archive)),
    sha256,
    "release archive checksum mismatch",
  );
}
assert.equal(
  await readFile(resolve(root, "SHA256SUMS"), "utf8"),
  manifest.targets
    .map(({ archive, sha256 }) => `${sha256}  ${archive}\n`)
    .join(""),
);
assert.equal(
  gh(["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"]),
  manifest.sourceRevision,
  "remote release tag must still identify the certified source",
);

let release = readRelease();
if (!release) {
  gh([
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--draft",
    "--verify-tag",
    "--target",
    manifest.sourceRevision,
    "--title",
    tag,
    "--generate-notes",
    ...(manifest.version.includes("-") ? ["--prerelease"] : []),
  ]);
  release = readRelease();
}
assert.ok(release, "created release could not be read back");
await verifyDownloads(release, !release.isDraft);
if (release.isDraft) {
  const existing = new Set(release.assets.map(({ name }) => name));
  const missing = files.filter((name) => !existing.has(name));
  // Never replace assets. Interrupted uploads resume only when existing bytes match.
  if (missing.length) {
    gh([
      "release",
      "upload",
      tag,
      "--repo",
      repository,
      ...missing.map((name) => resolve(root, name)),
    ]);
  }
  release = readRelease();
  assert.ok(release, "release disappeared during upload");
  await verifyDownloads(release, true);
  if (release.isDraft)
    gh(["release", "edit", tag, "--repo", repository, "--draft=false"]);
}
assert.equal(
  readRelease()?.isDraft,
  false,
  "release publication was not confirmed",
);
process.stdout.write(`Published and verified ${repository} ${tag}\n`);

function gh(args, allowMissing = false) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (
    allowMissing &&
    result.status !== 0 &&
    /^release not found\s*$/.test(result.stderr ?? "")
  )
    return null;
  assert.equal(
    result.status,
    0,
    `gh ${args.slice(0, 2).join(" ")} failed: ${result.error?.message ?? result.stderr}`,
  );
  return result.stdout.trim();
}

function readRelease() {
  const value = gh(
    [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "isDraft,assets,tagName",
    ],
    true,
  );
  if (value === null) return null;
  const release = JSON.parse(value);
  assert.equal(release.tagName, tag);
  return release;
}

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function verifyDownloads(current, complete) {
  const names = current.assets.map(({ name }) => name).sort();
  assert.equal(
    new Set(names).size,
    names.length,
    "duplicate release asset names",
  );
  assert.ok(
    names.every((name) => files.includes(name)),
    "release contains unexpected assets",
  );
  if (complete)
    assert.deepEqual(names, files, "release is missing required assets");
  if (!names.length) return;
  const download = await mkdtemp(resolve(tmpdir(), "krx-release-download-"));
  try {
    gh(["release", "download", tag, "--repo", repository, "--dir", download]);
    assert.deepEqual((await readdir(download)).sort(), names);
    for (const name of names) {
      assert.equal(
        await digest(resolve(download, name)),
        await digest(resolve(root, name)),
        `remote ${name} differs from the certified release; existing assets were not changed`,
      );
    }
  } finally {
    await rm(download, { recursive: true, force: true });
  }
}
