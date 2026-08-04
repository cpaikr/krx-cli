import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { getApiKey } from "../client/auth.js";
import { krxFetch } from "../client/client.js";
import { fetchDateRange } from "../client/range-fetch.js";
import {
  writeOutput,
  writeError,
  formatOutput,
  detectOutputFormat,
} from "../output/formatter.js";
import { EXIT_CODES } from "./exit-codes.js";
import { handleKrxError } from "./error-handler.js";
import { applyPipeline } from "../utils/data-pipeline.js";
import { matchesIsuCode } from "../utils/isin.js";
import { validateDate } from "../validator/index.js";
import { setVerbose, verbose } from "../utils/logger.js";
import { getRecentTradingDate } from "../utils/date.js";
import { withCliCancellation } from "./cancellation.js";

export function resolveDate(
  dateOpt: string | undefined,
  program: Command,
): string {
  const fromDate = program.opts().from as string | undefined;
  const toDate = program.opts().to as string | undefined;

  if (dateOpt) {
    return validateDate(dateOpt);
  }

  if (fromDate && toDate) {
    return getRecentTradingDate();
  }

  writeError("Either --date or --from/--to is required");
  process.exit(EXIT_CODES.USAGE_ERROR);
}

interface ExecuteCommandOptions {
  readonly endpoint: string;
  readonly params: Record<string, string>;
  readonly program: Command;
  readonly noDataMessage?: string;
}

export async function executeCommand(
  options: ExecuteCommandOptions,
): Promise<void> {
  const { endpoint, params, program, noDataMessage } = options;

  const apiKey = getApiKey();
  if (!apiKey) {
    writeError(
      "No API key configured. Use 'krx auth set' or set KRX_API_KEY env var.",
    );
    process.exit(EXIT_CODES.AUTH_FAILURE);
  }

  const parentOpts = program.opts();

  if (parentOpts.verbose) {
    setVerbose(true);
  }

  verbose(`endpoint: ${endpoint}`);

  // isuCd is NOT sent to the API — KRX endpoints ignore it and return all rows.
  // Filtering is done client-side after fetch, which also avoids cache key duplication.
  const finalParams = params;

  const codeFilter = parentOpts.code as string | undefined;

  if (parentOpts.dryRun) {
    writeOutput(
      JSON.stringify(
        {
          method: "POST",
          endpoint,
          params: finalParams,
          clientFilter: codeFilter ? { ISU_CD: codeFilter } : undefined,
          headers: { AUTH_KEY: "***" },
        },
        null,
        2,
      ),
    );
    return;
  }

  const fromDate = parentOpts.from as string | undefined;
  const toDate = parentOpts.to as string | undefined;

  if ((fromDate && !toDate) || (!fromDate && toDate)) {
    writeError("Both --from and --to must be provided together");
    process.exit(EXIT_CODES.USAGE_ERROR);
  }

  if (fromDate) {
    try {
      validateDate(fromDate);
    } catch (err) {
      writeError(
        `Invalid --from date: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(EXIT_CODES.USAGE_ERROR);
    }
  }

  if (toDate) {
    try {
      validateDate(toDate);
    } catch (err) {
      writeError(
        `Invalid --to date: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(EXIT_CODES.USAGE_ERROR);
    }
  }

  const isDateRange = fromDate && toDate;

  let data = await withCliCancellation(async (signal) => {
    if (isDateRange) {
      const restParams = Object.fromEntries(
        Object.entries(finalParams).filter(([k]) => k !== "basDd"),
      );
      const rangeResult = await fetchDateRange({
        endpoint,
        from: fromDate,
        to: toDate,
        apiKey,
        cache: parentOpts.cache as boolean,
        extraParams: restParams,
        signal,
      });

      if (!rangeResult.success) {
        handleKrxError({
          success: false,
          data: [],
          error: rangeResult.error ?? "Date range fetch failed",
          errorType: rangeResult.errorType,
        });
      }

      if (rangeResult.failedDays > 0) {
        writeError(`Warning: ${rangeResult.failedDays} day(s) failed to fetch`);
      }

      return rangeResult.data as unknown as Record<string, unknown>[];
    } else {
      const result = await krxFetch({
        endpoint,
        params: finalParams,
        apiKey,
        cache: parentOpts.cache as boolean,
        retries: parentOpts.retries as number | undefined,
        signal,
      });

      if (!result.success) {
        handleKrxError(result);
      }

      return result.data as unknown as Record<string, unknown>[];
    }
  });

  if (codeFilter) {
    data = data.filter((row) =>
      matchesIsuCode(
        String(row["ISU_CD"] ?? ""),
        String(row["ISU_SRT_CD"] ?? ""),
        codeFilter,
      ),
    );
  }

  if (data.length === 0) {
    writeError(noDataMessage ?? "No data");
    process.exit(EXIT_CODES.NO_DATA);
  }

  const beforePipeline = data.length;

  data = applyPipeline(data, {
    filter: parentOpts.filter as string | undefined,
    sort: parentOpts.sort as string | undefined,
    direction: parentOpts.asc ? "asc" : "desc",
    offset: parentOpts.offset as number | undefined,
    limit: parentOpts.limit as number | undefined,
  }) as Record<string, unknown>[];

  verbose(`pipeline: ${beforePipeline} → ${data.length} rows`);

  if (data.length === 0) {
    writeError(
      parentOpts.filter
        ? `No results matched filter: ${parentOpts.filter as string}`
        : (noDataMessage ?? "No data"),
    );
    process.exit(EXIT_CODES.NO_DATA);
  }

  const format = detectOutputFormat(parentOpts.output);
  const fields = parentOpts.fields?.split(",");
  const output = formatOutput(data, format, fields);

  const savePath = parentOpts.save as string | undefined;
  if (savePath) {
    try {
      const dir = path.dirname(savePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(savePath, output + "\n", "utf-8");
      writeOutput(JSON.stringify({ saved: savePath, records: data.length }));
    } catch (err) {
      writeError(
        `Failed to save file: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(EXIT_CODES.GENERAL_ERROR);
    }
  } else {
    writeOutput(output);
  }
}

export function resolveEndpoint(
  endpoints: Record<string, string>,
  key: string,
  label: string,
): string {
  const endpoint = endpoints[key.toLowerCase()];
  if (!endpoint) {
    writeError(
      `Invalid ${label}: ${key}. Must be one of: ${Object.keys(endpoints).join(", ")}`,
    );
    process.exit(EXIT_CODES.USAGE_ERROR);
  }
  return endpoint;
}
