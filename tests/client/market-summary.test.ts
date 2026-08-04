import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchMarketSummary } from "../../src/client/market-summary.js";

vi.mock("../../src/client/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/client.js")>()),
  krxFetch: vi.fn(),
}));

import { krxFetch } from "../../src/client/client.js";

const mockedKrxFetch = vi.mocked(krxFetch);

function makeIndexData(name: string, close: string, change: string) {
  return {
    IDX_NM: name,
    TDD_CLSPRC: close,
    FLUC_RT: change,
    ACC_TRDVOL: "1000000",
    ACC_TRDVAL: "5000000000",
  };
}

function makeStockData(
  name: string,
  close: string,
  change: string,
  vol: string,
  val: string,
) {
  return {
    ISU_NM: name,
    TDD_CLSPRC: close,
    FLUC_RT: change,
    ACC_TRDVOL: vol,
    ACC_TRDVAL: val,
  };
}

describe("fetchMarketSummary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("aggregates index and stock data from 4 endpoints", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [
          makeIndexData("코스피", "2,700.50", "1.20"),
          makeIndexData("코스피 200", "360.00", "0.80"),
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          makeIndexData("코스닥", "870.30", "-0.50"),
          makeIndexData("코스닥 150", "1,100.00", "-0.30"),
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          makeStockData(
            "삼성전자",
            "75,000",
            "2.50",
            "10000000",
            "750000000000",
          ),
          makeStockData(
            "SK하이닉스",
            "180,000",
            "-1.20",
            "5000000",
            "900000000000",
          ),
          makeStockData(
            "LG에너지솔루션",
            "400,000",
            "0.00",
            "1000000",
            "400000000000",
          ),
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          makeStockData(
            "에코프로비엠",
            "250,000",
            "5.00",
            "2000000",
            "500000000000",
          ),
          makeStockData(
            "셀트리온",
            "170,000",
            "-3.00",
            "3000000",
            "510000000000",
          ),
        ],
      });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.kospiIndex).toBeDefined();
    expect(result.data!.kosdaqIndex).toBeDefined();
    expect(result.data!.stockStats).toBeDefined();
  });

  it("counts advancing, declining, and unchanged stocks", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({
        success: true,
        data: [
          makeStockData("A", "100", "2.00", "100", "100"),
          makeStockData("B", "200", "-1.00", "200", "200"),
          makeStockData("C", "300", "0.00", "300", "300"),
          makeStockData("D", "400", "3.50", "400", "400"),
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [makeStockData("E", "500", "-2.00", "500", "500")],
      });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result.data!.stockStats.advancing).toBe(2);
    expect(result.data!.stockStats.declining).toBe(2);
    expect(result.data!.stockStats.unchanged).toBe(1);
  });

  it("computes top gainers and losers sorted by FLUC_RT", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({
        success: true,
        data: [
          makeStockData("A", "100", "5.00", "100", "100"),
          makeStockData("B", "200", "3.00", "200", "200"),
          makeStockData("C", "300", "-4.00", "300", "300"),
          makeStockData("D", "400", "10.00", "400", "400"),
          makeStockData("E", "500", "-7.00", "500", "500"),
          makeStockData("F", "600", "1.00", "600", "600"),
        ],
      })
      .mockResolvedValueOnce({ success: true, data: [] });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    const topGainers = result.data!.topGainers;
    expect(topGainers).toHaveLength(5);
    expect(topGainers[0].ISU_NM).toBe("D");
    expect(topGainers[1].ISU_NM).toBe("A");

    const topLosers = result.data!.topLosers;
    expect(topLosers).toHaveLength(5);
    expect(topLosers[0].ISU_NM).toBe("E");
    expect(topLosers[1].ISU_NM).toBe("C");
  });

  it("calculates total volume and value across all stocks", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({
        success: true,
        data: [
          makeStockData("A", "100", "1.00", "1,000", "10,000"),
          makeStockData("B", "200", "2.00", "2,000", "20,000"),
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [makeStockData("C", "300", "3.00", "3,000", "30,000")],
      });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result.data!.stockStats.totalVolume).toBe(6000);
    expect(result.data!.stockStats.totalValue).toBe(60000);
  });

  it("returns error when all fetches fail", async () => {
    mockedKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      error: "HTTP 500",
    });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("preserves typed errors when every component fails", async () => {
    mockedKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      error: "KRX request was cancelled",
      errorType: "cancelled",
    });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result).toMatchObject({
      success: false,
      error: "KRX request was cancelled",
      errorType: "cancelled",
    });
  });

  it("returns partial data when some fetches fail", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [makeIndexData("코스피", "2,700", "1.00")],
      })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "failed",
      })
      .mockResolvedValueOnce({
        success: true,
        data: [makeStockData("삼성전자", "75,000", "2.50", "10000", "750000")],
      })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "failed",
      });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result.success).toBe(true);
    expect(result.data!.kospiIndex).toHaveLength(1);
    expect(result.data!.kosdaqIndex).toBeNull();
    expect(result.data!.stockStats).toBeNull();
    expect(result.data!.topGainers).toBeNull();
    expect(result.completeness).toMatchObject({
      state: "partial",
      succeeded: ["kospiIndex", "kospiStocks"],
      failed: [{ id: "kosdaqIndex" }, { id: "kosdaqStocks" }],
    });
  });

  it("does not hide cancellation behind completed components", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [makeIndexData("코스피", "2,700", "1.00")],
      })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "KRX request was cancelled",
        errorType: "cancelled",
      })
      .mockResolvedValue({ success: true, data: [] });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result).toMatchObject({ success: false, errorType: "cancelled" });
    expect(result.completeness.state).toBe("failed");
    expect(result.data.kosdaqIndex).toBeNull();
  });

  it("handles network errors gracefully", async () => {
    mockedKrxFetch.mockRejectedValue(new Error("Network timeout"));

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("distinguishes an observed empty market from unavailable inputs", async () => {
    mockedKrxFetch.mockResolvedValue({ success: true, data: [] });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result.success).toBe(true);
    expect(result.completeness).toMatchObject({
      state: "empty",
      succeeded: ["kospiIndex", "kosdaqIndex", "kospiStocks", "kosdaqStocks"],
      failed: [],
    });
    expect(result.data.stockStats).toEqual({
      advancing: 0,
      declining: 0,
      unchanged: 0,
      totalVolume: 0,
      totalValue: 0,
    });
  });

  it("returns top 5 gainers/losers even when fewer stocks exist", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({
        success: true,
        data: [
          makeStockData("A", "100", "5.00", "100", "100"),
          makeStockData("B", "200", "-3.00", "200", "200"),
        ],
      })
      .mockResolvedValueOnce({ success: true, data: [] });

    const result = await fetchMarketSummary({
      apiKey: "test-key",
      date: "20260310",
    });

    expect(result.data!.topGainers).toHaveLength(2);
    expect(result.data!.topLosers).toHaveLength(2);
  });
});
