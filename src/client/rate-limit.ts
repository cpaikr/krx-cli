import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import {
  abortableDelay,
  RequestCancelledError,
  RequestTimeoutError,
} from "./retry.js";

const CONFIG_DIR = path.join(os.homedir(), ".krx-cli");
const RATE_FILE = path.join(CONFIG_DIR, "rate-limit.json");
const DAILY_LIMIT = 10_000;
const WARNING_THRESHOLD = 0.8;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

interface RateEntry {
  readonly date: string;
  readonly count: number;
}

interface RateData {
  readonly version: 1;
  readonly credentials: Readonly<Record<string, RateEntry>>;
}

export interface RateLimitStatus {
  readonly date: string;
  readonly count: number;
  readonly limit: number;
  readonly remaining: number;
  readonly allowed: boolean;
  readonly warning: boolean;
  readonly advisory: true;
  readonly reserved?: boolean;
}

interface RateLimitOptions {
  readonly filePath?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly lockTimeoutMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function credentialFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** YYYYMMDD in Korea Standard Time, independent of the machine timezone. */
export function kstDate(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
}

function emptyRateData(): RateData {
  return { version: 1, credentials: {} };
}

function validEntry(value: unknown): value is RateEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RateEntry>;
  return (
    typeof entry.date === "string" &&
    /^\d{8}$/.test(entry.date) &&
    Number.isSafeInteger(entry.count) &&
    (entry.count ?? -1) >= 0
  );
}

function readRateData(filePath: string, apiKey: string): RateData {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("root must be an object");
    }
    const candidate = parsed as Partial<RateData>;
    const legacy = parsed as Partial<RateEntry>;
    if (validEntry(legacy)) {
      return {
        version: 1,
        credentials: { [credentialFingerprint(apiKey)]: legacy },
      };
    }
    if (
      candidate.version !== 1 ||
      !candidate.credentials ||
      typeof candidate.credentials !== "object"
    ) {
      throw new Error("unsupported quota-state format");
    }
    if (!Object.values(candidate.credentials).every(validEntry)) {
      throw new Error("invalid credential quota entry");
    }
    return candidate as RateData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRateData();
    }
    throw new Error(
      `Cannot safely read local quota state at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function currentStatus(
  data: RateData,
  apiKey: string,
  date: string,
): RateLimitStatus {
  const entry = data.credentials[credentialFingerprint(apiKey)];
  const count = entry?.date === date ? entry.count : 0;
  return {
    date,
    count,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - count),
    allowed: count < DAILY_LIMIT,
    warning: count >= DAILY_LIMIT * WARNING_THRESHOLD,
    advisory: true,
  };
}

function lockOwnerIsAlive(lockPath: string): boolean {
  try {
    const rawOwner = fs.readFileSync(path.join(lockPath, "owner"), "utf8");
    const ownerPid = Number(rawOwner.split("-", 1)[0]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isRetryableLockContention(error: unknown, lockPath: string): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return true;
  if (process.platform !== "win32" || code !== "EPERM") return false;

  // Windows can report EPERM instead of EEXIST while another process is
  // removing or recreating the lock directory. Retry only when the lock is
  // visible or its parent is writable, preserving genuine permission errors.
  if (fs.existsSync(lockPath)) return true;
  try {
    fs.accessSync(path.dirname(lockPath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(
  filePath: string,
  options: RateLimitOptions,
): Promise<() => void> {
  const lockPath = `${filePath}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  const started = Date.now();
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", relayAbort, { once: true });

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    while (true) {
      if (options.signal?.aborted) {
        if (options.signal.reason instanceof RequestTimeoutError) {
          throw options.signal.reason;
        }
        throw new RequestCancelledError();
      }
      let acquired = false;
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if (!isRetryableLockContention(error, lockPath)) throw error;
      }

      if (acquired) {
        try {
          fs.writeFileSync(path.join(lockPath, "owner"), owner, {
            encoding: "utf8",
            mode: 0o600,
          });
        } catch (error) {
          try {
            fs.rmdirSync(lockPath);
          } catch {
            // A partial owner write is recovered by the stale-lock policy.
          }
          throw error;
        }
        return () => {
          try {
            if (
              fs.readFileSync(path.join(lockPath, "owner"), "utf8") !== owner
            ) {
              return;
            }
            fs.unlinkSync(path.join(lockPath, "owner"));
            fs.rmdirSync(lockPath);
          } catch {
            // A failed cleanup is recovered by the stale-lock policy.
          }
        };
      }

      try {
        if (
          Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS &&
          !lockOwnerIsAlive(lockPath)
        ) {
          const stalePath = `${lockPath}.stale-${randomUUID()}`;
          fs.renameSync(lockPath, stalePath);
          fs.rmSync(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock changed while it was inspected. Retry after the bounded
        // contention delay instead of spinning indefinitely.
      }

      if (Date.now() - started >= (options.lockTimeoutMs ?? LOCK_TIMEOUT_MS)) {
        throw new Error("Timed out waiting for the local quota lock");
      }
      await (options.sleep ?? abortableDelay)(25, controller.signal);
    }
  } finally {
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

/**
 * Atomically reserve one local quota unit before an outbound HTTP attempt.
 * A crash between reservation and dispatch can overcount, but never undercounts.
 */
export async function reserveCall(
  apiKey: string,
  options: RateLimitOptions = {},
): Promise<RateLimitStatus> {
  const filePath = options.filePath ?? RATE_FILE;
  const release = await acquireLock(filePath, options);
  try {
    const date = kstDate(options.now?.() ?? new Date());
    const data = readRateData(filePath, apiKey);
    const status = currentStatus(data, apiKey, date);
    if (!status.allowed) return { ...status, reserved: false };

    const fingerprint = credentialFingerprint(apiKey);
    const count = status.count + 1;
    const next: RateData = {
      version: 1,
      credentials: {
        ...Object.fromEntries(
          Object.entries(data.credentials).filter(
            ([, entry]) => entry.date === date,
          ),
        ),
        [fingerprint]: { date, count },
      },
    };
    writeFileAtomicSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return {
      ...status,
      count,
      remaining: DAILY_LIMIT - count,
      allowed: count < DAILY_LIMIT,
      warning: count >= DAILY_LIMIT * WARNING_THRESHOLD,
      reserved: true,
    };
  } finally {
    release();
  }
}

export function getRateLimitStatus(
  apiKey = "",
  options: Pick<RateLimitOptions, "filePath" | "now"> = {},
): RateLimitStatus {
  const filePath = options.filePath ?? RATE_FILE;
  return currentStatus(
    readRateData(filePath, apiKey),
    apiKey,
    kstDate(options.now?.() ?? new Date()),
  );
}

/** @deprecated Use reserveCall so admission and accounting are one operation. */
export async function incrementCallCount(
  apiKey = "",
): Promise<{ count: number; limit: number }> {
  const status = await reserveCall(apiKey);
  return { count: status.count, limit: status.limit };
}

/** @deprecated Use reserveCall for race-free admission. */
export function checkRateLimit(apiKey = ""): RateLimitStatus {
  return getRateLimitStatus(apiKey);
}
