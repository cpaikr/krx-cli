import { z } from "zod/v4";
import { getApiKey } from "../../client/auth.js";
import { searchStock } from "../../client/search.js";
import type { ToolDefinition } from "./index.js";
import { compositeResult } from "./result.js";
import { missingApiKeyMessage } from "../../user-contract.js";

export function createSearchTool(): ToolDefinition {
  return {
    name: "krx_search",
    description:
      "Search KOSPI and KOSDAQ stocks by name. Returns a composite envelope with matching stock codes (ISU_CD), short codes (ISU_SRT_CD), names (ISU_NM), market, and explicit completeness partitions. Check completeness.state before treating the search as exhaustive.",
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
                error: missingApiKeyMessage(),
              }),
            },
          ],
          isError: true,
        };
      }

      const result = await searchStock(apiKey, query, signal);
      return compositeResult(result);
    },
  };
}
