import { Command } from "commander";
import { getApiKey } from "../../client/auth.js";
import { fetchMarketSummary } from "../../client/market-summary.js";
import { getRecentTradingDate } from "../../utils/date.js";
import { validateDate } from "../../validator/index.js";
import { writeOutput, writeError } from "../../output/formatter.js";
import { EXIT_CODES } from "../exit-codes.js";

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

      const result = await fetchMarketSummary({
        apiKey,
        date,
        cache: parentOpts.cache as boolean,
      });

      if (!result.success) {
        writeError(result.error ?? "Failed to fetch market summary");
        process.exit(EXIT_CODES.GENERAL_ERROR);
      }

      writeOutput(JSON.stringify(result.data, null, 2));
    });
}
