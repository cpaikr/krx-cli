import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  canonicalOperations,
  compareOfficialRegistry,
  parseCatalog,
  parseOfficialDetail,
  recentTradingDate,
  validateTradingDate,
} from "../../scripts/contract-drift.mjs";

const calendar = JSON.parse(
  readFileSync("src/calendar/krx-closures.json", "utf8"),
);

describe("contract drift inputs", () => {
  it("selects the prior verified session across a midweek KRX closure", () => {
    expect(recentTradingDate(new Date("2026-06-04T00:00:00Z"), calendar)).toBe(
      "20260602",
    );
  });

  it("rejects impossible, closed, and uncovered dates", () => {
    expect(() => validateTradingDate("20260230", calendar)).toThrow(
      /not a real calendar date/u,
    );
    expect(() => validateTradingDate("20260603", calendar)).toThrow(
      /not a verified KRX session/u,
    );
    expect(() => validateTradingDate("20270104", calendar)).toThrow(
      /outside the verified KRX calendar/u,
    );
    expect(() =>
      validateTradingDate(
        "20261201",
        calendar,
        new Date("2026-08-24T06:00:00Z"),
      ),
    ).toThrow(/later than the most recent completed verified KRX session/u);
  });

  it("parses bounded same-origin KRX catalog and detail documents", () => {
    const [entry] = parseCatalog(
      '<a href="/contents/OPP/USE/OPPUSES001_S2.cmd?BO_ID=one" class="link">Service &amp; One</a>',
    );
    expect(entry.officialName).toBe("Service & One");
    const xml =
      '<contract><input><field name="basDd" type="string"/></input>' +
      '<output><field name="BAS_DD" type="string"/></output></contract>';
    const detail = parseOfficialDetail(
      `<input name="apiTestUrl" value="/svc/sample/apis/sto/stk_bydd_trd">` +
        `<dt>최근 수정일</dt><dd>2026-01-02</dd>` +
        `<script>var bld = '${Buffer.from(xml).toString("base64")}'</script>`,
      entry,
    );
    expect(detail).toMatchObject({
      path: "/svc/apis/sto/stk_bydd_trd",
      officialName: "Service & One",
      modifiedDate: "2026-01-02",
      requestFields: [{ name: "basDd", type: "string" }],
      responseFields: [{ name: "BAS_DD", type: "string" }],
    });
  });

  it("reports official membership, field, and modification drift", () => {
    const maintained = [
      {
        path: "/svc/apis/example",
        operationId: "example",
        modifiedDate: "2026-01-01",
        requestFields: [{ name: "basDd", type: "string" }],
        responseFields: [{ name: "BAS_DD", type: "string" }],
      },
    ];
    const official = [
      {
        path: "/svc/apis/example",
        officialName: "Example",
        detailUrl: "https://openapi.krx.co.kr/example",
        modifiedDate: "2026-01-02",
        requestFields: [{ name: "basDd", type: "integer" }],
        responseFields: [{ name: "ADDED", type: "string" }],
      },
      {
        path: "/svc/apis/added",
        officialName: "Added",
        detailUrl: "https://openapi.krx.co.kr/added",
        modifiedDate: "2026-01-02",
        requestFields: [],
        responseFields: [],
      },
    ];
    const comparison = compareOfficialRegistry(maintained, official);
    expect(comparison.hasDrift).toBe(true);
    expect(comparison.addedServices).toEqual(["/svc/apis/added"]);
    expect(comparison.endpoints[0].request.changedTypes).toHaveLength(1);
    expect(comparison.endpoints[0].response.addedInOfficial).toEqual(["ADDED"]);
    expect(comparison.endpoints[0].response.missingFromOfficial).toEqual([
      "BAS_DD",
    ]);
  });

  it("derives all 31 canonical operations from the maintained OpenAPI", () => {
    const openapi = YAML.parse(
      readFileSync("contracts/krx/openapi.yaml", "utf8"),
    );
    expect(canonicalOperations(openapi)).toHaveLength(31);
  });
});
