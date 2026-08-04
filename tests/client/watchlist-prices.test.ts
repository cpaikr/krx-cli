import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/client.js")>()),
  krxFetch: vi.fn(),
}));

import { krxFetch } from "../../src/client/client.js";
import { fetchWatchlistPrices } from "../../src/client/watchlist-prices.js";

const mockedKrxFetch = vi.mocked(krxFetch);
const options = {
  apiKey: "test-key",
  date: "20260310",
  securityCodes: new Set(["005930"]),
};

describe("fetchWatchlistPrices", () => {
  beforeEach(() => mockedKrxFetch.mockReset());

  it("returns complete observed watchlist data", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [{ ISU_CD: "005930", ISU_NM: "삼성전자" }],
      })
      .mockResolvedValueOnce({ success: true, data: [] });

    const result = await fetchWatchlistPrices(options);

    expect(result.success).toBe(true);
    expect(result.data.stocks).toHaveLength(1);
    expect(result.completeness.state).toBe("complete");
  });

  it("surfaces a single-market failure as partial", async () => {
    mockedKrxFetch
      .mockResolvedValueOnce({
        success: true,
        data: [{ ISU_CD: "005930", ISU_NM: "삼성전자" }],
      })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "KOSDAQ unavailable",
        errorType: "upstream",
      });

    const result = await fetchWatchlistPrices(options);

    expect(result.success).toBe(true);
    expect(result.completeness).toMatchObject({
      state: "partial",
      succeeded: ["KOSPI"],
      failed: [{ id: "KOSDAQ", errorType: "upstream" }],
    });
  });

  it("distinguishes a genuine empty result", async () => {
    mockedKrxFetch.mockResolvedValue({ success: true, data: [] });

    const result = await fetchWatchlistPrices(options);

    expect(result).toMatchObject({
      success: true,
      data: { stocks: [] },
      completeness: { state: "empty" },
    });
  });

  it("returns failed when every market fails", async () => {
    mockedKrxFetch.mockResolvedValue({
      success: false,
      data: [],
      error: "deadline exceeded",
      errorType: "timeout",
    });

    const result = await fetchWatchlistPrices(options);

    expect(result).toMatchObject({
      success: false,
      errorType: "timeout",
      completeness: { state: "failed", succeeded: [] },
    });
  });
});
