import { krxFetch, selectKrxFailure, type KrxResponse } from "./client.js";
import { getTradingDays } from "../utils/date.js";
import { verbose } from "../utils/logger.js";
import {
  componentFailure,
  createCompleteness,
  type CompositeResult,
} from "./completeness.js";

interface DateRangeOptions {
  readonly endpoint: string;
  readonly from: string;
  readonly to: string;
  readonly apiKey: string;
  readonly cache?: boolean;
  readonly concurrency?: number;
  readonly extraParams?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export interface DateRangeResult<
  T = Record<string, string>,
> extends CompositeResult<readonly T[], string> {
  readonly fetchedDays: number;
  readonly failedDays: number;
}

const DEFAULT_CONCURRENCY = 5;

async function fetchWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<readonly T[]> {
  const slots: Promise<T>[] = new Array(tasks.length);
  let index = 0;

  async function runNext(): Promise<void> {
    while (index < tasks.length) {
      const currentIndex = index;
      index += 1;
      const task = tasks[currentIndex];
      if (task) {
        const result = await task();
        slots[currentIndex] = Promise.resolve(result);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => runNext(),
  );
  await Promise.all(workers);

  return Promise.all(slots);
}

export async function fetchDateRange<T = Record<string, string>>(
  options: DateRangeOptions,
): Promise<DateRangeResult<T>> {
  const { endpoint, from, to, apiKey, cache, extraParams, signal } = options;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  if (from > to) {
    return {
      success: false,
      data: [],
      error: `'from' date (${from}) must not be after 'to' date (${to})`,
      completeness: createCompleteness({
        requested: [],
        hasData: false,
        forceFailed: true,
      }),
      fetchedDays: 0,
      failedDays: 0,
    };
  }

  const tradingDays = getTradingDays(from, to);

  verbose(`date range: ${from}~${to} → ${tradingDays.length} trading days`);

  if (tradingDays.length === 0) {
    return {
      success: true,
      data: [],
      completeness: createCompleteness({
        requested: [],
        hasData: false,
      }),
      fetchedDays: 0,
      failedDays: 0,
    };
  }

  const tasks = tradingDays.map((day) => async (): Promise<KrxResponse<T>> => {
    const params: Record<string, string> = {
      basDd: day,
      ...extraParams,
    };

    return krxFetch<T>({
      endpoint,
      params,
      apiKey,
      cache,
      signal,
    });
  });

  const results = await fetchWithConcurrency(tasks, concurrency);
  const outcomes = results.map((response, index) => ({
    date: tradingDays[index] as string,
    response,
  }));
  const succeeded = outcomes
    .filter(({ response }) => response.success && response.data.length > 0)
    .map(({ date }) => date);
  const skipped = outcomes
    .filter(({ response }) => response.success && response.data.length === 0)
    .map(({ date }) => date);
  const failures = outcomes
    .filter(({ response }) => !response.success)
    .map(({ date, response }) => componentFailure(date, response));
  const failedDays = failures.length;
  const cancellation = outcomes.find(
    ({ response }) => !response.success && response.errorType === "cancelled",
  )?.response;
  const mergedData = results
    .filter((result) => result.success)
    .flatMap((result) => [...result.data]);
  const completeness = createCompleteness({
    requested: tradingDays,
    succeeded,
    failed: failures,
    skipped,
    hasData: mergedData.length > 0,
    forceFailed: Boolean(cancellation),
  });

  if (cancellation) {
    return {
      success: false,
      data: [],
      error: cancellation.error ?? "Date range fetch was cancelled",
      errorType: "cancelled",
      completeness,
      fetchedDays: succeeded.length + skipped.length,
      failedDays,
    };
  }

  if (completeness.state === "failed") {
    const primaryFailure = selectKrxFailure(results);
    return {
      success: false,
      data: [],
      error: primaryFailure?.error ?? "Date range fetch failed",
      errorType: primaryFailure?.errorType,
      completeness,
      fetchedDays: 0,
      failedDays,
    };
  }

  return {
    success: true,
    data: mergedData,
    completeness,
    fetchedDays: succeeded.length + skipped.length,
    failedDays,
  };
}
