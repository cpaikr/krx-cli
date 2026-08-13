import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adjustStockDateRange,
  adjustStockRows,
} from "../../src/client/stock-adjustment.js";
import type { DateRangeResult } from "../../src/client/range-fetch.js";

interface OracleCase {
  readonly name: string;
  readonly raw: readonly Record<string, string>[];
  readonly adjustedOhlc: readonly (readonly string[])[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/adjusted-stock-prices/oracles.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: readonly OracleCase[] };

function row(
  date: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    BAS_DD: date,
    ISU_CD: "000001",
    ISU_NM: "테스트",
    MKT_NM: "KOSPI",
    TDD_OPNPRC: "100",
    TDD_HGPRC: "110",
    TDD_LWPRC: "90",
    TDD_CLSPRC: "100",
    CMPPREVDD_PRC: "0",
    ACC_TRDVOL: "1",
    MKTCAP: "1000",
    LIST_SHRS: "10",
    ...overrides,
  };
}

function envelope(
  data: readonly Record<string, string>[],
  state: "complete" | "partial" = "complete",
): DateRangeResult<Record<string, string>> {
  const dates = data.map((item) => item.BAS_DD ?? "");
  return {
    success: true,
    data,
    completeness: {
      state,
      requested: dates,
      succeeded: dates,
      failed:
        state === "partial"
          ? [{ id: "20240103", error: "upstream failed", errorType: "network" }]
          : [],
      skipped: [],
    },
    fetchedDays: dates.length,
    failedDays: state === "partial" ? 1 : 0,
    calendar: {
      version: 1,
      source: "official",
      retrievedAt: "2026-08-13",
      coverage: "verified",
      fallbackYears: [],
      unverifiedDates: [],
    },
  };
}

describe("adjustStockRows", () => {
  it.each(fixture.cases)("matches the official $name oracle", (oracle) => {
    const result = adjustStockRows(oracle.raw);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(
      result.data.map((item) => [
        item.ADJ_TDD_OPNPRC,
        item.ADJ_TDD_HGPRC,
        item.ADJ_TDD_LWPRC,
        item.ADJ_TDD_CLSPRC,
      ]),
    ).toEqual(oracle.adjustedOhlc);
    expect(result.adjustment.asOf).toBe(oracle.raw.at(-1)?.BAS_DD);
    expect(result.data.at(-1)?.ADJ_FACTOR).toBe("1/1");
  });

  it("accumulates multiple exact fractional transitions", () => {
    const result = adjustStockRows([
      row("20240101"),
      row("20240102", {
        TDD_LWPRC: "80",
        TDD_CLSPRC: "90",
        CMPPREVDD_PRC: "40",
        MKTCAP: "900",
      }),
      row("20240103", {
        TDD_OPNPRC: "80",
        TDD_LWPRC: "70",
        TDD_CLSPRC: "80",
        CMPPREVDD_PRC: "20",
        MKTCAP: "800",
      }),
    ]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((item) => item.ADJ_FACTOR)).toEqual([
      "1/3",
      "2/3",
      "1/1",
    ]);
    expect(result.data.map((item) => item.ADJ_TDD_CLSPRC)).toEqual([
      "33",
      "60",
      "80",
    ]);
  });

  it("accepts canonical comma formatting and negative changes", () => {
    const result = adjustStockRows([
      row("20240101", {
        TDD_OPNPRC: "1,000",
        TDD_HGPRC: "1,100",
        TDD_LWPRC: "900",
        TDD_CLSPRC: "1,000",
        CMPPREVDD_PRC: "-10",
        MKTCAP: "10,000",
      }),
    ]);
    expect(result.success).toBe(true);
  });

  it("fails closed when FLUC_RT contradicts the implied reference price", () => {
    const result = adjustStockRows([
      row("20240101", {
        TDD_CLSPRC: "90",
        CMPPREVDD_PRC: "-10",
        FLUC_RT: "-9.99",
        MKTCAP: "900",
      }),
    ]);
    expect(result).toMatchObject({
      success: false,
      data: [],
      errorType: "integrity",
    });
  });

  it("fails closed when a suspended transition cannot be reconciled", () => {
    const result = adjustStockRows([
      row("20240101", {
        TDD_OPNPRC: "0",
        TDD_HGPRC: "0",
        TDD_LWPRC: "0",
        ACC_TRDVOL: "0",
      }),
      row("20240102", {
        TDD_LWPRC: "80",
        TDD_CLSPRC: "90",
        CMPPREVDD_PRC: "40",
        MKTCAP: "900",
      }),
    ]);
    expect(result).toMatchObject({
      success: false,
      data: [],
      errorType: "integrity",
    });
  });

  it.each([
    ["reordered dates", [row("20240102"), row("20240101")]],
    ["duplicate dates", [row("20240101"), row("20240101")]],
    ["zero close", [row("20240101", { TDD_CLSPRC: "0", MKTCAP: "0" })]],
    ["missing field", [row("20240101", { TDD_OPNPRC: "" })]],
    ["malformed integer", [row("20240101", { TDD_CLSPRC: "1,00" })]],
    ["OHLC violation", [row("20240101", { TDD_HGPRC: "95" })]],
    ["identity change", [row("20240101"), row("20240102", { ISU_NM: "다름" })]],
  ])("fails closed for %s", (_label, rows) => {
    const result = adjustStockRows(rows as Record<string, string>[]);
    expect(result).toMatchObject({
      success: false,
      data: [],
      errorType: "integrity",
    });
  });

  it("handles long histories without floating-point overflow", () => {
    const rows = Array.from({ length: 400 }, (_, index) =>
      row(
        `2024${String(Math.floor(index / 28) + 1).padStart(2, "0")}${String((index % 28) + 1).padStart(2, "0")}`,
      ),
    );
    // Use lexically ordered synthetic dates while keeping a long BigInt path.
    rows.forEach((item, index) => {
      item.BAS_DD = String(20240000 + index).padStart(8, "0");
      if (index > 0) item.CMPPREVDD_PRC = "-1";
    });
    const result = adjustStockRows(rows);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(400);
      expect(result.data[0]?.ADJ_FACTOR).toBe(
        `${101n ** 399n}/${100n ** 399n}`,
      );
    }
  });
});

describe("adjustStockDateRange", () => {
  it("preserves upstream evidence and adds adjustment metadata", () => {
    const result = adjustStockDateRange(
      envelope([row("20240101"), row("20240102")]),
    );
    expect(result).toMatchObject({
      success: true,
      completeness: { state: "complete" },
      adjustment: { asOf: "20240102", cashDividends: "excluded" },
    });
  });

  it("turns partial input into an empty integrity failure", () => {
    const result = adjustStockDateRange(envelope([row("20240101")], "partial"));
    expect(result).toMatchObject({
      success: false,
      data: [],
      errorType: "integrity",
      completeness: { state: "failed" },
    });
  });

  it("rejects a missing target row on a successful market date", () => {
    const input = envelope([row("20240101")]);
    const result = adjustStockDateRange({
      ...input,
      completeness: {
        ...input.completeness,
        requested: ["20240101", "20240102"],
        succeeded: ["20240101", "20240102"],
      },
    });
    expect(result).toMatchObject({
      success: false,
      data: [],
      errorType: "integrity",
    });
  });
});
