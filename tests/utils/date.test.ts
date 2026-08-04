import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyKrxDate,
  formatDateToYYYYMMDD,
  getRecentTradingDate,
  getTradingDaySelection,
  getTradingDays,
  isWeekend,
  resolveRecentTradingDate,
} from "../../src/utils/date.js";

const originalTimezone = process.env.TZ;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

function atKst(year: number, month: number, day: number, hour = 12): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9));
}

describe("KST date boundaries", () => {
  it("formats the same instant by its KST calendar date", () => {
    expect(formatDateToYYYYMMDD(new Date("2026-03-09T14:59:59Z"))).toBe(
      "20260309",
    );
    expect(formatDateToYYYYMMDD(new Date("2026-03-09T15:00:00Z"))).toBe(
      "20260310",
    );
  });

  it("is deterministic on hosts outside Korea", () => {
    const instant = new Date("2026-03-13T15:30:00Z");
    for (const timezone of ["America/Los_Angeles", "UTC", "Pacific/Auckland"]) {
      process.env.TZ = timezone;
      expect(formatDateToYYYYMMDD(instant)).toBe("20260314");
      expect(isWeekend(instant)).toBe(true);
    }
  });
});

describe("official KRX date classification", () => {
  it("classifies Lunar New Year and Chuseok closures", () => {
    expect(classifyKrxDate("20260217")).toMatchObject({
      status: "non_trading",
      verified: true,
      reason: expect.stringContaining("Seollal"),
    });
    expect(classifyKrxDate("20260924")).toMatchObject({
      status: "non_trading",
      verified: true,
      reason: expect.stringContaining("Chuseok"),
    });
  });

  it("classifies weekends and ad-hoc closures", () => {
    expect(classifyKrxDate("20260314")).toMatchObject({
      status: "non_trading",
      reason: "Weekend in KST",
    });
    expect(classifyKrxDate("20250603")).toMatchObject({
      status: "non_trading",
      reason: "Temporary Holiday",
    });
  });

  it("marks weekdays outside snapshot coverage as unknown", () => {
    expect(classifyKrxDate("20150102")).toEqual({
      date: "20150102",
      status: "unknown",
      verified: false,
    });
  });
});

describe("recent KRX session resolution", () => {
  it("skips the full Lunar New Year closure", () => {
    expect(resolveRecentTradingDate(atKst(2026, 2, 19)).date).toBe("20260213");
  });

  it("skips Chuseok and its adjacent weekend", () => {
    expect(resolveRecentTradingDate(atKst(2026, 9, 28)).date).toBe("20260923");
  });

  it("crosses the year boundary past both KRX year-end closures", () => {
    expect(resolveRecentTradingDate(atKst(2026, 1, 2)).date).toBe("20251230");
  });

  it("skips an ad-hoc election closure", () => {
    expect(resolveRecentTradingDate(atKst(2025, 6, 4)).date).toBe("20250602");
  });

  it("falls back observably to the last verified session when coverage is stale", () => {
    const resolution = resolveRecentTradingDate(atKst(2027, 1, 5));

    expect(resolution).toMatchObject({
      date: "20261230",
      confidence: "stale_fallback",
      calendar: { coverage: "fallback" },
      warning: expect.stringContaining("unavailable for 2027"),
    });
    expect(resolution.calendar.unverifiedDates).toEqual(["20270104"]);
    expect(resolution.calendar.fallbackYears).toEqual([2027]);
  });

  it("warns observably when the default crosses stale coverage", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(getRecentTradingDate(atKst(2027, 1, 2))).toBe("20261230");
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("KRX_CALENDAR_FALLBACK"),
    );
  });
});

describe("KRX range selection", () => {
  it("returns only verified sessions across Lunar New Year", () => {
    expect(getTradingDays("20260213", "20260219")).toEqual([
      "20260213",
      "20260219",
    ]);
  });

  it("classifies known non-trading dates as skipped", () => {
    const selection = getTradingDaySelection("20260923", "20260928");

    expect(selection).toMatchObject({
      requestedDates: [
        "20260923",
        "20260924",
        "20260925",
        "20260926",
        "20260927",
        "20260928",
      ],
      tradingDays: ["20260923", "20260928"],
      skippedDays: ["20260924", "20260925", "20260926", "20260927"],
      calendar: { coverage: "verified", unverifiedDates: [] },
    });
  });

  it("keeps uncovered weekdays as an observable probe fallback", () => {
    const selection = getTradingDaySelection("20150101", "20150104");

    expect(selection).toMatchObject({
      requestedDates: ["20150101", "20150102", "20150103", "20150104"],
      tradingDays: ["20150101", "20150102"],
      skippedDays: ["20150103", "20150104"],
      calendar: {
        coverage: "fallback",
        fallbackYears: [2015],
        unverifiedDates: ["20150101", "20150102"],
      },
    });
  });

  it("uses conservative fixed-closure rules only beyond current coverage", () => {
    const selection = getTradingDaySelection("20270101", "20270104");

    expect(selection).toMatchObject({
      tradingDays: ["20270104"],
      skippedDays: ["20270101", "20270102", "20270103"],
      calendar: {
        coverage: "fallback",
        fallbackYears: [2027],
        unverifiedDates: ["20270104"],
      },
    });
  });

  it("returns empty partitions when from is after to", () => {
    expect(getTradingDaySelection("20260310", "20260309")).toMatchObject({
      requestedDates: [],
      tradingDays: [],
      skippedDays: [],
    });
  });
});
