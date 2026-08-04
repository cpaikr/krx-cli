import { krxFetch, selectKrxFailure, type KrxResponse } from "./client.js";
import { parseKrxNumber } from "../utils/data-pipeline.js";
import {
  componentFailure,
  createCompleteness,
  type CompositeResult,
} from "./completeness.js";

const KOSPI_INDEX_ENDPOINT = "/svc/apis/idx/kospi_dd_trd";
const KOSDAQ_INDEX_ENDPOINT = "/svc/apis/idx/kosdaq_dd_trd";
const KOSPI_STOCK_ENDPOINT = "/svc/apis/sto/stk_bydd_trd";
const KOSDAQ_STOCK_ENDPOINT = "/svc/apis/sto/ksq_bydd_trd";

const TOP_N = 5;
const MARKET_COMPONENTS = [
  "kospiIndex",
  "kosdaqIndex",
  "kospiStocks",
  "kosdaqStocks",
] as const;
type MarketComponent = (typeof MARKET_COMPONENTS)[number];

interface MarketSummaryOptions {
  readonly apiKey: string;
  readonly date: string;
  readonly cache?: boolean;
  readonly signal?: AbortSignal;
}

interface StockStats {
  readonly advancing: number;
  readonly declining: number;
  readonly unchanged: number;
  readonly totalVolume: number;
  readonly totalValue: number;
}

export interface MarketSummaryData {
  readonly date: string;
  readonly kospiIndex: readonly Record<string, string>[] | null;
  readonly kosdaqIndex: readonly Record<string, string>[] | null;
  readonly stockStats: StockStats | null;
  readonly topGainers: readonly Record<string, string>[] | null;
  readonly topLosers: readonly Record<string, string>[] | null;
}

export type MarketSummaryResult = CompositeResult<
  MarketSummaryData,
  MarketComponent
>;

function computeStockStats(
  stocks: readonly Record<string, string>[],
): StockStats {
  return stocks.reduce(
    (acc, stock) => {
      const rate = parseKrxNumber(stock["FLUC_RT"] ?? "0");
      return {
        advancing: acc.advancing + (rate > 0 ? 1 : 0),
        declining: acc.declining + (rate < 0 ? 1 : 0),
        unchanged: acc.unchanged + (rate === 0 ? 1 : 0),
        totalVolume:
          acc.totalVolume + parseKrxNumber(stock["ACC_TRDVOL"] ?? "0"),
        totalValue: acc.totalValue + parseKrxNumber(stock["ACC_TRDVAL"] ?? "0"),
      };
    },
    {
      advancing: 0,
      declining: 0,
      unchanged: 0,
      totalVolume: 0,
      totalValue: 0,
    },
  );
}

function computeTopMovers(stocks: readonly Record<string, string>[]): {
  readonly topGainers: readonly Record<string, string>[];
  readonly topLosers: readonly Record<string, string>[];
} {
  const sorted = [...stocks].sort((a, b) => {
    const rateA = parseKrxNumber(a["FLUC_RT"] ?? "0");
    const rateB = parseKrxNumber(b["FLUC_RT"] ?? "0");
    return rateB - rateA;
  });

  const topGainers = sorted.slice(0, TOP_N);
  const topLosers = sorted.slice(-TOP_N).reverse();

  return { topGainers, topLosers };
}

function safeFetch(...args: Parameters<typeof krxFetch>): Promise<KrxResponse> {
  return krxFetch(...args).catch(
    (err: unknown): KrxResponse => ({
      success: false,
      data: [],
      error: err instanceof Error ? err.message : "Network error",
      errorType: "upstream",
    }),
  );
}

export async function fetchMarketSummary(
  options: MarketSummaryOptions,
): Promise<MarketSummaryResult> {
  const { apiKey, date, cache, signal } = options;
  const params = { basDd: date };

  const [kospiIdx, kosdaqIdx, kospiStk, kosdaqStk] = await Promise.all([
    safeFetch({
      endpoint: KOSPI_INDEX_ENDPOINT,
      params,
      apiKey,
      cache,
      signal,
    }),
    safeFetch({
      endpoint: KOSDAQ_INDEX_ENDPOINT,
      params,
      apiKey,
      cache,
      signal,
    }),
    safeFetch({
      endpoint: KOSPI_STOCK_ENDPOINT,
      params,
      apiKey,
      cache,
      signal,
    }),
    safeFetch({
      endpoint: KOSDAQ_STOCK_ENDPOINT,
      params,
      apiKey,
      cache,
      signal,
    }),
  ]);

  const responses = [kospiIdx, kosdaqIdx, kospiStk, kosdaqStk] as const;
  const outcomes = MARKET_COMPONENTS.map((id, index) => ({
    id,
    response: responses[index] as KrxResponse,
  }));
  const cancellation = responses.find(
    (response) => !response.success && response.errorType === "cancelled",
  );
  const succeeded = outcomes
    .filter(({ response }) => response.success)
    .map(({ id }) => id);
  const failures = outcomes
    .filter(({ response }) => !response.success)
    .map(({ id, response }) => componentFailure(id, response));
  const hasData = responses.some(
    (response) => response.success && response.data.length > 0,
  );
  const completeness = createCompleteness({
    requested: MARKET_COMPONENTS,
    succeeded,
    failed: failures,
    hasData,
    forceFailed: Boolean(cancellation),
  });

  const kospiIndexData = kospiIdx.success
    ? (kospiIdx.data as Record<string, string>[])
    : null;
  const kosdaqIndexData = kosdaqIdx.success
    ? (kosdaqIdx.data as Record<string, string>[])
    : null;
  const stockInputsComplete = kospiStk.success && kosdaqStk.success;
  const allStocks = stockInputsComplete
    ? [
        ...(kospiStk.data as Record<string, string>[]),
        ...(kosdaqStk.data as Record<string, string>[]),
      ]
    : null;
  const stockStats = allStocks ? computeStockStats(allStocks) : null;
  const movers = allStocks ? computeTopMovers(allStocks) : null;
  const data: MarketSummaryData = {
    date,
    kospiIndex: kospiIndexData,
    kosdaqIndex: kosdaqIndexData,
    stockStats,
    topGainers: movers?.topGainers ?? null,
    topLosers: movers?.topLosers ?? null,
  };

  if (completeness.state === "failed") {
    const primaryFailure = cancellation ?? selectKrxFailure(responses);
    return {
      success: false,
      data,
      completeness,
      error: primaryFailure?.error ?? "Market summary fetch failed",
      errorType: primaryFailure?.errorType,
    };
  }

  return {
    success: true,
    data,
    completeness,
  };
}
