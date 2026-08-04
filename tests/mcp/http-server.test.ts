import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../src/mcp/http-server.js";

vi.mock("../../src/watchlist/store.js", () => ({
  getWatchlist: vi.fn(() => []),
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(() => ({ removed: true })),
}));

const HOST = "127.0.0.1";
const TOKEN = "test-mcp-token-with-at-least-32-characters";

type ServerHandle = Awaited<ReturnType<typeof startHttpServer>>;

function baseUrl(handle: ServerHandle): string {
  return `http://${HOST}:${handle.port}`;
}

function bearer(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "initialize",
    id: 1,
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };
}

async function initialize(handle: ServerHandle): Promise<Response> {
  return fetch(`${baseUrl(handle)}/mcp`, {
    method: "POST",
    headers: {
      ...bearer(),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(initializeBody()),
  });
}

describe("MCP HTTP Server", () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it("requires a strong authentication token before startup", async () => {
    await expect(
      startHttpServer({ port: 0, host: HOST, authToken: "short" }),
    ).rejects.toThrow("at least 32 characters");
  });

  it("requires allowed hosts for non-loopback startup", async () => {
    await expect(
      startHttpServer({ port: 0, host: "0.0.0.0", authToken: TOKEN }),
    ).rejects.toThrow("KRX_MCP_ALLOWED_HOSTS");
  });

  it("starts authenticated non-loopback servers with allowed hosts", async () => {
    handle = await startHttpServer({
      port: 0,
      host: "0.0.0.0",
      authToken: TOKEN,
      allowedHosts: ["127.0.0.1"],
    });
    expect(handle.port).toBeGreaterThan(0);
  });

  it("keeps health public and free of server secrets", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });

    const res = await fetch(`${baseUrl(handle)}/health`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toMatchObject({
      status: "ok",
      transport: "streamable-http",
    });
  });

  it("rejects missing and invalid credentials before initialization", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });

    for (const authorization of [undefined, "Bearer invalid-token"]) {
      const res = await fetch(`${baseUrl(handle)}/mcp`, {
        method: "POST",
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(initializeBody()),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(await res.text()).not.toContain(TOKEN);
    }
  });

  it("authenticates GET, POST, and DELETE consistently", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });

    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await fetch(`${baseUrl(handle)}/mcp`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "POST"
          ? { body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }) }
          : {}),
      });
      expect(res.status).toBe(401);
    }
  });

  it("allows an authorized client to list tools and mutate the watchlist", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl(handle)}/mcp`),
      { requestInit: { headers: bearer() } },
    );

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.some((tool) => tool.name === "krx_watchlist")).toBe(true);

      const result = await client.callTool({
        name: "krx_watchlist",
        arguments: { action: "remove", name: "005930" },
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it("enforces a per-client request limit", async () => {
    handle = await startHttpServer({
      port: 0,
      host: HOST,
      authToken: TOKEN,
      maxRequestsPerMinute: 1,
    });

    expect((await initialize(handle)).status).toBe(200);
    const limited = await initialize(handle);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("enforces a per-client session limit", async () => {
    handle = await startHttpServer({
      port: 0,
      host: HOST,
      authToken: TOKEN,
      maxSessionsPerClient: 1,
    });

    expect((await initialize(handle)).status).toBe(200);
    const limited = await initialize(handle);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: "Client session limit exceeded",
    });
  });

  it("returns 400 for authorized non-initialize requests without sessions", async () => {
    handle = await startHttpServer({ port: 0, host: HOST, authToken: TOKEN });

    const res = await fetch(`${baseUrl(handle)}/mcp`, {
      method: "POST",
      headers: { ...bearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(400);
  });
});
