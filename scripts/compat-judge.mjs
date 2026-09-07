import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
const cliOverlay = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "contracts/product/v1/cli-overlay.json"),
    "utf8",
  ),
);
const candidateCliCases = JSON.parse(
  await readFile(resolve(repositoryRoot, cliOverlay.candidateCases), "utf8"),
).cases;
const candidateBehaviorIds = new Set(
  cliOverlay.behaviorChanges.map(({ id }) => id),
);
for (const requiredBehavior of [
  "headless-credential-store-fails-closed",
  "mcp-schema-metadata-removed",
]) {
  assertion(
    candidateBehaviorIds.has(requiredBehavior),
    `candidate compatibility waiver is absent from the CLI overlay: ${requiredBehavior}`,
  );
}
const schemaOracle = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "tests/compat/oracles/schema-all.json"),
    "utf8",
  ),
);
const nativeSchemaOracle = schemaOracle.map((schema) => {
  const projected = structuredClone(schema);
  if (projected.derivedOutput?.optOut !== undefined) {
    delete projected.derivedOutput.optOut.mcp;
  }
  return projected;
});
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

function candidateRow(endpoint, row) {
  const schema = schemaOracle.find(({ endpoint: path }) => path === endpoint);
  assertion(schema !== undefined, `schema oracle omitted ${endpoint}`);
  return Object.fromEntries(
    schema.responseFields.map(({ name }) => [
      name,
      name === "ISU_CD" && typeof row.ISU_SRT_CD === "string"
        ? row.ISU_SRT_CD
        : (row[name] ?? ""),
    ]),
  );
}

async function seedCache(home, name, profile) {
  if (name === "adjustedSamsungSplit") {
    const oracle = adjustmentOracles.cases.find(
      ({ name }) => name === "samsung-50-for-1-split-through-suspension",
    );
    assertion(oracle !== undefined, "adjustment oracle was absent");
    for (const row of oracle.raw) {
      await writeCacheEntry(home, {
        data:
          profile === "candidate"
            ? [candidateRow(endpointFixtures.kospiStocks.endpoint, row)]
            : [row],
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
      data:
        profile === "candidate"
          ? fixture.data.map((row) => candidateRow(fixture.endpoint, row))
          : fixture.data,
      date: fixtureDate,
      endpoint: fixture.endpoint,
    });
  }
}

async function writeCacheEntry(home, { data, date, endpoint }) {
  const params = { basDd: date };
  const directory = join(home, ".krx-cli", "cache", date);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${cacheKey(endpoint, params)}.json`);
  await writeFile(
    destination,
    `${JSON.stringify({
      version: 1,
      fetchedAt: new Date().toISOString(),
      endpoint,
      params: sortedParams(params),
      data,
    })}\n`,
    { mode: 0o600 },
  );
  return destination;
}

function v2CachePath(home, operationId, date) {
  const parameters = JSON.stringify([["basDd", date]]);
  const digest = createHash("sha256")
    .update(`krx-cache-v2\n${operationId}\n${parameters}`)
    .digest("hex");
  return join(home, ".krx-cli", "cache", "v2", date, `${digest}.json`);
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

async function secureWindowsFixture(home) {
  if (process.platform !== "win32") return;
  // POSIX mode flags do not set Windows ownership. These paths were just
  // created by this harness; establish the private fixture precondition before
  // testing the installed product's refusal to repair unsafe existing state.
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$root = Get-Item -LiteralPath $env:KRX_FIXTURE_STATE
$entries = @($root) + @(Get-ChildItem -LiteralPath $root.FullName -Recurse -Force)
foreach ($entry in $entries) {
  if ($entry.PSIsContainer) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $entry.FullName -AclObject $acl
}
`;
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      cwd: repositoryRoot,
      env: { ...process.env, KRX_FIXTURE_STATE: join(home, ".krx-cli") },
    },
  );
  if (result.code !== 0) {
    throw new Error(`Windows fixture security setup failed: ${result.stderr}`);
  }
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
      ? /^\s+(?:-[A-Za-z],\s+)?--([a-z][a-z0-9-]*)\b/.exec(line)
      : null;
    if (match) options.add(match[1]);
  }
  return options;
}

