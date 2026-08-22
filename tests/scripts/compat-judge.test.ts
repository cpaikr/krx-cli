import { describe, expect, it } from "vitest";
import { sameJsonValue } from "../../scripts/compat-judge.mjs";

describe("compatibility JSON comparison", () => {
  it("ignores object key order while preserving array order", () => {
    expect(sameJsonValue({ left: 1, right: 2 }, { right: 2, left: 1 })).toBe(
      true,
    );
    expect(sameJsonValue(["left", "right"], ["right", "left"])).toBe(false);
  });
});
