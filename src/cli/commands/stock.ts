import { Command } from "commander";
import { validateMarket } from "../../validator/index.js";
import { validateNoInjection } from "../../validator/index.js";
import {
  executeCommand,
  resolveEndpoint,
  resolveDate,
} from "../command-helper.js";
import { getApiKey } from "../../client/auth.js";
import { searchStock } from "../../client/search.js";
import {
  writeOutput,
  writeError,
  formatOutput,
  detectOutputFormat,
} from "../../output/formatter.js";
import { EXIT_CODES } from "../exit-codes.js";

const TRADING_ENDPOINTS: Record<string, string> = {
  kospi: "/svc/apis/sto/stk_bydd_trd",
  kosdaq: "/svc/apis/sto/ksq_bydd_trd",
  konex: "/svc/apis/sto/knx_bydd_trd",
};

const INFO_ENDPOINTS: Record<string, string> = {
  kospi: "/svc/apis/sto/stk_isu_base_info",
  kosdaq: "/svc/apis/sto/ksq_isu_base_info",
  konex: "/svc/apis/sto/knx_isu_base_info",
};

export function registerStockCommand(program: Command): void {
  const stock = program.command("stock").description("Query KRX stock data");

  stock
    .command("list")
    .description("List stock daily trading data")
    .option("--date <date>", "trading date (YYYYMMDD)")
    .option("--market <market>", "market: kospi, kosdaq, konex", "kospi")
    .action(async (opts: { date?: string; market: string }) => {
      const date = resolveDate(opts.date, program);
      validateMarket(opts.market);
      const endpoint = resolveEndpoint(
        TRADING_ENDPOINTS,
        opts.market,
        "market",
      );

      await executeCommand({
        endpoint,
        params: { basDd: date },
        program,
        noDataMessage: `No data for date ${date}`,
      });
    });

  stock
    .command("info")
    .description("List stock base information")
    .option("--market <market>", "market: kospi, kosdaq, konex", "kospi")
    .action(async (opts: { market: string }) => {
      validateMarket(opts.market);
      const endpoint = resolveEndpoint(INFO_ENDPOINTS, opts.market, "market");

      await executeCommand({
        endpoint,
        params: {},
        program,
      });
    });

  stock
    .command("search <query>")
    .description("Search stocks by name")
    .action(async (query: string) => {
      validateNoInjection(query);

      const apiKey = getApiKey();
      if (!apiKey) {
        writeError(
          "No API key configured. Use 'krx auth set' or set KRX_API_KEY env var.",
        );
        process.exit(EXIT_CODES.AUTH_FAILURE);
      }

      const results = await searchStock(apiKey, query);

      if (results.length === 0) {
        writeError(`No stocks found matching "${query}"`);
        process.exit(EXIT_CODES.NO_DATA);
      }

      const parentOpts = program.opts();
      const format = detectOutputFormat(parentOpts.output);
      const fields = parentOpts.fields?.split(",");
      writeOutput(
        formatOutput(
          results as unknown as Record<string, unknown>[],
          format,
          fields,
        ),
      );
    });
}
