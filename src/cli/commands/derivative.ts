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
  futures: OPENAPI_OPERATION_PATHS.derivative_fut_bydd_trd,
  "futures-kospi": OPENAPI_OPERATION_PATHS.derivative_eqsfu_stk_bydd_trd,
  "futures-kosdaq": OPENAPI_OPERATION_PATHS.derivative_eqkfu_ksq_bydd_trd,
  options: OPENAPI_OPERATION_PATHS.derivative_opt_bydd_trd,
  "options-kospi": OPENAPI_OPERATION_PATHS.derivative_eqsop_bydd_trd,
  "options-kosdaq": OPENAPI_OPERATION_PATHS.derivative_eqkop_bydd_trd,
};

export function registerDerivativeCommand(program: Command): void {
  const derivative = program
    .command("derivative")
    .description("Query KRX derivative data");

  derivative
    .command("list")
    .description("List derivative daily trading data")
    .option("--date <date>", "trading date (YYYYMMDD)")
    .option(
      "--type <type>",
      "type: futures, futures-kospi, futures-kosdaq, options, options-kospi, options-kosdaq",
      "futures",
    )
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
