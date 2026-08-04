import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("node:fs");
vi.mock("node:os");

const mockedFs = vi.mocked(fs);
const mockedOs = vi.mocked(os);

const MOCK_HOME = path.join(path.parse(process.cwd()).root, "mock-home");
const WATCHLIST_PATH = path.join(MOCK_HOME, ".krx-cli", "watchlist.json");

describe("watchlist store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockedOs.homedir.mockReturnValue(MOCK_HOME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getWatchlist", () => {
    it("returns empty array when file does not exist", async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const { getWatchlist } = await import("../../src/watchlist/store.js");
      const result = getWatchlist();

      expect(result).toEqual([]);
    });

    it("reads and parses watchlist from file", async () => {
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

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(entries));

      const { getWatchlist } = await import("../../src/watchlist/store.js");
      const result = getWatchlist();

      expect(result).toEqual(entries);
      expect(mockedFs.readFileSync).toHaveBeenCalledWith(
        WATCHLIST_PATH,
        "utf-8",
      );
    });

    it("returns empty array and logs when file is corrupted", async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue("not valid json{{{");
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const { getWatchlist } = await import("../../src/watchlist/store.js");
      const result = getWatchlist();

      expect(result).toEqual([]);
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
    });
  });

  describe("saveWatchlist", () => {
    it("writes entries to file with directory creation and returns true", async () => {
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      const { saveWatchlist } = await import("../../src/watchlist/store.js");
      const entries = [
        {
          isuCd: "KR7005930003",
          isuSrtCd: "005930",
          name: "삼성전자",
          market: "KOSPI",
        },
      ];

      const result = saveWatchlist(entries);

      expect(result).toBe(true);
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.dirname(WATCHLIST_PATH),
        { recursive: true },
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        WATCHLIST_PATH,
        JSON.stringify(entries, null, 2),
        "utf-8",
      );
    });

    it("returns false and logs on write failure", async () => {
      mockedFs.mkdirSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const { saveWatchlist } = await import("../../src/watchlist/store.js");

      const result = saveWatchlist([]);

      expect(result).toBe(false);
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
    });
  });

  describe("addToWatchlist", () => {
    it("adds new entry to empty watchlist", async () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      const { addToWatchlist } = await import("../../src/watchlist/store.js");
      const entry = {
        isuCd: "KR7005930003",
        isuSrtCd: "005930",
        name: "삼성전자",
        market: "KOSPI",
      };

      const result = addToWatchlist(entry);

      expect(result.added).toBe(true);
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });

    it("prevents duplicate entries by isuCd", async () => {
      const existing = [
        {
          isuCd: "KR7005930003",
          isuSrtCd: "005930",
          name: "삼성전자",
          market: "KOSPI",
        },
      ];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

      const { addToWatchlist } = await import("../../src/watchlist/store.js");
      const entry = {
        isuCd: "KR7005930003",
        isuSrtCd: "005930",
        name: "삼성전자",
        market: "KOSPI",
      };

      const result = addToWatchlist(entry);

      expect(result.added).toBe(false);
      expect(result.reason).toBe("duplicate");
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it("appends new entry to existing watchlist immutably", async () => {
      const existing = [
        {
          isuCd: "KR7005930003",
          isuSrtCd: "005930",
          name: "삼성전자",
          market: "KOSPI",
        },
      ];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      const { addToWatchlist } = await import("../../src/watchlist/store.js");
      const newEntry = {
        isuCd: "KR7000660001",
        isuSrtCd: "000660",
        name: "SK하이닉스",
        market: "KOSPI",
      };

      const result = addToWatchlist(newEntry);

      expect(result.added).toBe(true);
      const writtenData = JSON.parse(
        (mockedFs.writeFileSync as ReturnType<typeof vi.fn>).mock
          .calls[0][1] as string,
      );
      expect(writtenData).toHaveLength(2);
      expect(writtenData[1].name).toBe("SK하이닉스");
    });

    it("returns write_error when save fails", async () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockImplementation(() => {
        throw new Error("Disk full");
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const { addToWatchlist } = await import("../../src/watchlist/store.js");

      const result = addToWatchlist({
        isuCd: "KR7005930003",
        isuSrtCd: "005930",
        name: "삼성전자",
        market: "KOSPI",
      });

      expect(result.added).toBe(false);
      expect(result.reason).toBe("write_error");
    });
  });

  describe("removeFromWatchlist", () => {
    it("removes entry by exact name", async () => {
      const existing = [
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
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      const { removeFromWatchlist } =
        await import("../../src/watchlist/store.js");

      const result = removeFromWatchlist("삼성전자");

      expect(result.removed).toBe(true);
      const writtenData = JSON.parse(
        (mockedFs.writeFileSync as ReturnType<typeof vi.fn>).mock
          .calls[0][1] as string,
      );
      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].name).toBe("SK하이닉스");
    });

    it("removes entry by isuCd", async () => {
      const existing = [
        {
          isuCd: "KR7005930003",
          isuSrtCd: "005930",
          name: "삼성전자",
          market: "KOSPI",
        },
      ];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      const { removeFromWatchlist } =
        await import("../../src/watchlist/store.js");

      const result = removeFromWatchlist("KR7005930003");

      expect(result.removed).toBe(true);
    });

    it("returns not found when entry does not exist", async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify([]));

      const { removeFromWatchlist } =
        await import("../../src/watchlist/store.js");

      const result = removeFromWatchlist("없는종목");

      expect(result.removed).toBe(false);
      expect(result.reason).toBe("not_found");
    });

    it("does not remove by partial name match", async () => {
      const existing = [
        {
          isuCd: "KR7005930003",
          isuSrtCd: "005930",
          name: "삼성전자",
          market: "KOSPI",
        },
        {
          isuCd: "KR7207940008",
          isuSrtCd: "207940",
          name: "삼성바이오로직스",
          market: "KOSPI",
        },
      ];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

      const { removeFromWatchlist } =
        await import("../../src/watchlist/store.js");

      const result = removeFromWatchlist("삼성");

      expect(result.removed).toBe(false);
      expect(result.reason).toBe("not_found");
    });

    it("returns write_error when save fails during removal", async () => {
      const existing = [
        {
          isuCd: "KR7005930003",
          isuSrtCd: "005930",
          name: "삼성전자",
          market: "KOSPI",
        },
      ];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));
      mockedFs.mkdirSync.mockImplementation(() => {
        throw new Error("Disk full");
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const { removeFromWatchlist } =
        await import("../../src/watchlist/store.js");

      const result = removeFromWatchlist("삼성전자");

      expect(result.removed).toBe(false);
      expect(result.reason).toBe("write_error");
    });
  });

  describe("edge cases", () => {
    it("handles file system errors gracefully on read", async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const { getWatchlist } = await import("../../src/watchlist/store.js");
      const result = getWatchlist();

      expect(result).toEqual([]);
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
    });
  });
});
