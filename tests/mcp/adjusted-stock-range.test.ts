import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/auth.js", () => ({ getApiKey: () => "test-key" }));
vi.mock("../../src/client/range-fetch.js", () => ({ fetchDateRange: vi.fn() }));

import { fetchDateRange } from "../../src/client/range-fetch.js";
import { createCategoryTools } from "../../src/mcp/tools/index.js";

const mockedFetchDateRange = vi.mocked(fetchDateRange);

const rawRows = [
  {
    BAS_DD: "20180427",
    ISU_CD: "005930",
    ISU_NM: "삼성전자",
    MKT_NM: "KOSPI",
    TDD_OPNPRC: "2669000",
    TDD_HGPRC: "2682000",
    TDD_LWPRC: "2622000",
    TDD_CLSPRC: "2650000",
    CMPPREVDD_PRC: "43000",
    ACC_TRDVOL: "606216",
    MKTCAP: "340224209100000",
    LIST_SHRS: "128386494",
  },
  {
    BAS_DD: "20180504",
    ISU_CD: "005930",
    ISU_NM: "삼성전자",
    MKT_NM: "KOSPI",
    TDD_OPNPRC: "53000",
    TDD_HGPRC: "53900",
    TDD_LWPRC: "51800",
    TDD_CLSPRC: "51900",
    CMPPREVDD_PRC: "-1100",
    ACC_TRDVOL: "39565391",
    MKTCAP: "333162951930000",
    LIST_SHRS: "6419324700",
  },
] as const;

function completeRange() {
  return {
    success: true as const,
    data: rawRows,
    completeness: {
      state: "complete" as const,
      requested: ["20180427", "20180504"],
      succeeded: ["20180427", "20180504"],
      failed: [],
      skipped: [],
    },
    fetchedDays: 2,
    failedDays: 0,
    calendar: {
      version: 1 as const,
      source: "official",
      retrievedAt: "2026-08-13",
      coverage: "verified" as const,
      fallbackYears: [],
      unverifiedDates: [],
    },
  };
}

function parseResult(
  result: Awaited<
    ReturnType<ReturnType<typeof createCategoryTools>[number]["handler"]>
  >,
) {
  return JSON.parse(result.content[0]?.text ?? "null") as Record<
    string,
    unknown
  >;
}

describe("krx_stock adjusted ranges", () => {
  beforeEach(() => mockedFetchDateRange.mockResolvedValue(completeRange()));

  it("adjusts by default before limit and preserves envelope metadata", async () => {
    const stock = createCategoryTools().find(
      (tool) => tool.name === "krx_stock",
    );
    const result = await stock?.handler({
      endpoint: "stk_bydd_trd",
      date_from: "20180427",
      date_to: "20180504",
      isuCd: "005930",
      sort: "BAS_DD",
      sort_direction: "asc",
      limit: 1,
    });
    expect(result).toBeDefined();
    const body = parseResult(result!);
    expect(body).toMatchObject({
      success: true,
      adjustment: { asOf: "20180504", cashDividends: "excluded" },
      data: [
        { BAS_DD: "20180427", ADJ_TDD_CLSPRC: "53000", ADJ_FACTOR: "1/50" },
      ],
    });
  });

  it("supports explicit raw-only ranges", async () => {
    const stock = createCategoryTools().find(
      (tool) => tool.name === "krx_stock",
    );
    const result = await stock?.handler({
      endpoint: "stk_bydd_trd",
      date_from: "20180427",
      date_to: "20180504",
      isuCd: "005930",
      adjusted: false,
    });
    const body = parseResult(result!);
    expect(body.adjustment).toBeUndefined();
    expect(body.data).toEqual(rawRows);
  });

  it("returns no rows for incomplete adjusted input", async () => {
    mockedFetchDateRange.mockResolvedValue({
      ...completeRange(),
      completeness: {
        ...completeRange().completeness,
        state: "partial",
        failed: [{ id: "20180504", error: "network", errorType: "network" }],
      },
      failedDays: 1,
    });
    const stock = createCategoryTools().find(
      (tool) => tool.name === "krx_stock",
    );
    const result = await stock?.handler({
      endpoint: "stk_bydd_trd",
      date_from: "20180427",
      date_to: "20180504",
      isuCd: "005930",
    });
    expect(result?.isError).toBe(true);
    expect(parseResult(result!)).toMatchObject({
      success: false,
      data: [],
      errorType: "integrity",
      completeness: { state: "failed" },
    });
  });

  it("preserves a successful empty range when no trading date exists", async () => {
    mockedFetchDateRange.mockResolvedValue({
      ...completeRange(),
      data: [],
      completeness: {
        ...completeRange().completeness,
        state: "empty",
        requested: [],
        succeeded: [],
        skipped: ["20180428", "20180429"],
      },
      fetchedDays: 0,
    });
    const stock = createCategoryTools().find(
      (tool) => tool.name === "krx_stock",
    );
    const result = await stock?.handler({
      endpoint: "stk_bydd_trd",
      date_from: "20180428",
      date_to: "20180429",
      isuCd: "005930",
    });
    expect(result?.isError).toBeUndefined();
    expect(parseResult(result!)).toMatchObject({
      success: true,
      data: [],
      completeness: { state: "empty", succeeded: [] },
    });
  });

  it("preserves typed upstream failures for adjusted ranges", async () => {
    mockedFetchDateRange.mockResolvedValue({
      ...completeRange(),
      success: false,
      data: [],
      error: "authentication failed",
      errorType: "authentication",
      completeness: {
        ...completeRange().completeness,
        state: "failed",
        succeeded: [],
        failed: [
          {
            id: "20180427",
            error: "authentication failed",
            errorType: "authentication",
          },
        ],
      },
      fetchedDays: 0,
      failedDays: 1,
    });
    const stock = createCategoryTools().find(
      (tool) => tool.name === "krx_stock",
    );
    const result = await stock?.handler({
      endpoint: "stk_bydd_trd",
      date_from: "20180427",
      date_to: "20180504",
      isuCd: "005930",
    });
    expect(result?.isError).toBe(true);
    expect(parseResult(result!)).toMatchObject({
      success: false,
      data: [],
      error: "authentication failed",
      errorType: "authentication",
      completeness: { state: "failed" },
    });
  });

  it("scopes the adjusted input to the stock tool", () => {
    const tools = createCategoryTools();
    expect(
      tools.find((tool) => tool.name === "krx_stock")?.inputSchema.adjusted,
    ).toBeDefined();
    for (const tool of tools.filter((item) => item.name !== "krx_stock")) {
      expect(tool.inputSchema.adjusted).toBeUndefined();
    }
  });
});
