import { z } from "zod/v4";
import {
  CATEGORIES,
  ENDPOINTS,
  type CategoryId,
  type EndpointDef,
} from "../../client/endpoints.js";
import { krxFetch } from "../../client/client.js";
import { fetchDateRange } from "../../client/range-fetch.js";
import { getApiKey } from "../../client/auth.js";
import { validateDate } from "../../validator/index.js";
import { getRecentTradingDate } from "../../utils/date.js";
import { applyPipeline } from "../../utils/data-pipeline.js";
import {
  compositeResult as compositeToolResult,
  successResult,
  errorResult,
} from "./result.js";
import { matchesIsuCode } from "../../utils/isin.js";
import { completenessForOutput } from "../../client/completeness.js";

type ZodRawShape = Record<string, z.ZodType>;

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodRawShape;
  readonly handler: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

function getEndpointShortName(path: string): string {
  return path.split("/").pop() ?? path;
}

function buildDescription(
  categoryId: CategoryId,
  endpoints: readonly EndpointDef[],
): string {
  const category = CATEGORIES.find((c) => c.id === categoryId);
  const endpointList = endpoints
    .map((e) => `- ${getEndpointShortName(e.path)}: ${e.descriptionKo}`)
    .join("\n");

  const fieldSample = endpoints[0]?.responseFields
    .slice(0, 6)
    .map((f) => `${f.name}(${f.description})`)
    .join(", ");

  return `Query KRX ${category?.name ?? categoryId} market data (${category?.nameKo ?? ""}).

Available endpoints:
${endpointList}

Common response fields: ${fieldSample}

Notes:
- Date format: YYYYMMDD (e.g., 20260310)
- Data is T-1 (previous trading day)
- All response values are strings
- Rate limit: 10,000 calls/day
- Date ranges return a composite envelope. Inspect completeness.state and its requested, succeeded, failed, and skipped partitions before using data.
- IMPORTANT: When querying a specific stock, ALWAYS pass 'isuCd' to filter. Without it, all stocks in the market are returned.
- Full market listings can exceed the result size limit. Use 'fields' to select only needed columns, or 'limit'+'offset' for pagination. If the response contains '_truncated', follow its instructions to retrieve remaining data.`;
}

function buildInputSchema(endpoints: readonly EndpointDef[]): ZodRawShape {
  const shortNames = endpoints.map((e) => getEndpointShortName(e.path));

  return {
    endpoint: z
      .enum(shortNames as [string, ...string[]])
      .describe("Endpoint short name"),
    date: z
      .string()
      .optional()
      .describe(
        "Trading date in YYYYMMDD format (default: recent trading day)",
      ),
    date_from: z
      .string()
      .optional()
      .describe(
        "Start date for range query (YYYYMMDD). Use with date_to for multi-day data.",
      ),
    date_to: z
      .string()
      .optional()
      .describe(
        "End date for range query (YYYYMMDD). Use with date_from for multi-day data.",
      ),
    isuCd: z
      .string()
      .optional()
      .describe(
        "Stock/item code to filter. Accepts both ISIN (e.g., KR7005930003) and short code (e.g., 005930).",
      ),
    sort: z.string().optional().describe("Sort results by this field name"),
    sort_direction: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort direction (default: desc)"),
    offset: z
      .number()
      .optional()
      .describe("Skip first N results (use with limit for pagination)"),
    limit: z.number().optional().describe("Limit number of results returned"),
    filter: z
      .string()
      .optional()
      .describe(
        'Filter expression (e.g. "FLUC_RT > 5", "MKT_NM == KOSPI"). Operators: >, <, >=, <=, ==, !=',
      ),
    fields: z
      .array(z.string())
      .optional()
      .describe("Filter response to these field names only"),
  };
}

function filterFields(
  data: readonly Record<string, string>[],
  fields: readonly string[],
): readonly Record<string, string>[] {
  const fieldSet = new Set(fields);
  return data.map((row) => {
    const filtered: Record<string, string> = {};
    for (const key of Object.keys(row)) {
      if (fieldSet.has(key)) {
        const value = row[key];
        if (value !== undefined) {
          filtered[key] = value;
        }
      }
    }
    return filtered;
  });
}

