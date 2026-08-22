import type { DateRangeResult } from "./range-fetch.js";
import { OPENAPI_OPERATION_PATHS } from "../contracts/generated/openapi-registry.js";

export const ADJUSTED_STOCK_ENDPOINTS = [
  OPENAPI_OPERATION_PATHS.stock_stk_bydd_trd,
  OPENAPI_OPERATION_PATHS.stock_ksq_bydd_trd,
  OPENAPI_OPERATION_PATHS.stock_knx_bydd_trd,
] as const;

export const ADJUSTED_STOCK_FIELDS = [
  "ADJ_TDD_OPNPRC",
  "ADJ_TDD_HGPRC",
  "ADJ_TDD_LWPRC",
  "ADJ_TDD_CLSPRC",
  "ADJ_FACTOR",
] as const;

const RAW_PRICE_FIELDS = [
  "TDD_OPNPRC",
  "TDD_HGPRC",
  "TDD_LWPRC",
  "TDD_CLSPRC",
] as const;

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface StockAdjustmentTransition {
  readonly previousDate: string;
  readonly date: string;
  readonly previousClose: string;
  readonly referencePrice: string;
  readonly ratio: {
    readonly numerator: string;
    readonly denominator: string;
  };
}

export interface StockAdjustmentMetadata {
  readonly method: "krx-backward-reference-ratio";
  readonly version: 1;
  readonly asOf: string;
  readonly rounding: "nearest-integer-half-up";
  readonly cashDividends: "excluded";
  readonly rawFields: readonly string[];
  readonly adjustedFields: readonly string[];
  readonly factorField: "ADJ_FACTOR";
  readonly transitions: readonly StockAdjustmentTransition[];
}

export type AdjustedStockRow = Record<string, string> & {
  readonly ADJ_TDD_OPNPRC: string;
  readonly ADJ_TDD_HGPRC: string;
  readonly ADJ_TDD_LWPRC: string;
  readonly ADJ_TDD_CLSPRC: string;
  readonly ADJ_FACTOR: string;
};

export interface AdjustedDateRangeResult extends DateRangeResult<AdjustedStockRow> {
  readonly adjustment?: StockAdjustmentMetadata;
}

export interface StockAdjustmentFailure {
  readonly success: false;
  readonly data: readonly [];
  readonly error: string;
  readonly errorType: "integrity";
}

export interface StockAdjustmentSuccess {
  readonly success: true;
  readonly data: readonly AdjustedStockRow[];
  readonly adjustment: StockAdjustmentMetadata;
}

export type StockAdjustmentResult =
  | StockAdjustmentFailure
  | StockAdjustmentSuccess;

export interface DerivedOutputSchema {
  readonly provenance: "krx-cli-derived";
  readonly eligibleEndpoints: readonly string[];
  readonly defaultForEligibleSingleSecurityRanges: true;
  readonly optOut: {
    readonly cli: "--no-adjusted";
    readonly mcp: "adjusted: false";
  };
  readonly fields: readonly {
    readonly name: string;
    readonly type: "string";
    readonly description: string;
  }[];
  readonly envelopeField: "adjustment";
}

export const ADJUSTED_STOCK_OUTPUT_SCHEMA: DerivedOutputSchema = {
  provenance: "krx-cli-derived",
  eligibleEndpoints: ADJUSTED_STOCK_ENDPOINTS,
  defaultForEligibleSingleSecurityRanges: true,
  optOut: { cli: "--no-adjusted", mcp: "adjusted: false" },
  fields: [
    {
      name: "ADJ_TDD_OPNPRC",
      type: "string",
      description: "Adjusted opening price",
    },
    {
      name: "ADJ_TDD_HGPRC",
      type: "string",
      description: "Adjusted high price",
    },
    {
      name: "ADJ_TDD_LWPRC",
      type: "string",
      description: "Adjusted low price",
    },
    {
      name: "ADJ_TDD_CLSPRC",
      type: "string",
      description: "Adjusted closing price",
    },
    {
      name: "ADJ_FACTOR",
      type: "string",
      description: "Exact reduced backward factor as numerator/denominator",
    },
  ],
  envelopeField: "adjustment",
};

