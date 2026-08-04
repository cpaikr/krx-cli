import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL_ORIGIN = "https://global.krx.co.kr";
const OTP_URL = `${OFFICIAL_ORIGIN}/contents/COM/GenerateOTP.jspx`;
const DATA_URL = `${OFFICIAL_ORIGIN}/contents/GLB/99/GLB99000001.jspx`;
const BLD = "GLB/05/0501/0501110000/glb0501110000_01";
const REQUEST_TIMEOUT_MS = 15_000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const calendarPath = resolve(root, "src/calendar/krx-closures.json");

function kstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

function currentKstYear() {
  return kstDate().slice(0, 4);
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Official KRX calendar returned HTTP ${response.status}`);
  }
  return response;
}

async function fetchOfficialYear(year) {
  const otpUrl = new URL(OTP_URL);
  otpUrl.searchParams.set("name", "form");
  otpUrl.searchParams.set("bld", BLD);
  const otpResponse = await fetch(otpUrl, {
    headers: {
      Referer: `${OFFICIAL_ORIGIN}/contents/GLB/05/0501/0501110000/GLB0501110000.jsp`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!otpResponse.ok) {
    throw new Error(
      `Official KRX calendar returned HTTP ${otpResponse.status}`,
    );
  }
  const otp = (await otpResponse.text()).trim();
  if (!otp) throw new Error("Official KRX calendar returned an empty OTP");

  const payload = await (
    await post(DATA_URL, { code: otp, search_bas_yy: year, gridTp: "KRX" })
  ).json();
  if (!Array.isArray(payload.block1) || payload.block1.length === 0) {
    throw new Error(`Official KRX calendar returned no closures for ${year}`);
  }

  const closures = {};
  for (const row of payload.block1) {
    const date = String(row.calnd_dd ?? "").replaceAll("-", "");
    if (!new RegExp(`^${year}\\d{4}$`).test(date)) {
      throw new Error(`Official KRX calendar returned an invalid ${year} date`);
    }
    if (Object.hasOwn(closures, date)) {
      throw new Error(`Official KRX calendar returned duplicate date ${date}`);
    }
    closures[date] = String(row.holdy_eng_nm || "KRX market holiday");
  }
  return Object.fromEntries(
    Object.entries(closures).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function normalizeYears(arguments_) {
  const years = arguments_.filter((argument) => argument !== "--");
  const selected = years.length > 0 ? years : [currentKstYear()];
  for (const year of selected) {
    if (!/^20\d{2}$/.test(year))
      throw new Error(`Invalid calendar year: ${year}`);
  }
  return [...new Set(selected)].sort();
}

const [mode, ...yearArguments] = process.argv.slice(2);
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Usage: krx-calendar.mjs <--check|--write> [YYYY ...]");
}

const calendar = JSON.parse(await readFile(calendarPath, "utf8"));
const years = normalizeYears(yearArguments);
let changed = false;

for (const year of years) {
  const official = await fetchOfficialYear(year);
  const maintained = calendar.years[year];
  if (JSON.stringify(official) === JSON.stringify(maintained)) {
    process.stdout.write(`KRX calendar ${year}: current\n`);
    continue;
  }

  if (mode === "--check") {
    const officialDates = new Set(Object.keys(official));
    const maintainedDates = new Set(Object.keys(maintained ?? {}));
    const added = [...officialDates].filter(
      (date) => !maintainedDates.has(date),
    );
    const missing = [...maintainedDates].filter(
      (date) => !officialDates.has(date),
    );
    const renamed = [...officialDates].filter(
      (date) =>
        maintained?.[date] !== undefined && maintained[date] !== official[date],
    );
    throw new Error(
      `KRX calendar ${year} drifted (added: ${added.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}; renamed: ${renamed.join(", ") || "none"}). Run pnpm calendar:update -- ${year} and review the official source.`,
    );
  }

  calendar.years[year] = official;
  changed = true;
  process.stdout.write(`KRX calendar ${year}: updated\n`);
}

if (mode === "--write" && changed) {
  calendar.retrievedAt = kstDate();
  calendar.years = Object.fromEntries(
    Object.entries(calendar.years).sort(([a], [b]) => a.localeCompare(b)),
  );
  const temporaryPath = `${calendarPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(calendar, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, calendarPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