function createCategoryTool(categoryId: CategoryId): ToolDefinition {
  const endpoints = ENDPOINTS.filter((e) => e.category === categoryId);

  return {
    name: `krx_${categoryId}`,
    description: buildDescription(categoryId, endpoints),
    inputSchema: buildInputSchema(endpoints),
    handler: async (args, signal) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        return errorResult(
          "API key not configured. Set KRX_API_KEY environment variable.",
        );
      }

      const shortName = args.endpoint as string;
      const endpoint = endpoints.find(
        (e) => getEndpointShortName(e.path) === shortName,
      );
      if (!endpoint) {
        return errorResult(`Unknown endpoint: ${shortName}`);
      }

      const dateFrom = args.date_from as string | undefined;
      const dateTo = args.date_to as string | undefined;
      const isuCd = args.isuCd as string | undefined;

      if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
        return errorResult(
          "Both date_from and date_to must be provided together",
        );
      }

      const isDateRange = dateFrom && dateTo;

      if (isDateRange) {
        try {
          validateDate(dateFrom);
          validateDate(dateTo);
        } catch (err) {
          return errorResult(
            err instanceof Error ? err.message : "Invalid date format",
          );
        }

        // isuCd omitted from API params — see comment in single-date path above
        const rangeResult = await fetchDateRange({
          endpoint: endpoint.path,
          from: dateFrom,
          to: dateTo,
          apiKey,
          signal,
        });

        if (!rangeResult.success) {
          return compositeToolResult(rangeResult);
        }

        let data: readonly Record<string, string>[] =
          rangeResult.data as Record<string, string>[];

        if (isuCd) {
          data = data.filter((row) =>
            matchesIsuCode(row["ISU_CD"] ?? "", row["ISU_SRT_CD"] ?? "", isuCd),
          );
        }

        const filterExpr = args.filter as string | undefined;
        const sortField = args.sort as string | undefined;
        const sortDirection = (args.sort_direction as "asc" | "desc") ?? "desc";
        const offsetN = args.offset as number | undefined;
        const limitN = args.limit as number | undefined;

        data = applyPipeline(data, {
          filter: filterExpr,
          sort: sortField,
          direction: sortDirection,
          offset: offsetN,
          limit: limitN,
        }) as Record<string, string>[];

        const fields = args.fields as string[] | undefined;
        if (fields) {
          data = filterFields(data, fields);
        }

        return compositeToolResult({
          ...rangeResult,
          data: data as Record<string, unknown>[],
          completeness: completenessForOutput(
            rangeResult.completeness,
            data.length > 0,
          ),
        });
      }

      const dateStr =
        (args.date as string | undefined) ?? getRecentTradingDate();

      try {
        validateDate(dateStr);
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : "Invalid date format",
        );
      }

      // isuCd is NOT passed to the API — KRX endpoints ignore it and return
      // all rows regardless. Client-side filtering is applied after fetch.
      // This also ensures a single cache entry per date (no isuCd in cache key).
      const params: Record<string, string> = { basDd: dateStr };

      const result = await krxFetch({
        endpoint: endpoint.path,
        params,
        apiKey,
        signal,
      });

      if (!result.success) {
        return errorResult(
          result.error ?? "API request failed",
          result.errorType,
        );
      }

      const filterExpr2 = args.filter as string | undefined;
      const sortField = args.sort as string | undefined;
      const sortDirection = (args.sort_direction as "asc" | "desc") ?? "desc";
      const offsetN = args.offset as number | undefined;
      const limitN = args.limit as number | undefined;

      let data: readonly Record<string, string>[] = result.data;

      if (isuCd) {
        data = data.filter((row) =>
          matchesIsuCode(row["ISU_CD"] ?? "", row["ISU_SRT_CD"] ?? "", isuCd),
        );
      }

      data = applyPipeline(data, {
        filter: filterExpr2,
        sort: sortField,
        direction: sortDirection,
        offset: offsetN,
        limit: limitN,
      }) as Record<string, string>[];

      const fields = args.fields as string[] | undefined;
      if (fields) {
        data = filterFields(data, fields);
      }

      return successResult(data as Record<string, unknown>[]);
    },
  };
}

export function createCategoryTools(): readonly ToolDefinition[] {
  return CATEGORIES.map((cat) => createCategoryTool(cat.id));
}

export type { ToolDefinition };
