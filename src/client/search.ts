import {
  KrxRequestError,
  krxFetch,
  selectKrxFailure,
  type KrxResponse,
} from "./client.js";
import { getRecentTradingDate } from "../utils/date.js";

interface StockSearchResult {
  readonly ISU_CD: string;
  readonly ISU_SRT_CD: string;
  readonly ISU_NM: string;
  readonly MKT_NM: string;
}

const BASE_INFO_ENDPOINTS = [
  { endpoint: "/svc/apis/sto/stk_isu_base_info", market: "KOSPI" },
  { endpoint: "/svc/apis/sto/ksq_isu_base_info", market: "KOSDAQ" },
] as const;

export async function searchStock(
  apiKey: string,
  query: string,
  signal?: AbortSignal,
): Promise<readonly StockSearchResult[]> {
  const basDd = getRecentTradingDate();
  const lowerQuery = query.toLowerCase();

  const responses = await Promise.all(
    BASE_INFO_ENDPOINTS.map(async ({ endpoint, market }) => {
      const response = await krxFetch<Record<string, string>>({
        endpoint,
        params: { basDd },
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

  const failures = responses.map(({ response }) => response);
  const cancellation = failures.find(
    (response) => !response.success && response.errorType === "cancelled",
  );
  if (cancellation) throw new KrxRequestError(cancellation);
  if (failures.every((response) => !response.success)) {
    const primaryFailure = selectKrxFailure(failures);
    if (primaryFailure) throw new KrxRequestError(primaryFailure);
  }

  return responses.flatMap(({ market, response }) =>
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
}
