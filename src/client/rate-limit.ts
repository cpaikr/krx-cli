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
const MAX_CREDENTIALS = 10_000;
const WARNING_THRESHOLD = 0.8;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const STEAL_CLAIM_FILE = "steal";

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
    validCompactDate(entry.date) &&
    Number.isSafeInteger(entry.count) &&
    (entry.count ?? -1) >= 0 &&
    (entry.count ?? DAILY_LIMIT + 1) <= DAILY_LIMIT &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "date") &&
    Object.hasOwn(value, "count")
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
    if (
      validEntry(legacy) &&
      Object.keys(legacy).length === 2 &&
      Object.hasOwn(legacy, "date") &&
      Object.hasOwn(legacy, "count")
    ) {
      return {
        version: 1,
        credentials: { [credentialFingerprint(apiKey)]: legacy },
      };
    }
    if (
      candidate.version !== 1 ||
      !candidate.credentials ||
      typeof candidate.credentials !== "object" ||
      Array.isArray(candidate.credentials) ||
      Object.keys(candidate).length !== 2 ||
      !Object.hasOwn(candidate, "version") ||
      !Object.hasOwn(candidate, "credentials")
    ) {
      throw new Error("unsupported quota-state format");
    }
    if (Object.keys(candidate.credentials).length > MAX_CREDENTIALS) {
      throw new Error("too many credential quota entries");
    }
    if (
      !Object.entries(candidate.credentials).every(
        ([fingerprint, entry]) =>
          FINGERPRINT_GRAMMAR.test(fingerprint) && validEntry(entry),
      )
    ) {
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

interface LockIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface LockObservation extends LockIdentity {
  readonly modifiedMs: number;
}

interface ClaimObservation {
  readonly identity: LockIdentity;
  readonly owner: string;
}

class UnsafeLocalQuotaLockError extends Error {}

const OWNER_GRAMMAR =
  /^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_GRAMMAR = /^[0-9a-f]{64}$/;

function validCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function observeLockDirectory(lockPath: string): LockObservation {
  const stat = fs.lstatSync(lockPath, { bigint: true });
  const effectiveUid = process.geteuid?.();
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" &&
      (Number(stat.mode & 0o777n) !== 0o700 ||
        effectiveUid === undefined ||
        stat.uid !== BigInt(effectiveUid)))
  ) {
    throw new UnsafeLocalQuotaLockError("Local quota lock directory is unsafe");
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    modifiedMs: Number(stat.mtimeMs),
  };
}

function lockIdentity(lockPath: string): LockIdentity {
  const observed = observeLockDirectory(lockPath);
  return { device: observed.device, inode: observed.inode };
}

function sameLockIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function ownerIsAlive(rawOwner: string): boolean {
  const ownerPid = Number(rawOwner.split("-", 1)[0]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwnedLockProtocolFile(
  filePath: string,
  description: "owner" | "steal claim",
): ClaimObservation | null {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.size > 128n) {
      throw new UnsafeLocalQuotaLockError(
        `Local quota ${description} is unsafe`,
      );
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const bytes = Buffer.alloc(129);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (read === 0) break;
      length += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const owner = bytes.subarray(0, length).toString("utf8");
    const effectiveUid = process.geteuid?.();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      !after.isFile() ||
      length > 128 ||
      (process.platform !== "win32" &&
        (Number(after.mode & 0o777n) !== 0o600 ||
          effectiveUid === undefined ||
          after.uid !== BigInt(effectiveUid))) ||
      !OWNER_GRAMMAR.test(owner)
    ) {
      throw new UnsafeLocalQuotaLockError(
        `Local quota ${description} is unsafe`,
      );
    }
    return {
      identity: { device: after.dev, inode: after.ino },
      owner,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readLockOwner(lockPath: string): ClaimObservation | null {
  return readOwnedLockProtocolFile(path.join(lockPath, "owner"), "owner");
}

function readStealClaim(lockPath: string): ClaimObservation | null {
  return readOwnedLockProtocolFile(
    path.join(lockPath, STEAL_CLAIM_FILE),
    "steal claim",
  );
}

function sameProtocolFileObservation(
  left: ClaimObservation | null,
  right: ClaimObservation | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.owner === right.owner &&
      sameLockIdentity(left.identity, right.identity))
  );
}

function validateRetainedStaleLock(stalePath: string): void {
  const entries = fs.readdirSync(stalePath).sort();
  if (
    !entries.includes(STEAL_CLAIM_FILE) ||
    entries.some((entry) => entry !== "owner" && entry !== STEAL_CLAIM_FILE)
  ) {
    throw new UnsafeLocalQuotaLockError(
      "Retained stale local quota lock contains unexpected entries",
    );
  }
}

function releaseStealClaim(
  lockPath: string,
  expectedLock: LockIdentity,
  expectedClaim: ClaimObservation,
): void {
  try {
    if (!sameLockIdentity(lockIdentity(lockPath), expectedLock)) return;
    const current = readStealClaim(lockPath);
    if (
      !current ||
      current.owner !== expectedClaim.owner ||
      !sameLockIdentity(current.identity, expectedClaim.identity)
    ) {
      return;
    }
    fs.unlinkSync(path.join(lockPath, STEAL_CLAIM_FILE));
  } catch {
    // The lock or claim changed while it was inspected. Its current owner is
    // responsible for cleanup.
  }
}

function removePreparedProtocolCandidate(
  candidatePath: string,
  expected: LockIdentity | null,
): void {
  if (!expected) return;
  try {
    const current = fs.lstatSync(candidatePath, { bigint: true });
    if (current.dev !== expected.device || current.ino !== expected.inode) {
      return;
    }
    fs.unlinkSync(candidatePath);
  } catch {
    // A moved lock carries its prepared file with it. Prepared files are never
    // protocol authority, so failed best-effort cleanup cannot target another lock.
  }
}

function releasePublishedOwner(
  lockPath: string,
  expectedLock: LockIdentity,
  expectedOwner: ClaimObservation,
): void {
  try {
    if (!sameLockIdentity(lockIdentity(lockPath), expectedLock)) return;
    const current = readLockOwner(lockPath);
    if (!sameProtocolFileObservation(current, expectedOwner)) return;
    fs.unlinkSync(path.join(lockPath, "owner"));
  } catch {
    // The lock or owner changed while it was inspected. Preserve its current
    // contents rather than cleaning up a protocol file we no longer own.
  }
}

function publishLockOwner(
  lockPath: string,
  owner: string,
  expectedLock: LockIdentity,
): ClaimObservation {
  const candidatePath = path.join(lockPath, `.owner.${owner}.tmp`);
  const ownerPath = path.join(lockPath, "owner");
  let directoryDescriptor: number | undefined;
  let candidateIdentity: LockIdentity | null = null;
  let published: ClaimObservation | null = null;
  try {
    if (process.platform === "win32") {
      if (!sameLockIdentity(lockIdentity(lockPath), expectedLock)) {
        throw new UnsafeLocalQuotaLockError(
          "Local quota lock changed before owner publication",
        );
      }
    } else {
      directoryDescriptor = fs.openSync(lockPath, "r");
      const openedLock = fs.fstatSync(directoryDescriptor, { bigint: true });
      if (
        !openedLock.isDirectory() ||
        openedLock.dev !== expectedLock.device ||
        openedLock.ino !== expectedLock.inode
      ) {
        throw new UnsafeLocalQuotaLockError(
          "Local quota lock changed before owner publication",
        );
      }
    }
    fs.writeFileSync(candidatePath, owner, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    if (process.platform !== "win32") fs.chmodSync(candidatePath, 0o600);
    const candidate = fs.lstatSync(candidatePath, { bigint: true });
    candidateIdentity = { device: candidate.dev, inode: candidate.ino };
    const expectedOwner = { identity: candidateIdentity, owner };
    if (!sameLockIdentity(lockIdentity(lockPath), expectedLock)) {
      throw new UnsafeLocalQuotaLockError(
        "Local quota lock changed before owner publication",
      );
    }
    fs.linkSync(candidatePath, ownerPath);
    published = expectedOwner;
    if (directoryDescriptor !== undefined) fs.fsyncSync(directoryDescriptor);
    const observedOwner = readLockOwner(lockPath);
    if (
      !observedOwner ||
      !sameProtocolFileObservation(observedOwner, expectedOwner)
    ) {
      throw new UnsafeLocalQuotaLockError(
        "Local quota owner publication failed",
      );
    }
    published = observedOwner;
    return observedOwner;
  } catch (error) {
    if (published) releasePublishedOwner(lockPath, expectedLock, published);
    throw error;
  } finally {
    removePreparedProtocolCandidate(candidatePath, candidateIdentity);
    if (directoryDescriptor !== undefined) {
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  }
}

function publishStealClaim(
  lockPath: string,
  claimant: string,
  expectedLock: LockIdentity,
): ClaimObservation | null {
  const candidatePath = path.join(lockPath, `.steal.${claimant}.tmp`);
  const claimPath = path.join(lockPath, STEAL_CLAIM_FILE);
  let directoryDescriptor: number | undefined;
  let candidateIdentity: LockIdentity | null = null;
  let published: ClaimObservation | null = null;
  try {
    if (process.platform === "win32") {
      if (!sameLockIdentity(lockIdentity(lockPath), expectedLock)) return null;
    } else {
      directoryDescriptor = fs.openSync(lockPath, "r");
      const openedLock = fs.fstatSync(directoryDescriptor, { bigint: true });
      if (
        !openedLock.isDirectory() ||
        openedLock.dev !== expectedLock.device ||
        openedLock.ino !== expectedLock.inode
      ) {
        return null;
      }
    }
    fs.writeFileSync(candidatePath, claimant, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    const candidate = fs.lstatSync(candidatePath, { bigint: true });
    candidateIdentity = { device: candidate.dev, inode: candidate.ino };
    const expectedClaim: ClaimObservation = {
      identity: candidateIdentity,
      owner: claimant,
    };
    if (!sameLockIdentity(lockIdentity(lockPath), expectedLock)) return null;
    try {
      fs.linkSync(candidatePath, claimPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOENT") return null;
      throw error;
    }
    published = expectedClaim;
    if (directoryDescriptor !== undefined) fs.fsyncSync(directoryDescriptor);
    const claim = readStealClaim(lockPath);
    if (
      !claim ||
      claim.owner !== claimant ||
      !sameLockIdentity(expectedClaim.identity, claim.identity)
    ) {
      throw new Error("Local quota steal claim publication failed");
    }
    published = claim;
    return claim;
  } catch (error) {
    if (published) releaseStealClaim(lockPath, expectedLock, published);
    throw error;
  } finally {
    removePreparedProtocolCandidate(candidatePath, candidateIdentity);
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
  }
}

function tryStealStaleLock(lockPath: string, claimant: string): boolean {
  const observedDirectory = observeLockDirectory(lockPath);
  const observedOwner = readLockOwner(lockPath);
  if (
    Date.now() - observedDirectory.modifiedMs <= STALE_LOCK_MS ||
    (observedOwner !== null && ownerIsAlive(observedOwner.owner))
  ) {
    return false;
  }
  const observed = {
    device: observedDirectory.device,
    inode: observedDirectory.inode,
  };
  let claim = readStealClaim(lockPath);
  let ownsClaim = false;
  if (claim) {
    if (ownerIsAlive(claim.owner)) return false;
  } else {
    claim = publishStealClaim(lockPath, claimant, observed);
    if (!claim) return false;
    ownsClaim = true;
  }

  let moved = false;
  try {
    const confirmedClaim = readStealClaim(lockPath);
    if (
      !sameLockIdentity(lockIdentity(lockPath), observed) ||
      !sameProtocolFileObservation(readLockOwner(lockPath), observedOwner) ||
      (observedOwner !== null && ownerIsAlive(observedOwner.owner)) ||
      !confirmedClaim ||
      confirmedClaim.owner !== claim.owner ||
      !sameLockIdentity(confirmedClaim.identity, claim.identity)
    ) {
      return false;
    }
    const stalePath = `${lockPath}.stale-${claim.owner}`;
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      try {
        if (!sameLockIdentity(lockIdentity(lockPath), observed)) return false;
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw inspectionError;
      }
      throw new UnsafeLocalQuotaLockError(
        "Local quota stale-lock tombstone conflicts with the observed lock",
        { cause: error },
      );
    }
    moved = true;
    validateRetainedStaleLock(stalePath);
    return true;
  } finally {
    if (!moved && ownsClaim) releaseStealClaim(lockPath, observed, claim);
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
        const acquiredLock = lockIdentity(lockPath);
        const publishedOwner = publishLockOwner(lockPath, owner, acquiredLock);
        let claim: ClaimObservation | null;
        let confirmedOwner: ClaimObservation | null;
        try {
          claim = readStealClaim(lockPath);
          confirmedOwner = readLockOwner(lockPath);
        } catch (error) {
          releasePublishedOwner(lockPath, acquiredLock, publishedOwner);
          throw error;
        }
        if (
          claim ||
          !sameProtocolFileObservation(confirmedOwner, publishedOwner)
        ) {
          releasePublishedOwner(lockPath, acquiredLock, publishedOwner);
          // Never remove a failed-acquisition directory by pathname: it may
          // have been replaced after inspection. An ownerless original is
          // recovered by the bounded stale-lock protocol.
          continue;
        }
        return () => {
          try {
            if (
              !sameLockIdentity(lockIdentity(lockPath), acquiredLock) ||
              !sameProtocolFileObservation(
                readLockOwner(lockPath),
                publishedOwner,
              )
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
        if (tryStealStaleLock(lockPath, owner)) continue;
      } catch (error) {
        if (error instanceof UnsafeLocalQuotaLockError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code !== "ENOENT" &&
          code !== "ENOTDIR" &&
          !isRetryableLockContention(error, lockPath)
        ) {
          throw error;
        }
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
    const currentCredentials = Object.fromEntries(
      Object.entries(data.credentials).filter(
        ([, entry]) => entry.date === date,
      ),
    );
    if (
      !(fingerprint in currentCredentials) &&
      Object.keys(currentCredentials).length >= MAX_CREDENTIALS
    ) {
      throw new Error("Cannot safely reserve another credential quota entry");
    }
    const next: RateData = {
      version: 1,
      credentials: {
        ...currentCredentials,
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
