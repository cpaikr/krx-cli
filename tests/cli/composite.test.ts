import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCompositeExitPolicy } from "../../src/cli/composite.js";

describe("CLI composite exit policy", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("warns on stderr and uses exit 7 for partial success", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    applyCompositeExitPolicy(
      {
        state: "partial",
        requested: ["KOSPI", "KOSDAQ"],
        succeeded: ["KOSPI"],
        failed: [{ id: "KOSDAQ", error: "unavailable" }],
        skipped: [],
      },
      "Stock search",
    );

    expect(process.exitCode).toBe(7);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Stock search is partial"),
    );
  });

  it("uses the existing no-data exit for a genuine empty result", () => {
    applyCompositeExitPolicy(
      {
        state: "empty",
        requested: ["KOSPI", "KOSDAQ"],
        succeeded: ["KOSPI", "KOSDAQ"],
        failed: [],
        skipped: [],
      },
      "Stock search",
    );

    expect(process.exitCode).toBe(3);
  });
});
