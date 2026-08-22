import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { installedBinCommand } from "./package-smoke-command.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);
const scenarios = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "tests/compat/scenarios.json"),
    "utf8",
  ),
);
const fixtures = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "tests/compat/fixtures/cache-rows.json"),
    "utf8",
  ),
);
const commandInventory = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "tests/compat/command-inventory.json"),
    "utf8",
  ),
);
const schemaOracle = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "tests/compat/oracles/schema-all.json"),
    "utf8",
  ),
);
const adjustedRangeOracle = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "tests/compat/oracles/adjusted-stock-range.json"),
    "utf8",
  ),
);
const adjustmentOracles = JSON.parse(
  await readFile(
    resolve(
      repositoryRoot,
      "tests/fixtures/adjusted-stock-prices/oracles.json",
    ),
    "utf8",
  ),
);
const apiKey = "compat-judge-key";
const fixtureDate = "20260102";
const endpointFixtures = {
  kospiStocks: {
    data: fixtures.kospiStocks,
    endpoint: "/svc/apis/sto/stk_bydd_trd",
  },
  kospiIndex: {
    data: fixtures.kospiIndex,
    endpoint: "/svc/apis/idx/kospi_dd_trd",
  },
  kosdaqIndex: {
    data: fixtures.kosdaqIndex,
    endpoint: "/svc/apis/idx/kosdaq_dd_trd",
  },
};

function normalized(text) {
  return text.replaceAll("\r\n", "\n");
}

function sortedParams(params) {
  return Object.entries(params).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function cacheKey(endpoint, params) {
  const raw = `${endpoint}:${JSON.stringify(sortedParams(params))}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function kstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
}

async function seedCache(home, name) {
  if (name === "adjustedSamsungSplit") {
    const oracle = adjustmentOracles.cases.find(
      ({ name }) => name === "samsung-50-for-1-split-through-suspension",
    );
    assertion(oracle !== undefined, "adjustment oracle was absent");
    for (const row of oracle.raw) {
      await writeCacheEntry(home, {
        data: [row],
        date: row.BAS_DD,
        endpoint: endpointFixtures.kospiStocks.endpoint,
      });
    }
    return;
  }

  const requested =
    name === "partialMarketSummary"
      ? ["kospiStocks", "kospiIndex", "kosdaqIndex"]
      : name
        ? [name]
        : [];
  for (const fixtureName of requested) {
    const fixture = endpointFixtures[fixtureName];
    assertion(
      fixture !== undefined,
      `cache fixture ${fixtureName} was not defined`,
    );
    await writeCacheEntry(home, {
      data: fixture.data,
      date: fixtureDate,
      endpoint: fixture.endpoint,
    });
  }
}

async function writeCacheEntry(home, { data, date, endpoint }) {
  const params = { basDd: date };
  const directory = join(home, ".krx-cli", "cache", date);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `${cacheKey(endpoint, params)}.json`),
    `${JSON.stringify({
      version: 1,
      fetchedAt: new Date().toISOString(),
      endpoint,
      params: sortedParams(params),
      data,
    })}\n`,
    { mode: 0o600 },
  );
}

async function seedQuota(home) {
  const config = join(home, ".krx-cli");
  await mkdir(config, { recursive: true, mode: 0o700 });
  const fingerprint = createHash("sha256").update(apiKey).digest("hex");
  await writeFile(
    join(config, "rate-limit.json"),
    `${JSON.stringify({
      version: 1,
      credentials: { [fingerprint]: { date: kstDate(), count: 10_000 } },
    })}\n`,
    { mode: 0o600 },
  );
}

function processEnvironment(home, withoutApiKey) {
  const allowed = [
    "ComSpec",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "WINDIR",
  ];
  const environment = Object.fromEntries(
    allowed
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    ...(withoutApiKey ? {} : { KRX_API_KEY: apiKey }),
  };
}

function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code: code ?? 1,
        signal,
        stderr: normalized(stderr),
        stdout: normalized(stdout),
      });
    });
  });
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

export function sameJsonValue(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

function compareJsonSubset(actual, expected, path = "result") {
  for (const [key, value] of Object.entries(expected)) {
    assertion(
      sameJsonValue(actual?.[key], value),
      `${path}.${key} did not match`,
    );
  }
}

function assertSetEquals(actual, expected, label) {
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expectedSet.has(name));
  assertion(
    missing.length === 0 && extra.length === 0,
    `${label} differed (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
  );
}

function helpCommands(stdout) {
  const commands = new Set();
  let inCommands = false;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "Commands:") {
      inCommands = true;
      continue;
    }
    if (inCommands && /^\S.*:$/.test(line)) {
      inCommands = false;
      continue;
    }
    const match = inCommands ? /^ {2}([a-z][a-z0-9-]*)\b/.exec(line) : null;
    if (match && match[1] !== "help") commands.add(match[1]);
  }
  return commands;
}

