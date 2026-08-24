import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import { runCompatibilityJudge } from "./compat-judge.mjs";
import { resolveNpmCommand } from "./native-package/npm-command.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}
const candidateArgument = argumentsByName.get("--candidate-tarball");
if (!candidateArgument) {
  throw new Error(
    "usage: compat-certify.mjs --candidate-tarball <native-package.tgz>",
  );
}
const candidateTarball = resolve(candidateArgument);

function run(
  command,
  args,
  { cwd = repositoryRoot, timeoutMs = 120_000 } = {},
) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun({ stderr, stdout });
      } else {
        reject(
          new Error(`${command} failed with exit ${code}\n${stderr || stdout}`),
        );
      }
    });
  });
}

function failedScenarios(report) {
  return report.filter(({ status }) => status === "failed");
}

function requirePassing(report, label) {
  const failures = failedScenarios(report);
  if (failures.length > 0) {
    throw new Error(`${label} failed:\n${JSON.stringify(failures, null, 2)}`);
  }
}

async function requireSingleMutantFailure({
  installRoot,
  mutantName,
  scenarioId,
  mutateResult,
}) {
  const report = await runCompatibilityJudge(installRoot, {
    profile: "candidate",
    mutateResult,
  });
  const failures = failedScenarios(report);
  if (failures.length !== 1 || failures[0].id !== scenarioId) {
    throw new Error(
      `${mutantName} mutant did not fail only ${scenarioId}:\n${JSON.stringify(report, null, 2)}`,
    );
  }
}

const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), "krx-native-compat-certify-"),
);
try {
  const installRoot = resolve(temporaryRoot, "candidate");
  await mkdir(installRoot, { recursive: true });
  const { command: npm, argumentPrefix } = resolveNpmCommand();
  await run(
    npm,
    [
      ...argumentPrefix,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      candidateTarball,
    ],
    { cwd: temporaryRoot },
  );

  const baseline = await runCompatibilityJudge(installRoot, {
    profile: "candidate",
  });
  requirePassing(baseline, "native candidate");

  await requireSingleMutantFailure({
    installRoot,
    mutantName: "no-data exit",
    scenarioId: "empty-result-exit",
    mutateResult: (scenario, result) =>
      scenario.id === "empty-result-exit" ? { ...result, code: 2 } : result,
  });
  await requireSingleMutantFailure({
    installRoot,
    mutantName: "schema description",
    scenarioId: "schema-inventory",
    mutateResult: (scenario, result) =>
      scenario.id === "schema-inventory"
        ? {
            ...result,
            stdout: result.stdout.replace(
              "ESG index info",
              "Changed ESG index info",
            ),
          }
        : result,
  });
  await requireSingleMutantFailure({
    installRoot,
    mutantName: "adjustment metadata",
    scenarioId: "adjusted-stock-range",
    mutateResult: (scenario, result) =>
      scenario.id === "adjusted-stock-range"
        ? {
            ...result,
            stdout: result.stdout.replace(
              "nearest-integer-half-up",
              "changed-rounding-policy",
            ),
          }
        : result,
  });

  process.stdout.write(
    `Native compatibility judge passed ${baseline.length} installed-product checks ` +
      "(14 frozen compatibility scenarios plus 2 native migration cases); " +
      "the no-data exit, schema, and adjustment mutants were rejected by their named scenarios\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
