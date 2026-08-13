export const EXIT_CODE_CONTRACT = {
  SUCCESS: {
    code: 0,
    trigger:
      "The command completed without a reportable failure or required-result miss.",
  },
  GENERAL_ERROR: {
    code: 1,
    trigger:
      "An upstream, network, timeout, cancellation, invalid-response, integrity, or local-state failure prevented completion.",
  },
  USAGE_ERROR: {
    code: 2,
    trigger: "Arguments or input were invalid or incomplete.",
  },
  NO_DATA: {
    code: 3,
    trigger: "The requested market data or local target was absent.",
  },
  AUTH_FAILURE: {
    code: 4,
    trigger:
      "No API key is configured, or KRX returned HTTP 401 (an ambiguous credential-or-approval failure).",
  },
  RATE_LIMIT: {
    code: 5,
    trigger: "Local quota admission or KRX HTTP 429 rejected the request.",
  },
  SERVICE_NOT_APPROVED: {
    code: 6,
    trigger: "KRX explicitly rejected service approval with HTTP 403.",
  },
  PARTIAL_SUCCESS: {
    code: 7,
    trigger:
      "A composite command returned usable data while one or more requested components failed.",
  },
} as const;

type ExitCodeName = keyof typeof EXIT_CODE_CONTRACT;

export const EXIT_CODES = Object.fromEntries(
  Object.entries(EXIT_CODE_CONTRACT).map(([name, value]) => [name, value.code]),
) as {
  readonly [Name in ExitCodeName]: (typeof EXIT_CODE_CONTRACT)[Name]["code"];
};
