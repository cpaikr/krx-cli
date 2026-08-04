import { krxFetch, selectKrxFailure, type KrxResponse } from "./client.js";
import {
  componentFailure,
  createCompleteness,
  type CompositeResult,
} from "./completeness.js";

const STOCK_ENDPOINTS = [
  { market: "KOSPI", endpoint: "/svc/apis/sto/stk_bydd_trd" },
  { market: "KOSDAQ", endpoint: "/svc/apis/sto/ksq_bydd_trd" },
] as const;

type WatchlistMarket = (typeof STOCK_ENDPOINTS)[number]["market"];
const WATCHLIST_MARKETS = STOCK_ENDPOINTS.map(({ market }) => market);

export interface WatchlistPricesData {
  readonly date: string;
  readonly stocks: readonly Record<string, string>[];
}

export type WatchlistPricesResult = CompositeResult<
  WatchlistPricesData,
  WatchlistMarket
>;

interface WatchlistPricesOptions {
  readonly apiKey: string;
  readonly date: string;
  readonly securityCodes: ReadonlySet<string>;
  readonly cache?: boolean;
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
}

export async function fetchWatchlistPrices(
  options: WatchlistPricesOptions,
): Promise<WatchlistPricesResult> {
  const outcomes = await Promise.all(
    STOCK_ENDPOINTS.map(async ({ market, endpoint }) => {
      const response = await krxFetch<Record<string, string>>({
        endpoint,
        params: { basDd: options.date },
        apiKey: options.apiKey,
        cache: options.cache,
        refresh: options.refresh,
        signal: options.signal,
      }).catch(
        (error: unknown): KrxResponse<Record<string, string>> => ({
          success: false,
          data: [],
          error:
            error instanceof Error
              ? error.message
              : "Unexpected watchlist fetch failure",
          errorType: "upstream",
        }),
      );
      return { market, response };
    }),
  );

  const rawResponses = outcomes.map(({ response }) => response);
  const cancellation = rawResponses.find(
    (response) => !response.success && response.errorType === "cancelled",
  );
  const succeeded = outcomes
    .filter(({ response }) => response.success)
    .map(({ market }) => market);
  const failures = outcomes
    .filter(({ response }) => !response.success)
    .map(({ market, response }) => componentFailure(market, response));
  const stocks = outcomes
    .filter(({ response }) => response.success)
    .flatMap(({ response }) => response.data)
    .filter((stock) =>
      [stock["ISU_CD"], stock["ISU_SRT_CD"]].some(
        (code) => code !== undefined && options.securityCodes.has(code),
      ),
    );
  const completeness = createCompleteness({
    requested: WATCHLIST_MARKETS,
    succeeded,
    failed: failures,
    hasData: stocks.length > 0,
    forceFailed: Boolean(cancellation),
  });
  const data = { date: options.date, stocks };

  if (completeness.state === "failed") {
    const primaryFailure = cancellation ?? selectKrxFailure(rawResponses);
    return {
      success: false,
      data,
      completeness,
      error: primaryFailure?.error ?? "Watchlist market data fetch failed",
      errorType: primaryFailure?.errorType,
    };
  }

  return { success: true, data, completeness };
}
