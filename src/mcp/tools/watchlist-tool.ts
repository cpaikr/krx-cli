import { z } from "zod/v4";
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
} from "../../watchlist/store.js";
import { searchStock } from "../../client/search.js";
import {
  formatKrxFailure,
  KrxRequestError,
  krxFetch,
  selectKrxFailure,
  type KrxResponse,
} from "../../client/client.js";
import { getApiKey } from "../../client/auth.js";
import { validateDate } from "../../validator/index.js";
import { getRecentTradingDate } from "../../utils/date.js";
import type { ToolDefinition } from "./index.js";

const STOCK_ENDPOINTS = {
  KOSPI: "/svc/apis/sto/stk_bydd_trd",
  KOSDAQ: "/svc/apis/sto/ksq_bydd_trd",
} as const;

function textResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handleAdd(name: string, signal?: AbortSignal) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return textResult({ error: "API key not configured" }, true);
  }

  let results: Awaited<ReturnType<typeof searchStock>>;
  try {
    results = await searchStock(apiKey, name, signal);
  } catch (err) {
    if (err instanceof KrxRequestError) {
      return textResult(
        {
          error: err.response.error ?? "Stock search failed",
          errorType: err.response.errorType,
        },
        true,
      );
    }
    return textResult(
      {
        error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      true,
    );
  }

  if (results.length === 0) {
    return textResult({ error: `No stock found matching '${name}'` }, true);
  }

  if (results.length > 1) {
    return textResult({
      message: `Multiple matches for '${name}'. Be more specific.`,
      matches: results,
    });
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
    return textResult({ error: message }, result.reason === "write_error");
  }

  return textResult({
    message: `Added '${stock.ISU_NM}' (${stock.ISU_CD})`,
    entry: { isuCd: stock.ISU_CD, name: stock.ISU_NM, market: stock.MKT_NM },
  });
}

async function handleShow(dateArg?: string, signal?: AbortSignal) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return textResult({ error: "API key not configured" }, true);
  }

  const entries = getWatchlist();
  if (entries.length === 0) {
    return textResult({ message: "Watchlist is empty", entries: [] });
  }

  const date = dateArg ?? getRecentTradingDate();
  try {
    validateDate(date);
  } catch (err) {
    return textResult(
      { error: err instanceof Error ? err.message : "Invalid date" },
      true,
    );
  }

  const isuCds = new Set(entries.flatMap((e) => [e.isuCd, e.isuSrtCd]));
  const [kospiResult, kosdaqResult] = await Promise.all([
    krxFetch<Record<string, string>>({
      endpoint: STOCK_ENDPOINTS.KOSPI,
      params: { basDd: date },
      apiKey,
      signal,
    }).catch(
      (err: unknown): KrxResponse<Record<string, string>> => ({
        success: false,
        data: [],
        error: err instanceof Error ? err.message : String(err),
        errorType: "upstream",
      }),
    ),
    krxFetch<Record<string, string>>({
      endpoint: STOCK_ENDPOINTS.KOSDAQ,
      params: { basDd: date },
      apiKey,
      signal,
    }).catch(
      (err: unknown): KrxResponse<Record<string, string>> => ({
        success: false,
        data: [],
        error: err instanceof Error ? err.message : String(err),
        errorType: "upstream",
      }),
    ),
  ]);

  const cancellation = [kospiResult, kosdaqResult].find(
    (result) => !result.success && result.errorType === "cancelled",
  );
  if (cancellation) {
    return textResult(
      {
        error:
          cancellation.error ?? "Watchlist market data fetch was cancelled",
        errorType: "cancelled",
      },
      true,
    );
  }

  if (!kospiResult.success && !kosdaqResult.success) {
    const primaryFailure = selectKrxFailure([kospiResult, kosdaqResult]);
    return textResult(
      {
        error: primaryFailure?.error ?? "Watchlist market data fetch failed",
        errorType: primaryFailure?.errorType ?? "upstream",
      },
      true,
    );
  }

  const allStocks = [
    ...(kospiResult.success ? kospiResult.data : []),
    ...(kosdaqResult.success ? kosdaqResult.data : []),
  ];

  const watchlistData = allStocks.filter((s) => isuCds.has(s["ISU_CD"] ?? ""));

  const output: Record<string, unknown> = { date, stocks: watchlistData };
  const warnings = [
    ...(kospiResult.success ? [] : [`KOSPI: ${formatKrxFailure(kospiResult)}`]),
    ...(kosdaqResult.success
      ? []
      : [`KOSDAQ: ${formatKrxFailure(kosdaqResult)}`]),
  ];
  if (warnings.length > 0) {
    output["warnings"] = warnings;
  }

  return textResult(output);
}

export function createWatchlistTool(): ToolDefinition {
  return {
    name: "krx_watchlist",
    description: `Manage a persistent watchlist of stocks.

Actions:
- add: Search by name and add to watchlist
- remove: Remove by name or stock code (exact match)
- list: Show all watchlist entries
- show: Fetch current prices for all watchlist stocks

The watchlist is stored locally at ~/.krx-cli/watchlist.json.`,
    inputSchema: {
      action: z
        .enum(["add", "remove", "list", "show"])
        .describe("Action to perform"),
      name: z
        .string()
        .optional()
        .describe("Stock name or code (required for add/remove)"),
      date: z
        .string()
        .optional()
        .describe("Trading date YYYYMMDD (for show action)"),
    },
    handler: async (args, signal) => {
      const action = args.action as string;
      const name = args.name as string | undefined;
      const date = args.date as string | undefined;

      switch (action) {
        case "add": {
          if (!name) {
            return textResult(
              { error: "name is required for add action" },
              true,
            );
          }
          return handleAdd(name, signal);
        }
        case "remove": {
          if (!name) {
            return textResult(
              { error: "name is required for remove action" },
              true,
            );
          }
          const result = removeFromWatchlist(name);
          if (!result.removed) {
            const message =
              result.reason === "write_error"
                ? "Failed to save watchlist"
                : `'${name}' not found in watchlist`;
            return textResult({ error: message }, true);
          }
          return textResult({ message: `Removed '${name}' from watchlist` });
        }
        case "list": {
          const entries = getWatchlist();
          return textResult(
            entries.length === 0
              ? { message: "Watchlist is empty", entries: [] }
              : entries,
          );
        }
        case "show": {
          return handleShow(date, signal);
        }
        default: {
          return textResult({ error: `Unknown action: ${action}` }, true);
        }
      }
    },
  };
}
