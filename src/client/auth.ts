import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CATEGORIES, type CategoryId } from "./endpoints.js";
import { krxFetch, type KrxErrorType } from "./client.js";
import { getRecentTradingDate } from "../utils/date.js";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { credentialFingerprint } from "./rate-limit.js";
import { PUBLIC_CONTRACT } from "../user-contract.js";

const CONFIG_DIR = path.join(os.homedir(), ".krx-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const SERVICE_STATUS_TTL_MS = 15 * 60 * 1_000;

export type ApprovalState = "approved" | "rejected" | "inconclusive";
export type ApprovalFailureType = KrxErrorType | "no_data" | "unknown_category";

interface PersistedServiceStatus {
  readonly state: ApprovalState;
  readonly approved?: boolean;
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly credentialId: string;
  readonly failureType?: ApprovalFailureType;
  readonly error?: string;
}

interface Config {
  readonly apiKey?: string;
  readonly serviceStatus?: Record<string, PersistedServiceStatus>;
}

function enforcePrivatePermissions(): void {
  if (process.platform === "win32") return;
  for (const [target, expected, label] of [
    [CONFIG_DIR, 0o700, "configuration directory"],
    [CONFIG_FILE, 0o600, "configuration file"],
  ] as const) {
    try {
      const actual = fs.statSync(target).mode & 0o777;
      if (actual !== expected) {
        fs.chmodSync(target, expected);
        process.stderr.write(
          `[krx-cli] corrected unsafe permissions on ${label}\n`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function isPersistedStatus(value: unknown): value is PersistedServiceStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Partial<PersistedServiceStatus>;
  return (
    ["approved", "rejected", "inconclusive"].includes(status.state ?? "") &&
    typeof status.checkedAt === "string" &&
    typeof status.validUntil === "string" &&
    typeof status.credentialId === "string"
  );
}

function isLegacyStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status["approved"] === "boolean" &&
    typeof status["checkedAt"] === "string"
  );
}

function readConfig(options: { readonly strict?: boolean } = {}): Config {
  try {
    enforcePrivatePermissions();
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration root must be an object");
    }
    const config = parsed as Record<string, unknown>;
    if (
      config["apiKey"] !== undefined &&
      typeof config["apiKey"] !== "string"
    ) {
      throw new Error("configuration apiKey must be a string");
    }
    if (config["serviceStatus"] !== undefined) {
      const statuses = config["serviceStatus"];
      if (
        !config["serviceStatus"] ||
        typeof config["serviceStatus"] !== "object" ||
        Array.isArray(config["serviceStatus"])
      ) {
        throw new Error("configuration serviceStatus is invalid");
      }
      const values = Object.values(statuses as Record<string, unknown>);
      if (!values.every(isPersistedStatus)) {
        if (values.every(isLegacyStatus)) {
          // Legacy statuses were not credential-bound, so they are unsafe to
          // reuse. Preserve the API key and drop only these unverifiable rows.
          config["serviceStatus"] = {};
        } else {
          throw new Error("configuration serviceStatus is invalid");
        }
      }
    }
    return config as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (options.strict) {
      throw new Error(
        `Cannot update invalid configuration at ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    process.stderr.write(
      `[krx-cli] configuration read failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return {};
  }
}

function writeConfig(config: Config): void {
  writeFileAtomicSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

export function getApiKey(): string | undefined {
  return process.env[PUBLIC_CONTRACT.environment.apiKey] ?? readConfig().apiKey;
}

export function saveApiKey(apiKey: string): void {
  const normalized = apiKey.trim();
  if (!normalized) throw new Error("API key must not be empty");
  const config = readConfig({ strict: true });
  writeConfig({ ...config, apiKey: normalized, serviceStatus: {} });
}

export function removeApiKey(): boolean {
  const config = readConfig({ strict: true });
  if (!config.apiKey) return false;
  const retained = Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => key !== "apiKey" && key !== "serviceStatus",
    ),
  ) as Config;
  writeConfig(retained);
  return true;
}

export interface ServiceStatus {
  readonly state: ApprovalState;
  readonly approved?: boolean;
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly fresh: boolean;
  readonly failureType?: ApprovalFailureType;
  readonly error?: string;
}

function statusFor(
  apiKey: string,
  state: ApprovalState,
  options: {
    readonly now: Date;
    readonly failureType?: ApprovalFailureType;
    readonly error?: string;
  },
): PersistedServiceStatus {
  return {
    state,
    ...(state !== "inconclusive" ? { approved: state === "approved" } : {}),
    checkedAt: options.now.toISOString(),
    validUntil: new Date(
      options.now.getTime() + SERVICE_STATUS_TTL_MS,
    ).toISOString(),
    credentialId: credentialFingerprint(apiKey),
    ...(options.failureType ? { failureType: options.failureType } : {}),
    ...(options.error
      ? {
          error: apiKey
            ? options.error.replaceAll(apiKey, "[REDACTED]")
            : options.error,
        }
      : {}),
  };
}

function publicStatus(
  status: PersistedServiceStatus,
  now = new Date(),
): ServiceStatus {
  return {
    state: status.state,
    ...(status.approved !== undefined ? { approved: status.approved } : {}),
    checkedAt: status.checkedAt,
    validUntil: status.validUntil,
    fresh: Date.parse(status.validUntil) > now.getTime(),
    ...(status.failureType ? { failureType: status.failureType } : {}),
    ...(status.error ? { error: status.error } : {}),
  };
}

function persistStatus(categoryId: CategoryId, status: PersistedServiceStatus) {
  const config = readConfig({ strict: true });
  writeConfig({
    ...config,
    serviceStatus: { ...config.serviceStatus, [categoryId]: status },
  });
}

async function probeCategory(
  apiKey: string,
  categoryId: CategoryId,
  options: { readonly signal?: AbortSignal; readonly now?: () => Date },
): Promise<PersistedServiceStatus> {
  const now = options.now?.() ?? new Date();
  const category = CATEGORIES.find((candidate) => candidate.id === categoryId);
  if (!category) {
    return statusFor(apiKey, "inconclusive", {
      now,
      failureType: "unknown_category",
      error: "Unknown KRX service category",
    });
  }

  const result = await krxFetch({
    // Probe endpoints are selected only from the checked-in official category
    // registry; arbitrary endpoints can never become approval probes.
    endpoint: category.probeEndpoint,
    params: { basDd: getRecentTradingDate() },
    apiKey,
    cache: false,
    signal: options.signal,
  });
  if (result.success && result.data.length > 0) {
    return statusFor(apiKey, "approved", { now });
  }
  if (result.success) {
    return statusFor(apiKey, "inconclusive", {
      now,
      failureType: "no_data",
      error: "Probe succeeded but returned no rows",
    });
  }
  if (result.errorType === "approval") {
    return statusFor(apiKey, "rejected", {
      now,
      failureType: "approval",
      error: result.error,
    });
  }
  const ambiguous401 = result.httpStatus === 401;
  return statusFor(apiKey, "inconclusive", {
    now,
    failureType: result.errorType ?? "upstream",
    error: ambiguous401
      ? "KRX HTTP 401 cannot distinguish an invalid credential from missing category approval"
      : (result.error ?? "Approval probe failed"),
  });
}

export async function checkCategoryApproval(
  apiKey: string,
  categoryId: CategoryId,
  options: { readonly signal?: AbortSignal; readonly now?: () => Date } = {},
): Promise<ServiceStatus> {
  const now = options.now?.() ?? new Date();
  const status = await probeCategory(apiKey, categoryId, options);
  persistStatus(categoryId, status);
  return publicStatus(status, now);
}

export async function checkAllCategories(
  apiKey: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Record<CategoryId, ServiceStatus>> {
  const checkedAt = new Date();
  const entries = await Promise.all(
    CATEGORIES.map(async (category) => {
      const status = await probeCategory(apiKey, category.id, {
        signal: options.signal,
        now: () => checkedAt,
      });
      return [category.id, status] as const;
    }),
  );
  const config = readConfig({ strict: true });
  const serviceStatus = Object.fromEntries(entries);
  writeConfig({ ...config, serviceStatus });
  return Object.fromEntries(
    entries.map(([category, status]) => [
      category,
      publicStatus(status, checkedAt),
    ]),
  ) as Record<CategoryId, ServiceStatus>;
}

export function getCachedServiceStatus(
  apiKey = getApiKey(),
  now = new Date(),
): Record<string, ServiceStatus> {
  if (!apiKey) return {};
  const credentialId = credentialFingerprint(apiKey);
  return Object.fromEntries(
    Object.entries(readConfig().serviceStatus ?? {})
      .filter(([, status]) => status.credentialId === credentialId)
      .map(([category, status]) => [category, publicStatus(status, now)]),
  );
}
