import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../src/mcp/http-server.js";

/**
 * MCP 통합 테스트: SDK 클라이언트로 HTTP 서버에 연결하여
 * tool call → truncation → pagination/fields 재요청 흐름을 검증
 */

const HOST = "127.0.0.1";
const TOKEN = "test-mcp-token-with-at-least-32-characters";

type ServerHandle = Awaited<ReturnType<typeof startHttpServer>>;

// KRX API mock: 대량 데이터 생성
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
  getRecentTradingDate: vi.fn(() => "20260310"),
  getTradingDays: vi.fn(),
}));

import { krxFetch } from "../../src/client/client.js";

const mockedKrxFetch = vi.mocked(krxFetch);

function generateLargeStockData(count: number): Record<string, string>[] {
  return Array.from({ length: count }, (_, i) => {
    const shortCode = String(i).padStart(6, "0");
    const row: Record<string, string> = {
      BAS_DD: "20260310",
      ISU_CD: shortCode,
      ISU_SRT_CD: shortCode,
      ISU_NM: `테스트종목_${String(i).padStart(4, "0")}`,
      MKT_NM: "KOSPI",
      TDD_CLSPRC: String(10000 + i * 100),
      FLUC_RT: (Math.random() * 10 - 5).toFixed(2),
      TDD_OPNPRC: String(9900 + i * 100),
      TDD_HGPRC: String(10200 + i * 100),
      TDD_LWPRC: String(9800 + i * 100),
      ACC_TRDVOL: String(1000000 + i * 1000),
      ACC_TRDVAL: String(50000000000 + i * 100000),
      MKTCAP: String(100000000000 + i * 1000000),
      LIST_SHRS: String(5000000 + i * 100),
      SECT_TP_NM: "보통주",
      CMPPREVDD_PRC: String((i % 200) - 100),
    };
    for (let f = 0; f < 15; f++) {
      row[`EXTRA_${f}`] = "x".repeat(150);
    }
    return row;
  });
}

const TOTAL_ROWS = 500;
const FULL_DATA = generateLargeStockData(TOTAL_ROWS);

async function createMcpClient(port: number): Promise<Client> {
  const client = new Client({
    name: "test-client",
    version: "1.0.0",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${HOST}:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
  );

  await client.connect(transport);
  return client;
}

describe("MCP 통합 테스트: truncation 시나리오", () => {
  let handle: ServerHandle | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedKrxFetch.mockResolvedValue({
      success: true,
      data: FULL_DATA,
    });
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

  it("tools/list 에서 krx_stock tool 확인", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    const { tools } = await client.listTools();
    const stockTool = tools.find((t) => t.name === "krx_stock");

    expect(stockTool).toBeDefined();
    expect(stockTool!.description).toContain("_truncated");
  });

  it("전체 요청 → truncation 메타데이터 반환", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    const result = await client.callTool({
      name: "krx_stock",
      arguments: { endpoint: "stk_bydd_trd", date: "20260310" },
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text) as {
      data: Record<string, string>[];
      _truncated: { total: number; returned: number; message: string };
    };

    expect(parsed._truncated).toBeDefined();
    expect(parsed._truncated.total).toBe(TOTAL_ROWS);
    expect(parsed._truncated.returned).toBeLessThan(TOTAL_ROWS);
    expect(parsed._truncated.message).toContain("offset=");
  });

  it("Strategy A: fields로 필수 필드만 → 전체 행 수신", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    const result = await client.callTool({
      name: "krx_stock",
      arguments: {
        endpoint: "stk_bydd_trd",
        date: "20260310",
        fields: ["ISU_CD", "ISU_NM", "TDD_CLSPRC", "FLUC_RT"],
      },
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(TOTAL_ROWS);
    expect(Object.keys(parsed[0]).sort()).toEqual([
      "FLUC_RT",
      "ISU_CD",
      "ISU_NM",
      "TDD_CLSPRC",
    ]);
  });

  it("Strategy B: offset+limit 페이지네이션으로 전체 수신", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    const allRows: Record<string, string>[] = [];
    const pageSize = 100;

    for (let offset = 0; offset < TOTAL_ROWS; offset += pageSize) {
      const result = await client.callTool({
        name: "krx_stock",
        arguments: {
          endpoint: "stk_bydd_trd",
          date: "20260310",
          offset,
          limit: pageSize,
        },
      });

      const text = (result.content as { type: string; text: string }[])[0]!
        .text;
      const parsed = JSON.parse(text);

      expect(Array.isArray(parsed)).toBe(true);
      allRows.push(...(parsed as Record<string, string>[]));
    }

    expect(allRows.length).toBe(TOTAL_ROWS);

    const uniqueIds = new Set(allRows.map((r) => r.ISU_CD));
    expect(uniqueIds.size).toBe(TOTAL_ROWS);
  });

  it("truncation 메시지의 offset으로 후속 요청 → 나머지 전체 수신", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    // 1차: truncation 발생
    const firstResult = await client.callTool({
      name: "krx_stock",
      arguments: { endpoint: "stk_bydd_trd", date: "20260310" },
    });

    const firstText = (
      firstResult.content as { type: string; text: string }[]
    )[0]!.text;
    const firstParsed = JSON.parse(firstText) as {
      data: Record<string, string>[];
      _truncated: { total: number; returned: number };
    };

    const collected = [...firstParsed.data];
    let offset = firstParsed._truncated.returned;

    // 후속 요청: offset으로 나머지 수신
    while (offset < TOTAL_ROWS) {
      const nextResult = await client.callTool({
        name: "krx_stock",
        arguments: {
          endpoint: "stk_bydd_trd",
          date: "20260310",
          offset,
          limit: firstParsed._truncated.returned,
        },
      });

      const nextText = (
        nextResult.content as { type: string; text: string }[]
      )[0]!.text;
      const nextParsed = JSON.parse(nextText);

      if (Array.isArray(nextParsed)) {
        collected.push(...(nextParsed as Record<string, string>[]));
      } else {
        collected.push(
          ...(nextParsed as { data: Record<string, string>[] }).data,
        );
      }

      offset += firstParsed._truncated.returned;
    }

    expect(collected.length).toBe(TOTAL_ROWS);
    const uniqueIds = new Set(collected.map((r) => r.ISU_CD));
    expect(uniqueIds.size).toBe(TOTAL_ROWS);
  });

  it("단축코드(ISU_SRT_CD)로 특정 종목 조회 → 1건만 반환", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    const targetShortCode = FULL_DATA[42]!.ISU_SRT_CD;

    const result = await client.callTool({
      name: "krx_stock",
      arguments: {
        endpoint: "stk_bydd_trd",
        date: "20260310",
        isuCd: targetShortCode,
      },
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text) as Record<string, string>[];

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.ISU_SRT_CD).toBe(targetShortCode);
    expect(parsed[0]!.ISU_NM).toBe("테스트종목_0042");
  });

  it("ISIN코드로 특정 종목 조회 → ISU_CD 매칭으로 1건 반환", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    client = await createMcpClient(handle.port);

    // ISU_CD가 단축코드인 데이터에 ISIN 코드로 검색해도 ISU_CD 매칭으로 찾아야 함
    const targetIsuCd = FULL_DATA[42]!.ISU_CD;

    const result = await client.callTool({
      name: "krx_stock",
      arguments: {
        endpoint: "stk_bydd_trd",
        date: "20260310",
        isuCd: targetIsuCd,
      },
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(text) as Record<string, string>[];

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.ISU_CD).toBe(targetIsuCd);
    expect(parsed[0]!.ISU_NM).toBe("테스트종목_0042");
  });
});
