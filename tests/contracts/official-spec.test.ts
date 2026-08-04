import { describe, expect, it, vi } from "vitest";
import {
  fetchOfficialRegistry,
  MAX_OFFICIAL_SERVICE_DETAILS,
  parseServiceCatalog,
  parseServiceDetail,
} from "../../src/contracts/official-spec.js";

describe("official KRX specification parser", () => {
  it("extracts catalog detail links without unrelated page content", () => {
    const entries = parseServiceCatalog(`
      <a href="/ignored">ignored</a>
      <a href="/contents/OPP/USES/service/OPPUSES001_S2.cmd?BO_ID=abc&amp;v=1" class="link">KOSPI &amp; index</a>
    `);

    expect(entries).toEqual([
      {
        detailUrl:
          "https://openapi.krx.co.kr/contents/OPP/USES/service/OPPUSES001_S2.cmd?BO_ID=abc&v=1",
        officialName: "KOSPI & index",
      },
    ]);
  });

  it("rejects service links outside the official KRX origin", () => {
    expect(() =>
      parseServiceCatalog(`
        <a href="https://example.com/contents/OPP/USES/service/OPPUSES001_S2.cmd?BO_ID=abc" class="link">KOSPI</a>
      `),
    ).toThrow("non-KRX origin");
  });

  it("bounds public detail-page reads when the catalog grows unexpectedly", async () => {
    const links = Array.from(
      { length: MAX_OFFICIAL_SERVICE_DETAILS + 1 },
      (_, index) =>
        `<a href="/contents/OPP/USES/service/OPPUSES001_S2.cmd?BO_ID=${index}" class="link">service ${index}</a>`,
    ).join("\n");
    const fetchImpl = vi.fn(async () => new Response(links));

    await expect(fetchOfficialRegistry(fetchImpl)).rejects.toThrow(
      "service safety limit",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("decodes request and response fields from the official embedded contract", () => {
    const xml = `
      <transaction>
        <input><block><field name="basDd" type="string">20260310</field></block></input>
        <output><block name="OutBlock_1"><field name="BAS_DD" type="string"/><field name="IDX_NM" type="string"/></block></output>
      </transaction>
    `;
    const html = `
      <input name="apiTestUrl" value="/svc/sample/apis/idx/kospi_dd_trd" />
      <dt>최근 수정일</dt><dd>2026/07/16</dd>
      <input name="AUTH_KEY" value="public-sample-key-must-not-be-parsed" />
      <script>var bld = '${Buffer.from(xml).toString("base64")}';</script>
    `;

    const spec = parseServiceDetail(html, {
      detailUrl: "https://openapi.krx.co.kr/detail",
      officialName: "KOSPI",
    });

    expect(spec).toEqual({
      path: "/svc/apis/idx/kospi_dd_trd",
      officialName: "KOSPI",
      detailUrl: "https://openapi.krx.co.kr/detail",
      modifiedDate: "2026/07/16",
      requestFields: [{ name: "basDd", type: "string" }],
      responseFields: [
        { name: "BAS_DD", type: "string" },
        { name: "IDX_NM", type: "string" },
      ],
    });
    expect(JSON.stringify(spec)).not.toContain("public-sample-key");
  });
});
