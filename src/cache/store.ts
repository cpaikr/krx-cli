import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { formatDateToYYYYMMDD } from "../utils/date.js";
import { writeFileAtomicSync } from "../utils/atomic-file.js";

const CACHE_DIR = path.join(os.homedir(), ".krx-cli", "cache");
const DATE_FORMAT = /^\d{8}$/;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_CONFIGURED_AGE_HOURS = 365 * 24;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const CACHE_FORMAT_VERSION = 1;
export const DEFAULT_CACHE_MAX_AGE_HOURS = 7 * 24;

type CacheParams = readonly (readonly [string, string])[];

interface CacheEntry<T> {
  readonly version: 1;
  readonly fetchedAt: string;
  readonly endpoint: string;
  readonly params: CacheParams;
  readonly data: readonly T[];
}

interface CacheReadOptions {
  readonly now?: Date;
  readonly maxAgeMs?: number;
}

interface CacheWriteOptions {
  readonly now?: Date;
}

let warnedInvalidMaxAge = false;

function isValidCacheDate(date: string): boolean {
  return DATE_FORMAT.test(date);
}

function sortedParams(params: Record<string, string>): CacheParams {
  return Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
}

function getCacheKey(endpoint: string, params: Record<string, string>): string {
  const raw = `${endpoint}:${JSON.stringify(sortedParams(params))}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function getCachePath(date: string, key: string): string {
  return path.join(CACHE_DIR, date, `${key}.json`);
}

function isToday(dateStr: string, now = new Date()): boolean {
  return dateStr === formatDateToYYYYMMDD(now);
}

function configuredMaxAgeMs(): number {
  const configured = process.env["KRX_CACHE_MAX_AGE_HOURS"];
  if (configured === undefined) return DEFAULT_CACHE_MAX_AGE_HOURS * HOUR_MS;

  const hours = Number(configured);
  if (
    Number.isFinite(hours) &&
    hours >= 0 &&
    hours <= MAX_CONFIGURED_AGE_HOURS
  ) {
    return hours * HOUR_MS;
  }

  if (!warnedInvalidMaxAge) {
    warnedInvalidMaxAge = true;
    process.stderr.write(
      `[krx-cli] invalid KRX_CACHE_MAX_AGE_HOURS=${JSON.stringify(configured)}; using ${DEFAULT_CACHE_MAX_AGE_HOURS}\n`,
    );
  }
  return DEFAULT_CACHE_MAX_AGE_HOURS * HOUR_MS;
}

function isCacheParams(value: unknown): value is CacheParams {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

function parseEntry<T>(
  raw: string,
  endpoint: string,
  params: Record<string, string>,
  now: Date,
  maxAgeMs: number,
): { readonly data: readonly T[]; readonly stale: boolean } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unsupported cache format");
  }

  const candidate = parsed as Partial<CacheEntry<T>>;
  if (candidate.version !== CACHE_FORMAT_VERSION) {
    throw new Error(`unsupported cache version ${String(candidate.version)}`);
  }
  if (candidate.endpoint !== endpoint) {
    throw new Error("endpoint identity does not match its cache key");
  }
  if (
    !isCacheParams(candidate.params) ||
    JSON.stringify(candidate.params) !== JSON.stringify(sortedParams(params))
  ) {
    throw new Error("request parameters do not match their cache key");
  }
  if (!Array.isArray(candidate.data)) {
    throw new Error("cached data must be an array");
  }
  if (typeof candidate.fetchedAt !== "string") {
    throw new Error("fetchedAt must be an ISO timestamp");
  }

  const fetchedAt = Date.parse(candidate.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    throw new Error("fetchedAt must be an ISO timestamp");
  }
  if (fetchedAt - now.getTime() > FUTURE_CLOCK_SKEW_MS) {
    throw new Error("fetchedAt is unreasonably far in the future");
  }

  return {
    data: candidate.data,
    stale: Math.max(0, now.getTime() - fetchedAt) >= maxAgeMs,
  };
}

function quarantineCacheEntry(
  cachePath: string,
  raw: string,
  error: unknown,
): void {
  const quarantinePath = `${cachePath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
  try {
    // Avoid moving a replacement written after this reader observed the file.
    if (fs.readFileSync(cachePath, "utf8") !== raw) return;
    fs.renameSync(cachePath, quarantinePath);
    process.stderr.write(
      `[krx-cli] ignored invalid cache entry ${cachePath}: ${error instanceof Error ? error.message : String(error)}; quarantined at ${quarantinePath}\n`,
    );
  } catch (quarantineError) {
    if ((quarantineError as NodeJS.ErrnoException).code === "ENOENT") return;
    process.stderr.write(
      `[krx-cli] cache quarantine failed for ${cachePath}: ${String(quarantineError)}\n`,
    );
  }
}

export function getCached<T>(
  endpoint: string,
  params: Record<string, string>,
  options: CacheReadOptions = {},
): readonly T[] | null {
  const date = params["basDd"];
  const now = options.now ?? new Date();
  if (!date || !isValidCacheDate(date) || isToday(date, now)) return null;

  const cachePath = getCachePath(date, getCacheKey(endpoint, params));
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    process.stderr.write(
      `[krx-cli] cache read failed for ${cachePath}: ${String(error)}\n`,
    );
    return null;
  }

  try {
    const entry = parseEntry<T>(
      raw,
      endpoint,
      params,
      now,
      options.maxAgeMs ?? configuredMaxAgeMs(),
    );
    return entry.stale ? null : entry.data;
  } catch (error) {
    quarantineCacheEntry(cachePath, raw, error);
    return null;
  }
}