function inventoryFor(profile) {
  const inventory = structuredClone(commandInventory);
  if (profile === "legacy") return inventory;
  assertion(
    profile === "candidate",
    `unknown compatibility profile ${profile}`,
  );
  const byPath = (path) =>
    inventory.find(
      (entry) => JSON.stringify(entry.path) === JSON.stringify(path),
    );
  for (const change of cliOverlay.inventoryChanges) {
    const entry = byPath(change.path);
    assertion(
      entry !== undefined,
      `overlay path ${change.path.join(" ")} is absent`,
    );
    if (change.change === "remove-command") {
      entry.commands = (entry.commands ?? []).filter(
        (command) => command !== change.name,
      );
      const removedPath = [...change.path, change.name];
      const index = inventory.findIndex(
        (candidate) =>
          JSON.stringify(candidate.path) === JSON.stringify(removedPath),
      );
      if (index >= 0) inventory.splice(index, 1);
    } else if (change.change === "add-command") {
      entry.commands = [...(entry.commands ?? []), change.name];
      inventory.push({
        path: [...change.path, change.name],
        options: change.options ?? ["help"],
      });
    } else if (change.change === "add-option") {
      entry.options = [...(entry.options ?? ["help"]), change.name];
    } else {
      throw new Error(`unsupported inventory overlay ${change.change}`);
    }
  }
  return inventory;
}

async function assessCommandInventory(installRoot, runOptions, profile) {
  const inventory = inventoryFor(profile);
  const rootOptions = new Set(
    inventory.find(({ path }) => path.length === 0).options,
  );
  for (const entry of inventory) {
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
    if (profile === "candidate" && entry.path.length > 0) {
      const expectedOptions = new Set(entry.options ?? ["help"]);
      for (const option of rootOptions) {
        if (option !== "help" && !expectedOptions.has(option)) {
          optionNames.delete(option);
        }
      }
    }
    assertSetEquals(commands, entry.commands ?? [], `${label} commands`);
    assertSetEquals(optionNames, entry.options ?? ["help"], `${label} options`);
  }
}

function expectedText(text, installedVersion) {
  return text.replaceAll("{{version}}", installedVersion);
}

function assessScenario(scenario, result, installedVersion, profile) {
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
    if (expected.json !== undefined) {
      const expectedJson =
        profile === "candidate" && scenario.id === "cached-row-pipeline"
          ? expected.json.map((row) => {
              const candidateRow = { ...row };
              delete candidateRow.ISU_SRT_CD;
              return candidateRow;
            })
          : expected.json;
      assertion(sameJsonValue(parsed, expectedJson), "JSON did not match");
    }
    if (expected.jsonFixture !== undefined) {
      if (profile === "candidate") {
        assertCandidateRows(
          parsed,
          fixtures[expected.jsonFixture],
          expected.jsonFixture,
        );
      } else {
        assertion(
          sameJsonValue(parsed, fixtures[expected.jsonFixture]),
          "fixture JSON did not match",
        );
      }
    }
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
        sameJsonValue(
          parsed,
          profile === "candidate" ? nativeSchemaOracle : schemaOracle,
        ),
        "complete schema oracle did not match",
      );
    if (expected.adjustmentOracle === true)
      assertion(
        sameJsonValue(
          parsed,
          profile === "candidate"
            ? candidateAdjustmentOracle(adjustedRangeOracle)
            : adjustedRangeOracle,
        ),
        "complete adjusted-range oracle did not match",
      );
  }
}

function assertCandidateRows(actual, expected, fixtureName) {
  const endpoint = endpointFixtures[fixtureName]?.endpoint;
  assertion(
    endpoint !== undefined,
    `candidate fixture ${fixtureName} has no endpoint`,
  );
  assertion(
    sameJsonValue(
      actual,
      expected.map((row) => candidateRow(endpoint, row)),
    ),
    "candidate fixture JSON did not match its exact canonical cache migration projection",
  );
}

function candidateAdjustmentOracle(oracle) {
  const derivedFields = [
    "ADJ_TDD_OPNPRC",
    "ADJ_TDD_HGPRC",
    "ADJ_TDD_LWPRC",
    "ADJ_TDD_CLSPRC",
    "ADJ_FACTOR",
  ];
  return {
    ...oracle,
    data: oracle.data.map((row) => ({
      ...candidateRow(endpointFixtures.kospiStocks.endpoint, row),
      ...Object.fromEntries(derivedFields.map((name) => [name, row[name]])),
    })),
  };
}

