import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  installedBinCommand,
  parseNpmPackReport,
} from "../../scripts/package-smoke-command.mjs";

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

describe("parseNpmPackReport", () => {
  it("accepts npm 10 prepare output before the JSON report", () => {
    expect(
      parseNpmPackReport(
        '> krx-cli@1.8.1 build C:\\repo\r\n> node esbuild.config.js\r\n\r\n[\r\n  {"filename":"krx-cli-1.8.1.tgz"}\r\n]\r\n',
      ),
    ).toEqual([{ filename: "krx-cli-1.8.1.tgz" }]);
  });

  it("rejects lifecycle output without a JSON array report", () => {
    expect(() => parseNpmPackReport("> krx-cli build\n")).toThrow(
      "npm pack did not emit a JSON array report",
    );
  });
});
