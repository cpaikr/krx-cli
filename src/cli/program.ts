import { Command, InvalidArgumentError, Option } from "commander";
import { registerAuthCommand } from "./commands/auth.js";
import { registerIndexCommand } from "./commands/index-cmd.js";
import { registerStockCommand } from "./commands/stock.js";
import { registerEtpCommand } from "./commands/etp.js";
import { registerBondCommand } from "./commands/bond.js";
import { registerDerivativeCommand } from "./commands/derivative.js";
import { registerCommodityCommand } from "./commands/commodity.js";
import { registerEsgCommand } from "./commands/esg.js";
import { registerSchemaCommand } from "./commands/schema.js";
import { registerCacheCommand } from "./commands/cache.js";
import { registerMarketCommand } from "./commands/market.js";
import { registerWatchlistCommand } from "./commands/watchlist.js";
import { registerVersionCommand, getVersion } from "./commands/version.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerServeCommand } from "./commands/serve.js";
import { PUBLIC_CONTRACT } from "../user-contract.js";
import { EXIT_CODES } from "./exit-codes.js";
import { UserInputError } from "../errors.js";

interface CliExitError extends Error {
  readonly code?: string;
  readonly exitCode?: number;
}

export function exitCodeForCliError(error: unknown): number {
  if (!(error instanceof Error)) return EXIT_CODES.GENERAL_ERROR;

  const cliError = error as CliExitError;
  if (cliError.exitCode === 0) return EXIT_CODES.SUCCESS;
  if (error instanceof UserInputError) return EXIT_CODES.USAGE_ERROR;
  if (cliError.code?.startsWith("commander.")) {
    return EXIT_CODES.USAGE_ERROR;
  }
  return cliError.exitCode ?? EXIT_CODES.GENERAL_ERROR;
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Must be a non-negative integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("Must be a safe non-negative integer.");
  }
  return parsed;
}

function overrideCommandExits(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) overrideCommandExits(child);
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("krx")
    .description("Agent-native CLI for KRX (Korea Exchange) Open API")
    .version(getVersion())
    .addOption(
      new Option(
        "-o, --output <format>",
        "row output format; defaults to table on a TTY and JSON when redirected (composite commands always return JSON)",
      ).choices([...PUBLIC_CONTRACT.output.formats]),
    )
    .option("-f, --fields <fields>", "fields for endpoint rows or stock search")
    .option("--dry-run", "show an endpoint row request without calling API")
    .option("-v, --verbose", "verbose output to stderr")
    .option("--code <isuCd>", "filter endpoint rows by stock code (ISU_CD)")
    .option("--sort <field>", "sort endpoint rows by field name")
    .option("--asc", "sort endpoint rows ascending (default: descending)")
    .option(
      "--offset <n>",
      "skip the first N endpoint rows",
      parseNonNegativeInteger,
    )
    .option(
      "--limit <n>",
      "limit endpoint row results",
      parseNonNegativeInteger,
    )
    .option("--no-cache", "bypass reads and writes for supported data commands")
    .option(
      "--refresh",
      "replace matching historical entries for supported data commands",
    )
    .option("--from <date>", "start date for endpoint row range (YYYYMMDD)")
    .option("--to <date>", "end date for endpoint row range (YYYYMMDD)")
    .option(
      "--filter <expression>",
      'filter endpoint rows (e.g. "FLUC_RT > 5")',
    )
    .option("--save <path>", "save endpoint row output to a file")
    .option(
      "--retries <n>",
      `max retries for a direct endpoint row request (default: ${PUBLIC_CONTRACT.requests.maxRetries})`,
      parseNonNegativeInteger,
    );

  registerAuthCommand(program);
  registerIndexCommand(program);
  registerStockCommand(program);
  registerEtpCommand(program);
  registerBondCommand(program);
  registerDerivativeCommand(program);
  registerCommodityCommand(program);
  registerEsgCommand(program);
  registerSchemaCommand(program);
  registerCacheCommand(program);
  registerMarketCommand(program);
  registerWatchlistCommand(program);
  registerVersionCommand(program);
  registerUpdateCommand(program);
  registerServeCommand(program);

  overrideCommandExits(program);

  return program;
}
