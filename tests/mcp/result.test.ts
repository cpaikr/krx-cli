import { describe, it, expect } from "vitest";
import {
  compositeResult,
  successResult,
  errorResult,
  textResult,
} from "../../src/mcp/tools/result.js";

describe("successResult", () => {
  it("returns data as-is when within size limit", () => {
    const data = [{ name: "test", value: "123" }];
    const result = successResult(data);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(data);
  });

  it("truncates data when exceeding size limit", () => {
    // Generate ~2MB of data
    const bigRow: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      bigRow[`field_${i}`] = "x".repeat(200);
    }
    const data = Array.from({ length: 200 }, () => ({ ...bigRow }));

    const result = successResult(data);
    const parsed = JSON.parse(result.content[0]!.text) as {
      data: unknown[];
      _truncated: { total: number; returned: number; message: string };
    };

    expect(parsed._truncated).toBeDefined();
    expect(parsed._truncated.total).toBe(200);
    expect(parsed._truncated.returned).toBeLessThan(200);
    expect(parsed.data.length).toBe(parsed._truncated.returned);
    expect(Buffer.byteLength(result.content[0]!.text, "utf-8")).toBeLessThan(
      500_000,
    );
  });
});

describe("errorResult", () => {
  it("returns error with isError flag", () => {
    const result = errorResult("something failed");

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe("something failed");
  });

  it("includes a stable error type when provided", () => {
    const result = errorResult("request expired", "timeout");

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: "request expired",
      errorType: "timeout",
    });
  });
});

describe("textResult", () => {
  it("returns data without isError by default", () => {
    const result = textResult({ foo: "bar" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.foo).toBe("bar");
  });

  it("sets isError when specified", () => {
    const result = textResult({ error: "oops" }, true);
    expect(result.isError).toBe(true);
  });
});

describe("compositeResult", () => {
  it("retains completeness metadata when row data is truncated", () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: String(index),
      payload: "x".repeat(1_000),
    }));
    const result = compositeResult({
      success: true,
      data: rows,
      completeness: {
        state: "partial",
        requested: ["KOSPI", "KOSDAQ"],
        succeeded: ["KOSPI"],
        failed: [{ id: "KOSDAQ", error: "unavailable" }],
        skipped: [],
      },
    });
    const parsed = JSON.parse(result.content[0]!.text) as {
      data: unknown[];
      completeness: { state: string; failed: { id: string }[] };
      _truncated: { total: number; returned: number };
    };

    expect(parsed.data.length).toBeLessThan(rows.length);
    expect(parsed._truncated.total).toBe(rows.length);
    expect(parsed._truncated.returned).toBe(parsed.data.length);
    expect(parsed.completeness).toMatchObject({
      state: "partial",
      failed: [{ id: "KOSDAQ" }],
    });
    expect(
      Buffer.byteLength(result.content[0]!.text, "utf8"),
    ).toBeLessThanOrEqual(500_000);
  });

  it("retains a watchlist envelope when nested stock rows are truncated", () => {
    const stocks = Array.from({ length: 1_000 }, (_, index) => ({
      ISU_CD: String(index),
      payload: "x".repeat(1_000),
    }));
    const result = compositeResult({
      success: true,
      data: { date: "20260310", stocks },
      completeness: {
        state: "complete",
        requested: ["KOSPI", "KOSDAQ"],
        succeeded: ["KOSPI", "KOSDAQ"],
        failed: [],
        skipped: [],
      },
    });
    const parsed = JSON.parse(result.content[0]!.text) as {
      data: { date: string; stocks: unknown[] };
      completeness: { state: string };
      _truncated: { path: string; total: number; returned: number };
    };

    expect(parsed.data.date).toBe("20260310");
    expect(parsed.data.stocks.length).toBeLessThan(stocks.length);
    expect(parsed._truncated).toMatchObject({
      path: "data.stocks",
      total: stocks.length,
      returned: parsed.data.stocks.length,
    });
    expect(parsed.completeness.state).toBe("complete");
    expect(
      Buffer.byteLength(result.content[0]!.text, "utf8"),
    ).toBeLessThanOrEqual(500_000);
  });
});
