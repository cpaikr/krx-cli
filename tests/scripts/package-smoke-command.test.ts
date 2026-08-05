import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { installedBinCommand } from "../../scripts/package-smoke-command.mjs";

describe("installed package binary command", () => {
  it("passes a Windows command shim and its arguments as separate tokens", () => {
    const command = installedBinCommand(
      "C:/temporary install",
      "krx",
      ["--help"],
      { commandShell: "cmd.exe", isWindows: true },
    );

    expect(command).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        "call",
        join("C:/temporary install", "node_modules", ".bin", "krx.cmd"),
        "--help",
      ],
      command: "cmd.exe",
    });
  });

  it("executes an installed binary directly outside Windows", () => {
    const command = installedBinCommand("/tmp/install", "krx", ["--help"], {
      isWindows: false,
    });

    expect(command).toEqual({
      args: ["--help"],
      command: join("/tmp/install", "node_modules", ".bin", "krx"),
    });
  });
});