async function runCandidateMigrationCases(installRoot, report) {
  const endpoint = endpointFixtures.kospiStocks.endpoint;
  const operationId = "stock_stk_bydd_trd";
  const canonicalRows = fixtures.kospiStocks.map((row) =>
    candidateRow(endpoint, row),
  );
  const contractCase = (id, polarity, setup) => {
    const candidate = candidateCliCases.find((entry) => entry.id === id);
    assertion(candidate !== undefined, `candidate CLI case is absent: ${id}`);
    assertion(
      candidate.coversBehavior === "strict-canonical-cache-row-migration" &&
        candidate.polarity === polarity &&
        candidate.setup === setup,
      `candidate CLI migration case drifted: ${id}`,
    );
    return candidate;
  };
  const canonicalCase = contractCase(
    "canonical-legacy-cache-row-migrates",
    "positive",
    "cache-v1-canonical-openapi-row",
  );
  const invalidCase = contractCase(
    "noncanonical-legacy-cache-row-rejected",
    "rejection",
    "cache-v1-row-with-unknown-field",
  );
  const definitions = [
    {
      id: canonicalCase.id,
      args: canonicalCase.args,
      rows: canonicalRows,
      assess: async ({ home, legacyPath, result }) => {
        assertion(
          result.code === canonicalCase.expect.code,
          `migration exited ${result.code}`,
        );
        const current = JSON.parse(
          await readFile(v2CachePath(home, operationId, fixtureDate), "utf8"),
        );
        assertion(current.version === 2, "migration did not create cache v2");
        assertion(
          current.operationId === operationId,
          "migrated operation ID did not match",
        );
        assertion(
          /^[0-9a-f]{64}$/u.test(current.schemaSha256),
          "migrated schema digest was not canonical",
        );
        assertion(
          sameJsonValue(current.params, [["basDd", fixtureDate]]),
          "migrated parameters did not match",
        );
        assertion(
          sameJsonValue(current.rows, canonicalRows),
          "migrated rows did not match the canonical OpenAPI schema",
        );
        await access(legacyPath).then(
          () => {
            throw new Error("legacy cache remained after v2 promotion");
          },
          () => undefined,
        );
      },
    },
    {
      id: invalidCase.id,
      args: invalidCase.args,
      rows: [{ ...canonicalRows[0], UNKNOWN_PROVIDER_FIELD: "rejected" }],
      withoutApiKey: true,
      assess: async ({ home, result }) => {
        assertion(
          result.code === invalidCase.expect.code,
          `invalid legacy row exited ${result.code}`,
        );
        assertion(result.stdout === "", "invalid legacy row wrote stdout");
        assertion(
          result.stderr.includes("/cache_invalid]"),
          "invalid legacy row did not report cache_invalid",
        );
        await access(v2CachePath(home, operationId, fixtureDate)).then(
          () => {
            throw new Error("invalid legacy row created cache v2");
          },
          () => undefined,
        );
      },
    },
  ];

  for (const definition of definitions) {
    const scenarioRoot = await mkdtemp(
      join(
        resolve(repositoryRoot, "target/compat-scenarios"),
        "krx-migration-",
      ),
    );
    try {
      const home = join(scenarioRoot, "home");
      const cwd = join(scenarioRoot, "cwd");
      await Promise.all([
        mkdir(home, { recursive: true, mode: 0o700 }),
        mkdir(cwd, { recursive: true, mode: 0o700 }),
      ]);
      const legacyPath = await writeCacheEntry(home, {
        data: definition.rows,
        date: fixtureDate,
        endpoint,
      });
      await seedQuota(home);
      await secureWindowsFixture(home);
      const command = installedBinCommand(installRoot, "krx", definition.args);
      const result = await run(command.command, command.args, {
        cwd,
        env: processEnvironment(home, definition.withoutApiKey),
      });
      try {
        await definition.assess({ home, legacyPath, result });
        report.push({ id: definition.id, status: "passed" });
      } catch (error) {
        report.push({
          id: definition.id,
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
}

export async function runCompatibilityJudge(
  installRoot,
  { profile = "legacy", mutateResult = (_scenario, result) => result } = {},
) {
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
  const scenarioRootBase = resolve(repositoryRoot, "target/compat-scenarios");
  await mkdir(scenarioRootBase, { recursive: true, mode: 0o700 });
  for (const scenario of scenarios) {
    const scenarioRoot = await mkdtemp(
      join(scenarioRootBase, "krx-compat-scenario-"),
    );
    try {
      const home = join(scenarioRoot, "home");
      const cwd = join(scenarioRoot, "cwd");
      await Promise.all([
        mkdir(home, { recursive: true, mode: 0o700 }),
        mkdir(cwd, { recursive: true, mode: 0o700 }),
      ]);
      let result;
      try {
        await seedCache(home, scenario.cache, profile);
        await seedQuota(home);
        await secureWindowsFixture(home);
        if (scenario.commandInventory === true) {
          await assessCommandInventory(
            installRoot,
            {
              cwd,
              env: processEnvironment(home, scenario.withoutApiKey),
            },
            profile,
          );
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
          result = mutateResult(scenario, result);
          assessScenario(scenario, result, installedManifest.version, profile);
        }
        report.push({ id: scenario.id, status: "passed" });
      } catch (error) {
        if (
          profile === "candidate" &&
          scenario.id === "missing-credential" &&
          result?.code === 1 &&
          result.stdout === "" &&
          result.stderr ===
            "krx: error[local_state/credential_read_failed]: credential read failed\n"
        ) {
          report.push({
            id: scenario.id,
            status: "passed",
            classification: "headless-credential-store-fails-closed",
          });
          continue;
        }
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
  if (profile === "candidate") {
    await runCandidateMigrationCases(installRoot, report);
  }
  return report;
}
