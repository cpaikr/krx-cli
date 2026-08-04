import { Command } from "commander";
import {
  saveApiKey,
  getApiKey,
  checkAllCategories,
  checkCategoryApproval,
  removeApiKey,
} from "../../client/auth.js";
import type { CategoryId } from "../../client/endpoints.js";
import { CATEGORIES } from "../../client/endpoints.js";
import {
  writeOutput,
  writeError,
  formatOutput,
  detectOutputFormat,
} from "../../output/formatter.js";
import { EXIT_CODES } from "../index.js";
import { readSecret } from "../secret-input.js";
import { withCliCancellation } from "../cancellation.js";
import { handleKrxError } from "../error-handler.js";

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage API key and service approvals");

  auth
    .command("set [api-key]")
    .description("Save KRX API key (prompts securely when omitted)")
    .option("--stdin", "read the API key from standard input")
    .action(
      async (apiKey: string | undefined, options: { stdin?: boolean }) => {
        if (apiKey && options.stdin) {
          throw new Error(
            "Provide the API key either as an argument or via stdin",
          );
        }
        if (apiKey) {
          process.stderr.write(
            "Warning: passing API keys as arguments is deprecated because shell history and process listings may expose them.\n",
          );
        }
        const secret = apiKey ?? (await readSecret());
        saveApiKey(secret);
        writeOutput(
          JSON.stringify({ success: true, message: "API key saved" }),
        );
      },
    );

  auth
    .command("remove")
    .description("Remove the persisted KRX API key")
    .action(() => {
      const removed = removeApiKey();
      const environmentStillActive = Boolean(process.env["KRX_API_KEY"]);
      writeOutput(
        JSON.stringify({
          success: true,
          message: removed
            ? "Persisted API key removed"
            : "No persisted API key found",
          ...(environmentStillActive
            ? { note: "KRX_API_KEY remains active for this process" }
            : {}),
        }),
      );
    });

  auth
    .command("status")
    .description("Check API key and service approval status")
    .action(async () => {
      const apiKey = getApiKey();
      if (!apiKey) {
        writeError(
          "No API key configured. Use 'krx auth set' or set KRX_API_KEY env var.",
        );
        process.exit(EXIT_CODES.AUTH_FAILURE);
      }

      writeError("Checking service approvals...");
      const { statuses, cancelled } = await withCliCancellation(
        async (signal) => ({
          statuses: await checkAllCategories(apiKey, { signal }),
          cancelled: signal.aborted,
        }),
      );
      if (cancelled) {
        handleKrxError({
          success: false,
          data: [],
          error: "KRX approval checks were cancelled",
          errorType: "cancelled",
        });
      }

      const format = detectOutputFormat(
        program.parent?.opts().output ?? program.opts().output,
      );

      const result = {
        api_key_set: true,
        services: statuses,
      };

      if (format === "json" || format === "ndjson") {
        writeOutput(JSON.stringify(result, null, 2));
      } else {
        const rows = CATEGORIES.map((cat) => {
          const status = statuses[cat.id];
          return {
            category: cat.id,
            name: cat.nameKo,
            approved: status?.state.toUpperCase() ?? "INCONCLUSIVE",
            checked_at: status?.checkedAt ?? "-",
          };
        });
        writeOutput(
          formatOutput(rows as unknown as Record<string, unknown>[], "table"),
        );
      }
    });

  auth
    .command("check <category>")
    .description("Check approval for a specific category")
    .action(async (category: string) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        writeError(
          "No API key configured. Use 'krx auth set' or set KRX_API_KEY env var.",
        );
        process.exit(EXIT_CODES.AUTH_FAILURE);
      }

      const validCategories = CATEGORIES.map((c) => c.id);
      if (!validCategories.includes(category as CategoryId)) {
        writeError(
          `Invalid category: ${category}. Must be one of: ${validCategories.join(", ")}`,
        );
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      const { status, cancelled } = await withCliCancellation(
        async (signal) => ({
          status: await checkCategoryApproval(apiKey, category as CategoryId, {
            signal,
          }),
          cancelled: signal.aborted,
        }),
      );
      if (cancelled) {
        handleKrxError({
          success: false,
          data: [],
          error: "KRX approval check was cancelled",
          errorType: "cancelled",
        });
      }
      writeOutput(JSON.stringify({ category, ...status }, null, 2));
    });
}
