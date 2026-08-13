import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

/** Load developer-only contract credentials without overriding the shell. */
export function loadLocalContractEnvironment(
  path = resolve(process.cwd(), ".env.local"),
): void {
  if (existsSync(path)) loadEnvFile(path);
}
