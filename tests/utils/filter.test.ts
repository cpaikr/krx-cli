import { describe, it, expect } from "vitest";
import { parseFilterExpression, filterData } from "../../src/utils/filter.js";

describe("parseFilterExpression", () => {
  it("parses greater than expression", () => {
    const result = parseFilterExpression("FLUC_RT > 5");
    expect(result).toEqual({ field: "FLUC_RT", operator: ">", value: "5" });
  });

  it("parses less than expression", () => {
    const result = parseFilterExpression("FLUC_RT < -3");
    expect(result).toEqual({ field: "FLUC_RT", operator: "<", value: "-3" });
  });

  it("parses greater than or equal expression", () => {
    const result = parseFilterExpression("ACC_TRDVOL >= 1000000");
    expect(result).toEqual({
      field: "ACC_TRDVOL",
      operator: ">=",
      value: "1000000",
    });
  });

  it("parses less than or equal expression", () => {
    const result = parseFilterExpression("FLUC_RT <= 0");
    expect(result).toEqual({ field: "FLUC_RT", operator: "<=", value: "0" });
  });

  it("parses equality expression", () => {
    const result = parseFilterExpression("MKT_NM == KOSPI");
    expect(result).toEqual({ field: "MKT_NM", operator: "==", value: "KOSPI" });
  });

  it("parses inequality expression", () => {
    const result = parseFilterExpression("SECT_TP_NM != 외국기업");
    expect(result).toEqual({
      field: "SECT_TP_NM",
      operator: "!=",
      value: "외국기업",
    });
  });

  it("handles extra whitespace", () => {
    const result = parseFilterExpression("  FLUC_RT   >   5  ");
    expect(result).toEqual({ field: "FLUC_RT", operator: ">", value: "5" });
  });

  it("returns null for invalid expression", () => {
    expect(parseFilterExpression("")).toBeNull();
    expect(parseFilterExpression("FLUC_RT")).toBeNull();
    expect(parseFilterExpression("FLUC_RT ~~ 5")).toBeNull();
  });
});

describe("filterData", () => {
  const sampleData: readonly Record<string, string>[] = [
    {
      ISU_NM: "삼성전자",
      FLUC_RT: "2.50",
      ACC_TRDVOL: "10,000,000",
      MKT_NM: "KOSPI",
    },
    {
      ISU_NM: "SK하이닉스",
      FLUC_RT: "-1.20",
      ACC_TRDVOL: "5,000,000",
      MKT_NM: "KOSPI",
    },
    {
      ISU_NM: "에코프로비엠",
      FLUC_RT: "5.00",
      ACC_TRDVOL: "2,000,000",
      MKT_NM: "KOSDAQ",
    },
    {
      ISU_NM: "셀트리온",
      FLUC_RT: "-3.00",
      ACC_TRDVOL: "3,000,000",
      MKT_NM: "KOSPI",
    },
    {
      ISU_NM: "카카오",
      FLUC_RT: "0.00",
      ACC_TRDVOL: "1,500,000",
      MKT_NM: "KOSPI",
    },
  ];

  it("filters numeric greater than", () => {
    const result = filterData(sampleData, "FLUC_RT > 0");
    expect(result).toHaveLength(2);
    expect(result.map((r) => r["ISU_NM"])).toEqual([
      "삼성전자",
      "에코프로비엠",
    ]);
  });

  it("filters numeric less than", () => {
    const result = filterData(sampleData, "FLUC_RT < 0");
    expect(result).toHaveLength(2);
    expect(result.map((r) => r["ISU_NM"])).toEqual(["SK하이닉스", "셀트리온"]);
  });

  it("filters numeric greater than or equal", () => {
    const result = filterData(sampleData, "FLUC_RT >= 0");
    expect(result).toHaveLength(3);
  });

  it("filters numeric less than or equal", () => {
    const result = filterData(sampleData, "FLUC_RT <= 0");
    expect(result).toHaveLength(3);
  });

  it("filters string equality", () => {
    const result = filterData(sampleData, "MKT_NM == KOSDAQ");
    expect(result).toHaveLength(1);
    expect(result[0]["ISU_NM"]).toBe("에코프로비엠");
  });

  it("filters string inequality", () => {
    const result = filterData(sampleData, "MKT_NM != KOSPI");
    expect(result).toHaveLength(1);
    expect(result[0]["ISU_NM"]).toBe("에코프로비엠");
  });

  it("handles comma-separated numbers correctly", () => {
    const result = filterData(sampleData, "ACC_TRDVOL > 3000000");
    expect(result).toHaveLength(2);
    expect(result.map((r) => r["ISU_NM"])).toEqual(["삼성전자", "SK하이닉스"]);
  });

  it("handles negative value comparison", () => {
    const result = filterData(sampleData, "FLUC_RT > -2");
    expect(result).toHaveLength(4);
  });

  it("returns empty array for missing field", () => {
    const result = filterData(sampleData, "NONEXISTENT > 0");
    expect(result).toHaveLength(0);
  });

  it("rejects an invalid expression instead of returning unfiltered data", () => {
    expect(() => filterData(sampleData, "invalid expression")).toThrow(
      "Invalid filter expression",
    );
  });

  it("returns empty array for empty data", () => {
    const result = filterData([], "FLUC_RT > 0");
    expect(result).toHaveLength(0);
  });

  it("filters exact numeric equality", () => {
    const result = filterData(sampleData, "FLUC_RT == 5.00");
    expect(result).toHaveLength(1);
    expect(result[0]["ISU_NM"]).toBe("에코프로비엠");
  });
});
