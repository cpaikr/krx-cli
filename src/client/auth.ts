import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CATEGORIES, type CategoryId } from "./endpoints.js";
import { krxFetch } from "./client.js";
import { getRecentTradingDate } from "../utils/date.js";
import { writeFileAtomicSync } from "../utils/atomic-file.js";

const CONFIG_DIR = path.join(os.homedir(), ".krx-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

interface Config {
  readonly apiKey?: string;
  readonly serviceStatus?: Record<
    string,
    { approved: boolean; checkedAt: string }
  >;
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
    if (
      config["serviceStatus"] !== undefined &&
      (!config["serviceStatus"] ||
        typeof config["serviceStatus"] !== "object" ||
        Array.isArray(config["serviceStatus"]))
    ) {
      throw new Error("configuration serviceStatus must be an object");
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
  return process.env["KRX_API_KEY"] ?? readConfig().apiKey;
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
  readonly approved: boolean;
  readonly checkedAt: string;
  readonly error?: string;
}

export async function checkCategoryApproval(
  apiKey: string,
  categoryId: CategoryId,
): Promise<ServiceStatus> {
  const category = CATEGORIES.find((c) => c.id === categoryId);
  if (!category) {
    return { approved: false, checkedAt: new Date().toISOString() };
  }

  const basDd = getRecentTradingDate();

  try {
    const result = await krxFetch({
      endpoint: category.probeEndpoint,
      params: { basDd },
      apiKey,
    });

    const status: ServiceStatus = {
      approved: result.success,
      checkedAt: new Date().toISOString(),
      ...(result.error ? { error: result.error } : {}),
    };

    const config = readConfig({ strict: true });
    const serviceStatus = { ...config.serviceStatus, [categoryId]: status };
    writeConfig({ ...config, serviceStatus });

    return status;
  } catch {
    return { approved: false, checkedAt: new Date().toISOString() };
  }
}

export async function checkAllCategories(
  apiKey: string,
): Promise<Record<CategoryId, ServiceStatus>> {
  const results = await Promise.all(
    CATEGORIES.map(async (cat) => {
      const status = await checkCategoryApproval(apiKey, cat.id);
      return [cat.id, status] as const;
    }),
  );

  return Object.fromEntries(results) as Record<CategoryId, ServiceStatus>;
}

export function getCachedServiceStatus(): Record<string, ServiceStatus> {
  return readConfig().serviceStatus ?? {};
}
