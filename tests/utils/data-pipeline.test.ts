import { describe, it, expect } from "vitest";
import {
  parseKrxNumber,
  sortData,
  limitData,
  applyPipeline,
} from "../../src/utils/data-pipeline.js";

describe("parseKrxNumber", () => {
  it("parses plain number", () => {
    expect(parseKrxNumber("1234")).toBe(1234);
  });

  it("parses comma-formatted number", () => {
    expect(parseKrxNumber("2,650.00")).toBe(2650);
  });

  it("parses negative number", () => {
    expect(parseKrxNumber("-0.5")).toBe(-0.5);
  });

  it("parses negative comma-formatted number", () => {
    expect(parseKrxNumber("-1,234.56")).toBe(-1234.56);
  });

  it("returns 0 for non-numeric string", () => {
    expect(parseKrxNumber("삼성전자")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseKrxNumber("")).toBe(0);
  });
});

describe("sortData", () => {
  const data = [
    { ISU_NM: "삼성전자", FLUC_RT: "2.5" },
    { ISU_NM: "카카오", FLUC_RT: "-1.3" },
    { ISU_NM: "SK하이닉스", FLUC_RT: "5.0" },
  ];

  it("sorts numerically descending by default", () => {
    const result = sortData(data, "FLUC_RT");
    expect(result.map((r) => r["FLUC_RT"])).toEqual(["5.0", "2.5", "-1.3"]);
  });

  it("sorts numerically ascending", () => {
    const result = sortData(data, "FLUC_RT", "asc");
    expect(result.map((r) => r["FLUC_RT"])).toEqual(["-1.3", "2.5", "5.0"]);
  });

  it("sorts strings by Korean locale", () => {
    const result = sortData(data, "ISU_NM", "asc");
    // Korean locale: 한글(삼, 카) before ASCII(SK)
    expect(result.map((r) => r["ISU_NM"])).toEqual([
      "삼성전자",
      "카카오",
      "SK하이닉스",
    ]);
  });

  it("handles comma-formatted numbers", () => {
    const commaData = [{ VOL: "1,000" }, { VOL: "500" }, { VOL: "2,500" }];
    const result = sortData(commaData, "VOL", "desc");
    expect(result.map((r) => r["VOL"])).toEqual(["2,500", "1,000", "500"]);
  });

  it("handles missing field gracefully", () => {
    const result = sortData(data, "NONEXISTENT");
    expect(result).toHaveLength(3);
  });

  it("handles empty array", () => {
    const result = sortData([], "FLUC_RT");
    expect(result).toEqual([]);
  });

  it("does not mutate original array", () => {
    const original = [...data];
    sortData(data, "FLUC_RT");
    expect(data).toEqual(original);
  });
});

describe("limitData", () => {
  const data = [{ a: "1" }, { a: "2" }, { a: "3" }, { a: "4" }, { a: "5" }];

  it("returns first N items", () => {
    expect(limitData(data, 3)).toHaveLength(3);
  });

  it("returns all items if limit exceeds length", () => {
    expect(limitData(data, 10)).toHaveLength(5);
  });

  it("returns empty for limit 0", () => {
    expect(limitData(data, 0)).toEqual([]);
  });

  it("does not mutate original", () => {
    const original = [...data];
    limitData(data, 2);
    expect(data).toEqual(original);
  });
});

describe("applyPipeline", () => {
  const data = [
    { ISU_NM: "A", FLUC_RT: "3.0" },
    { ISU_NM: "B", FLUC_RT: "1.0" },
    { ISU_NM: "C", FLUC_RT: "5.0" },
    { ISU_NM: "D", FLUC_RT: "2.0" },
    { ISU_NM: "E", FLUC_RT: "4.0" },
  ];

  it("applies sort then limit", () => {
    const result = applyPipeline(data, {
      sort: "FLUC_RT",
      direction: "desc",
      limit: 3,
    });
    expect(result).toHaveLength(3);
    expect(result.map((r) => r["ISU_NM"])).toEqual(["C", "E", "A"]);
  });

  it("applies only sort when no limit", () => {
    const result = applyPipeline(data, { sort: "FLUC_RT", direction: "asc" });
    expect(result).toHaveLength(5);
    expect(result[0]?.["ISU_NM"]).toBe("B");
  });

  it("applies only limit when no sort", () => {
    const result = applyPipeline(data, { limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]?.["ISU_NM"]).toBe("A");
  });

  it("honors an explicit zero limit", () => {
    expect(applyPipeline(data, { limit: 0 })).toEqual([]);
  });

  it("returns original data when no options", () => {
    const result = applyPipeline(data, {});
    expect(result).toEqual(data);
  });
});
