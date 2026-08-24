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
  filterOutputFields,
} from "../../output/formatter.js";
import { EXIT_CODES } from "../exit-codes.js";
import { handleKrxError } from "../error-handler.js";
import { withCliCancellation } from "../cancellation.js";
import { applyCompositeExitPolicy } from "../composite.js";
import { missingApiKeyMessage } from "../../user-contract.js";
import { UserInputError } from "../../errors.js";
import {
  OPENAPI_OPERATION_PATHS,
  OPENAPI_WIRE,
} from "../../contracts/generated/openapi-registry.js";

const TRADING_ENDPOINTS: Record<string, string> = {
  kospi: OPENAPI_OPERATION_PATHS.stock_stk_bydd_trd,
  kosdaq: OPENAPI_OPERATION_PATHS.stock_ksq_bydd_trd,
  konex: OPENAPI_OPERATION_PATHS.stock_knx_bydd_trd,
};

const INFO_ENDPOINTS: Record<string, string> = {
  kospi: OPENAPI_OPERATION_PATHS.stock_stk_isu_base_info,
  kosdaq: OPENAPI_OPERATION_PATHS.stock_ksq_isu_base_info,
  konex: OPENAPI_OPERATION_PATHS.stock_knx_isu_base_info,
};

export function registerStockCommand(program: Command): void {
  const stock = program.command("stock").description("Query KRX stock data");

  stock
    .command("list")
    .description("List stock daily trading data")
    .option("--date <date>", "trading date (YYYYMMDD)")
    .option("--market <market>", "market: kospi, kosdaq, konex", "kospi")
    .option(
      "--no-adjusted",
      "return raw-only OHLC for an eligible exact-code date range",
    )
    .action(
      async (opts: { date?: string; market: string; adjusted: boolean }) => {
        const date = resolveDate(opts.date, program);
        validateMarket(opts.market);
        const endpoint = resolveEndpoint(
          TRADING_ENDPOINTS,
          opts.market,
          "market",
        );

        await executeCommand({
          endpoint,
          params: { [OPENAPI_WIRE.requestDateField]: date },
          program,
          adjusted: opts.adjusted,
          noDataMessage: `No data for date ${date}`,
        });
      },
    );

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
      const injectionError = validateNoInjection(query);
      if (injectionError) throw new UserInputError(injectionError);

      const apiKey = getApiKey();
      if (!apiKey) {
        writeError(missingApiKeyMessage());
        process.exit(EXIT_CODES.AUTH_FAILURE);
      }

      const result = await withCliCancellation((signal) =>
        searchStock(apiKey, query, signal),
      );
      if (!result.success) {
        handleKrxError(result);
      }

      const parentOpts = program.opts();
      const fields = parentOpts.fields?.split(",");
      writeOutput(
        JSON.stringify(
          {
            ...result,
            data: fields
              ? filterOutputFields(
                  result.data as unknown as Record<string, unknown>[],
                  fields,
                )
              : result.data,
          },
          null,
          2,
        ),
      );
      applyCompositeExitPolicy(result.completeness, "Stock search");
    });
}
