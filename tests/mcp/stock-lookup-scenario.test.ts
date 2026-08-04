import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../src/mcp/http-server.js";

/**
 * MCP 시나리오 테스트: 종목 검색 → 시세 조회 전체 흐름
 *
 * 실제 사용 패턴: "삼성전자 주가 알려줘"
 * 1. krx_search("삼성전자") → ISIN 코드 반환 (KR7005930003)
 * 2. krx_stock(isuCd: "KR7005930003") → 시세 1건 반환
 *
 * 검색 API는 ISIN 코드를, 시세 API는 단축코드를 ISU_CD로 사용하므로
 * 클라이언트 필터링이 ISU_CD와 ISU_SRT_CD 모두 매칭해야 함
 */

const HOST = "127.0.0.1";
const TOKEN = "test-mcp-token-with-at-least-32-characters";

type ServerHandle = Awaited<ReturnType<typeof startHttpServer>>;

vi.mock("../../src/client/client.js", () => ({
  krxFetch: vi.fn(),
}));

vi.mock("../../src/client/auth.js", () => ({
  getApiKey: vi.fn(() => "test-api-key"),
  checkCategoryApproval: vi.fn(),
  checkAllCategories: vi.fn(),
  getCachedServiceStatus: vi.fn(() => ({})),
  saveApiKey: vi.fn(),
}));

vi.mock("../../src/utils/date.js", () => ({
  getRecentTradingDate: vi.fn(() => "20260313"),
  getTradingDays: vi.fn(),
}));

import { krxFetch } from "../../src/client/client.js";

const mockedKrxFetch = vi.mocked(krxFetch);

// 검색 API (stk_isu_base_info) 응답: ISU_CD가 ISIN 코드
const SEARCH_RESPONSE = [
  {
    ISU_CD: "KR7005930003",
    ISU_SRT_CD: "005930",
    ISU_NM: "삼성전자",
    ISU_ABBRV: "삼성전자",
    MKT_NM: "KOSPI",
  },
  {
    ISU_CD: "KR7005935002",
    ISU_SRT_CD: "005935",
    ISU_NM: "삼성전자우",
    ISU_ABBRV: "삼성전자우",
    MKT_NM: "KOSPI",
  },
  {
    ISU_CD: "KR7000010001",
    ISU_SRT_CD: "000010",
    ISU_NM: "다른종목",
    ISU_ABBRV: "다른종목",
    MKT_NM: "KOSPI",
  },
];

// 시세 API (stk_bydd_trd) 응답: ISU_CD가 단축코드
const TRADING_RESPONSE = [
  {
    BAS_DD: "20260313",
    ISU_CD: "005930",
    ISU_SRT_CD: "005930",
    ISU_NM: "삼성전자",
    MKT_NM: "KOSPI",
    TDD_CLSPRC: "85000",
    FLUC_RT: "1.50",
    ACC_TRDVOL: "15000000",
  },
  {
    BAS_DD: "20260313",
    ISU_CD: "005935",
    ISU_SRT_CD: "005935",
    ISU_NM: "삼성전자우",
    MKT_NM: "KOSPI",
    TDD_CLSPRC: "72000",
    FLUC_RT: "0.80",
    ACC_TRDVOL: "3000000",
  },
  {
    BAS_DD: "20260313",
    ISU_CD: "000010",
    ISU_SRT_CD: "000010",
    ISU_NM: "다른종목",
    MKT_NM: "KOSPI",
    TDD_CLSPRC: "50000",
    FLUC_RT: "-0.50",
    ACC_TRDVOL: "1000000",
  },
];

async function createMcpClient(port: number): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${HOST}:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
  );
  await client.connect(transport);
  return client;
}

describe("시나리오: 종목 검색 → 시세 조회", () => {
  let handle: ServerHandle | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
      client = undefined;
    }
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  function setupMock() {
    mockedKrxFetch.mockImplementation(async (opts) => {
      if (opts.endpoint.includes("stk_isu_base_info")) {
        // KOSPI 기본정보
        return { success: true, data: SEARCH_RESPONSE };
      }
      if (opts.endpoint.includes("ksq_isu_base_info")) {
        // KOSDAQ 기본정보: 삼성전자 없음
        return { success: true, data: [] };
      }
      // 시세 API
      return { success: true, data: TRADING_RESPONSE };
    });
  }

  it("검색 → ISIN코드로 시세 조회 → 1건 반환", async () => {
    setupMock();
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    // Step 1: 검색
    const searchResult = await client.callTool({
      name: "krx_search",
      arguments: { query: "삼성전자" },
    });

    const searchText = (
      searchResult.content as { type: string; text: string }[]
    )[0]!.text;
    const searchParsed = JSON.parse(searchText) as {
      ISU_CD: string;
      ISU_NM: string;
    }[];

    // 삼성전자, 삼성전자우 모두 검색됨
    expect(searchParsed.length).toBe(2);
    const samsung = searchParsed.find((r) => r.ISU_NM === "삼성전자")!;
    expect(samsung.ISU_CD).toBe("KR7005930003"); // ISIN 코드

    // Step 2: ISIN 코드로 시세 조회
    const stockResult = await client.callTool({
      name: "krx_stock",
      arguments: {
        endpoint: "stk_bydd_trd",
        date: "20260313",
        isuCd: samsung.ISU_CD, // "KR7005930003" — ISIN 코드
      },
    });

    const stockText = (
      stockResult.content as { type: string; text: string }[]
    )[0]!.text;
    const stockParsed = JSON.parse(stockText) as Record<string, string>[];

    // 시세 API의 ISU_CD는 "005930"이지만, ISIN "KR7005930003"도 매칭되어야 함
    expect(Array.isArray(stockParsed)).toBe(true);
    expect(stockParsed.length).toBe(1);
    expect(stockParsed[0]!.ISU_NM).toBe("삼성전자");
    expect(stockParsed[0]!.TDD_CLSPRC).toBe("85000");
  });

  it("단축코드로 시세 조회 → 1건 반환", async () => {
    setupMock();
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    const result = await client.callTool({
      name: "krx_stock",
      arguments: {
        endpoint: "stk_bydd_trd",
        date: "20260313",
        isuCd: "005930", // 단축코드
      },
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text) as Record<string, string>[];

    expect(parsed.length).toBe(1);
    expect(parsed[0]!.ISU_NM).toBe("삼성전자");
  });

  it("존재하지 않는 코드로 조회 → 빈 배열", async () => {
    setupMock();
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    const result = await client.callTool({
      name: "krx_stock",
      arguments: {
        endpoint: "stk_bydd_trd",
        date: "20260313",
        isuCd: "INVALID_CODE",
      },
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text) as Record<string, string>[];

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(0);
  });
});
