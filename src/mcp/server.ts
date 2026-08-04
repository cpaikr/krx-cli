import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCategoryTools } from "./tools/index.js";
import { createSchemaTool } from "./tools/schema-tool.js";
import { createRateLimitTool } from "./tools/rate-limit-tool.js";
import { createSearchTool } from "./tools/search-tool.js";
import { createMarketSummaryTool } from "./tools/market-summary-tool.js";
import { createWatchlistTool } from "./tools/watchlist-tool.js";
import {
  createWatchlistResource,
  createRateLimitResource,
  createServiceStatusResource,
} from "./resources/index.js";
import { getVersion } from "../cli/commands/version.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "krx-cli",
    version: getVersion(),
  });

  const allTools = [
    ...createCategoryTools(),
    createSchemaTool(),
    createRateLimitTool(),
    createSearchTool(),
    createMarketSummaryTool(),
    createWatchlistTool(),
  ];

  for (const tool of allTools) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema,
      async (args, extra) =>
        tool.handler(args as Record<string, unknown>, extra.signal),
    );
  }

  const allResources = [
    createWatchlistResource(),
    createRateLimitResource(),
    createServiceStatusResource(),
  ];

  for (const resource of allResources) {
    server.resource(resource.name, resource.uri, async (uri) => {
      return resource.handler(uri);
    });
  }

  return server;
}
