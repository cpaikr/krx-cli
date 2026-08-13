import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProgram, exitCodeForCliError } from "../../src/cli/program.js";
import { EXIT_CODE_CONTRACT, EXIT_CODES } from "../../src/cli/exit-codes.js";
import { exitCodeForKrxError } from "../../src/cli/error-handler.js";
import { PUBLIC_CONTRACT } from "../../src/user-contract.js";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function silenceCommandOutput(command: ReturnType<typeof createProgram>): void {
  command.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  for (const child of command.commands) silenceCommandOutput(child);
}

describe("public CLI contract", () => {
  it("renders output defaults and choices from the executable contract", () => {
    const help = createProgram().helpInformation();
    const unwrappedHelp = help.replace(/\s+/g, " ");

    expect(unwrappedHelp).toContain(
      "defaults to table on a TTY and JSON when redirected",
    );
    for (const format of PUBLIC_CONTRACT.output.formats) {
      expect(help).toContain(`"${format}"`);
    }
    expect(help).toContain(`default: ${PUBLIC_CONTRACT.requests.maxRetries}`);
    expect(help).toContain("--refresh");
    expect(unwrappedHelp).toContain(
      "replace matching historical entries for supported data commands",
    );
    expect(unwrappedHelp).toContain(
      "max retries for a direct endpoint row request",
    );
  });

  it("documents the stock-range raw opt-out at the scoped command", () => {
    const program = createProgram();
    const stock = program.commands.find(
      (command) => command.name() === "stock",
    );
    const list = stock?.commands.find((command) => command.name() === "list");
    expect(list?.helpInformation()).toContain("--no-adjusted");
    expect(program.helpInformation()).not.toContain("--no-adjusted");
  });

  it("documents every HTTP MCP environment variable in serve help", () => {
    const program = createProgram();
    const serve = program.commands.find(
      (command) => command.name() === "serve",
    );
    expect(serve).toBeDefined();

    let help = "";
    serve?.configureOutput({
      writeOut: (value) => {
        help += value;
      },
    });
    serve?.outputHelp();

    expect(help).toContain(PUBLIC_CONTRACT.environment.apiKey);
    expect(help).toContain(PUBLIC_CONTRACT.environment.mcpToken);
    expect(help).toContain(PUBLIC_CONTRACT.environment.mcpAllowedHosts);
    expect(help).toContain(PUBLIC_CONTRACT.environment.cacheMaxAgeHours);
  });

  it("maps typed request failures to precise exit statuses", () => {
    expect(exitCodeForKrxError({ errorType: "authentication" })).toBe(
      EXIT_CODES.AUTH_FAILURE,
    );
    expect(exitCodeForKrxError({ errorType: "approval" })).toBe(
      EXIT_CODES.SERVICE_NOT_APPROVED,
    );
    expect(exitCodeForKrxError({ errorType: "rate_limit" })).toBe(
      EXIT_CODES.RATE_LIMIT,
    );
    expect(exitCodeForKrxError({ errorCode: "RATE_LIMIT" })).toBe(
      EXIT_CODES.RATE_LIMIT,
    );
    expect(exitCodeForKrxError({ errorType: "timeout" })).toBe(
      EXIT_CODES.GENERAL_ERROR,
    );
  });

  it("maps Commander argument failures to usage status 2", async () => {
    for (const args of [
      ["--output", "yaml"],
      ["--limit", "not-a-number"],
      ["--offset", "-1"],
      ["--retries", "1.5"],
      ["serve", "--port", "70000"],
      ["stock", "search", "../unsafe"],
      ["stock", "list", "--date", "invalid"],
      ["stock", "list", "--date", "20260310", "--market", "invalid"],
      ["stock", "list", "--date", "20260310", "--filter", "invalid"],
      ["market", "summary", "--date", "invalid"],
      ["auth", "check", "invalid-category"],
      ["auth", "set", "placeholder", "--stdin"],
    ]) {
      const program = createProgram();
      silenceCommandOutput(program);

      let failure: unknown;
      try {
        await program.parseAsync(["node", "krx", ...args]);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(exitCodeForCliError(failure)).toBe(EXIT_CODES.USAGE_ERROR);
    }
  });

  it("keeps README, skill CLI reference, and contract exit tables complete", () => {
    const readme = readRepositoryFile("README.md");
    const skillReference = readRepositoryFile(
      "skills/krx-cli/references/cli-usage.md",
    );
    const reference = readRepositoryFile("docs/CLI-CONTRACT.md");

    for (const { code, trigger } of Object.values(EXIT_CODE_CONTRACT)) {
      const tableRow = new RegExp(`^\\|\\s*${code}\\s*\\|`, "m");
      expect(readme).toMatch(tableRow);
      expect(reference).toMatch(tableRow);
      expect(reference).toContain(trigger);
      expect(skillReference).toMatch(new RegExp(`^${code} = `, "m"));
    }
    expect(readme).toContain("HTTP 401");
    expect(readme).toContain("HTTP 403");
    expect(skillReference).toContain("ambiguous KRX HTTP 401");
    expect(reference.replace(/\s+/g, " ")).toContain(
      "Only an explicit HTTP 403",
    );
  });

  it("keeps environment, output, security, CI, and official-link docs aligned", () => {
    const readme = readRepositoryFile("README.md");
    const skillReference = readRepositoryFile(
      "skills/krx-cli/references/cli-usage.md",
    );
    const reference = readRepositoryFile("docs/CLI-CONTRACT.md");
    const documents = [readme, skillReference, reference];

    for (const variable of Object.values(PUBLIC_CONTRACT.environment)) {
      expect(reference).toContain(variable);
    }

    for (const variable of [
      PUBLIC_CONTRACT.environment.apiKey,
      PUBLIC_CONTRACT.environment.mcpToken,
      PUBLIC_CONTRACT.environment.mcpAllowedHosts,
      PUBLIC_CONTRACT.environment.cacheMaxAgeHours,
    ]) {
      for (const document of documents) expect(document).toContain(variable);
    }

    expect(readme).toContain("TTY에서는 `table`");
    expect(readme).toContain("항상 JSON envelope");
    expect(skillReference.replace(/\s+/g, " ")).toContain(
      "table on a TTY and JSON when redirected",
    );
    expect(reference).toContain("always return a JSON envelope");
    expect(reference.replace(/\s+/g, " ")).toContain(
      "behavioral scope is deliberate",
    );
    expect(readme).toContain("stdio 전송은 네트워크 포트를 열지 않고");
    expect(readme).toContain("일반 CI나 release gate");
    expect(readme).toContain("실행하지 않습니다");

    const officialUsage =
      "https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp";
    const officialServices =
      "https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd";
    for (const document of [readme, skillReference]) {
      expect(document).toContain(officialUsage);
      expect(document).toContain(officialServices);
    }
  });

  it("uses placeholders or environment expansion in documented API-key examples", () => {
    for (const path of [
      "README.md",
      "skills/krx-cli/references/cli-usage.md",
    ]) {
      const document = readRepositoryFile(path);
      const assignments = document.match(/^export KRX_API_KEY=(.+)$/gm) ?? [];
      for (const assignment of assignments) {
        expect(assignment).toMatch(
          /^export KRX_API_KEY=(?:<[^>]+>|\$\{?\w+\}?)/,
        );
      }
    }
  });
});
