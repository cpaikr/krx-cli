import { Command } from "commander";
import { getApiKey } from "../../client/auth.js";
import { searchStock } from "../../client/search.js";
import { fetchWatchlistPrices } from "../../client/watchlist-prices.js";
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
} from "../../watchlist/store.js";
import { getRecentTradingDate } from "../../utils/date.js";
import { validateDate, validateNoInjection } from "../../validator/index.js";
import { writeOutput, writeError } from "../../output/formatter.js";
import { EXIT_CODES } from "../exit-codes.js";
import { handleKrxError } from "../error-handler.js";
import { withCliCancellation } from "../cancellation.js";
import { applyCompositeExitPolicy } from "../composite.js";

export function registerWatchlistCommand(program: Command): void {
  const watchlist = program
    .command("watchlist")
    .description("Manage watchlist: add, remove, list, show");

  watchlist
    .command("add <name>")
    .description("Add stock to watchlist by name (searches first)")
    .action(async (name: string) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        writeError(
          "No API key configured. Use 'krx auth set' or set KRX_API_KEY env var.",
        );
        process.exit(EXIT_CODES.AUTH_FAILURE);
      }

      const injectionError = validateNoInjection(name);
      if (injectionError) {
        writeError(`Invalid input: ${injectionError}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      const searchResult = await withCliCancellation((signal) =>
        searchStock(apiKey, name, signal),
      );
      if (!searchResult.success) {
        handleKrxError(searchResult);
      }
      if (searchResult.completeness.state !== "complete") {
        writeOutput(JSON.stringify(searchResult, null, 2));
        applyCompositeExitPolicy(
          searchResult.completeness,
          "Watchlist stock search",
        );
        return;
      }
      const results = searchResult.data;

      if (results.length === 0) {
        writeError(`No stock found matching '${name}'`);
        process.exit(EXIT_CODES.NO_DATA);
      }

      if (results.length > 1) {
        writeOutput(
          JSON.stringify(
            {
              message: `Multiple matches found for '${name}'. Please be more specific.`,
              matches: results,
            },
            null,
            2,
          ),
        );
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      const stock = results[0] as (typeof results)[number];
      const result = addToWatchlist({
        isuCd: stock.ISU_CD,
        isuSrtCd: stock.ISU_SRT_CD,
        name: stock.ISU_NM,
        market: stock.MKT_NM,
      });

      if (!result.added) {
        const message =
          result.reason === "write_error"
            ? "Failed to save watchlist"
            : `'${stock.ISU_NM}' is already in watchlist`;
        writeError(message);
        if (result.reason === "write_error") {
          process.exit(EXIT_CODES.GENERAL_ERROR);
        }
        return;
      }

      writeOutput(
        JSON.stringify({
          message: `Added '${stock.ISU_NM}' (${stock.ISU_CD}) to watchlist`,
          entry: {
            isuCd: stock.ISU_CD,
            isuSrtCd: stock.ISU_SRT_CD,
            name: stock.ISU_NM,
            market: stock.MKT_NM,
          },
        }),
      );
    });

  watchlist
    .command("remove <name>")
    .description("Remove stock from watchlist by name or code")
    .action((name: string) => {
      const injectionError = validateNoInjection(name);
      if (injectionError) {
        writeError(`Invalid input: ${injectionError}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      const result = removeFromWatchlist(name);

      if (!result.removed) {
        const message =
          result.reason === "write_error"
            ? "Failed to save watchlist"
            : `'${name}' not found in watchlist`;
        writeError(message);
        process.exit(
          result.reason === "write_error"
            ? EXIT_CODES.GENERAL_ERROR
            : EXIT_CODES.NO_DATA,
        );
      }

      writeOutput(
        JSON.stringify({ message: `Removed '${name}' from watchlist` }),
      );
    });

  watchlist
    .command("list")
    .description("List all stocks in watchlist")
    .action(() => {
      const entries = getWatchlist();

      if (entries.length === 0) {
        writeOutput(
          JSON.stringify({ message: "Watchlist is empty", entries: [] }),
        );
        return;
      }

      writeOutput(JSON.stringify(entries, null, 2));
    });

  watchlist
    .command("show")
    .description("Show current prices for watchlist stocks")
    .option("-d, --date <date>", "trading date (YYYYMMDD)")
    .action(async (opts) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        writeError(
          "No API key configured. Use 'krx auth set' or set KRX_API_KEY env var.",
        );
        process.exit(EXIT_CODES.AUTH_FAILURE);
      }

      const entries = getWatchlist();
      if (entries.length === 0) {
        writeOutput(
          JSON.stringify({ message: "Watchlist is empty", entries: [] }),
        );
        return;
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
      const isuCds = new Set(entries.flatMap((e) => [e.isuCd, e.isuSrtCd]));
      const result = await withCliCancellation((signal) =>
        fetchWatchlistPrices({
          apiKey,
          date,
          securityCodes: isuCds,
          cache: parentOpts.cache as boolean,
          signal,
        }),
      );
      if (!result.success) {
        handleKrxError(result);
      }
      writeOutput(JSON.stringify(result, null, 2));
      applyCompositeExitPolicy(result.completeness, "Watchlist prices");
    });
}
