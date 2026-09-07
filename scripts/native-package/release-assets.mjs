import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1]);
}
for (const name of ["--artifacts", "--reports", "--out", "--revision"]) {
  assert.ok(values.get(name), `missing ${name}`);
}
const root = process.cwd();
const artifacts = resolve(values.get("--artifacts"));
const reportsRoot = resolve(values.get("--reports"));
const output = resolve(values.get("--out"));
const revision = values.get("--revision");
const { version } = JSON.parse(await readFile(resolve(root, "package.json")));
const manifest = JSON.parse(
  await readFile(resolve(root, "contracts/product/v1/native-targets.json")),
);
assert.match(revision, /^[a-f0-9]{40}$/);
const tag = `v${version}`;
const certifiedTargets = manifest.distribution.continuousCertificationTargets;
assert.ok(Array.isArray(certifiedTargets) && certifiedTargets.length > 0);
assert.equal(new Set(certifiedTargets).size, certifiedTargets.length);
assert.ok(
  certifiedTargets.every((id) =>
    manifest.targets.some((target) => target.id === id),
  ),
);
const expectedReports = certifiedTargets
  .flatMap((id) =>
    manifest.distribution.nodeMajors.map((node) => `${id}-node${node}.json`),
  )
  .sort();
assert.deepEqual(
  (await readdir(reportsRoot)).sort(),
  expectedReports,
  "release requires reports for every CI target and supported Node version",
);
const reports = await Promise.all(
  expectedReports.map(async (name) =>
    JSON.parse(await readFile(resolve(reportsRoot, name))),
  ),
);
const baseline = reports[0];
const targets = [];
for (const target of manifest.targets) {
  const archive = manifest.distribution.assetNameTemplate
    .replace("{version}", version)
    .replace("{target}", target.id);
  const sha256 = createHash("sha256")
    .update(await readFile(resolve(artifacts, archive)))
    .digest("hex");
  const nodeMajors = certifiedTargets.includes(target.id)
    ? manifest.distribution.nodeMajors
    : [];
  for (const node of nodeMajors) {
    const report = JSON.parse(
      await readFile(resolve(reportsRoot, `${target.id}-node${node}.json`)),
    );
    assert.equal(report.status, "passed");
    assert.equal(report.target, target.id);
    assert.equal(report.node, node);
    assert.equal(report.packageVersion, version);
    assert.equal(
      report.sourceRevision,
      revision,
      "certification must identify the release source",
    );
    assert.equal(
      report.archiveSha256,
      sha256,
      "release must use the exact certified archive",
    );
    assert.equal(
      report.portableSha256,
      baseline.portableSha256,
      "portable package sources must match across targets",
    );
    assert.deepEqual(report.packageMetadata, baseline.packageMetadata);
    assert.deepEqual(report.capability, baseline.capability);
  }
  targets.push({
    target: target.id,
    archive,
    sha256,
    nodeMajors,
  });
}
assert.deepEqual(
  (await readdir(artifacts)).sort(),
  targets.map(({ archive }) => archive).sort(),
  "release archive inventory must match the supported target manifest",
);
// The bundle is built only after the complete certification set has passed.
await mkdir(output);
for (const { archive } of targets) {
  await copyFile(resolve(artifacts, archive), resolve(output, archive));
}
await writeFile(
  resolve(output, "release-manifest.json"),
  `${JSON.stringify({ tag, version, sourceRevision: revision, targets }, null, 2)}\n`,
);
await writeFile(
  resolve(output, "SHA256SUMS"),
  targets.map(({ archive, sha256 }) => `${sha256}  ${archive}\n`).join(""),
);
process.stdout.write(
  `Prepared ${tag}: ${targets.length} archives at ${revision}\n`,
);
