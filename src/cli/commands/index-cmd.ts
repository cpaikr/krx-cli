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

const MARKET_ENDPOINTS: Record<string, string> = {
  kospi: OPENAPI_OPERATION_PATHS.index_kospi_dd_trd,
  kosdaq: OPENAPI_OPERATION_PATHS.index_kosdaq_dd_trd,
  krx: OPENAPI_OPERATION_PATHS.index_krx_dd_trd,
  bond: OPENAPI_OPERATION_PATHS.index_bon_dd_trd,
  derivative: OPENAPI_OPERATION_PATHS.index_drvprod_dd_trd,
};

export function registerIndexCommand(program: Command): void {
  const index = program.command("index").description("Query KRX index data");

  index
    .command("list")
    .description("List index daily trading data")
    .option("--date <date>", "trading date (YYYYMMDD)")
    .option(
      "--market <market>",
      "market: kospi, kosdaq, krx, bond, derivative",
      "kospi",
    )
    .action(async (opts: { date?: string; market: string }) => {
      const date = resolveDate(opts.date, program);
      const endpoint = resolveEndpoint(MARKET_ENDPOINTS, opts.market, "market");

      await executeCommand({
        endpoint,
        params: { [OPENAPI_WIRE.requestDateField]: date },
        program,
        noDataMessage: `No data for date ${date}`,
      });
    });
}
