import {
  krxFetch,
  selectKrxFailure,
  type KrxErrorType,
  type KrxResponse,
} from "./client.js";
import { parseKrxNumber } from "../utils/data-pipeline.js";

const KOSPI_INDEX_ENDPOINT = "/svc/apis/idx/kospi_dd_trd";
const KOSDAQ_INDEX_ENDPOINT = "/svc/apis/idx/kosdaq_dd_trd";
const KOSPI_STOCK_ENDPOINT = "/svc/apis/sto/stk_bydd_trd";
const KOSDAQ_STOCK_ENDPOINT = "/svc/apis/sto/ksq_bydd_trd";

const TOP_N = 5;

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

interface MarketSummaryData {
  readonly date: string;
  readonly kospiIndex: readonly Record<string, string>[];
  readonly kosdaqIndex: readonly Record<string, string>[];
  readonly stockStats: StockStats;
  readonly topGainers: readonly Record<string, string>[];
  readonly topLosers: readonly Record<string, string>[];
}

interface MarketSummaryResult {
  readonly success: boolean;
  readonly data?: MarketSummaryData;
  readonly error?: string;
  readonly errorType?: KrxErrorType;
}

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

  const responses = [kospiIdx, kosdaqIdx, kospiStk, kosdaqStk];
  const cancellation = responses.find(
    (response) => !response.success && response.errorType === "cancelled",
  );
  if (cancellation) {
    return {
      success: false,
      error: cancellation.error ?? "Market summary fetch was cancelled",
      errorType: "cancelled",
    };
  }

  const allFailed =
    !kospiIdx.success &&
    !kosdaqIdx.success &&
    !kospiStk.success &&
    !kosdaqStk.success;

  if (allFailed) {
    const primaryFailure = selectKrxFailure(responses);
    return {
      success: false,
      error: primaryFailure?.error ?? "Market summary fetch failed",
      errorType: primaryFailure?.errorType,
    };
  }

  const kospiIndexData = kospiIdx.success
    ? (kospiIdx.data as Record<string, string>[])
    : [];
  const kosdaqIndexData = kosdaqIdx.success
    ? (kosdaqIdx.data as Record<string, string>[])
    : [];
  const kospiStockData = kospiStk.success
    ? (kospiStk.data as Record<string, string>[])
    : [];
  const kosdaqStockData = kosdaqStk.success
    ? (kosdaqStk.data as Record<string, string>[])
    : [];

  const allStocks = [...kospiStockData, ...kosdaqStockData];
  const stockStats = computeStockStats(allStocks);
  const { topGainers, topLosers } = computeTopMovers(allStocks);

  return {
    success: true,
    data: {
      date,
      kospiIndex: kospiIndexData,
      kosdaqIndex: kosdaqIndexData,
      stockStats,
      topGainers,
      topLosers,
    },
  };
}
