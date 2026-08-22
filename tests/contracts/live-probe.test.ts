import { describe, expect, it, vi } from "vitest";
import type { EndpointDef } from "../../src/client/endpoints.js";
import { probeEndpoint } from "../../src/contracts/live-probe.js";

const endpoint: EndpointDef = {
  path: "/svc/apis/idx/kospi_dd_trd",
  description: "KOSPI",
  descriptionKo: "코스피",
  category: "index",
  requestFields: [{ name: "basDd", type: "string", required: true }],
  responseFields: [
    { name: "BAS_DD", description: "date" },
    { name: "IDX_NM", description: "name" },
  ],
};

const reserve = vi.fn(async () => ({
  reserved: true,
  count: 1,
  limit: 10_000,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("credentialed KRX contract probe", () => {
  it("validates HTTP, OutBlock_1, required fields, and string types", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        OutBlock_1: [{ BAS_DD: "20260310", IDX_NM: "KOSPI" }],
      }),
    );

    const report = await probeEndpoint({
      endpoint,
      apiKey: "secret-key",
      date: "20260310",
      fetchImpl,
      reserve,
    });

    expect(report).toMatchObject({
      status: "passed",
      httpStatus: 200,
      quotaReserved: true,
      rowCount: 1,
      response: {
        addedInObserved: [],
        missingFromObserved: [],
        changedTypes: [],
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(endpoint.path),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ basDd: "20260310" }),
      }),
    );
  });

  it("does not mistake an empty trading-day response for schema success", async () => {
    const report = await probeEndpoint({
      endpoint,
      apiKey: "secret-key",
      date: "20260310",
      fetchImpl: vi.fn(async () => jsonResponse({ OutBlock_1: [] })),
      reserve,
    });

    expect(report).toMatchObject({
      status: "empty",
      quotaReserved: true,
      rowCount: 0,
    });
  });

  it("counts a reserved call even when the request fails", async () => {
    const report = await probeEndpoint({
      endpoint,
      apiKey: "secret-key",
      date: "20260310",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
      reserve,
    });

    expect(report).toMatchObject({
      status: "request_failed",
      quotaReserved: true,
    });
  });

  it("does not contact KRX when local quota admission is rejected", async () => {
    const fetchImpl = vi.fn();
    const report = await probeEndpoint({
      endpoint,
      apiKey: "secret-key",
      date: "20260310",
      fetchImpl,
      reserve: vi.fn(async () => ({
        reserved: false,
        count: 10_000,
        limit: 10_000,
      })),
    });

    expect(report).toMatchObject({
      status: "quota_rejected",
      quotaReserved: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts credentials from a KRX error envelope", async () => {
    const apiKey = "sensitive-contract-key";
    const report = await probeEndpoint({
      endpoint,
      apiKey,
      date: "20260310",
      fetchImpl: vi.fn(async () =>
        jsonResponse({ respCode: "AUTH", respMsg: `invalid ${apiKey}` }),
      ),
      reserve,
    });

    expect(report).toMatchObject({
      status: "krx_error",
      httpStatus: 200,
      krxErrorCode: "AUTH",
      quotaReserved: true,
    });
    expect(JSON.stringify(report)).not.toContain(apiKey);
  });

  it("classifies an empty-but-present KRX error field", async () => {
    const report = await probeEndpoint({
      endpoint,
      apiKey: "secret-key",
      date: "20260310",
      fetchImpl: vi.fn(async () =>
        jsonResponse({ respCode: "", OutBlock_1: [{ BAS_DD: "20260310" }] }),
      ),
      reserve,
    });

    expect(report).toMatchObject({
      status: "krx_error",
      issues: [
        {
          code: "krx_error_envelope",
          message: "KRX returned an error envelope",
        },
      ],
      quotaReserved: true,
    });
  });

  it("classifies a non-JSON failed response by its HTTP status", async () => {
    const report = await probeEndpoint({
      endpoint,
      apiKey: "secret-key",
      date: "20260310",
      fetchImpl: vi.fn(
        async () => new Response("upstream unavailable", { status: 503 }),
      ),
      reserve,
    });

    expect(report).toMatchObject({
      status: "http_error",
      httpStatus: 503,
      quotaReserved: true,
    });
  });

  it("reports observed field and type drift without retaining row data", async () => {
    const report = await probeEndpoint({
      endpoint,
      apiKey: "secret-key",
      date: "20260310",
      fetchImpl: vi.fn(async () =>
        jsonResponse({ OutBlock_1: [{ BAS_DD: "20260310", EXTRA: 1 }] }),
      ),
      reserve,
    });

    expect(report).toMatchObject({
      status: "schema_drift",
      response: {
        addedInObserved: ["EXTRA"],
        missingFromObserved: ["IDX_NM"],
      },
    });
    expect(JSON.stringify(report)).not.toContain("OutBlock_1");
  });

  it("rejects a field missing from only one observed row", async () => {
    const report = await probeEndpoint({
      endpoint,
      apiKey: "secret-key",
      date: "20260310",
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          OutBlock_1: [
            { BAS_DD: "20260310", IDX_NM: "KOSPI" },
            { BAS_DD: "20260310" },
          ],
        }),
      ),
      reserve,
    });

    expect(report).toMatchObject({
      status: "schema_drift",
      response: { missingFromObserved: ["IDX_NM"] },
    });
  });
});
