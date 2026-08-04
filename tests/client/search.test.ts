import { describe, it, expect, vi, beforeEach } from "vitest";
import { KrxRequestError } from "../../src/client/client.js";
import { searchStock } from "../../src/client/search.js";

vi.mock("../../src/client/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/client.js")>()),
  krxFetch: vi.fn(),
}));

vi.mock("../../src/utils/date.js", () => ({
  getRecentTradingDate: () => "20260310",
}));

import { krxFetch } from "../../src/client/client.js";

const mockKrxFetch = vi.mocked(krxFetch);

const MOCK_KOSPI_DATA = [
  {
    ISU_CD: "KR7005930003",
    ISU_SRT_CD: "005930",
    ISU_NM: "삼성전자",
    ISU_ABBRV: "삼성전자",
  },
  {
    ISU_CD: "KR7000660001",
    ISU_SRT_CD: "000660",
    ISU_NM: "SK하이닉스",
    ISU_ABBRV: "SK하이닉스",
  },
  {
    ISU_CD: "KR7005380001",
    ISU_SRT_CD: "005380",
    ISU_NM: "현대자동차",
    ISU_ABBRV: "현대차",
  },
];

const MOCK_KOSDAQ_DATA = [
  {
    ISU_CD: "KR7035720002",
    ISU_SRT_CD: "035720",
    ISU_NM: "카카오",
    ISU_ABBRV: "카카오",
  },
  {
    ISU_CD: "KR7263750004",
    ISU_SRT_CD: "263750",
    ISU_NM: "펄어비스",
    ISU_ABBRV: "펄어비스",
  },
];

function setupMock() {
  mockKrxFetch.mockImplementation(async (options) => {
    if (options.endpoint.includes("stk_isu_base_info")) {
      return { success: true, data: MOCK_KOSPI_DATA };
    }
    if (options.endpoint.includes("ksq_isu_base_info")) {
      return { success: true, data: MOCK_KOSDAQ_DATA };
    }
    return { success: true, data: [] };
  });
}

describe("searchStock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds exact match by name", async () => {
    setupMock();
    const results = await searchStock("test-key", "삼성전자");

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      ISU_CD: "KR7005930003",
      ISU_SRT_CD: "005930",
      ISU_NM: "삼성전자",
      MKT_NM: "KOSPI",
    });
  });

  it("finds partial match", async () => {
    setupMock();
    const results = await searchStock("test-key", "삼성");

    expect(results).toHaveLength(1);
    expect(results[0]?.ISU_NM).toBe("삼성전자");
  });

  it("finds stock in KOSDAQ", async () => {
    setupMock();
    const results = await searchStock("test-key", "카카오");

    expect(results).toHaveLength(1);
    expect(results[0]?.MKT_NM).toBe("KOSDAQ");
  });

  it("returns empty array when no match", async () => {
    setupMock();
    const results = await searchStock("test-key", "존재하지않는종목");

    expect(results).toEqual([]);
  });

  it("searches across both markets", async () => {
    setupMock();
    expect(mockKrxFetch).not.toHaveBeenCalled();

    await searchStock("test-key", "삼성");

    expect(mockKrxFetch).toHaveBeenCalledTimes(2);
  });

  it("is case-insensitive for abbreviation matching", async () => {
    setupMock();
    const results = await searchStock("test-key", "현대차");

    expect(results).toHaveLength(1);
    expect(results[0]?.ISU_NM).toBe("현대자동차");
  });

  it("throws a typed request error when every market fails", async () => {
    mockKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      error: "KRX request deadline exceeded",
      errorType: "timeout",
    });

    const pending = searchStock("test-key", "삼성");
    await expect(pending).rejects.toBeInstanceOf(KrxRequestError);
    await expect(pending).rejects.toMatchObject({
      response: { errorType: "timeout" },
    });
  });

  it("uses results from the market that succeeds", async () => {
    mockKrxFetch
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "KOSPI unavailable",
        errorType: "upstream",
      })
      .mockResolvedValueOnce({ success: true, data: MOCK_KOSDAQ_DATA });

    const results = await searchStock("test-key", "카카오");
    expect(results).toHaveLength(1);
    expect(results[0]?.MKT_NM).toBe("KOSDAQ");
  });

  it("does not hide cancellation behind results from another market", async () => {
    mockKrxFetch
      .mockResolvedValueOnce({ success: true, data: MOCK_KOSPI_DATA })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "KRX request was cancelled",
        errorType: "cancelled",
      });

    await expect(searchStock("test-key", "삼성")).rejects.toMatchObject({
      response: { errorType: "cancelled" },
    });
  });

  it("returns multiple matches", async () => {
    mockKrxFetch.mockImplementation(async (options) => {
      if (options.endpoint.includes("stk_isu_base_info")) {
        return {
          success: true,
          data: [
            {
              ISU_CD: "KR7005930003",
              ISU_SRT_CD: "005930",
              ISU_NM: "삼성전자",
              ISU_ABBRV: "삼성전자",
            },
            {
              ISU_CD: "KR7006400006",
              ISU_SRT_CD: "006400",
              ISU_NM: "삼성SDI",
              ISU_ABBRV: "삼성SDI",
            },
          ],
        };
      }
      return { success: true, data: [] };
    });

    const results = await searchStock("test-key", "삼성");
    expect(results).toHaveLength(2);
  });
});
