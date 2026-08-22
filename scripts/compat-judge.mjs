import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedBinCommand } from "./package-smoke-command.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
    child.on("error", reject);
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

function compareJsonSubset(actual, expected, path = "result") {
  for (const [key, value] of Object.entries(expected)) {
    assertion(
      JSON.stringify(actual?.[key]) === JSON.stringify(value),
      `${path}.${key} did not match`,
    );
  }
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
  return new Set(
    stdout.match(/--[a-z][a-z0-9-]*/g)?.map((name) => name.slice(2)),
  );
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
    for (const name of entry.commands ?? [])
      assertion(commands.has(name), `${label} help omitted command ${name}`);
    for (const name of entry.forbiddenCommands ?? [])
      assertion(!commands.has(name), `${label} help included command ${name}`);
    for (const name of entry.options ?? [])
      assertion(
        optionNames.has(name),
        `${label} help omitted option --${name}`,
      );
  }
}

function assessScenario(scenario, result) {
  const expected = scenario.expect;
  assertion(result.signal === null, `terminated by ${result.signal}`);
  assertion(result.code === expected.code, `exited ${result.code}`);
  if (expected.stdout !== undefined)
    assertion(result.stdout === expected.stdout, "stdout did not match");
  if (expected.stderr !== undefined)
    assertion(result.stderr === expected.stderr, "stderr did not match");
  for (const text of expected.stdoutIncludes ?? [])
    assertion(result.stdout.includes(text), `stdout omitted ${text}`);
  for (const text of expected.stdoutExcludes ?? [])
    assertion(
      !result.stdout.includes(text),
      `stdout unexpectedly included ${text}`,
    );
  for (const text of expected.stderrIncludes ?? [])
    assertion(result.stderr.includes(text), `stderr omitted ${text}`);

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
      assertion(
        JSON.stringify(parsed) === JSON.stringify(expected.json),
        "JSON did not match",
      );
    if (expected.jsonFixture !== undefined)
      assertion(
        JSON.stringify(parsed) ===
          JSON.stringify(fixtures[expected.jsonFixture]),
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
        JSON.stringify(parsed.completeness?.succeeded) ===
          JSON.stringify(expected.completeness.succeeded),
        "completeness succeeded partition did not match",
      );
      assertion(
        JSON.stringify(parsed.completeness?.failed?.map(({ id }) => id)) ===
          JSON.stringify(expected.completeness.failed),
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
        JSON.stringify(parsed) === JSON.stringify(schemaOracle),
        "complete schema oracle did not match",
      );
    if (expected.adjustmentOracle === true)
      assertion(
        JSON.stringify(parsed) === JSON.stringify(adjustedRangeOracle),
        "complete adjusted-range oracle did not match",
      );
  }
}

export async function runCompatibilityJudge(installRoot) {
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
      await seedCache(home, scenario.cache);
      await seedQuota(home);
      if (scenario.commandInventory === true) {
        try {
          await assessCommandInventory(installRoot, {
            cwd,
            env: processEnvironment(home, scenario.withoutApiKey),
          });
          report.push({ id: scenario.id, status: "passed" });
        } catch (error) {
          report.push({
            id: scenario.id,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      const command = installedBinCommand(installRoot, "krx", scenario.args);
      const result = await run(command.command, command.args, {
        cwd,
        env: processEnvironment(home, scenario.withoutApiKey),
      });
      try {
        assessScenario(scenario, result);
        report.push({ id: scenario.id, status: "passed" });
      } catch (error) {
        report.push({
          id: scenario.id,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
          observation: {
            code: result.code,
            stderr: result.stderr,
            stdout: result.stdout,
          },
        });
      }
    } finally {
      await rm(scenarioRoot, { recursive: true, force: true });
    }
  }
  return report;
}
