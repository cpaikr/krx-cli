import { describe, expect, it } from "vitest";
import {
  parseContractArguments,
  resolveContractDate,
} from "../../src/contracts/cli-options.js";

describe("contract-check CLI arguments", () => {
  it("accepts pnpm's forwarded argument separator", () => {
    expect(
      parseContractArguments([
        "--dry-run",
        "--",
        "--date",
        "20260310",
        "--report",
        "artifacts/report.json",
      ]),
    ).toEqual({
      dryRun: true,
      help: false,
      date: "20260310",
      reportPath: "artifacts/report.json",
    });
  });

  it("rejects unknown options", () => {
    expect(() => parseContractArguments(["--network"])).toThrow(
      "Unknown option: --network",
    );
  });

  it("treats a blank scheduled date as absent", () => {
    expect(resolveContractDate(undefined, "")).toBeUndefined();
    expect(resolveContractDate(undefined, "   ")).toBeUndefined();
  });

  it("prefers the CLI date and trims an environment date", () => {
    expect(resolveContractDate("20260310", "20260309")).toBe("20260310");
    expect(resolveContractDate(undefined, " 20260309 ")).toBe("20260309");
  });
});
