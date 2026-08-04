import { describe, expect, it } from "vitest";
import type { EndpointDef } from "../../src/client/endpoints.js";
import { compareOfficialRegistry } from "../../src/contracts/drift.js";
import { compareObservedRows } from "../../src/contracts/live-probe.js";
import type { OfficialEndpointSpec } from "../../src/contracts/types.js";

const endpoint: EndpointDef = {
  path: "/svc/apis/drv/opt_bydd_trd",
  description: "Options",
  descriptionKo: "옵션",
  category: "derivative",
  requestFields: [{ name: "basDd", type: "string", required: true }],
  responseFields: [
    { name: "BAS_DD", description: "date" },
    { name: "VALUE", description: "value" },
  ],
};

function official(
  overrides: Partial<OfficialEndpointSpec> = {},
): OfficialEndpointSpec {
  return {
    path: endpoint.path,
    officialName: "Options",
    detailUrl: "https://openapi.krx.co.kr/detail",
    modifiedDate: "2026/07/16",
    requestFields: [{ name: "basDd", type: "string" }],
    responseFields: [
      { name: "BAS_DD", type: "string" },
      { name: "VALUE", type: "string" },
    ],
    ...overrides,
  };
}

describe("contract drift comparison", () => {
  it("accepts a registry matching the official fields and modification date", () => {
    const drift = compareOfficialRegistry([endpoint], [official()], {
      [endpoint.path]: "2026/07/16",
    });

    expect(drift.hasDrift).toBe(false);
    expect(drift.endpoints).toHaveLength(1);
  });

  it("reports endpoint, field, type, and modification drift", () => {
    const drift = compareOfficialRegistry(
      [endpoint],
      [
        official({
          modifiedDate: "2026/08/01",
          requestFields: [{ name: "date", type: "string" }],
          responseFields: [
            { name: "BAS_DD", type: "number" },
            { name: "ADDED", type: "string" },
          ],
        }),
        official({ path: "/svc/apis/new/service" }),
      ],
      { [endpoint.path]: "2026/07/16" },
    );

    expect(drift.addedServices).toEqual(["/svc/apis/new/service"]);
    expect(drift.endpoints[0]).toMatchObject({
      path: endpoint.path,
      request: {
        addedInOfficial: ["date"],
        missingFromOfficial: ["basDd"],
      },
      response: {
        addedInOfficial: ["ADDED"],
        missingFromOfficial: ["VALUE"],
        changedTypes: [
          {
            name: "BAS_DD",
            maintainedType: "string",
            officialTypes: ["number"],
          },
        ],
      },
      maintainedModifiedDate: "2026/07/16",
      officialModifiedDate: "2026/08/01",
      modifiedDateChanged: true,
    });
  });

  it("reports observed added, missing, and changed response fields", () => {
    expect(
      compareObservedRows(
        {
          ...endpoint,
          responseFields: [
            ...endpoint.responseFields,
            { name: "MISSING", description: "missing" },
          ],
        },
        [
          { BAS_DD: "20260310", VALUE: 1, ADDED: "x" },
          { BAS_DD: "20260310", VALUE: null, ADDED: "y" },
        ],
      ),
    ).toEqual({
      addedInObserved: ["ADDED"],
      missingFromObserved: ["MISSING"],
      changedTypes: [
        {
          name: "VALUE",
          maintainedType: "string",
          observedTypes: ["null", "number"],
        },
      ],
    });
  });
});