function helpOptions(stdout) {
  const options = new Set();
  let inOptions = false;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "Options:") {
      inOptions = true;
      continue;
    }
    if (inOptions && /^\S.*:$/.test(line)) {
      inOptions = false;
      continue;
    }
    const match = inOptions
      ? /^ {2}(?:-[A-Za-z],\s+)?--([a-z][a-z0-9-]*)\b/.exec(line)
      : null;
    if (match) options.add(match[1]);
  }
  return options;
}

async function assessCommandInventory(installRoot, runOptions) {
  for (const entry of commandInventory) {
    const command = installedBinCommand(installRoot, "krx", [
      ...entry.path,
      "--help",
    ]);
    const result = await run(command.command, command.args, runOptions);
    const label =
      entry.path.length === 0 ? "krx" : `krx ${entry.path.join(" ")}`;
    assertion(
      result.signal === null,
      `${label} help terminated by ${result.signal}`,
    );
    assertion(result.code === 0, `${label} help exited ${result.code}`);
    assertion(result.stderr === "", `${label} help wrote to stderr`);
    const commands = helpCommands(result.stdout);
    const optionNames = helpOptions(result.stdout);
    assertSetEquals(commands, entry.commands ?? [], `${label} commands`);
    assertSetEquals(optionNames, entry.options ?? ["help"], `${label} options`);
  }
}

function expectedText(text, installedVersion) {
  return text.replaceAll("{{version}}", installedVersion);
}

