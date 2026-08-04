import {
  isOutputFormat,
  PUBLIC_CONTRACT,
  type OutputFormat,
} from "../user-contract.js";

export type { OutputFormat } from "../user-contract.js";

export function detectOutputFormat(explicit?: string): OutputFormat {
  if (explicit) {
    if (!isOutputFormat(explicit)) {
      throw new RangeError(`Unsupported output format: ${explicit}`);
    }
    return explicit;
  }
  return process.stdout.isTTY
    ? PUBLIC_CONTRACT.output.interactiveDefault
    : PUBLIC_CONTRACT.output.redirectedDefault;
}

export function formatOutput(
  data: readonly Record<string, unknown>[],
  format: OutputFormat,
  fields?: readonly string[],
): string {
  const filtered = fields ? filterOutputFields(data, fields) : data;

  switch (format) {
    case "json":
      return JSON.stringify(filtered, null, 2);
    case "ndjson":
      return filtered.map((row) => JSON.stringify(row)).join("\n");
    case "table":
      return formatTable(filtered);
    case "csv":
      return formatCsv(filtered);
  }
}

export function filterOutputFields(
  data: readonly Record<string, unknown>[],
  fields: readonly string[],
): readonly Record<string, unknown>[] {
  return data.map((row) => {
    const filtered: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in row) {
        filtered[field] = row[field];
      }
    }
    return filtered;
  });
}

function formatTable(data: readonly Record<string, unknown>[]): string {
  if (data.length === 0) return "(no data)";

  const firstRow = data[0];
  if (!firstRow) return "(no data)";

  const keys = Object.keys(firstRow);
  const widths = keys.map((key) => {
    const values = data.map((row) => String(row[key] ?? ""));
    return Math.max(key.length, ...values.map((v) => v.length));
  });

  const header = keys.map((k, i) => k.padEnd(widths[i] ?? 0)).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const rows = data.map((row) =>
    keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i] ?? 0)).join("  "),
  );

  return [header, separator, ...rows].join("\n");
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCsv(data: readonly Record<string, unknown>[]): string {
  if (data.length === 0) return "";

  const firstRow = data[0];
  if (!firstRow) return "";

  const keys = Object.keys(firstRow);
  const header = keys.join(",");
  const rows = data.map((row) =>
    keys.map((k) => escapeCsvField(String(row[k] ?? ""))).join(","),
  );

  return [header, ...rows].join("\n");
}

export function writeOutput(output: string): void {
  process.stdout.write(output + "\n");
}

export function writeError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

export function writeWarning(message: string): void {
  process.stderr.write(`Warning: ${message}\n`);
}
