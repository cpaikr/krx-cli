import { z } from "zod/v4";
import { fetchMarketSummary } from "../../client/market-summary.js";
import { getApiKey } from "../../client/auth.js";
import { validateDate } from "../../validator/index.js";
import { getRecentTradingDate } from "../../utils/date.js";
import type { ToolDefinition } from "./index.js";
import { errorResult } from "./result.js";

export function createMarketSummaryTool(): ToolDefinition {
  return {
    name: "krx_market_summary",
    description: `Get a comprehensive market summary including KOSPI/KOSDAQ indices, stock statistics (advancing/declining/unchanged), top 5 gainers/losers, and total trading volume/value.

This tool combines data from 4 API endpoints in a single call — ideal for getting a quick market overview.

Returns:
- kospiIndex: KOSPI series index data
- kosdaqIndex: KOSDAQ series index data
- stockStats: { advancing, declining, unchanged, totalVolume, totalValue }
- topGainers: Top 5 stocks by change rate
- topLosers: Bottom 5 stocks by change rate`,
    inputSchema: {
      date: z
        .string()
        .optional()
        .describe(
          "Trading date in YYYYMMDD format (default: recent trading day)",
        ),
    },
    handler: async (args, signal) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "API key not configured. Set KRX_API_KEY environment variable.",
              }),
            },
          ],
          isError: true,
        };
      }

      const dateStr =
        (args.date as string | undefined) ?? getRecentTradingDate();

      try {
        validateDate(dateStr);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : "Invalid date",
              }),
            },
          ],
          isError: true,
        };
      }

      const result = await fetchMarketSummary({
        apiKey,
        date: dateStr,
        signal,
      });

      if (!result.success) {
        return errorResult(
          result.error ?? "Failed to fetch market summary",
          result.errorType,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  };
}
