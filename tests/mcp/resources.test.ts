import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/watchlist/store.js", () => ({
  getWatchlist: vi.fn(),
}));

vi.mock("../../src/client/rate-limit.js", () => ({
  getRateLimitStatus: vi.fn(),
}));

vi.mock("../../src/client/auth.js", () => ({
  getCachedServiceStatus: vi.fn(),
  getApiKey: vi.fn(() => "active-key"),
}));

import {
  createWatchlistResource,
  createRateLimitResource,
  createServiceStatusResource,
} from "../../src/mcp/resources/index.js";
import { getWatchlist } from "../../src/watchlist/store.js";
import { getRateLimitStatus } from "../../src/client/rate-limit.js";
import { getCachedServiceStatus } from "../../src/client/auth.js";

const mockGetWatchlist = vi.mocked(getWatchlist);
const mockGetRateLimitStatus = vi.mocked(getRateLimitStatus);
const mockGetCachedServiceStatus = vi.mocked(getCachedServiceStatus);

describe("MCP Resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createWatchlistResource", () => {
    it("returns resource definition with correct name and uri", () => {
      const resource = createWatchlistResource();
      expect(resource.name).toBe("watchlist");
      expect(resource.uri).toBe("krx://watchlist");
    });

    it("returns watchlist entries as JSON content", async () => {
      const entries = [
        {
          isuCd: "KR7005930003",
          isuSrtCd: "005930",
          name: "삼성전자",
          market: "KOSPI",
        },
        {
          isuCd: "KR7000660001",
          isuSrtCd: "000660",
          name: "SK하이닉스",
          market: "KOSPI",
        },
      ];
      mockGetWatchlist.mockReturnValue(entries);

      const resource = createWatchlistResource();
      const result = await resource.handler(new URL("krx://watchlist"));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe("krx://watchlist");

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("삼성전자");
      expect(parsed[1].name).toBe("SK하이닉스");
    });

    it("returns empty array when watchlist is empty", async () => {
      mockGetWatchlist.mockReturnValue([]);

      const resource = createWatchlistResource();
      const result = await resource.handler(new URL("krx://watchlist"));

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed).toEqual([]);
    });
  });

  describe("createRateLimitResource", () => {
    it("returns resource definition with correct name and uri", () => {
      const resource = createRateLimitResource();
      expect(resource.name).toBe("rate-limit");
      expect(resource.uri).toBe("krx://rate-limit");
    });

    it("returns rate limit status as JSON content", async () => {
      mockGetRateLimitStatus.mockReturnValue({
        date: "20260312",
        count: 150,
        limit: 10000,
        remaining: 9850,
      });

      const resource = createRateLimitResource();
      const result = await resource.handler(new URL("krx://rate-limit"));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe("krx://rate-limit");

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed.date).toBe("20260312");
      expect(parsed.count).toBe(150);
      expect(parsed.limit).toBe(10000);
      expect(parsed.remaining).toBe(9850);
    });

    it("returns zero count when no calls made", async () => {
      mockGetRateLimitStatus.mockReturnValue({
        date: "20260312",
        count: 0,
        limit: 10000,
        remaining: 10000,
      });

      const resource = createRateLimitResource();
      const result = await resource.handler(new URL("krx://rate-limit"));

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed.count).toBe(0);
      expect(parsed.remaining).toBe(10000);
    });
  });

  describe("createServiceStatusResource", () => {
    it("returns resource definition with correct name and uri", () => {
      const resource = createServiceStatusResource();
      expect(resource.name).toBe("service-status");
      expect(resource.uri).toBe("krx://service-status");
    });

    it("returns service status as JSON content", async () => {
      mockGetCachedServiceStatus.mockReturnValue({
        index: {
          state: "approved",
          approved: true,
          checkedAt: "2026-03-12T09:00:00.000Z",
          validUntil: "2026-03-12T09:15:00.000Z",
          fresh: true,
        },
        stock: {
          state: "approved",
          approved: true,
          checkedAt: "2026-03-12T09:00:00.000Z",
          validUntil: "2026-03-12T09:15:00.000Z",
          fresh: true,
        },
        esg: {
          state: "rejected",
          approved: false,
          checkedAt: "2026-03-12T09:00:00.000Z",
          validUntil: "2026-03-12T09:15:00.000Z",
          fresh: false,
          failureType: "approval",
          error: "Unauthorized API Call",
        },
      });

      const resource = createServiceStatusResource();
      const result = await resource.handler(new URL("krx://service-status"));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe("krx://service-status");

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed.index.approved).toBe(true);
      expect(parsed.stock.approved).toBe(true);
      expect(parsed.esg.approved).toBe(false);
      expect(parsed.esg.fresh).toBe(false);
      expect(parsed.esg.error).toBe("Unauthorized API Call");
    });

    it("returns empty object when no status cached", async () => {
      mockGetCachedServiceStatus.mockReturnValue({});

      const resource = createServiceStatusResource();
      const result = await resource.handler(new URL("krx://service-status"));

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed).toEqual({});
    });

    it("strips apiKey from service status if present", async () => {
      const statusWithKey = {
        apiKey: "secret-key-123",
        index: {
          approved: true,
          checkedAt: "2026-03-12T09:00:00.000Z",
        },
      } as unknown as Record<string, { approved: boolean; checkedAt: string }>;
      mockGetCachedServiceStatus.mockReturnValue(statusWithKey);

      const resource = createServiceStatusResource();
      const result = await resource.handler(new URL("krx://service-status"));

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed.apiKey).toBeUndefined();
      expect(parsed.index.approved).toBe(true);
    });
  });

  describe("error handling", () => {
    it("returns error content when getWatchlist throws", async () => {
      mockGetWatchlist.mockImplementation(() => {
        throw new Error("file read error");
      });

      const resource = createWatchlistResource();
      const result = await resource.handler(new URL("krx://watchlist"));

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed.error).toBe("Failed to read watchlist");
    });

    it("returns error content when getRateLimitStatus throws", async () => {
      mockGetRateLimitStatus.mockImplementation(() => {
        throw new Error("file read error");
      });

      const resource = createRateLimitResource();
      const result = await resource.handler(new URL("krx://rate-limit"));

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed.error).toBe("Failed to read rate limit status");
    });

    it("returns error content when getCachedServiceStatus throws", async () => {
      mockGetCachedServiceStatus.mockImplementation(() => {
        throw new Error("config corrupted");
      });

      const resource = createServiceStatusResource();
      const result = await resource.handler(new URL("krx://service-status"));

      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed.error).toBe("Failed to read service status");
    });
  });
});
