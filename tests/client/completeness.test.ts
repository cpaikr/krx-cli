import { describe, expect, it } from "vitest";
import {
  componentFailure,
  createCompleteness,
} from "../../src/client/completeness.js";

describe("composite completeness contract", () => {
  it.each([
    {
      expected: "complete",
      input: { requested: ["a"], succeeded: ["a"], hasData: true },
    },
    {
      expected: "partial",
      input: {
        requested: ["a", "b"],
        succeeded: ["a"],
        failed: [{ id: "b", error: "failed" }],
        hasData: true,
      },
    },
    {
      expected: "empty",
      input: { requested: ["a"], succeeded: ["a"], hasData: false },
    },
    {
      expected: "failed",
      input: {
        requested: ["a"],
        failed: [{ id: "a", error: "failed" }],
        hasData: false,
      },
    },
  ] as const)("derives $expected state", ({ input, expected }) => {
    expect(createCompleteness(input).state).toBe(expected);
  });

  it("forces cancellation-dominated aggregates to failed", () => {
    expect(
      createCompleteness({
        requested: ["a", "b"],
        succeeded: ["a"],
        failed: [{ id: "b", error: "cancelled", errorType: "cancelled" }],
        hasData: true,
        forceFailed: true,
      }).state,
    ).toBe("failed");
  });

  it("preserves component identity and typed diagnostics", () => {
    expect(
      componentFailure("KOSDAQ", {
        error: "deadline exceeded",
        errorType: "timeout",
      }),
    ).toEqual({
      id: "KOSDAQ",
      error: "deadline exceeded",
      errorType: "timeout",
    });
  });
});
