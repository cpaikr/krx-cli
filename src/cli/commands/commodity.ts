import { Command } from "commander";
import {
  executeCommand,
  resolveEndpoint,
  resolveDate,
} from "../command-helper.js";
import {
  OPENAPI_OPERATION_PATHS,
  OPENAPI_WIRE,
} from "../../contracts/generated/openapi-registry.js";

const TYPE_ENDPOINTS: Record<string, string> = {
  oil: OPENAPI_OPERATION_PATHS.commodity_oil_bydd_trd,
  gold: OPENAPI_OPERATION_PATHS.commodity_gold_bydd_trd,
  emission: OPENAPI_OPERATION_PATHS.commodity_ets_bydd_trd,
};

export function registerCommodityCommand(program: Command): void {
  const commodity = program
    .command("commodity")
    .description("Query KRX commodity data (oil/gold/emission)");

  commodity
    .command("list")
    .description("List commodity daily trading data")
    .option("--date <date>", "trading date (YYYYMMDD)")
    .option("--type <type>", "type: oil, gold, emission", "gold")
    .action(async (opts: { date?: string; type: string }) => {
      const date = resolveDate(opts.date, program);
      const endpoint = resolveEndpoint(TYPE_ENDPOINTS, opts.type, "type");

      await executeCommand({
        endpoint,
        params: { [OPENAPI_WIRE.requestDateField]: date },
        program,
        noDataMessage: `No data for date ${date}`,
      });
    });
}
