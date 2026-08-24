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
  etf: OPENAPI_OPERATION_PATHS.etp_etf_bydd_trd,
  etn: OPENAPI_OPERATION_PATHS.etp_etn_bydd_trd,
  elw: OPENAPI_OPERATION_PATHS.etp_elw_bydd_trd,
};

export function registerEtpCommand(program: Command): void {
  const etp = program
    .command("etp")
    .description("Query KRX ETP data (ETF/ETN/ELW)");

  etp
    .command("list")
    .description("List ETP daily trading data")
    .option("--date <date>", "trading date (YYYYMMDD)")
    .option("--type <type>", "type: etf, etn, elw", "etf")
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