function fail(message: string): StockAdjustmentFailure {
  return { success: false, data: [], error: message, errorType: "integrity" };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = abs(left);
  let b = abs(right);
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator <= 0n || numerator <= 0n) {
    throw new Error("Adjustment ratios must be positive");
  }
  const divisor = gcd(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

function multiply(left: Rational, right: Rational): Rational {
  // Cross-reduce before multiplication to keep long histories compact.
  const a = gcd(left.numerator, right.denominator);
  const b = gcd(right.numerator, left.denominator);
  return rational(
    (left.numerator / a) * (right.numerator / b),
    (left.denominator / b) * (right.denominator / a),
  );
}

function exactInteger(
  value: unknown,
  field: string,
  allowNegative = false,
): bigint {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string integer`);
  }
  const pattern = allowNegative
    ? /^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/
    : /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/;
  if (!pattern.test(value)) {
    throw new Error(`${field} is not a canonical KRX integer: ${value}`);
  }
  return BigInt(value.replaceAll(",", ""));
}

function roundedProduct(value: bigint, factor: Rational): string {
  if (value === 0n) return "0";
  const scaled = value * factor.numerator;
  return ((scaled + factor.denominator / 2n) / factor.denominator).toString();
}

function roundedSignedRatio(numerator: bigint, denominator: bigint): bigint {
  const magnitude = (abs(numerator) + denominator / 2n) / denominator;
  return numerator < 0n ? -magnitude : magnitude;
}

function parseRateHundredths(value: string, field: string): bigint {
  const match = /^([+-]?)(\d+)\.(\d{2})$/.exec(value);
  if (!match) throw new Error(`${field} must have exactly two decimal places`);
  const magnitude = BigInt(`${match[2]}${match[3]}`);
  return match[1] === "-" ? -magnitude : magnitude;
}

function validateOhlc(
  open: bigint,
  high: bigint,
  low: bigint,
  close: bigint,
  volume: bigint | undefined,
  label: string,
): void {
  if (close <= 0n) throw new Error(`${label} close must be positive`);
  if (open === 0n || high === 0n || low === 0n) {
    if (open !== 0n || high !== 0n || low !== 0n || volume !== 0n) {
      throw new Error(
        `${label} zero OHLC is valid only for a zero-volume suspension row`,
      );
    }
    return;
  }
  if (low > open || low > close || high < open || high < close || low > high) {
    throw new Error(`${label} violates OHLC ordering`);
  }
}

function factorString(value: Rational): string {
  return `${value.numerator}/${value.denominator}`;
}

export function adjustStockRows(
  rows: readonly Record<string, string>[],
): StockAdjustmentResult {
  if (rows.length === 0)
    return fail("No rows remain for the requested security");

  try {
    const parsed = rows.map((row, index) => {
      const date = row["BAS_DD"];
      const code = row["ISU_CD"];
      const name = row["ISU_NM"];
      const market = row["MKT_NM"];
      if (!date || !/^\d{8}$/.test(date))
        throw new Error(`Row ${index} has an invalid BAS_DD`);
      if (!code || !name || !market)
        throw new Error(`Row ${index} has an incomplete security identity`);

      const close = exactInteger(row["TDD_CLSPRC"], `${date}.TDD_CLSPRC`);
      const change = exactInteger(
        row["CMPPREVDD_PRC"],
        `${date}.CMPPREVDD_PRC`,
        true,
      );
      const reference = close - change;
      if (reference <= 0n)
        throw new Error(`${date} implied reference price must be positive`);
      if (row["FLUC_RT"] !== undefined) {
        const actualRate = parseRateHundredths(
          row["FLUC_RT"],
          `${date}.FLUC_RT`,
        );
        const expectedRate = roundedSignedRatio(change * 10_000n, reference);
        if (actualRate !== expectedRate) {
          throw new Error(
            `${date} FLUC_RT is inconsistent with change and reference price`,
          );
        }
      }
      const open = exactInteger(row["TDD_OPNPRC"], `${date}.TDD_OPNPRC`);
      const high = exactInteger(row["TDD_HGPRC"], `${date}.TDD_HGPRC`);
      const low = exactInteger(row["TDD_LWPRC"], `${date}.TDD_LWPRC`);
      const volume =
        row["ACC_TRDVOL"] === undefined
          ? undefined
          : exactInteger(row["ACC_TRDVOL"], `${date}.ACC_TRDVOL`);
      validateOhlc(open, high, low, close, volume, date);

      const shares =
        row["LIST_SHRS"] === undefined
          ? undefined
          : exactInteger(row["LIST_SHRS"], `${date}.LIST_SHRS`);
      const marketCap =
        row["MKTCAP"] === undefined
          ? undefined
          : exactInteger(row["MKTCAP"], `${date}.MKTCAP`);
      if (
        shares !== undefined &&
        marketCap !== undefined &&
        close * shares !== marketCap
      ) {
        throw new Error(
          `${date} market capitalization does not equal close times listed shares`,
        );
      }

      return {
        row,
        date,
        code,
        name,
        market,
        close,
        change,
        reference,
        open,
        high,
        low,
        volume,
        shares,
      };
    });

    const first = parsed[0];
    if (!first) return fail("No rows remain for the requested security");
    const seen = new Set<string>();
    for (let index = 0; index < parsed.length; index += 1) {
      const current = parsed[index];
      if (!current) continue;
      if (
        current.code !== first.code ||
        current.name !== first.name ||
        current.market !== first.market
      ) {
        throw new Error("Rows do not resolve to one stable security identity");
      }
      if (seen.has(current.date))
        throw new Error(`Duplicate observation date: ${current.date}`);
      seen.add(current.date);
      if (index > 0 && current.date <= (parsed[index - 1]?.date ?? "")) {
        throw new Error(
          "Observation dates must be unique and strictly increasing",
        );
      }
    }

    const boundaryRatios: Rational[] = parsed.map(() => rational(1n, 1n));
    const transitions: StockAdjustmentTransition[] = [];
    for (let index = 1; index < parsed.length; index += 1) {
      const previous = parsed[index - 1];
      const current = parsed[index];
      if (!previous || !current || current.reference === previous.close)
        continue;
      const ratio = rational(current.reference, previous.close);
      boundaryRatios[index] = ratio;

      // A transition reached through one or more suspension rows needs an
      // independent share-count reconciliation; otherwise multiple hidden
      // events could collapse into a mechanically plausible price ratio.
      const followsSuspension =
        previous.open === 0n && previous.high === 0n && previous.low === 0n;
      if (followsSuspension) {
        if (previous.shares === undefined || current.shares === undefined) {
          throw new Error(
            `${current.date} suspended transition lacks listed-share evidence`,
          );
        }
        const shareDifference = abs(
          ratio.numerator * current.shares -
            ratio.denominator * previous.shares,
        );
        // Consolidations can discard a remainder smaller than one post-event
        // share (Incon's official 5:1 fixture differs by one old share).
        if (shareDifference >= ratio.numerator) {
          throw new Error(
            `${current.date} suspended transition is ambiguous against listed shares`,
          );
        }
      }

      transitions.push({
        previousDate: previous.date,
        date: current.date,
        previousClose: previous.close.toString(),
        referencePrice: current.reference.toString(),
        ratio: {
          numerator: ratio.numerator.toString(),
          denominator: ratio.denominator.toString(),
        },
      });
    }

    const factors: Rational[] = parsed.map(() => rational(1n, 1n));
    let accumulated = rational(1n, 1n);
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      factors[index] = accumulated;
      if (index > 0)
        accumulated = multiply(
          accumulated,
          boundaryRatios[index] ?? rational(1n, 1n),
        );
    }

    const adjustedRows = parsed.map((entry, index): AdjustedStockRow => {
      const factor = factors[index] ?? rational(1n, 1n);
      const adjusted = {
        open: roundedProduct(entry.open, factor),
        high: roundedProduct(entry.high, factor),
        low: roundedProduct(entry.low, factor),
        close: roundedProduct(entry.close, factor),
      };
      validateOhlc(
        BigInt(adjusted.open),
        BigInt(adjusted.high),
        BigInt(adjusted.low),
        BigInt(adjusted.close),
        entry.volume,
        `${entry.date} adjusted`,
      );
      return {
        ...entry.row,
        ADJ_TDD_OPNPRC: adjusted.open,
        ADJ_TDD_HGPRC: adjusted.high,
        ADJ_TDD_LWPRC: adjusted.low,
        ADJ_TDD_CLSPRC: adjusted.close,
        ADJ_FACTOR: factorString(factor),
      };
    });

    return {
      success: true,
      data: adjustedRows,
      adjustment: {
        method: "krx-backward-reference-ratio",
        version: 1,
        asOf: parsed.at(-1)?.date ?? "",
        rounding: "nearest-integer-half-up",
        cashDividends: "excluded",
        rawFields: RAW_PRICE_FIELDS,
        adjustedFields: ADJUSTED_STOCK_FIELDS.slice(0, 4),
        factorField: "ADJ_FACTOR",
        transitions,
      },
    };
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : "Adjustment integrity validation failed",
    );
  }
}

export function adjustStockDateRange(
  result: DateRangeResult<Record<string, string>>,
): AdjustedDateRangeResult {
  const failRange = (message: string): AdjustedDateRangeResult => ({
    ...result,
    success: false,
    data: [],
    error: message,
    errorType: "integrity",
    completeness: {
      ...result.completeness,
      state: "failed",
      failed: [
        ...result.completeness.failed,
        { id: "adjustment", error: message, errorType: "integrity" },
      ],
    },
  });

  if (!result.success) {
    return { ...result, data: [] };
  }

  const emptyResponseCount =
    result.fetchedDays - result.completeness.succeeded.length;
  if (emptyResponseCount > 0) {
    return failRange(
      `Adjusted prices cannot verify ${emptyResponseCount} requestable date(s) with empty upstream responses`,
    );
  }

  if (
    result.completeness.state === "empty" &&
    result.completeness.succeeded.length === 0 &&
    result.data.length === 0
  ) {
    return { ...result, data: [] };
  }

  if (result.completeness.state !== "complete") {
    return failRange("Adjusted prices require a complete upstream date range");
  }

  const observedDates = new Set(result.data.map((row) => row["BAS_DD"]));
  const missing = result.completeness.succeeded.filter(
    (date) => !observedDates.has(date),
  );
  if (missing.length > 0) {
    return failRange(
      `Requested security is missing on successful market date(s): ${missing.join(", ")}`,
    );
  }

  const adjusted = adjustStockRows(result.data);
  if (!adjusted.success) return failRange(adjusted.error);
  return {
    ...result,
    data: adjusted.data,
    adjustment: adjusted.adjustment,
  };
}

export function isAdjustedStockEndpoint(endpoint: string): boolean {
  return (ADJUSTED_STOCK_ENDPOINTS as readonly string[]).includes(endpoint);
}
