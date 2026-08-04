import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/auth.js", () => ({ getApiKey: () => "test-key" }));
vi.mock("../../src/client/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/client.js")>()),
  krxFetch: vi.fn(),
}));
vi.mock("../../src/watchlist/store.js", () => ({
  getWatchlist: () => [
    {
      isuCd: "KR7005930003",
      isuSrtCd: "005930",
      name: "삼성전자",
      market: "KOSPI",
    },
  ],
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
}));

import { krxFetch } from "../../src/client/client.js";
import { createWatchlistTool } from "../../src/mcp/tools/watchlist-tool.js";

describe("MCP composite cancellation", () => {
  it("returns cancellation even when one watchlist market completed", async () => {
    vi.mocked(krxFetch)
      .mockResolvedValueOnce({
        success: true,
        data: [{ ISU_CD: "005930", ISU_NM: "삼성전자" }],
      })
      .mockResolvedValueOnce({
        success: false,
        data: [],
        error: "KRX request was cancelled",
        errorType: "cancelled",
      });

    const result = await createWatchlistTool().handler({
      action: "show",
      date: "20260310",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      errorType: "cancelled",
    });
  });
});
