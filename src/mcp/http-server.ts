import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "./server.js";
import { getVersion } from "../cli/commands/version.js";

const MAX_SESSIONS = 100;
const MAX_SESSIONS_PER_CLIENT = 10;
const MAX_REQUESTS_PER_MINUTE = 120;
const MAX_TRACKED_CLIENTS = 1024;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_TOKEN_LENGTH = 32;

interface HttpServerOptions {
  readonly port: number;
  readonly host: string;
  readonly authToken: string;
  readonly allowedHosts?: readonly string[];
  readonly maxSessions?: number;
  readonly maxSessionsPerClient?: number;
  readonly maxRequestsPerMinute?: number;
}

interface HttpServerHandle {
  readonly port: number;
  readonly close: () => Promise<void>;
}

export function startHttpServer(
  options: HttpServerOptions,
): Promise<HttpServerHandle> {
  const { port, host } = options;
  const authToken = options.authToken.trim();
  if (authToken.length < MIN_TOKEN_LENGTH) {
    return Promise.reject(
      new Error(
        `KRX_MCP_TOKEN must contain at least ${MIN_TOKEN_LENGTH} characters`,
      ),
    );
  }
  if (!isLoopbackHost(host) && !options.allowedHosts?.length) {
    return Promise.reject(
      new Error(
        "Non-loopback MCP servers require KRX_MCP_ALLOWED_HOSTS for DNS rebinding protection",
      ),
    );
  }

  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const maxSessionsPerClient =
    options.maxSessionsPerClient ?? MAX_SESSIONS_PER_CLIENT;
  const maxRequestsPerMinute =
    options.maxRequestsPerMinute ?? MAX_REQUESTS_PER_MINUTE;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionOwners = new Map<string, string>();
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const initializingClients = new Set<string>();
  const clientLimits = new Map<
    string,
    { windowStartedAt: number; count: number }
  >();

  function touchSession(sessionId: string): void {
    const existing = sessionTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    sessionTimers.set(
      sessionId,
      setTimeout(() => {
        const transport = transports.get(sessionId);
        if (transport) {
          transport.close().catch(() => {});
          transports.delete(sessionId);
          sessionOwners.delete(sessionId);
        }
        sessionTimers.delete(sessionId);
      }, SESSION_TTL_MS),
    );
  }

  function removeSession(sessionId: string): void {
    transports.delete(sessionId);
    sessionOwners.delete(sessionId);
    const timer = sessionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      sessionTimers.delete(sessionId);
    }
  }

  const app = createMcpExpressApp({
    host,
    ...(options.allowedHosts
      ? { allowedHosts: [...options.allowedHosts] }
      : {}),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get("/health", (_req: any, res: any) => {
    res.json({
      status: "ok",
      version: getVersion(),
      transport: "streamable-http",
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.all("/mcp", async (req: any, res: any) => {
    const clientId = authenticate(req, res, authToken);
    if (!clientId) return;

    if (!consumeRequest(clientId, clientLimits, maxRequestsPerMinute)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Request limit exceeded" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          res.status(400).json({ error: "Invalid or missing session ID" });
          return;
        }
        if (sessionId && sessionOwners.get(sessionId) !== clientId) {
          res
            .status(403)
            .json({ error: "Session is not owned by this client" });
          return;
        }
        if (sessionId) touchSession(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // POST with existing session
      if (sessionId && transports.has(sessionId)) {
        if (sessionOwners.get(sessionId) !== clientId) {
          res
            .status(403)
            .json({ error: "Session is not owned by this client" });
          return;
        }
        const transport = transports.get(sessionId)!;
        touchSession(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // New session: must be initialize request
      const body = req.body;
      if (!isInitializeRequest(body)) {
        res
          .status(400)
          .json({ error: "Bad Request: not an initialize request" });
        return;
      }

      // Session limit check
      if (transports.size + initializingClients.size >= maxSessions) {
        res.status(503).json({ error: "Too many active sessions" });
        return;
      }

      const ownedSessions = [...sessionOwners.values()].filter(
        (owner) => owner === clientId,
      ).length;
      if (ownedSessions >= maxSessionsPerClient) {
        res.status(429).json({ error: "Client session limit exceeded" });
        return;
      }

      // Serialize initialization per client without blocking other clients.
      if (initializingClients.has(clientId)) {
        res.status(429).json({ error: "Initialization already in progress" });
        return;
      }
      initializingClients.add(clientId);

      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            transports.set(id, transport);
            sessionOwners.set(id, clientId);
            touchSession(id);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            removeSession(transport.sessionId);
          }
        };

        try {
          const server = createServer();
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          await transport.close().catch(() => {});
          throw error;
        }
      } finally {
        initializingClients.delete(clientId);
      }
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  return new Promise<HttpServerHandle>((resolve, reject) => {
    let httpServer: Server;

    try {
      httpServer = app.listen(port, host, () => {
        const addr = httpServer.address() as AddressInfo;
        resolve({
          port: addr.port,
          close: () => closeServer(httpServer, transports, sessionTimers),
        });
      });
    } catch (err) {
      reject(err);
      return;
    }

    httpServer.on("error", reject);
  });
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// A static bearer token is a single-user full-control credential. Holders may
// invoke every tool, including mutating watchlist operations.
function authenticate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: any,
  expectedToken: string,
): string | null {
  const header = req.headers["authorization"] as string | undefined;
  const suppliedToken =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  const valid =
    supplied.length === expected.length && timingSafeEqual(supplied, expected);

  if (!valid) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="krx-cli"');
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const remoteAddress = req.socket.remoteAddress ?? "unknown";
  return createHash("sha256")
    .update(`${remoteAddress}\0${expectedToken}`)
    .digest("hex");
}

function consumeRequest(
  clientId: string,
  limits: Map<string, { windowStartedAt: number; count: number }>,
  maximum: number,
): boolean {
  const now = Date.now();
  const current = limits.get(clientId);
  if (!current || now - current.windowStartedAt >= 60_000) {
    for (const [trackedClient, state] of limits) {
      if (now - state.windowStartedAt >= 60_000) {
        limits.delete(trackedClient);
      }
    }
    if (!limits.has(clientId) && limits.size >= MAX_TRACKED_CLIENTS) {
      return false;
    }
    limits.set(clientId, { windowStartedAt: now, count: 1 });
    return maximum >= 1;
  }
  if (current.count >= maximum) return false;
  current.count += 1;
  return true;
}

async function closeServer(
  httpServer: Server,
  transports: Map<string, StreamableHTTPServerTransport>,
  sessionTimers: Map<string, ReturnType<typeof setTimeout>>,
): Promise<void> {
  for (const timer of sessionTimers.values()) {
    clearTimeout(timer);
  }
  sessionTimers.clear();

  const closePromises = [...transports.values()].map((t) =>
    t.close().catch(() => {}),
  );
  await Promise.all(closePromises);
  transports.clear();

  return new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
}
