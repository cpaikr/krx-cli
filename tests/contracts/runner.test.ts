import { describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "../../src/client/endpoints.js";
import { OFFICIAL_MODIFIED_DATE_BASELINE } from "../../src/contracts/baseline.js";
import {
  buildContractPlan,
  runContractCheck,
} from "../../src/contracts/runner.js";

function officialCatalog(): string {
  return ENDPOINTS.map(
    (_, index) =>
      `<a href="/contents/OPP/USES/service/OPPUSES001_S2.cmd?BO_ID=${index}" class="link">service ${index}</a>`,
  ).join("\n");
}

function officialDetail(index: number): string {
  const endpoint = ENDPOINTS[index];
  if (!endpoint) throw new Error(`Unknown fixture endpoint ${index}`);
  const output = endpoint.responseFields
    .map(({ name }) => `<field name="${name}" type="string"/>`)
    .join("");
  const xml = `<transaction><input><block><field name="basDd" type="string"/></block></input><output><block name="OutBlock_1">${output}</block></output></transaction>`;
  return `<input name="apiTestUrl" value="${endpoint.path.replace("/svc/apis/", "/svc/sample/apis/")}"/><dt>최근 수정일</dt><dd>${OFFICIAL_MODIFIED_DATE_BASELINE[endpoint.path]}</dd><script>var bld = '${Buffer.from(xml).toString("base64")}';</script>`;
}

describe("KRX contract plan", () => {
  it("covers every registered endpoint within the documented call budget", () => {
    const plan = buildContractPlan("20260310");

    expect(plan.probePaths).toEqual(ENDPOINTS.map(({ path }) => path));
    expect(plan.credentialedProbeCalls).toBe(31);
    expect(plan.maximumDailyKrxCalls).toBe(31);
    expect(plan.expectedOfficialSpecRequests).toBe(32);
    expect(plan.maximumOfficialSpecRequests).toBe(65);
    expect(plan.exclusions).toEqual([]);
  });

  it("requires a reviewed official modification baseline for every endpoint", () => {
    expect(Object.keys(OFFICIAL_MODIFIED_DATE_BASELINE).sort()).toEqual(
      ENDPOINTS.map(({ path }) => path).sort(),
    );
  });

  it("runs the full registry with deterministic mocked upstreams and exact quota accounting", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("OPPINFO004.cmd")) {
        return new Response(officialCatalog());
      }
      if (url.includes("OPPUSES001_S2.cmd")) {
        const index = Number(new URL(url).searchParams.get("BO_ID"));
        return new Response(officialDetail(index));
      }
      const endpoint = ENDPOINTS.find(({ path }) => url.endsWith(path));
      if (!endpoint) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          OutBlock_1: [
            Object.fromEntries(
              endpoint.responseFields.map(({ name }) => [name, "value"]),
            ),
          ],
        }),
      );
    });
    let reservations = 0;

    const report = await runContractCheck({
      apiKey: "fixture-key",
      date: "20260310",
      fetchImpl,
      reserve: vi.fn(async () => ({
        reserved: true,
        count: ++reservations,
        limit: 10_000,
      })),
    });

    expect(report.passed).toBe(true);
    expect(report.official.hasDrift).toBe(false);
    expect(report.probes).toHaveLength(ENDPOINTS.length);
    expect(report.probes.every(({ status }) => status === "passed")).toBe(true);
    expect(report.summary).toEqual({
      passedProbes: ENDPOINTS.length,
      failedProbes: 0,
      reservedKrxCalls: ENDPOINTS.length,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + ENDPOINTS.length * 2);
  });
});
