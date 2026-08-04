import { describe, expect, it } from "vitest";
import { withCliCancellation } from "../../src/cli/cancellation.js";

describe("CLI cancellation boundary", () => {
  it("forwards SIGINT and removes its listener after completion", async () => {
    const listenersBefore = process.listenerCount("SIGINT");
    const pending = withCliCancellation(
      (signal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => resolve(signal.aborted), {
            once: true,
          });
        }),
    );

    process.emit("SIGINT");

    await expect(pending).resolves.toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
  });
});
