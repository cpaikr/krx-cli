import { OPENAPI_OFFICIAL_MODIFIED_DATES } from "./generated/openapi-registry.js";

/**
 * Derived from the reviewed dates in the canonical OpenAPI operations. A date
 * change is drift until the official specification and OpenAPI are reviewed
 * together.
 */
export const OFFICIAL_MODIFIED_DATE_BASELINE: Readonly<Record<string, string>> =
  OPENAPI_OFFICIAL_MODIFIED_DATES;

export const CONTRACT_PROBE_EXCLUSIONS: readonly {
  readonly path: string;
  readonly reason: string;
}[] = [];
