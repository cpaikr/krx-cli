import { BASE_URL } from "../client/client.js";
import type { EndpointDef } from "../client/endpoints.js";
import { reserveCall } from "../client/rate-limit.js";
import type {
  LiveProbeReport,
  ObservedFieldDrift,
  ProbeIssue,
} from "./types.js";

const LIVE_PROBE_TIMEOUT_MS = 15_000;

interface Reservation {
  readonly reserved?: boolean;
  readonly count: number;
  readonly limit: number;
}

export type ReserveCall = (apiKey: string) => Promise<Reservation>;

interface LiveProbeOptions {
  readonly endpoint: EndpointDef;
  readonly date: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly reserve?: ReserveCall;
}

function emptyDrift(): ObservedFieldDrift {
  return { addedInObserved: [], missingFromObserved: [], changedTypes: [] };
}

function reportFailure(
  options: LiveProbeOptions,
  status: LiveProbeReport["status"],
  issue: ProbeIssue,
  details: Pick<
    LiveProbeReport,
    "httpStatus" | "krxErrorCode" | "quotaReserved"
  > = { quotaReserved: false },
): LiveProbeReport {
  return {
    path: options.endpoint.path,
    date: options.date,
    status,
    ...details,
    rowCount: 0,
    response: emptyDrift(),
    issues: [issue],
  };
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function compareObservedRows(
  endpoint: EndpointDef,
  rows: readonly Record<string, unknown>[],
): ObservedFieldDrift {
  const expected = new Set(endpoint.responseFields.map(({ name }) => name));
  const observed = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [name, value] of Object.entries(row)) {
      const types = observed.get(name) ?? new Set<string>();
      types.add(valueType(value));
      observed.set(name, types);
    }
  }

  return {
    addedInObserved: [...observed.keys()]
      .filter((name) => !expected.has(name))
      .sort(),
    missingFromObserved: [...expected]
      .filter((name) => !observed.has(name))
      .sort(),
    changedTypes: [...observed.entries()]
      .filter(
        ([name, types]) =>
          expected.has(name) && (types.size !== 1 || !types.has("string")),
      )
      .map(([name, types]) => ({
        name,
        maintainedType: "string",
        observedTypes: [...types].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function safeMessage(value: unknown, apiKey: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.replaceAll(apiKey, "[REDACTED]").slice(0, 240);
}

export async function probeEndpoint(
  options: LiveProbeOptions,
): Promise<LiveProbeReport> {
  const reserve = options.reserve ?? reserveCall;
  let reservation: Reservation;
  try {
    reservation = await reserve(options.apiKey);
  } catch {
    return reportFailure(options, "quota_rejected", {
      code: "quota_state_unavailable",
      message: "Local advisory quota state could not reserve this probe",
    });
  }
  if (reservation.reserved !== true) {
    return reportFailure(options, "quota_rejected", {
      code: "daily_quota_reached",
      message: `Local advisory quota rejected the probe at ${reservation.count}/${reservation.limit}`,
    });
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${BASE_URL}${options.endpoint.path}`,
      {
        method: "POST",
        headers: {
          AUTH_KEY: options.apiKey,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ basDd: options.date }),
        signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
      },
    );
  } catch {
    return reportFailure(
      options,
      "request_failed",
      {
        code: "request_failed",
        message: "KRX probe failed before receiving an HTTP response",
      },
      { quotaReserved: true },
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return reportFailure(
      options,
      response.ok ? "request_failed" : "http_error",
      {
        code: response.ok ? "response_body_failed" : "http_error",
        message: response.ok
          ? "KRX probe failed while reading the response body"
          : `KRX returned HTTP ${response.status}`,
      },
      { httpStatus: response.status, quotaReserved: true },
    );
  }

  let body: unknown;
  try {
    body = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    if (!response.ok) {
      return reportFailure(
        options,
        "http_error",
        {
          code: "http_error",
          message: `KRX returned HTTP ${response.status}`,
        },
        { httpStatus: response.status, quotaReserved: true },
      );
    }
    return reportFailure(
      options,
      "invalid_response",
      {
        code: "invalid_json",
        message: "KRX probe response was not valid JSON",
      },
      { httpStatus: response.status, quotaReserved: true },
    );
  }

  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  const krxErrorCode = safeMessage(record?.["respCode"], options.apiKey);
  const krxErrorMessage = safeMessage(record?.["respMsg"], options.apiKey);

  if (!response.ok) {
    return reportFailure(
      options,
      "http_error",
      {
        code: "http_error",
        message: krxErrorMessage
          ? `KRX returned HTTP ${response.status}: ${krxErrorMessage}`
          : `KRX returned HTTP ${response.status}`,
      },
      {
        httpStatus: response.status,
        quotaReserved: true,
        ...(krxErrorCode ? { krxErrorCode } : {}),
      },
    );
  }

  if (krxErrorCode || krxErrorMessage) {
    return reportFailure(
      options,
      "krx_error",
      {
        code: "krx_error_envelope",
        message: krxErrorMessage ?? "KRX returned an error envelope",
      },
      {
        httpStatus: response.status,
        quotaReserved: true,
        ...(krxErrorCode ? { krxErrorCode } : {}),
      },
    );
  }

  const outBlock = record?.["OutBlock_1"];
  if (!Array.isArray(outBlock)) {
    return reportFailure(
      options,
      "invalid_response",
      {
        code: "missing_out_block",
        message: "KRX success response did not contain OutBlock_1",
      },
      { httpStatus: response.status, quotaReserved: true },
    );
  }
  if (outBlock.length === 0) {
    return reportFailure(
      options,
      "empty",
      {
        code: "empty_trading_date",
        message:
          "OutBlock_1 was empty; choose a confirmed trading date before validating schema",
      },
      { httpStatus: response.status, quotaReserved: true },
    );
  }
  if (
    outBlock.some(
      (row) => typeof row !== "object" || row === null || Array.isArray(row),
    )
  ) {
    return reportFailure(
      options,
      "invalid_response",
      {
        code: "invalid_out_block_rows",
        message: "OutBlock_1 contained a non-object row",
      },
      { httpStatus: response.status, quotaReserved: true },
    );
  }

  const rows = outBlock as Record<string, unknown>[];
  const drift = compareObservedRows(options.endpoint, rows);
  const schemaDrift =
    drift.addedInObserved.length > 0 ||
    drift.missingFromObserved.length > 0 ||
    drift.changedTypes.length > 0;
  return {
    path: options.endpoint.path,
    date: options.date,
    status: schemaDrift ? "schema_drift" : "passed",
    httpStatus: response.status,
    quotaReserved: true,
    rowCount: rows.length,
    response: drift,
    issues: schemaDrift
      ? [
          {
            code: "observed_schema_drift",
            message:
              "Observed response keys or value types differ from the maintained registry",
          },
        ]
      : [],
  };
}
