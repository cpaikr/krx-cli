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
