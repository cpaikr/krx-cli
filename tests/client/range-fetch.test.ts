import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchDateRange } from "../../src/client/range-fetch.js";

vi.mock("../../src/client/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/client.js")>()),
  krxFetch: vi.fn(),
}));

vi.mock("../../src/utils/date.js", () => ({
  getTradingDaySelection: vi.fn(),
  formatDateToYYYYMMDD: () => "20260312",
}));

import { krxFetch } from "../../src/client/client.js";
import { getTradingDaySelection } from "../../src/utils/date.js";

const mockedKrxFetch = vi.mocked(krxFetch);
const mockedGetTradingDaySelection = vi.mocked(getTradingDaySelection);

function mockTradingDays(
  tradingDays: readonly string[],
  skippedDays: readonly string[] = [],
  unverifiedDates: readonly string[] = [],
): void {
  mockedGetTradingDaySelection.mockReturnValue({
    requestedDates: [...tradingDays, ...skippedDays].sort(),
    tradingDays,
    skippedDays,
    calendar: {
      version: 1,
      source: "https://global.krx.co.kr/calendar",
      retrievedAt: "2026-08-04",
      coverage: unverifiedDates.length > 0 ? "fallback" : "verified",
      fallbackYears: unverifiedDates.map((date) => Number(date.slice(0, 4))),
      unverifiedDates,
    },
  });
}

