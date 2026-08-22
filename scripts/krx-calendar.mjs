import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL_ORIGIN = "https://open.krx.co.kr";
const OTP_URL = `${OFFICIAL_ORIGIN}/contents/COM/GenerateOTP.jspx`;
const DATA_URL = `${OFFICIAL_ORIGIN}/contents/OPN/99/OPN99000001.jspx`;
const PAGE_URL = `${OFFICIAL_ORIGIN}/contents/MKD/01/0110/01100305/MKD01100305.jsp`;
const BLD = "MKD/01/0110/01100305/mkd01100305_01";
const REQUEST_TIMEOUT_MS = 15_000;
const CANONICAL_HOLIDAY_NAMES = new Map([
  ["20대 대통령 선거", "Presidential Election Day"],
  ["21대 국회의원선거", "General Election Day"],
  ["8회 지방선거", "Provincial Election Day"],
  ["개천절(대체휴일)", "Substitution Holiday"],
  ["개천절", "National Foundation Day"],
  ["광복절(대체휴일)", "Substitution Holiday"],
  ["광복절", "Liberation Day"],
  ["국회의원 총선거", "General Election Day"],
  ["근로자의날", "Labor Day"],
  ["대통령 선거일", "Presidential Election Day"],
  ["삼일절(대체휴일)", "Substitution Holiday"],
  ["삼일절", "Independence Movement Day"],
  ["석가탄신일(대체휴일)", "Substitution Holiday"],
  ["석가탄신일", "Buddha's Birthday"],
  ["설날(대체휴일)", "Substitution Holiday"],
  ["설날", "Seollal (New Year's Day by the lunar)"],
  ["성탄절", "Christmas Day"],
  ["신정", "New Year's Day"],
  ["어린이날(대체휴일)", "Substitution Holiday"],
  ["어린이날", "Children's Day"],
  ["연말휴장일", "End of Year Holiday"],
  ["임시 공휴일", "Temporary Holiday"],
  ["임시공휴일", "Temporary Holiday"],
  ["제헌절", "KRX market holiday"],
  ["지방선거", "Provincial Election Day"],
  ["추석(대체휴일)", "Substitution Holiday"],
  ["추석", "Chuseok (Korean Thanksgiving)"],
  ["한글날(대체휴일)", "Substitution Holiday"],
  ["한글날", "Hangeul Proclamation Day"],
  ["현충일", "Memorial Day"],
]);
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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: PAGE_URL,
    },
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
    headers: { Referer: PAGE_URL },
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
    const officialName = String(row.holdy_nm ?? "").trim();
    if (!officialName) {
      throw new Error(
        `Official KRX calendar returned an empty holiday label for ${date}`,
      );
    }
    closures[date] = CANONICAL_HOLIDAY_NAMES.get(officialName) ?? officialName;
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
