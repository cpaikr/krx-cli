import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { createSchemaTool } from "../../src/mcp/tools/schema-tool.js";

async function cliSchema(endpoint: string): Promise<Record<string, unknown>> {
  const output: string[] = [];
  const program = createProgram();
  program.configureOutput({
    writeOut: (value) => output.push(value),
    writeErr: () => undefined,
  });
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["node", "krx", "schema", endpoint]);
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output.join("")) as Record<string, unknown>;
}

describe("adjusted output schema discovery", () => {
  it("exposes derived provenance only for eligible CLI endpoint schemas", async () => {
    const schema = await cliSchema("stock.stk_bydd_trd");
    expect(schema).toMatchObject({
      derivedOutput: {
        provenance: "krx-cli-derived",
        defaultForEligibleSingleSecurityRanges: true,
        envelopeField: "adjustment",
      },
    });
    expect(JSON.stringify(schema)).toContain("ADJ_TDD_CLSPRC");
    expect(
      (await cliSchema("stock.stk_isu_base_info")).derivedOutput,
    ).toBeUndefined();
  });

  it("keeps non-eligible MCP schemas raw-only", async () => {
    const tool = createSchemaTool();
    const eligible = await tool.handler({ endpoint: "ksq_bydd_trd" });
    const ineligible = await tool.handler({ endpoint: "stk_isu_base_info" });
    expect(JSON.parse(eligible.content[0]?.text ?? "null")).toMatchObject({
      derivedOutput: { provenance: "krx-cli-derived" },
    });
    expect(
      JSON.parse(ineligible.content[0]?.text ?? "null").derivedOutput,
    ).toBeUndefined();
  });
});
