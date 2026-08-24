import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1]);
}
const reportsRoot = resolve(values.get("--reports") ?? "");
if (!values.get("--reports")) {
  throw new Error("usage: compare-reports.mjs --reports <directory>");
}

const files = (await readdir(reportsRoot))
  .filter((name) => name.endsWith(".json"))
  .sort();
const reports = await Promise.all(
  files.map(async (name) =>
    JSON.parse(await readFile(resolve(reportsRoot, name), "utf8")),
  ),
);
const expectedTargets = ["linux-x64-gnu", "linux-arm64-gnu"];
assert.equal(reports.length, expectedTargets.length * 2);
for (const target of expectedTargets) {
  assert.deepEqual(
    reports
      .filter((report) => report.target === target)
      .map((report) => report.node)
      .sort((left, right) => left - right),
    [22, 24],
    `${target} must have Node 22 and 24 consumer reports`,
  );
}

const baseline = reports[0];
for (const report of reports) {
  assert.equal(report.status, "passed");
  assert.equal(
    report.portableSha256,
    baseline.portableSha256,
    `${report.target}/Node ${report.node} has divergent JS or declarations`,
  );
  assert.equal(report.packageVersion, baseline.packageVersion);
  assert.deepEqual(report.packageMetadata, baseline.packageMetadata);
  assert.deepEqual(
    report.capability,
    baseline.capability,
    `${report.target}/Node ${report.node} has divergent native capabilities`,
  );
}

process.stdout.write(
  `Cross-target package identity passed (${reports.length} consumer reports, ${baseline.portableSha256.slice(0, 12)})\n`,
);
