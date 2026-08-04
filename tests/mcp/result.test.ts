import { describe, it, expect } from "vitest";
import {
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
