import { ENDPOINTS } from "../client/endpoints.js";
import { getRecentTradingDate } from "../utils/date.js";
import { validateDate } from "../validator/index.js";
import {
  CONTRACT_PROBE_EXCLUSIONS,
  OFFICIAL_MODIFIED_DATE_BASELINE,
} from "./baseline.js";
import { compareOfficialRegistry } from "./drift.js";
import { probeEndpoint, type ReserveCall } from "./live-probe.js";
import {
  fetchOfficialRegistry,
  MAX_OFFICIAL_SERVICE_DETAILS,
} from "./official-spec.js";
import type { ContractPlan, ContractReport } from "./types.js";

export function buildContractPlan(date = getRecentTradingDate()): ContractPlan {
  validateDate(date);
  const exclusions = new Map(
    CONTRACT_PROBE_EXCLUSIONS.map(({ path, reason }) => [path, reason]),
  );
  const probePaths = ENDPOINTS.map(({ path }) => path).filter(
    (path) => !exclusions.has(path),
  );
  return {
    date,
    registeredEndpoints: ENDPOINTS.length,
    credentialedProbeCalls: probePaths.length,
    maximumDailyKrxCalls: probePaths.length,
    expectedOfficialSpecRequests: ENDPOINTS.length + 1,
    maximumOfficialSpecRequests: MAX_OFFICIAL_SERVICE_DETAILS + 1,
    probePaths,
    exclusions: CONTRACT_PROBE_EXCLUSIONS,
  };
}

interface ContractRunOptions {
  readonly apiKey: string;
  readonly date?: string;
  readonly fetchImpl?: typeof fetch;
  readonly reserve?: ReserveCall;
}

export async function runContractCheck(
  options: ContractRunOptions,
): Promise<ContractReport> {
  const plan = buildContractPlan(options.date);
  if (!options.apiKey) {
    throw new Error("KRX_API_KEY is required for a live contract check");
  }

  const officialSpecs = await fetchOfficialRegistry(options.fetchImpl);
  const official = compareOfficialRegistry(
    ENDPOINTS,
    officialSpecs,
    OFFICIAL_MODIFIED_DATE_BASELINE,
  );
  const exclusionPaths = new Set(plan.exclusions.map(({ path }) => path));
  const probes = [];
  for (const endpoint of ENDPOINTS) {
    if (exclusionPaths.has(endpoint.path)) continue;
    probes.push(
      await probeEndpoint({
        endpoint,
        date: plan.date,
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
        reserve: options.reserve,
      }),
    );
  }

  const passedProbes = probes.filter(
    ({ status }) => status === "passed",
  ).length;
  const failedProbes = probes.length - passedProbes;
  return {
    version: 1,
    mode: "live",
    generatedAt: new Date().toISOString(),
    passed: !official.hasDrift && failedProbes === 0,
    plan,
    official,
    probes,
    summary: {
      passedProbes,
      failedProbes,
      reservedKrxCalls: probes.filter(({ quotaReserved }) => quotaReserved)
        .length,
    },
  };
}
