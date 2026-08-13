import { z } from "zod/v4";
import { ENDPOINTS } from "../../client/endpoints.js";
import type { ToolDefinition } from "./index.js";
import {
  ADJUSTED_STOCK_OUTPUT_SCHEMA,
  isAdjustedStockEndpoint,
} from "../../client/stock-adjustment.js";

function getEndpointShortName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function createSchemaTool(): ToolDefinition {
  const allShortNames = ENDPOINTS.map((e) => getEndpointShortName(e.path));

  return {
    name: "krx_schema",
    description: `Query response field schemas for KRX API endpoints. Returns field names and descriptions for each endpoint. Use this to discover available fields before querying data.`,
    inputSchema: {
      endpoint: z
        .string()
        .optional()
        .describe(
          `Endpoint short name (e.g., stk_bydd_trd). Omit to list all endpoints. Available: ${allShortNames.join(", ")}`,
        ),
    },
    handler: async (args) => {
      const shortName = args.endpoint as string | undefined;

      if (!shortName) {
        const all = ENDPOINTS.map((e) => ({
          endpoint: getEndpointShortName(e.path),
          path: e.path,
          description: e.description,
          descriptionKo: e.descriptionKo,
          category: e.category,
          fieldCount: e.responseFields.length,
          derivedFieldCount: isAdjustedStockEndpoint(e.path)
            ? ADJUSTED_STOCK_OUTPUT_SCHEMA.fields.length
            : 0,
        }));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(all, null, 2) },
          ],
        };
      }

      const endpoint = ENDPOINTS.find(
        (e) => getEndpointShortName(e.path) === shortName,
      );
      if (!endpoint) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown endpoint: ${shortName}` }),
            },
          ],
          isError: true,
        };
      }

      const schema = {
        endpoint: getEndpointShortName(endpoint.path),
        path: endpoint.path,
        description: endpoint.description,
        descriptionKo: endpoint.descriptionKo,
        category: endpoint.category,
        responseFields: endpoint.responseFields,
        ...(isAdjustedStockEndpoint(endpoint.path)
          ? { derivedOutput: ADJUSTED_STOCK_OUTPUT_SCHEMA }
          : {}),
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(schema, null, 2) },
        ],
      };
    },
  };
}
