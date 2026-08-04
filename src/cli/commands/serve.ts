import { Command, InvalidArgumentError } from "commander";
import { startHttpServer } from "../../mcp/http-server.js";
import { writeError } from "../../output/formatter.js";
import { getApiKey } from "../../client/auth.js";
import { missingApiKeyMessage, PUBLIC_CONTRACT } from "../../user-contract.js";

function parsePort(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError(
      `Invalid port: "${v}". Must be an integer between 1 and 65535.`,
    );
  }
  return n;
}

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start Streamable HTTP MCP server")
    .addHelpText(
      "after",
      `\nEnvironment:\n  ${PUBLIC_CONTRACT.environment.apiKey} optionally overrides the credential from krx auth set.\n  ${PUBLIC_CONTRACT.environment.mcpToken} is required for Bearer authentication.\n  ${PUBLIC_CONTRACT.environment.mcpAllowedHosts} is also required for non-loopback binds.\n  ${PUBLIC_CONTRACT.environment.cacheMaxAgeHours} optionally controls historical-cache freshness.\n`,
    )
    .option("-p, --port <port>", "port to listen on", parsePort, 3000)
    .option("--host <host>", "host to bind to", "127.0.0.1")
    .action(async (opts: { port: number; host: string }) => {
      const { port, host } = opts;
      const authToken = process.env[PUBLIC_CONTRACT.environment.mcpToken];
      const allowedHosts = process.env[
        PUBLIC_CONTRACT.environment.mcpAllowedHosts
      ]
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

      if (!getApiKey()) {
        process.stderr.write(`Warning: ${missingApiKeyMessage()}\n`);
      }

      if (!authToken) {
        throw new Error(
          `${PUBLIC_CONTRACT.environment.mcpToken} is required for Streamable HTTP MCP authentication`,
        );
      }

      const handle = await startHttpServer({
        port,
        host,
        authToken,
        ...(allowedHosts ? { allowedHosts } : {}),
      });

      process.stderr.write(
        `MCP server listening on http://${host}:${handle.port}/mcp\n`,
      );

      const shutdown = async () => {
        process.stderr.write("\nShutting down MCP server...\n");
        try {
          await handle.close();
        } catch (err) {
          writeError(err instanceof Error ? err.message : String(err));
        }
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
