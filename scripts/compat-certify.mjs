import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { runCompatibilityJudge } from "./compat-judge.mjs";
import { parseNpmPackReport } from "./package-smoke-command.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);
const isWindows = process.platform === "win32";
let npm;
let temporaryRoot;

async function resolveNpmCommand() {
  if (!isWindows) return { args: [], command: "npm" };
  const npmCli = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  await access(npmCli);
  return { args: [npmCli], command: process.execPath };
}

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
      if (code !== 0) {
        reject(new Error(`${command} failed with exit ${code}\n${stderr}`));
      } else {
        resolveRun({ stderr, stdout });
      }
    });
  });
}

async function pack() {
  const destination = join(temporaryRoot, "pack");
  await mkdir(destination, { recursive: true });
  const result = await run(
    npm.command,
    [
      ...npm.args,
      "pack",
      "--json",
      "--ignore-scripts",
      "--silent",
      "--pack-destination",
      destination,
    ],
    { cwd: repositoryRoot },
  );
  const report = parseNpmPackReport(result.stdout);
  if (!Array.isArray(report) || report.length !== 1 || !report[0].filename) {
    throw new Error("npm pack did not report exactly one artifact");
  }
  return resolve(destination, report[0].filename);
}

async function install(tarball, name) {
  const root = join(temporaryRoot, name);
  await mkdir(root, { recursive: true });
  await run(
    npm.command,
    [
      ...npm.args,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      root,
      tarball,
    ],
    { cwd: temporaryRoot },
  );
  return root;
}

function failures(report) {
  return report.filter(({ status }) => status === "failed");
}

async function mutateInstalledCli(root, source, target) {
  const cliPath = join(
    root,
    "node_modules",
    ...packageManifest.name.split("/"),
    "dist",
    "cli.js",
  );
  const original = await readFile(cliPath, "utf8");
  const occurrences = original.split(source).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one mutation site, found ${occurrences}`);
  }
  await writeFile(cliPath, original.replace(source, target));
}

function requireSingleFailure(report, scenarioId, mutantName) {
  const mutantFailures = failures(report);
  if (mutantFailures.length !== 1 || mutantFailures[0].id !== scenarioId) {
    throw new Error(
      `${mutantName} mutant did not fail only ${scenarioId}:\n${JSON.stringify(report, null, 2)}`,
    );
  }
}

try {
  npm = await resolveNpmCommand();
  await access(resolve(repositoryRoot, "dist/cli.js"));
  temporaryRoot = await mkdtemp(join(tmpdir(), "krx-compat-certify-"));
  const tarball = await pack();
  const baselineRoot = await install(tarball, "baseline");
  const baseline = await runCompatibilityJudge(baselineRoot);
  if (failures(baseline).length > 0) {
    throw new Error(
      `Legacy baseline failed:\n${JSON.stringify(baseline, null, 2)}`,
    );
  }

  const mutantRoot = await install(tarball, "mutant");
  await mutateInstalledCli(
    mutantRoot,
    "NO_DATA: {\n    code: 3,",
    "NO_DATA: {\n    code: 2,",
  );
  requireSingleFailure(
    await runCompatibilityJudge(mutantRoot),
    "empty-result-exit",
    "no-data exit",
  );

  const schemaMutantRoot = await install(tarball, "schema-mutant");
  await mutateInstalledCli(
    schemaMutantRoot,
    "ESG index info",
    "Changed ESG index info",
  );
  requireSingleFailure(
    await runCompatibilityJudge(schemaMutantRoot),
    "schema-inventory",
    "schema description",
  );

  const adjustmentMutantRoot = await install(tarball, "adjustment-mutant");
  await mutateInstalledCli(
    adjustmentMutantRoot,
    "nearest-integer-half-up",
    "changed-rounding-policy",
  );
  requireSingleFailure(
    await runCompatibilityJudge(adjustmentMutantRoot),
    "adjusted-stock-range",
    "adjustment metadata",
  );

  process.stdout.write(
    `Compatibility judge passed ${baseline.length} installed-package scenarios; ` +
      "the no-data exit, schema, and adjustment mutants were rejected by their named scenarios\n",
  );
} finally {
  if (temporaryRoot !== undefined)
    await rm(temporaryRoot, { recursive: true, force: true });
}
