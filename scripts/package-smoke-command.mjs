import { join } from "node:path";

export function parseNpmPackReport(stdout) {
  const starts = [0];
  for (const match of stdout.matchAll(/\r?\n(?=\[)/g)) {
    starts.push(match.index + match[0].length);
  }

  for (const start of starts.reverse()) {
    try {
      const parsed = JSON.parse(stdout.slice(start).trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // npm 10 can write prepare lifecycle output before its JSON report.
    }
  }
  throw new Error("npm pack did not emit a JSON array report");
}

export function installedBinCommand(
  installRoot,
  name,
  args = [],
  {
    isWindows = process.platform === "win32",
    commandShell = process.env.ComSpec ?? "cmd.exe",
  } = {},
) {
  const executable = join(
    installRoot,
    "node_modules",
    ".bin",
    `${name}${isWindows ? ".cmd" : ""}`,
  );

  if (!isWindows) return { args, command: executable };

  // Keep the command and its arguments separate so Node performs the one
  // required Windows quoting pass when it builds cmd.exe's command line.
  return {
    args: ["/d", "/s", "/c", "call", executable, ...args],
    command: commandShell,
  };
}
