import type { Completeness } from "../client/completeness.js";
import { writeWarning } from "../output/formatter.js";
import { EXIT_CODES } from "./exit-codes.js";

export function applyCompositeExitPolicy(
  completeness: Completeness,
  label: string,
): void {
  if (completeness.state === "partial") {
    const failed = completeness.failed.map(({ id }) => id).join(", ");
    writeWarning(
      `${label} is partial; failed component(s): ${failed || "unknown"}`,
    );
    process.exitCode = EXIT_CODES.PARTIAL_SUCCESS;
  } else if (completeness.state === "empty") {
    process.exitCode = EXIT_CODES.NO_DATA;
  }
}
