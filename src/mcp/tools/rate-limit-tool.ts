import { getRateLimitStatus } from "../../client/rate-limit.js";
import { getApiKey } from "../../client/auth.js";
import type { ToolDefinition } from "./index.js";

export function createRateLimitTool(): ToolDefinition {
  return {
    name: "krx_rate_limit",
    description:
      "Check daily API call usage. KRX API has a 10,000 calls/day limit. Use this to monitor remaining quota before making bulk queries.",
    inputSchema: {},
    handler: async () => {
      const status = getRateLimitStatus(getApiKey() ?? "");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(status, null, 2) },
        ],
      };
    },
  };
}
