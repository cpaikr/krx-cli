import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { installedBinCommand } from "./package-smoke-command.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "krx-cli-package-smoke-"));
const isWindows = process.platform === "win32";

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

const npmCommand = await resolveNpmCommand();

function run(command, args, options = {}) {
  const {
    allowFailure = false,
    cwd = repositoryRoot,
    timeoutMs = 30_000,
  } = options;

  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      const result = { code: code ?? 1, signal, stderr, stdout };
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      } else if (!allowFailure && code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit code ${code}\n${stderr}`,
          ),
        );
      } else {
        resolveRun(result);
      }
    });
  });
}

async function createTarball(packDirectory) {
  await mkdir(packDirectory, { recursive: true });
  const result = await run(
    npmCommand.command,
    [
      ...npmCommand.args,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDirectory,
    ],
    { cwd: repositoryRoot },
  );
  const report = JSON.parse(result.stdout);

  if (!Array.isArray(report) || report.length !== 1 || !report[0].filename) {
    throw new Error("npm pack did not report exactly one package artifact");
  }

  return resolve(packDirectory, report[0].filename);
}

async function listPackedTools(installRoot, sdkRoot) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(join(sdkRoot, "dist", "esm", "client", "index.js"))),
    import(pathToFileURL(join(sdkRoot, "dist", "esm", "client", "stdio.js"))),
  ]);
  const client = new Client({
    name: "krx-cli-package-smoke",
    version: "1.0.0",
  });
  const mcp = installedBinCommand(installRoot, "krx-mcp");
  const transport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args,
    stderr: "pipe",
  });

  try {
    await withTimeout(client.connect(transport), "MCP startup");
    return (await withTimeout(client.listTools(), "MCP tools/list")).tools;
  } finally {
    await client.close();
  }
}

async function withTimeout(promise, operation, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  const argumentsWithoutSeparator = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  if (argumentsWithoutSeparator.length > 1) {
    throw new Error("Expected at most one package tarball argument");
  }
  const [requestedTarball] = argumentsWithoutSeparator;
  const tarball = requestedTarball
    ? isAbsolute(requestedTarball)
      ? requestedTarball
      : resolve(repositoryRoot, requestedTarball)
    : await createTarball(join(temporaryRoot, "pack"));
  const installRoot = join(temporaryRoot, "install");

  await mkdir(installRoot, { recursive: true });
  await run(
    npmCommand.command,
    [
      ...npmCommand.args,
      "install",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      tarball,
    ],
    { cwd: temporaryRoot, timeoutMs: 120_000 },
  );

  const packageRoot = join(installRoot, "node_modules", "krx-cli");
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );

  const skillRoot = join(packageRoot, "skills", "krx-cli");
  const [skillEntry, cliReference, accessWorkflow] = await Promise.all([
    readFile(join(skillRoot, "SKILL.md"), "utf8"),
    readFile(join(skillRoot, "references", "cli-usage.md"), "utf8"),
    readFile(join(skillRoot, "workflows", "apply-service-access.md"), "utf8"),
  ]);
  if (
    !skillEntry.includes("name: krx-cli") ||
    !skillEntry.includes("references/cli-usage.md") ||
    !skillEntry.includes("workflows/apply-service-access.md") ||
    !cliReference.includes("# KRX CLI usage reference") ||
    !accessWorkflow.includes("# Apply for KRX endpoint service access")
  ) {
    throw new Error("Packed krx-cli skill is incomplete");
  }

  if (
    packageJson.bin?.krx !== "./dist/cli.js" ||
    packageJson.bin?.["krx-mcp"] !== "./dist/mcp.js"
  ) {
    throw new Error("Packed binary mappings do not match the release contract");
  }

  const helpCommand = installedBinCommand(installRoot, "krx", ["--help"]);
  const help = await run(helpCommand.command, helpCommand.args);
  if (!help.stdout.includes("Usage: krx")) {
    throw new Error("Packed krx --help output is missing its usage contract");
  }

  const schemaCommand = installedBinCommand(installRoot, "krx", [
    "schema",
    "--all",
  ]);
  const schema = await run(schemaCommand.command, schemaCommand.args);
  const schemas = JSON.parse(schema.stdout);
  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new Error("Packed krx schema --all returned no endpoint schemas");
  }

  const invalidCommand = installedBinCommand(installRoot, "krx", [
    "schema",
    "definitely-not-an-endpoint",
  ]);
  const invalid = await run(invalidCommand.command, invalidCommand.args, {
    allowFailure: true,
  });
  if (invalid.code !== 2) {
    throw new Error(
      `Packed krx invalid argument exited ${invalid.code}, expected 2`,
    );
  }

  const sdkRoot = join(
    installRoot,
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
  );
  const tools = await listPackedTools(installRoot, sdkRoot);
  if (!tools.some((tool) => tool.name === "krx_schema")) {
    throw new Error("Packed krx-mcp tools/list omitted krx_schema");
  }

  process.stdout.write(
    `Packed artifact smoke passed: ${schemas.length} schemas, ${tools.length} MCP tools\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
