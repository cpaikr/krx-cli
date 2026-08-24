import { krxFetch, selectKrxFailure, type KrxResponse } from "./client.js";
import { getRecentTradingDate } from "../utils/date.js";
import {
  componentFailure,
  createCompleteness,
  type CompositeResult,
} from "./completeness.js";
import {
  OPENAPI_OPERATION_PATHS,
  OPENAPI_WIRE,
} from "../contracts/generated/openapi-registry.js";

export interface StockSearchMatch {
  readonly ISU_CD: string;
  readonly ISU_SRT_CD: string;
  readonly ISU_NM: string;
  readonly MKT_NM: string;
}

const BASE_INFO_ENDPOINTS = [
  {
    endpoint: OPENAPI_OPERATION_PATHS.stock_stk_isu_base_info,
    market: "KOSPI",
  },
  {
    endpoint: OPENAPI_OPERATION_PATHS.stock_ksq_isu_base_info,
    market: "KOSDAQ",
  },
] as const;
type SearchMarket = (typeof BASE_INFO_ENDPOINTS)[number]["market"];
const SEARCH_MARKETS = BASE_INFO_ENDPOINTS.map(({ market }) => market);

export type StockSearchResult = CompositeResult<
  readonly StockSearchMatch[],
  SearchMarket
>;

export async function searchStock(
  apiKey: string,
  query: string,
  signal?: AbortSignal,
): Promise<StockSearchResult> {
  const requestDate = getRecentTradingDate();
  const lowerQuery = query.toLowerCase();

  const responses = await Promise.all(
    BASE_INFO_ENDPOINTS.map(async ({ endpoint, market }) => {
      const response = await krxFetch<Record<string, string>>({
        endpoint,
        params: { [OPENAPI_WIRE.requestDateField]: requestDate },
        apiKey,
        signal,
      }).catch(
        (error: unknown): KrxResponse<Record<string, string>> => ({
          success: false,
          data: [],
          error:
            error instanceof Error
              ? error.message
              : "Unexpected search failure",
          errorType: "upstream",
        }),
      );
      return { market, response };
    }),
  );

  const rawResponses = responses.map(({ response }) => response);
  const cancellation = rawResponses.find(
    (response) => !response.success && response.errorType === "cancelled",
  );
  const data = responses.flatMap(({ market, response }) =>
    response.success
      ? response.data
          .filter((row) => {
            const name = row["ISU_NM"] ?? "";
            const shortName = row["ISU_ABBRV"] ?? "";
            return (
              name.toLowerCase().includes(lowerQuery) ||
              shortName.toLowerCase().includes(lowerQuery)
            );
          })
          .map((row) => ({
            ISU_CD: row["ISU_CD"] ?? "",
            ISU_SRT_CD: row["ISU_SRT_CD"] ?? "",
            ISU_NM: row["ISU_NM"] ?? row["ISU_ABBRV"] ?? "",
            MKT_NM: market,
          }))
      : [],
  );
  const succeeded = responses
    .filter(({ response }) => response.success)
    .map(({ market }) => market);
  const failures = responses
    .filter(({ response }) => !response.success)
    .map(({ market, response }) => componentFailure(market, response));
  const completeness = createCompleteness({
    requested: SEARCH_MARKETS,
    succeeded,
    failed: failures,
    hasData: data.length > 0,
    forceFailed: Boolean(cancellation),
  });

  if (completeness.state === "failed") {
    const primaryFailure = cancellation ?? selectKrxFailure(rawResponses);
    return {
      success: false,
      data: [],
      completeness,
      error: primaryFailure?.error ?? "Stock search failed",
      errorType: primaryFailure?.errorType,
    };
  }

  return { success: true, data, completeness };
}
