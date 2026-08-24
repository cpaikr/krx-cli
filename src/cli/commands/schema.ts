import { Command } from "commander";
import { ENDPOINTS, type ResponseFieldDef } from "../../client/endpoints.js";
import { writeOutput, writeError } from "../../output/formatter.js";
import { EXIT_CODES } from "../exit-codes.js";
import {
  ADJUSTED_STOCK_OUTPUT_SCHEMA,
  isAdjustedStockEndpoint,
  type DerivedOutputSchema,
} from "../../client/stock-adjustment.js";
import { OPENAPI_WIRE } from "../../contracts/generated/openapi-registry.js";

interface SchemaEntry {
  readonly command: string;
  readonly endpoint: string;
  readonly description: string;
  readonly descriptionKo: string;
  readonly category: string;
  readonly params: readonly ParamDef[];
  readonly responseFields: readonly ResponseFieldDef[];
  readonly derivedOutput?: DerivedOutputSchema;
}

interface ParamDef {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

const COMMON_PARAMS: readonly ParamDef[] = [
  {
    name: OPENAPI_WIRE.requestDateField,
    type: "string",
    required: true,
    description: "Trading date in YYYYMMDD format",
  },
];

function getAllSchemas(): readonly SchemaEntry[] {
  return ENDPOINTS.map((endpoint) => ({
    command: endpoint.legacyCommand,
    endpoint: endpoint.path,
    description: endpoint.description,
    descriptionKo: endpoint.descriptionKo,
    category: endpoint.category,
    params: [...COMMON_PARAMS],
    responseFields: endpoint.responseFields,
    ...(isAdjustedStockEndpoint(endpoint.path)
      ? { derivedOutput: ADJUSTED_STOCK_OUTPUT_SCHEMA }
      : {}),
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
