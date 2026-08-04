import { afterEach, describe, it, expect } from "vitest";
import {
  detectOutputFormat,
  formatOutput,
} from "../../src/output/formatter.js";

const SAMPLE_DATA = [
  { IDX_NM: "코스피", CLSPRC_IDX: "2650.00", FLUC_RT: "0.5" },
  { IDX_NM: "코스피 200", CLSPRC_IDX: "350.00", FLUC_RT: "-0.2" },
];

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
  if (originalIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

describe("detectOutputFormat", () => {
  it("defaults to table on a TTY and JSON when redirected", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    expect(detectOutputFormat()).toBe("table");

    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    expect(detectOutputFormat()).toBe("json");
  });

  it("accepts supported explicit formats and rejects unsupported ones", () => {
    expect(detectOutputFormat("ndjson")).toBe("ndjson");
    expect(() => detectOutputFormat("yaml")).toThrow(
      "Unsupported output format: yaml",
    );
  });
});

describe("formatOutput", () => {
  describe("json", () => {
    it("outputs valid JSON", () => {
      const result = formatOutput(SAMPLE_DATA, "json");
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].IDX_NM).toBe("코스피");
    });

    it("pretty prints with 2-space indent", () => {
      const result = formatOutput(SAMPLE_DATA, "json");
      expect(result).toContain("\n");
      expect(result).toContain("  ");
    });
  });

  describe("ndjson", () => {
    it("outputs one JSON object per line", () => {
      const result = formatOutput(SAMPLE_DATA, "ndjson");
      const lines = result.split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).IDX_NM).toBe("코스피");
      expect(JSON.parse(lines[1]!).IDX_NM).toBe("코스피 200");
    });
  });

  describe("table", () => {
    it("outputs header, separator, and rows", () => {
      const result = formatOutput(SAMPLE_DATA, "table");
      const lines = result.split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(lines[0]).toContain("IDX_NM");
      expect(lines[1]).toMatch(/^-+/);
    });

    it("returns (no data) for empty array", () => {
      const result = formatOutput([], "table");
      expect(result).toBe("(no data)");
    });
  });

  describe("csv", () => {
    it("outputs CSV with header row", () => {
      const result = formatOutput(SAMPLE_DATA, "csv");
      const lines = result.split("\n");
      expect(lines[0]).toBe("IDX_NM,CLSPRC_IDX,FLUC_RT");
      expect(lines[1]).toBe("코스피,2650.00,0.5");
      expect(lines[2]).toBe("코스피 200,350.00,-0.2");
    });

    it("escapes fields containing commas", () => {
      const data = [{ NAME: "A,B", VALUE: "100" }];
      const result = formatOutput(data, "csv");
      const lines = result.split("\n");
      expect(lines[1]).toBe('"A,B",100');
    });

    it("escapes fields containing double quotes", () => {
      const data = [{ NAME: 'A"B', VALUE: "100" }];
      const result = formatOutput(data, "csv");
      const lines = result.split("\n");
      expect(lines[1]).toBe('"A""B",100');
    });

    it("escapes fields containing newlines", () => {
      const data = [{ NAME: "A\nB", VALUE: "100" }];
      const result = formatOutput(data, "csv");
      const lines = result.split("\n");
      expect(lines[1]).toContain('"A');
    });

    it("returns empty string for empty data", () => {
      const result = formatOutput([], "csv");
      expect(result).toBe("");
    });

    it("handles Korean characters correctly", () => {
      const data = [{ 종목명: "삼성전자", 등락률: "2.50" }];
      const result = formatOutput(data, "csv");
      expect(result).toContain("삼성전자");
    });
  });

  describe("field filtering", () => {
    it("filters to specified fields", () => {
      const result = formatOutput(SAMPLE_DATA, "json", ["IDX_NM"]);
      const parsed = JSON.parse(result);
      expect(parsed[0]).toEqual({ IDX_NM: "코스피" });
      expect(parsed[0]).not.toHaveProperty("CLSPRC_IDX");
    });

    it("ignores non-existent fields", () => {
      const result = formatOutput(SAMPLE_DATA, "json", ["NONEXISTENT"]);
      const parsed = JSON.parse(result);
      expect(parsed[0]).toEqual({});
    });
  });
});
