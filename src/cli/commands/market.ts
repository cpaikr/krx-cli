import { Command } from "commander";
import { getApiKey } from "../../client/auth.js";
import { fetchMarketSummary } from "../../client/market-summary.js";
import { getRecentTradingDate } from "../../utils/date.js";
import { validateDate } from "../../validator/index.js";
import { writeOutput, writeError } from "../../output/formatter.js";
import { EXIT_CODES } from "../exit-codes.js";
import { handleKrxError } from "../error-handler.js";
import { withCliCancellation } from "../cancellation.js";
import { applyCompositeExitPolicy } from "../composite.js";

export function registerMarketCommand(program: Command): void {
  const market = program
    .command("market")
    .description("Market overview commands");

  market
    .command("summary")
    .description("Market summary: indices, top movers, volume")
    .option("-d, --date <date>", "trading date (YYYYMMDD)")
    .action(async (opts) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        writeError(
          "No API key configured. Use 'krx auth set' or set KRX_API_KEY env var.",
        );
        process.exit(EXIT_CODES.AUTH_FAILURE);
      }

      const date = (opts.date as string | undefined) ?? getRecentTradingDate();

      try {
        validateDate(date);
      } catch (err) {
        writeError(
          `Invalid date: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      const parentOpts = program.opts();

      const result = await withCliCancellation((signal) =>
        fetchMarketSummary({
          apiKey,
          date,
          cache: parentOpts.cache as boolean,
          signal,
        }),
      );

      if (!result.success) {
        handleKrxError({
          success: false,
          data: [],
          error: result.error ?? "Failed to fetch market summary",
          errorType: result.errorType,
        });
      }

      writeOutput(JSON.stringify(result, null, 2));
      applyCompositeExitPolicy(result.completeness, "Market summary");
    });
}
