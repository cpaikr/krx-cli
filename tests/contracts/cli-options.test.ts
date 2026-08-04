import { describe, expect, it } from "vitest";
import { parseContractArguments } from "../../src/contracts/cli-options.js";

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
});
