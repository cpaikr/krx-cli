import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

const repository = resolve(import.meta.dirname, "..");
const CATALOG_URL =
  "https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd";
const OFFICIAL_ORIGIN = "https://openapi.krx.co.kr";
const MAX_OFFICIAL_DETAILS = 64;
const REQUEST_TIMEOUT_MS = 15_000;

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument?.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    argumentsByName.set(argument, next);
    index += 1;
  } else {
    argumentsByName.set(argument, true);
  }
}

const dryRun = argumentsByName.has("--dry-run");
const reportPath = argumentsByName.get("--report");
const packageRoot = resolve(
  repository,
  argumentsByName.get("--package") ?? "target/native-package/package",
);
const date =
  argumentsByName.get("--date") ||
  process.env.KRX_CONTRACT_DATE ||
  recentTradingDate();

if (!/^\d{8}$/u.test(date)) {
  throw new Error("contract date must use YYYYMMDD");
}

const openapi = YAML.parse(
  await readFile(resolve(repository, "contracts/krx/openapi.yaml"), "utf8"),
);
const operations = canonicalOperations(openapi);
const plan = {
  date,
  registeredEndpoints: operations.length,
  credentialedProbeCalls: operations.length,
  maximumDailyKrxCalls: operations.length,
  expectedOfficialSpecRequests: operations.length + 1,
  maximumOfficialSpecRequests: MAX_OFFICIAL_DETAILS + 1,
  probeOperations: operations.map(({ operationId }) => operationId),
  exclusions: [],
};

let report;
if (dryRun) {
  report = {
    version: 2,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    passed: true,
    plan,
  };
} else {
  if (!process.env.KRX_API_KEY) {
    throw new Error("KRX_API_KEY is required for a live contract check");
  }
  const officialSpecs = await fetchOfficialRegistry();
  const official = compareOfficialRegistry(operations, officialSpecs);
  const { KrxClient } = await import(
    pathToFileURL(resolve(packageRoot, "dist/index.js")).href
  );
  const client = new KrxClient({ apiKey: process.env.KRX_API_KEY });
  const probes = [];
  for (const operation of operations) {
    probes.push(await probeOperation(client, operation, date));
  }
  const passedProbes = probes.filter(
    ({ status }) => status === "passed",
  ).length;
  report = {
    version: 2,
    mode: "live-native-sdk",
    generatedAt: new Date().toISOString(),
    passed: !official.hasDrift && passedProbes === probes.length,
    plan,
    official,
    probes,
    summary: {
      passedProbes,
      failedProbes: probes.length - passedProbes,
      nativeSdkCalls: probes.length,
    },
  };
}

const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (typeof reportPath === "string") {
  const destination = resolve(repository, reportPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, rendered);
}
process.stdout.write(rendered);
if (!report.passed) process.exitCode = 1;

function recentTradingDate() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
  kst.setUTCHours(0, 0, 0, 0);
  kst.setUTCDate(kst.getUTCDate() - 1);
  while (kst.getUTCDay() === 0 || kst.getUTCDay() === 6) {
    kst.setUTCDate(kst.getUTCDate() - 1);
  }
  return kst.toISOString().slice(0, 10).replaceAll("-", "");
}

function canonicalOperations(document) {
  const operations = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    const operation = pathItem.post;
    const success = dereference(
      document,
      operation.responses?.["200"]?.content?.["application/json"]?.schema
        ?.oneOf?.[0],
    );
    const rows = dereference(document, success?.properties?.OutBlock_1?.items);
    operations.push({
      path,
      operationId: operation.operationId,
      modifiedDate: operation["x-krx-official-modified"],
      requestFields: [{ name: "basDd", type: "string" }],
      responseFields: Object.keys(rows?.properties ?? {}).map((name) => ({
        name,
        type: "string",
      })),
    });
  }
  if (operations.length !== 31) {
    throw new Error(
      `canonical OpenAPI must contain 31 operations, found ${operations.length}`,
    );
  }
  return operations;
}

