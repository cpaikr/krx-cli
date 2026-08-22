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
  kts: OPENAPI_OPERATION_PATHS.bond_kts_bydd_trd,
  general: OPENAPI_OPERATION_PATHS.bond_bnd_bydd_trd,
  small: OPENAPI_OPERATION_PATHS.bond_smb_bydd_trd,
};

export function registerBondCommand(program: Command): void {
  const bond = program.command("bond").description("Query KRX bond data");

  bond
    .command("list")
    .description("List bond daily trading data")
    .option("--date <date>", "trading date (YYYYMMDD)")
    .option("--market <market>", "market: kts, general, small", "general")
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
