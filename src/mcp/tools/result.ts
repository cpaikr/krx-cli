import type { CompositeResult } from "../../client/completeness.js";

const MAX_RESULT_BYTES = 500_000; // 500KB (플랫폼별 컨텍스트 제한에 여유 확보)

interface ToolResult {
  readonly content: { type: "text"; text: string }[];
  readonly isError?: boolean;
}

export function successResult(
  data: readonly Record<string, unknown>[],
): ToolResult {
  const text = JSON.stringify(data, null, 2);

  if (Buffer.byteLength(text, "utf-8") <= MAX_RESULT_BYTES) {
    return { content: [{ type: "text", text }] };
  }

  // Binary search for max rows that fit within the limit
  let lo = 0;
  let hi = data.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = JSON.stringify(data.slice(0, mid), null, 2);
    if (Buffer.byteLength(candidate, "utf-8") <= MAX_RESULT_BYTES - 2_000) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const truncated = data.slice(0, lo);
  const result = {
    data: truncated,
    _truncated: {
      total: data.length,
      returned: lo,
      message: `Result truncated: ${lo} of ${data.length} rows returned. To get remaining rows, use offset=${lo} with limit=${lo}. Or use 'fields' to reduce row size.`,
    },
  };

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export function errorResult(message: string, errorType?: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: message,
          ...(errorType ? { errorType } : {}),
        }),
      },
    ],
    isError: true,
  };
}

export function textResult(data: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function compositeResult<Data, Id extends string>(
  result: CompositeResult<Data, Id>,
): ToolResult {
  const fullText = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(fullText, "utf-8") <= MAX_RESULT_BYTES) {
    return {
      content: [{ type: "text", text: fullText }],
      ...(!result.success ? { isError: true } : {}),
    };
  }

  const nestedStocks =
    !Array.isArray(result.data) &&
    typeof result.data === "object" &&
    result.data !== null &&
    "stocks" in result.data &&
    Array.isArray(result.data.stocks)
      ? result.data.stocks
      : undefined;
  const rows = Array.isArray(result.data) ? result.data : nestedStocks;
  if (!rows) {
    return {
      content: [{ type: "text", text: fullText }],
      ...(!result.success ? { isError: true } : {}),
    };
  }

  const path = nestedStocks ? "data.stocks" : "data";
  const total = rows.length;
  const candidate = (returned: number): string =>
    JSON.stringify(
      {
        ...result,
        data: nestedStocks
          ? { ...result.data, stocks: rows.slice(0, returned) }
          : rows.slice(0, returned),
        _truncated: {
          path,
          total,
          returned,
          message: `Result truncated: ${returned} of ${total} rows returned from ${path}. Narrow the query or use available pagination and field-selection options.`,
        },
      },
      null,
      2,
    );

  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(candidate(mid), "utf-8") <= MAX_RESULT_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return {
    content: [{ type: "text", text: candidate(lo) }],
    ...(!result.success ? { isError: true } : {}),
  };
}
