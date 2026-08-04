import type { KrxResponse } from "../client/client.js";
import { writeError } from "../output/formatter.js";
import { EXIT_CODES } from "./exit-codes.js";

export function handleKrxError(
  result: Pick<KrxResponse, "error" | "errorCode" | "errorType"> & {
    readonly success?: boolean;
    readonly data?: unknown;
  },
): never {
  const exitCode =
    result.errorType === "rate_limit" || result.errorCode === "RATE_LIMIT"
      ? EXIT_CODES.RATE_LIMIT
      : result.errorType === "authentication"
        ? EXIT_CODES.AUTH_FAILURE
        : result.errorType === "approval"
          ? EXIT_CODES.SERVICE_NOT_APPROVED
          : EXIT_CODES.GENERAL_ERROR;

  writeError(
    `${result.errorType ?? "upstream"}: ${result.error ?? "Unknown error"}`,
  );
  process.exit(exitCode);
}