function dereference(document, value) {
  if (!value?.$ref) return value;
  const prefix = "#/components/schemas/";
  if (!value.$ref.startsWith(prefix))
    throw new Error("unsupported OpenAPI reference");
  return document.components.schemas[value.$ref.slice(prefix.length)];
}

async function probeOperation(client, operation, probeDate) {
  try {
    const result = await client.query({
      operation: operation.operationId,
      date: probeDate,
      cache: { mode: "bypass" },
      retries: 0,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const rows = result.data;
    const expected = new Set(operation.responseFields.map(({ name }) => name));
    const observed = new Set(rows.flatMap((row) => Object.keys(row)));
    const added = [...observed].filter((name) => !expected.has(name)).sort();
    const missing = [...expected]
      .filter((name) => rows.some((row) => !Object.hasOwn(row, name)))
      .sort();
    const changedTypes = [...expected]
      .filter((name) => rows.some((row) => typeof row[name] !== "string"))
      .sort();
    const status =
      rows.length > 0 &&
      added.length === 0 &&
      missing.length === 0 &&
      changedTypes.length === 0
        ? "passed"
        : "schema_drift";
    return {
      operationId: operation.operationId,
      path: operation.path,
      date: probeDate,
      status,
      rowCount: rows.length,
      response: { added, missing, changedTypes },
    };
  } catch (error) {
    return {
      operationId: operation.operationId,
      path: operation.path,
      date: probeDate,
      status: "request_failed",
      rowCount: 0,
      error: sanitizeError(error),
    };
  }
}

function sanitizeError(error) {
  const key = process.env.KRX_API_KEY ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: typeof error?.kind === "string" ? error.kind : "unknown",
    code: typeof error?.code === "string" ? error.code : "unknown",
    message: (key ? message.replaceAll(key, "[REDACTED]") : message).slice(
      0,
      240,
    ),
  };
}

async function fetchOfficialRegistry() {
  const catalog = await fetchText(CATALOG_URL);
  const entries = parseCatalog(catalog);
  if (entries.length > MAX_OFFICIAL_DETAILS) {
    throw new Error(
      `official catalog exceeds ${MAX_OFFICIAL_DETAILS} services`,
    );
  }
  const results = new Array(entries.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        const index = next++;
        results[index] = parseOfficialDetail(
          await fetchText(entries[index].detailUrl),
          entries[index],
        );
      }
    }),
  );
  return results;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { Accept: "text/html; charset=utf-8" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `official KRX specification returned HTTP ${response.status}`,
    );
  return response.text();
}

function parseCatalog(html) {
  const entries = [];
  const pattern =
    /href="([^"]*\/OPPUSES\d+_S2\.cmd\?BO_ID=[^"]+)"\s+class="link">([^<]+)<\/a>/gu;
  for (const match of html.matchAll(pattern)) {
    const detailUrl = new URL(decodeEntities(match[1]), OFFICIAL_ORIGIN);
    if (detailUrl.origin !== OFFICIAL_ORIGIN)
      throw new Error("official catalog linked off origin");
    entries.push({
      detailUrl: detailUrl.toString(),
      officialName: decodeEntities(match[2].trim()),
    });
  }
  if (entries.length === 0)
    throw new Error("official catalog contained no services");
  return entries;
}

function parseOfficialDetail(html, entry) {
  const samplePath = html.match(/name="apiTestUrl"\s+value="([^"]+)"/u)?.[1];
  const modifiedDate = html.match(
    /<dt>최근 수정일<\/dt>\s*<dd>([^<]+)<\/dd>/u,
  )?.[1];
  const encodedContract = html.match(/var bld = '([^']+)'/u)?.[1];
  if (!samplePath || !modifiedDate || !encodedContract) {
    throw new Error(
      `official service detail could not be parsed: ${entry.detailUrl}`,
    );
  }
  const xml = Buffer.from(encodedContract, "base64").toString("utf8");
  return {
    path: samplePath.replace("/svc/sample/apis/", "/svc/apis/"),
    officialName: entry.officialName,
    detailUrl: entry.detailUrl,
    modifiedDate: modifiedDate.trim(),
    requestFields: parseFields(xml, "input"),
    responseFields: parseFields(xml, "output"),
  };
}