export function setCached<T>(
  endpoint: string,
  params: Record<string, string>,
  data: readonly T[],
  options: CacheWriteOptions = {},
): void {
  const date = params["basDd"];
  const now = options.now ?? new Date();
  if (!date || !isValidCacheDate(date) || isToday(date, now)) return;

  const cachePath = getCachePath(date, getCacheKey(endpoint, params));
  const entry: CacheEntry<T> = {
    version: CACHE_FORMAT_VERSION,
    fetchedAt: now.toISOString(),
    endpoint,
    params: sortedParams(params),
    data,
  };

  try {
    writeFileAtomicSync(cachePath, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    process.stderr.write(
      `[krx-cli] cache write failed for ${cachePath}: ${String(error)}\n`,
    );
  }
}

export function clearCache(): { files: number; directories: number } {
  let files = 0;
  let directories = 0;

  try {
    if (!fs.existsSync(CACHE_DIR)) return { files, directories };

    for (const dateDir of fs.readdirSync(CACHE_DIR)) {
      const dirPath = path.join(CACHE_DIR, dateDir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      files += fs.readdirSync(dirPath).length;
      fs.rmSync(dirPath, { recursive: true, force: true });
      directories += 1;
    }
  } catch (error) {
    process.stderr.write(`[krx-cli] cache clear failed: ${String(error)}\n`);
  }

  return { files, directories };
}

export function getCacheStatus(): {
  totalFiles: number;
  totalSize: number;
  dates: number;
} {
  let totalFiles = 0;
  let totalSize = 0;
  let dates = 0;

  try {
    if (!fs.existsSync(CACHE_DIR)) return { totalFiles, totalSize, dates };

    for (const dateDir of fs.readdirSync(CACHE_DIR)) {
      const dirPath = path.join(CACHE_DIR, dateDir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      dates += 1;
      for (const file of fs.readdirSync(dirPath)) {
        const fileStat = fs.statSync(path.join(dirPath, file));
        totalFiles += 1;
        totalSize += fileStat.size;
      }
    }
  } catch (error) {
    process.stderr.write(`[krx-cli] cache status failed: ${String(error)}\n`);
  }

  return { totalFiles, totalSize, dates };
}
