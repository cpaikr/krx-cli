import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/auth.js", () => ({ getApiKey: () => "test-key" }));
vi.mock("../../src/client/range-fetch.js", () => ({ fetchDateRange: vi.fn() }));
vi.mock("../../src/output/formatter.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/output/formatter.js")>();
  return {
    ...actual,
    writeOutput: vi.fn(),
    writeError: vi.fn(),
  };
});

import { executeCommand } from "../../src/cli/command-helper.js";
import { fetchDateRange } from "../../src/client/range-fetch.js";
import { writeOutput } from "../../src/output/formatter.js";

const mockedFetchDateRange = vi.mocked(fetchDateRange);
const mockedWriteOutput = vi.mocked(writeOutput);

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

function programOptions(overrides: Record<string, unknown> = {}): Command {
  return {
    opts: () => ({
      cache: true,
      from: "20180427",
      to: "20180504",
      code: "005930",
      sort: "BAS_DD",
      asc: true,
      limit: 1,
      ...overrides,
    }),
  } as unknown as Command;
}

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

function outputEnvelope(): Record<string, unknown> {
  const output = mockedWriteOutput.mock.calls.at(-1)?.[0];
  return JSON.parse(String(output)) as Record<string, unknown>;
}

describe("CLI adjusted stock ranges", () => {
  beforeEach(() => {
    mockedFetchDateRange.mockResolvedValue(completeRange());
    mockedWriteOutput.mockClear();
    process.exitCode = undefined;
  });

  it("adjusts by default before the row pipeline", async () => {
    await executeCommand({
      endpoint: "/svc/apis/sto/stk_bydd_trd",
      params: { basDd: "20180427" },
      program: programOptions(),
    });

    expect(outputEnvelope()).toMatchObject({
      success: true,
      adjustment: { asOf: "20180504", cashDividends: "excluded" },
      data: [
        { BAS_DD: "20180427", ADJ_TDD_CLSPRC: "53000", ADJ_FACTOR: "1/50" },
      ],
    });
  });

  it("keeps explicit raw-only output free of derived fields", async () => {
    await executeCommand({
      endpoint: "/svc/apis/sto/stk_bydd_trd",
      params: { basDd: "20180427" },
      program: programOptions({ limit: undefined }),
      adjusted: false,
    });

    const body = outputEnvelope();
    expect(body.adjustment).toBeUndefined();
    expect(body.data).toEqual(rawRows);
  });
});
