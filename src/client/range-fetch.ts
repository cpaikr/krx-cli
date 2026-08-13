import { krxFetch, selectKrxFailure, type KrxResponse } from "./client.js";
import {
  getTradingDaySelection,
  type KrxCalendarSelection,
} from "../utils/date.js";
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
  readonly refresh?: boolean;
  readonly concurrency?: number;
  readonly extraParams?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export interface DateRangeResult<
  T = Record<string, string>,
> extends CompositeResult<readonly T[], string> {
  /** Successful upstream requests, including responses with no rows. */
  readonly fetchedDays: number;
  readonly failedDays: number;
  readonly calendar: KrxCalendarSelection;
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
  const { endpoint, from, to, apiKey, cache, refresh, extraParams, signal } =
    options;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const selection = getTradingDaySelection(from, to);

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
      calendar: selection.calendar,
    };
  }

  const { requestedDates, skippedDays, tradingDays } = selection;

  verbose(
    `date range: ${from}~${to} → ${tradingDays.length} requestable, ${skippedDays.length} known non-trading`,
  );
  if (selection.calendar.coverage === "fallback") {
    verbose(
      `KRX calendar fallback: ${selection.calendar.unverifiedDates.length} uncovered weekday(s) will be probed`,
    );
  }

  if (tradingDays.length === 0) {
    return {
      success: true,
      data: [],
      completeness: createCompleteness({
        requested: requestedDates,
        skipped: skippedDays,
        hasData: false,
      }),
      fetchedDays: 0,
      failedDays: 0,
      calendar: selection.calendar,
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
      refresh,
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
  const emptyResponseDays = outcomes
    .filter(({ response }) => response.success && response.data.length === 0)
    .map(({ date }) => date);
  const skipped = [...skippedDays, ...emptyResponseDays];
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
    requested: requestedDates,
    succeeded,
    failed: failures,
    skipped,
    hasData: mergedData.length > 0,
    forceFailed:
      Boolean(cancellation) ||
      (failures.length > 0 &&
        succeeded.length === 0 &&
        emptyResponseDays.length === 0),
  });

  if (cancellation) {
    return {
      success: false,
      data: [],
      error: cancellation.error ?? "Date range fetch was cancelled",
      errorType: "cancelled",
      completeness,
      fetchedDays: succeeded.length + emptyResponseDays.length,
      failedDays,
      calendar: selection.calendar,
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
      calendar: selection.calendar,
    };
  }

  return {
    success: true,
    data: mergedData,
    completeness,
    fetchedDays: succeeded.length + emptyResponseDays.length,
    failedDays,
    calendar: selection.calendar,
  };
}
