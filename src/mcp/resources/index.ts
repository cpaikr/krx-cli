import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { getWatchlist } from "../../watchlist/store.js";
import { getRateLimitStatus } from "../../client/rate-limit.js";
import { getApiKey, getCachedServiceStatus } from "../../client/auth.js";

export interface McpResource {
  readonly name: string;
  readonly uri: string;
  readonly handler: (uri: URL) => Promise<ReadResourceResult>;
}

function jsonContent(uri: URL, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data),
      },
    ],
  };
}

function errorContent(uri: URL, message: string): ReadResourceResult {
  return jsonContent(uri, { error: message });
}

export function createWatchlistResource(): McpResource {
  return {
    name: "watchlist",
    uri: "krx://watchlist",
    handler: async (uri: URL): Promise<ReadResourceResult> => {
      try {
        const entries = getWatchlist();
        return jsonContent(uri, entries);
      } catch {
        return errorContent(uri, "Failed to read watchlist");
      }
    },
  };
}

export function createRateLimitResource(): McpResource {
  return {
    name: "rate-limit",
    uri: "krx://rate-limit",
    handler: async (uri: URL): Promise<ReadResourceResult> => {
      try {
        const status = getRateLimitStatus(getApiKey() ?? "");
        return jsonContent(uri, status);
      } catch {
        return errorContent(uri, "Failed to read rate limit status");
      }
    },
  };
}

export function createServiceStatusResource(): McpResource {
  return {
    name: "service-status",
    uri: "krx://service-status",
    handler: async (uri: URL): Promise<ReadResourceResult> => {
      try {
        const rawStatus = getCachedServiceStatus();
        const safeStatus = Object.fromEntries(
          Object.entries(rawStatus).filter(([key]) => key !== "apiKey"),
        );
        return jsonContent(uri, safeStatus);
      } catch {
        return errorContent(uri, "Failed to read service status");
      }
    },
  };
}
