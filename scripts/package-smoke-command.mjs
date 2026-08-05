import { join } from "node:path";

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
