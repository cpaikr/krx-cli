import { z } from "zod/v4";
import { getApiKey } from "../../client/auth.js";
import { KrxRequestError } from "../../client/client.js";
import { searchStock } from "../../client/search.js";
import type { ToolDefinition } from "./index.js";
import { errorResult } from "./result.js";

export function createSearchTool(): ToolDefinition {
  return {
    name: "krx_search",
    description:
      "Search KRX stocks by name. Returns matching stock codes (ISU_CD), short codes (ISU_SRT_CD), names (ISU_NM), and market (KOSPI/KOSDAQ). Use this to resolve a stock name to its code before querying market data.",
    inputSchema: {
      query: z
        .string()
        .describe(
          "Stock name or partial name to search (e.g., '삼성전자', '카카오')",
        ),
    },
    handler: async (args, signal) => {
      const query = args.query as string;

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

      let results: Awaited<ReturnType<typeof searchStock>>;
      try {
        results = await searchStock(apiKey, query, signal);
      } catch (error) {
        if (error instanceof KrxRequestError) {
          return errorResult(
            error.response.error ?? "Stock search failed",
            error.response.errorType,
          );
        }
        return errorResult(
          error instanceof Error ? error.message : "Stock search failed",
          "upstream",
        );
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `No stocks found matching "${query}"`,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(results, null, 2) },
        ],
      };
    },
  };
}
