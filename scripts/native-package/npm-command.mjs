import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

export function resolveNpmCommand({
  platform = process.platform,
  execPath = process.execPath,
  fileExists = existsSync,
  npmCliPath,
} = {}) {
  if (platform !== "win32") {
    return { command: "npm", argumentPrefix: [] };
  }

  const npmCli =
    npmCliPath ??
    resolve(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fileExists(npmCli)) {
    throw new Error(
      `npm CLI was not found beside the Windows Node runtime: ${npmCli}`,
    );
  }
  return { command: execPath, argumentPrefix: [npmCli] };
}