function assessScenario(scenario, result, installedVersion) {
  const expected = scenario.expect;
  assertion(result.signal === null, `terminated by ${result.signal}`);
  assertion(result.code === expected.code, `exited ${result.code}`);
  if (expected.stdout !== undefined)
    assertion(
      result.stdout === expectedText(expected.stdout, installedVersion),
      "stdout did not match",
    );
  if (expected.stderr !== undefined)
    assertion(
      result.stderr === expectedText(expected.stderr, installedVersion),
      "stderr did not match",
    );
  for (const text of expected.stdoutIncludes ?? [])
    assertion(
      result.stdout.includes(expectedText(text, installedVersion)),
      `stdout omitted ${text}`,
    );
  for (const text of expected.stdoutExcludes ?? [])
    assertion(
      !result.stdout.includes(expectedText(text, installedVersion)),
      `stdout unexpectedly included ${text}`,
    );
  for (const text of expected.stderrIncludes ?? [])
    assertion(
      result.stderr.includes(expectedText(text, installedVersion)),
      `stderr omitted ${text}`,
    );

  if (
    expected.json !== undefined ||
    expected.jsonFixture !== undefined ||
    expected.jsonSubset !== undefined ||
    expected.completeness !== undefined ||
    expected.schemaCount !== undefined ||
    expected.schemaOracle === true ||
    expected.adjustmentOracle === true
  ) {
    const parsed = JSON.parse(result.stdout);
    if (expected.json !== undefined)
      assertion(sameJsonValue(parsed, expected.json), "JSON did not match");
    if (expected.jsonFixture !== undefined)
      assertion(
        sameJsonValue(parsed, fixtures[expected.jsonFixture]),
        "fixture JSON did not match",
      );
    if (expected.jsonSubset !== undefined)
      compareJsonSubset(parsed, expected.jsonSubset);
    if (expected.completeness !== undefined) {
      assertion(
        parsed.completeness?.state === expected.completeness.state,
        "completeness state did not match",
      );
      assertion(
        sameJsonValue(
          parsed.completeness?.succeeded,
          expected.completeness.succeeded,
        ),
        "completeness succeeded partition did not match",
      );
      assertion(
        sameJsonValue(
          parsed.completeness?.failed?.map(({ id }) => id),
          expected.completeness.failed,
        ),
        "completeness failed partition did not match",
      );
    }
    if (expected.schemaCount !== undefined) {
      assertion(Array.isArray(parsed), "schema output was not an array");
      assertion(
        parsed.length === expected.schemaCount,
        "schema count did not match",
      );
      assertion(
        new Set(parsed.map(({ endpoint }) => endpoint)).size ===
          expected.schemaCount,
        "schema endpoints were not unique",
      );
      const adjusted = parsed.find(
        ({ command }) => command === "stock.stk_bydd_trd",
      );
      assertion(
        adjusted?.derivedOutput?.provenance === "krx-cli-derived",
        "adjusted schema provenance was absent",
      );
    }
    if (expected.schemaOracle === true)
      assertion(
        sameJsonValue(parsed, schemaOracle),
        "complete schema oracle did not match",
      );
    if (expected.adjustmentOracle === true)
      assertion(
        sameJsonValue(parsed, adjustedRangeOracle),
        "complete adjusted-range oracle did not match",
      );
  }
}

export async function runCompatibilityJudge(installRoot) {
  const installedManifest = JSON.parse(
    await readFile(
      resolve(
        installRoot,
        "node_modules",
        ...packageManifest.name.split("/"),
        "package.json",
      ),
      "utf8",
    ),
  );
  assertion(
    installedManifest.name === packageManifest.name,
    `installed package name was ${installedManifest.name ?? "missing"}`,
  );
  assertion(
    typeof installedManifest.version === "string" &&
      installedManifest.version.length > 0,
    "installed package version was missing",
  );
  const report = [];
  for (const scenario of scenarios) {
    const scenarioRoot = await mkdtemp(join(tmpdir(), "krx-compat-scenario-"));
    try {
      const home = join(scenarioRoot, "home");
      const cwd = join(scenarioRoot, "cwd");
      await Promise.all([
        mkdir(home, { recursive: true, mode: 0o700 }),
        mkdir(cwd, { recursive: true, mode: 0o700 }),
      ]);
      let result;
      try {
        await seedCache(home, scenario.cache);
        await seedQuota(home);
        if (scenario.commandInventory === true) {
          await assessCommandInventory(installRoot, {
            cwd,
            env: processEnvironment(home, scenario.withoutApiKey),
          });
        } else {
          const command = installedBinCommand(
            installRoot,
            "krx",
            scenario.args,
          );
          result = await run(command.command, command.args, {
            cwd,
            env: processEnvironment(home, scenario.withoutApiKey),
          });
          assessScenario(scenario, result, installedManifest.version);
        }
        report.push({ id: scenario.id, status: "passed" });
      } catch (error) {
        report.push({
          id: scenario.id,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
          ...(result
            ? {
                observation: {
                  code: result.code,
                  stderr: result.stderr,
                  stdout: result.stdout,
                },
              }
            : {}),
        });
      }
    } finally {
      await rm(scenarioRoot, { recursive: true, force: true });
    }
  }
  return report;
}
