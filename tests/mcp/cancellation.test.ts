import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/auth.js", () => ({ getApiKey: () => "test-key" }));
vi.mock("../../src/client/client.js", () => ({ krxFetch: vi.fn() }));

import { krxFetch } from "../../src/client/client.js";
import { createCategoryTools } from "../../src/mcp/tools/index.js";

describe("MCP cancellation propagation", () => {
  it("rejects malformed filters before making a KRX request", async () => {
    const indexTool = createCategoryTools().find(
      (tool) => tool.name === "krx_index",
    );

    const result = await indexTool?.handler({
      endpoint: "kospi_dd_trd",
      date: "20260312",
      filter: "invalid",
    });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("Invalid filter expression");
    expect(krxFetch).not.toHaveBeenCalled();
  });

  it("passes the SDK request signal into the KRX client", async () => {
    vi.mocked(krxFetch).mockResolvedValue({ success: true, data: [] });
    const controller = new AbortController();
    const indexTool = createCategoryTools().find(
      (tool) => tool.name === "krx_index",
    );
    await indexTool?.handler(
      { endpoint: "kospi_dd_trd", date: "20260312" },
      controller.signal,
    );
    expect(krxFetch).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
