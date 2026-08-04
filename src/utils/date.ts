import calendarData from "../calendar/krx-closures.json";

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

const calendarYears = calendarData.years as Readonly<
  Record<string, Readonly<Record<string, string>>>
>;
const coveredYears = Object.keys(calendarYears)
  .map(Number)
  .sort((a, b) => a - b);
const warnedFallbackYears = new Set<number>();

export interface KrxCalendarSelection {
  readonly version: 1;
  readonly source: string;
  readonly retrievedAt: string;
  readonly coverage: "verified" | "fallback";
  /** Snapshot years missing from this selection. */
  readonly fallbackYears: readonly number[];
  /** Weekdays outside the snapshot; ranges probe them, defaults bypass them. */
  readonly unverifiedDates: readonly string[];
  readonly warning?: string;
}

export interface KrxTradingDaySelection {
  readonly requestedDates: readonly string[];
  readonly tradingDays: readonly string[];
  readonly skippedDays: readonly string[];
  readonly calendar: KrxCalendarSelection;
}

export interface RecentTradingDate {
  readonly date: string;
  readonly confidence: "verified" | "stale_fallback";
  readonly calendar: KrxCalendarSelection;
  readonly warning?: string;
}

export interface KrxDateClassification {
  readonly date: string;
  readonly status: "trading" | "non_trading" | "unknown";
  readonly verified: boolean;
  readonly reason?: string;
}

