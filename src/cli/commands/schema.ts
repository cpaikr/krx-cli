import { Command } from "commander";
import {
  ENDPOINTS,
  CATEGORIES,
  type ResponseFieldDef,
} from "../../client/endpoints.js";
import { writeOutput, writeError } from "../../output/formatter.js";
import { EXIT_CODES } from "../exit-codes.js";

interface SchemaEntry {
  readonly command: string;
  readonly endpoint: string;
  readonly description: string;
  readonly descriptionKo: string;
  readonly category: string;
  readonly params: readonly ParamDef[];
  readonly responseFields: readonly ResponseFieldDef[];
}

interface ParamDef {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

const COMMON_PARAMS: readonly ParamDef[] = [
  {
    name: "basDd",
    type: "string",
    required: true,
    description: "Trading date in YYYYMMDD format",
  },
];

function buildCommandName(endpoint: string): string {
  const parts = endpoint.replace("/svc/apis/", "").split("/");
  const categoryCode = parts[0];
  const apiName = parts[1];

  const category = CATEGORIES.find((c) => c.code === categoryCode);
  return `${category?.id ?? categoryCode}.${apiName}`;
}

function getAllSchemas(): readonly SchemaEntry[] {
  return ENDPOINTS.map((endpoint) => ({
    command: buildCommandName(endpoint.path),
    endpoint: endpoint.path,
    description: endpoint.description,
    descriptionKo: endpoint.descriptionKo,
    category: endpoint.category,
    params: [...COMMON_PARAMS],
    responseFields: endpoint.responseFields,
  }));
}

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema [command]")
    .description("Show API schema for agent introspection")
    .option("--all", "show all schemas")
    .action((command: string | undefined, opts: { all?: boolean }) => {
      if (opts.all || !command) {
        const schemas = getAllSchemas();
        writeOutput(JSON.stringify(schemas, null, 2));
        return;
      }

      const schemas = getAllSchemas();
      const match = schemas.find(
        (s) =>
          s.command === command ||
          s.command.toLowerCase() === command.toLowerCase(),
      );

      if (!match) {
        writeError(
          `Unknown command: ${command}. Use 'krx schema --all' to list all.`,
        );
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      writeOutput(JSON.stringify(match, null, 2));
    });
}