describe("fetchDateRange", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("fetches data for each trading day and merges results", async () => {
    mockTradingDays(["20260309", "20260310"]);
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [{ BAS_DD: "20260309", IDX_NM: "코스피", TDD_CLSPRC: "2700" }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ BAS_DD: "20260310", IDX_NM: "코스피", TDD_CLSPRC: "2710" }],
      });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260310",
      apiKey: "test-key",
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.completeness).toMatchObject({
      state: "complete",
      requested: ["20260309", "20260310"],
      succeeded: ["20260309", "20260310"],
      failed: [],
      skipped: [],
    });
    expect(result.data[0]).toEqual({
      BAS_DD: "20260309",
      IDX_NM: "코스피",
      TDD_CLSPRC: "2700",
    });
    expect(result.data[1]).toEqual({
      BAS_DD: "20260310",
      IDX_NM: "코스피",
      TDD_CLSPRC: "2710",
    });
  });

  it("skips days with empty data (holidays)", async () => {
    mockTradingDays(["20260309", "20260310", "20260311"]);
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [{ BAS_DD: "20260309", IDX_NM: "코스피" }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ BAS_DD: "20260311", IDX_NM: "코스피" }],
      });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260311",
      apiKey: "test-key",
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.completeness).toMatchObject({
      state: "complete",
      succeeded: ["20260309", "20260311"],
      skipped: ["20260310"],
    });
  });

  it("skips known exchange closures without spending KRX calls", async () => {
    mockTradingDays(
      ["20260923", "20260928"],
      ["20260924", "20260925", "20260926", "20260927"],
    );
    mockedKrxFetch.mockResolvedValue({ success: true, data: [{ value: "1" }] });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260923",
      to: "20260928",
      apiKey: "test-key",
    });

    expect(mockedKrxFetch).toHaveBeenCalledTimes(2);
    expect(result.completeness).toMatchObject({
      requested: [
        "20260923",
        "20260924",
        "20260925",
        "20260926",
        "20260927",
        "20260928",
      ],
      succeeded: ["20260923", "20260928"],
      skipped: ["20260924", "20260925", "20260926", "20260927"],
      failed: [],
    });
    expect(result.fetchedDays).toBe(2);
  });

  it("reports an observable fallback for uncovered historical weekdays", async () => {
    mockTradingDays(["20150102"], [], ["20150102"]);
    mockedKrxFetch.mockResolvedValue({ success: true, data: [{ value: "1" }] });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20150102",
      to: "20150102",
      apiKey: "test-key",
    });

    expect(result.calendar).toMatchObject({
      coverage: "fallback",
      unverifiedDates: ["20150102"],
    });
    expect(mockedKrxFetch).toHaveBeenCalledTimes(1);
  });

  it("returns error when all days fail", async () => {
    mockTradingDays(["20260309"]);
    mockedKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      error: "HTTP 500: Internal Server Error",
    });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260309",
      apiKey: "test-key",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.completeness).toMatchObject({
      state: "failed",
      failed: [{ id: "20260309" }],
    });
  });

  it("remains failed when every attempted session fails beside known closures", async () => {
    mockTradingDays(["20260923"], ["20260924"]);
    mockedKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      error: "HTTP 500",
      errorType: "upstream",
    });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260923",
      to: "20260924",
      apiKey: "test-key",
    });

    expect(result).toMatchObject({
      success: false,
      completeness: {
        state: "failed",
        failed: [{ id: "20260923" }],
        skipped: ["20260924"],
      },
    });
  });

  it("preserves the highest-priority typed error when all days fail", async () => {
    mockTradingDays(["20260309", "20260310"]);
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "Gateway unavailable",
        errorType: "upstream",
      })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "KRX request deadline exceeded",
        errorType: "timeout",
      });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260310",
      apiKey: "test-key",
    });

    expect(result).toMatchObject({
      success: false,
      error: "KRX request deadline exceeded",
      errorType: "timeout",
    });
  });

  it("returns partial results when some days fail", async () => {
    mockTradingDays(["20260309", "20260310"]);
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [{ BAS_DD: "20260309", IDX_NM: "코스피" }],
      })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "HTTP 500",
      });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260310",
      apiKey: "test-key",
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.completeness).toMatchObject({
      state: "partial",
      succeeded: ["20260309"],
      failed: [{ id: "20260310" }],
    });
  });

  it("does not hide cancellation behind an earlier successful day", async () => {
    mockTradingDays(["20260309", "20260310"]);
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [{ BAS_DD: "20260309" }],
      })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "KRX request was cancelled",
        errorType: "cancelled",
      });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260310",
      apiKey: "test-key",
    });

    expect(result).toMatchObject({ success: false, errorType: "cancelled" });
    expect(result.data).toEqual([]);
  });

  it("respects concurrency limit", async () => {
    const days = Array.from({ length: 10 }, (_, i) => {
      const d = (1 + i).toString().padStart(2, "0");
      return `202603${d}`;
    });
    mockTradingDays(days);

    let activeConcurrent = 0;
    let maxConcurrent = 0;

    mockedKrxFetch.mockImplementation(async (opts) => {
      activeConcurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, activeConcurrent);
      await new Promise((r) => setTimeout(r, 10));
      activeConcurrent -= 1;
      return {
        success: true,
        data: [{ BAS_DD: opts.params["basDd"] ?? "" }],
      };
    });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260301",
      to: "20260310",
      apiKey: "test-key",
      concurrency: 3,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(10);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("returns empty data when no trading days in range", async () => {
    mockTradingDays([], ["20260307", "20260308"]);

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260307",
      to: "20260308",
      apiKey: "test-key",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.completeness.state).toBe("empty");
  });

  it("distinguishes all successful empty dates from failures", async () => {
    mockTradingDays(["20260309", "20260310"]);
    mockedKrxFetch.mockResolvedValue({ success: true, data: [] });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260310",
      apiKey: "test-key",
    });

    expect(result).toMatchObject({
      success: true,
      data: [],
      completeness: {
        state: "empty",
        succeeded: [],
        failed: [],
        skipped: ["20260309", "20260310"],
      },
    });
  });

  it("passes cache and refresh options through to krxFetch", async () => {
    mockTradingDays(["20260309"]);
    mockedKrxFetch.mockResolvedValue({
      success: true,
      data: [{ BAS_DD: "20260309" }],
    });

    await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260309",
      apiKey: "test-key",
      cache: true,
      refresh: true,
    });

    expect(mockedKrxFetch).toHaveBeenCalledWith(
      expect.objectContaining({ cache: true, refresh: true }),
    );
  });

  it("preserves date order in results", async () => {
    mockTradingDays(["20260309", "20260310", "20260311"]);

    // Simulate out-of-order completion
    mockedKrxFetch
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { success: true, data: [{ BAS_DD: "20260309" }] };
      })
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { success: true, data: [{ BAS_DD: "20260310" }] };
      })
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { success: true, data: [{ BAS_DD: "20260311" }] };
      });

    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260309",
      to: "20260311",
      apiKey: "test-key",
    });

    expect(result.data.map((d) => d["BAS_DD"])).toEqual([
      "20260309",
      "20260310",
      "20260311",
    ]);
  });

  it("returns error when from is after to", async () => {
    const result = await fetchDateRange({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      from: "20260315",
      to: "20260310",
      apiKey: "test-key",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be after");
    expect(mockedKrxFetch).not.toHaveBeenCalled();
  });

  it("passes additional params (like isuCd) to each fetch", async () => {
    mockTradingDays(["20260309"]);
    mockedKrxFetch.mockResolvedValue({
      success: true,
      data: [{ BAS_DD: "20260309" }],
    });

    await fetchDateRange({
      endpoint: "/svc/apis/sto/stk_bydd_trd",
      from: "20260309",
      to: "20260309",
      apiKey: "test-key",
      extraParams: { isuCd: "KR7005930003" },
    });

    expect(mockedKrxFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { basDd: "20260309", isuCd: "KR7005930003" },
      }),
    );
  });
});