function parseFields(xml, section) {
  const body =
    xml.match(
      new RegExp(`<${section}>([\\s\\S]*?)<\\/${section}>`, "u"),
    )?.[1] ?? "";
  return [...body.matchAll(/<field\b([^>]*?)(?:\/>|>)/gu)].flatMap((match) => {
    const attributes = Object.fromEntries(
      [...(match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/gu)].map((item) => [
        item[1],
        decodeEntities(item[2]),
      ]),
    );
    return attributes.name && attributes.type
      ? [{ name: attributes.name, type: attributes.type }]
      : [];
  });
}

function compareOfficialRegistry(maintained, official) {
  const officialByPath = new Map(official.map((entry) => [entry.path, entry]));
  const maintainedPaths = new Set(maintained.map(({ path }) => path));
  const counts = new Map();
  for (const entry of official)
    counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
  const endpoints = maintained.flatMap((operation) => {
    const observed = officialByPath.get(operation.path);
    if (!observed) return [];
    const request = compareFields(
      operation.requestFields,
      observed.requestFields,
    );
    const response = compareFields(
      operation.responseFields,
      observed.responseFields,
    );
    return [
      {
        path: operation.path,
        officialName: observed.officialName,
        detailUrl: observed.detailUrl,
        maintainedModifiedDate: operation.modifiedDate,
        officialModifiedDate: observed.modifiedDate,
        modifiedDateChanged: operation.modifiedDate !== observed.modifiedDate,
        request,
        response,
      },
    ];
  });
  const addedServices = [...officialByPath.keys()]
    .filter((path) => !maintainedPaths.has(path))
    .sort();
  const missingServices = [...maintainedPaths]
    .filter((path) => !officialByPath.has(path))
    .sort();
  const duplicateOfficialPaths = [...counts]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort();
  const endpointDrift = endpoints.some(
    (entry) =>
      entry.modifiedDateChanged ||
      hasFieldDrift(entry.request) ||
      hasFieldDrift(entry.response),
  );
  return {
    catalogUrl: CATALOG_URL,
    officialServiceCount: official.length,
    maintainedServiceCount: maintained.length,
    addedServices,
    missingServices,
    duplicateOfficialPaths,
    endpoints,
    hasDrift:
      endpointDrift ||
      addedServices.length > 0 ||
      missingServices.length > 0 ||
      duplicateOfficialPaths.length > 0,
  };
}

function compareFields(maintained, official) {
  const maintainedByName = new Map(
    maintained.map((field) => [field.name, field.type]),
  );
  const officialByName = new Map();
  for (const field of official) {
    const types = officialByName.get(field.name) ?? new Set();
    types.add(field.type);
    officialByName.set(field.name, types);
  }
  return {
    addedInOfficial: [...officialByName.keys()]
      .filter((name) => !maintainedByName.has(name))
      .sort(),
    missingFromOfficial: [...maintainedByName.keys()]
      .filter((name) => !officialByName.has(name))
      .sort(),
    changedTypes: [...maintainedByName]
      .filter(
        ([name, type]) =>
          officialByName.has(name) && !officialByName.get(name).has(type),
      )
      .map(([name, maintainedType]) => ({
        name,
        maintainedType,
        officialTypes: [...officialByName.get(name)].sort(),
      })),
  };
}

function hasFieldDrift(value) {
  return (
    value.addedInOfficial.length > 0 ||
    value.missingFromOfficial.length > 0 ||
    value.changedTypes.length > 0
  );
}

function decodeEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
