import { createProgram, exitCodeForCliError } from "./program.js";
import { writeError } from "../output/formatter.js";
import { EXIT_CODES } from "./exit-codes.js";

export { EXIT_CODES };

const program = createProgram();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const exitCode = exitCodeForCliError(error);
  if (!(error instanceof Error && "exitCode" in error)) {
    writeError(error instanceof Error ? error.message : String(error));
  }
  process.exit(exitCode);
}