function parseCalendarDate(value: string): number {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new RangeError(`Invalid calendar date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
  return timestamp;
}

function formatCalendarDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear().toString();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

/** Format an instant as its Korea Standard Time calendar date. */
export function formatDateToYYYYMMDD(date: Date): string {
  return formatCalendarDate(date.getTime() + KST_OFFSET_MS);
}

/** Test whether an instant falls on a weekend in Korea Standard Time. */
export function isWeekend(date: Date): boolean {
  const day = new Date(date.getTime() + KST_OFFSET_MS).getUTCDay();
  return day === 0 || day === 6;
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

function isWeekendDate(date: string): boolean {
  const day = new Date(parseCalendarDate(date)).getUTCDay();
  return day === 0 || day === 6;
}

function yearEndClosure(year: number): string {
  let timestamp = Date.UTC(year, 11, 31);
  while ([0, 6].includes(new Date(timestamp).getUTCDay())) timestamp -= DAY_MS;
  return formatCalendarDate(timestamp);
}

function fallbackClosureReason(date: string): string | undefined {
  const year = yearOf(date);
  const lastCoveredYear = coveredYears.at(-1);
  if (lastCoveredYear === undefined || year <= lastCoveredYear)
    return undefined;

  const fixedClosures: Readonly<Record<string, string>> = {
    "0101": "New Year's Day",
    "0301": "Independence Movement Day",
    "0501": "Labor Day",
    "0505": "Children's Day",
    "0606": "Memorial Day",
    "0815": "Liberation Day",
    "1003": "National Foundation Day",
    "1225": "Christmas Day",
  };
  const fixed = fixedClosures[date.slice(4)];
  if (fixed) return `${fixed} (fallback rule)`;
  if (year >= 2013 && date.endsWith("1009")) {
    return "Hangeul Proclamation Day (fallback rule)";
  }
  if (year >= 2026 && date.endsWith("0717")) {
    return "Constitution Day (fallback rule)";
  }
  if (date === yearEndClosure(year)) {
    return "KRX year-end closure (fallback rule)";
  }
  return undefined;
}

function calendarSelection(
  fallbackYears: ReadonlySet<number>,
  unverifiedDates: readonly string[],
): KrxCalendarSelection {
  const years = [...fallbackYears].sort((a, b) => a - b);
  const warning =
    years.length > 0
      ? `Official KRX calendar coverage is unavailable for ${years.join(", ")}; fixed closures and weekends are skipped, while ${unverifiedDates.length} weekday(s) remain observable probes. Run pnpm calendar:update when KRX publishes the year.`
      : undefined;
  return {
    version: 1,
    source: calendarData.source,
    retrievedAt: calendarData.retrievedAt,
    coverage: warning ? "fallback" : "verified",
    fallbackYears: years,
    unverifiedDates,
    ...(warning ? { warning } : {}),
  };
}

/** Classify one KST calendar date against the checked-in official snapshot. */
export function classifyKrxDate(date: string): KrxDateClassification {
  parseCalendarDate(date);
  if (isWeekendDate(date)) {
    return {
      date,
      status: "non_trading",
      verified: true,
      reason: "Weekend in KST",
    };
  }

  const officialYear = calendarYears[String(yearOf(date))];
  if (officialYear) {
    const reason = officialYear[date];
    return reason
      ? { date, status: "non_trading", verified: true, reason }
      : { date, status: "trading", verified: true };
  }

  const reason = fallbackClosureReason(date);
  return reason
    ? { date, status: "non_trading", verified: false, reason }
    : { date, status: "unknown", verified: false };
}

export function getTradingDaySelection(
  from: string,
  to: string,
): KrxTradingDaySelection {
  const fromTimestamp = parseCalendarDate(from);
  const toTimestamp = parseCalendarDate(to);
  const requestedDates: string[] = [];
  const tradingDays: string[] = [];
  const skippedDays: string[] = [];
  const unverifiedDates: string[] = [];
  const fallbackYears = new Set<number>();

  for (
    let timestamp = fromTimestamp;
    timestamp <= toTimestamp;
    timestamp += DAY_MS
  ) {
    const date = formatCalendarDate(timestamp);
    requestedDates.push(date);
    const year = yearOf(date);
    if (!calendarYears[String(year)]) fallbackYears.add(year);

    const classification = classifyKrxDate(date);
    if (classification.status === "non_trading") skippedDays.push(date);
    else if (classification.status === "unknown") {
      tradingDays.push(date);
      unverifiedDates.push(date);
    } else tradingDays.push(date);
  }

  return {
    requestedDates,
    tradingDays,
    skippedDays,
    calendar: calendarSelection(fallbackYears, unverifiedDates),
  };
}

export function getTradingDays(from: string, to: string): readonly string[] {
  return getTradingDaySelection(from, to).tradingDays;
}

export function resolveRecentTradingDate(now = new Date()): RecentTradingDate {
  const todayKst = formatDateToYYYYMMDD(now);
  let timestamp = parseCalendarDate(todayKst) - DAY_MS;
  const fallbackYears = new Set<number>();
  const unverifiedDates: string[] = [];

  for (let checked = 0; checked < 370; checked += 1, timestamp -= DAY_MS) {
    const date = formatCalendarDate(timestamp);
    const year = yearOf(date);
    if (!calendarYears[String(year)]) fallbackYears.add(year);
    const classification = classifyKrxDate(date);

    if (classification.status === "unknown") {
      unverifiedDates.push(date);
      continue;
    }
    if (classification.status === "non_trading") continue;

    const selection = calendarSelection(fallbackYears, unverifiedDates);
    const warning =
      selection.coverage === "fallback"
        ? `Official KRX calendar coverage is unavailable for ${selection.fallbackYears.join(", ")}; defaulted to last verified session ${date} after ${unverifiedDates.length} unverified weekday(s). Run pnpm calendar:update before relying on newer defaults.`
        : undefined;
    const calendar = warning ? { ...selection, warning } : selection;
    return {
      date,
      confidence:
        calendar.coverage === "verified" ? "verified" : "stale_fallback",
      calendar,
      ...(warning ? { warning } : {}),
    };
  }
  const lastCoveredYear = coveredYears.at(-1);
  throw new Error(
    `Unable to find a verified recent KRX session within one year; official coverage ends in ${lastCoveredYear ?? "an unknown year"}. Check ${calendarData.source} and run pnpm calendar:update.`,
  );
}

export function getRecentTradingDateInfo(now = new Date()): RecentTradingDate {
  return resolveRecentTradingDate(now);
}

/** Return the last completed KRX session and warn if checked-in coverage is stale. */
export function getRecentTradingDate(now = new Date()): string {
  const result = getRecentTradingDateInfo(now);
  if (result.calendar.coverage === "fallback") {
    const currentKstYear = yearOf(formatDateToYYYYMMDD(now));
    if (!warnedFallbackYears.has(currentKstYear)) {
      warnedFallbackYears.add(currentKstYear);
      process.stderr.write(
        `[krx-cli] KRX_CALENDAR_FALLBACK: ${result.calendar.warning}\n`,
      );
    }
  }
  return result.date;
}
