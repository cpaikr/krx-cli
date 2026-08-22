import type { ContractField, OfficialEndpointSpec } from "./types.js";
import { OPENAPI_WIRE } from "./generated/openapi-registry.js";

export const KRX_OFFICIAL_ORIGIN = "https://openapi.krx.co.kr";
export const KRX_SERVICE_CATALOG_URL = `${KRX_OFFICIAL_ORIGIN}/contents/OPP/INFO/service/OPPINFO004.cmd`;
const OFFICIAL_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_OFFICIAL_SERVICE_DETAILS = 64;

interface CatalogEntry {
  readonly detailUrl: string;
  readonly officialName: string;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

export function parseServiceCatalog(html: string): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const linkPattern =
    /href="([^"]*\/OPPUSES\d+_S2\.cmd\?BO_ID=[^"]+)"\s+class="link">([^<]+)<\/a>/g;

  for (const match of html.matchAll(linkPattern)) {
    const href = match[1];
    const name = match[2];
    if (!href || !name) continue;
    const detailUrl = new URL(decodeEntities(href), KRX_OFFICIAL_ORIGIN);
    if (detailUrl.origin !== KRX_OFFICIAL_ORIGIN) {
      throw new Error("Official KRX catalog linked to a non-KRX origin");
    }
    entries.push({
      detailUrl: detailUrl.toString(),
      officialName: decodeEntities(name.trim()),
    });
  }

  if (entries.length === 0) {
    throw new Error("Official KRX service catalog contained no service links");
  }
  return entries;
}

function attributes(source: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([\w-]+)="([^"]*)"/g)) {
    const name = match[1];
    const value = match[2];
    if (name && value !== undefined) result[name] = decodeEntities(value);
  }
  return result;
}

function parseFields(
  xml: string,
  section: "input" | "output",
): ContractField[] {
  const sectionBody = xml.match(
    new RegExp(`<${section}>([\\s\\S]*?)<\\/${section}>`),
  )?.[1];
  if (!sectionBody) return [];

  const fields: ContractField[] = [];
  for (const match of sectionBody.matchAll(/<field\b([^>]*?)(?:\/>|>)/g)) {
    const field = attributes(match[1] ?? "");
    if (field["name"] && field["type"]) {
      fields.push({ name: field["name"], type: field["type"] });
    }
  }
  return fields;
}

export function parseServiceDetail(
  html: string,
  catalogEntry: CatalogEntry,
): OfficialEndpointSpec {
  const samplePath = html.match(/name="apiTestUrl"\s+value="([^"]+)"/)?.[1];
  const modifiedDate = html.match(
    /<dt>최근 수정일<\/dt>\s*<dd>([^<]+)<\/dd>/,
  )?.[1];
  const encodedContract = html.match(/var bld = '([^']+)'/)?.[1];

  if (!samplePath || !modifiedDate || !encodedContract) {
    throw new Error(
      `Official KRX service detail could not be parsed: ${catalogEntry.detailUrl}`,
    );
  }

  const xml = Buffer.from(encodedContract, "base64").toString("utf8");
  const requestFields = parseFields(xml, "input");
  const responseFields = parseFields(xml, "output");
  if (requestFields.length === 0 || responseFields.length === 0) {
    throw new Error(
      `Official KRX contract contained no input or output fields: ${catalogEntry.detailUrl}`,
    );
  }

  const path = samplePath.replace(
    "/svc/sample/apis/",
    OPENAPI_WIRE.providerPathPrefix,
  );
  if (!path.startsWith(OPENAPI_WIRE.providerPathPrefix)) {
    throw new Error(
      `Official KRX service path was outside ${OPENAPI_WIRE.providerPathPrefix}: ${catalogEntry.detailUrl}`,
    );
  }

  return {
    path,
    officialName: catalogEntry.officialName,
    modifiedDate: modifiedDate.trim(),
    detailUrl: catalogEntry.detailUrl,
    requestFields,
    responseFields,
  };
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { Accept: "text/html; charset=utf-8" },
    signal: AbortSignal.timeout(OFFICIAL_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Official KRX specification returned HTTP ${response.status}: ${url}`,
    );
  }
  return response.text();
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        output[index] = await task(values[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

export async function fetchOfficialRegistry(
  fetchImpl: typeof fetch = fetch,
): Promise<readonly OfficialEndpointSpec[]> {
  const catalog = parseServiceCatalog(
    await fetchText(KRX_SERVICE_CATALOG_URL, fetchImpl),
  );
  if (catalog.length > MAX_OFFICIAL_SERVICE_DETAILS) {
    throw new Error(
      `Official KRX catalog exceeded the ${MAX_OFFICIAL_SERVICE_DETAILS}-service safety limit`,
    );
  }
  return mapWithConcurrency(catalog, 4, async (entry) =>
    parseServiceDetail(await fetchText(entry.detailUrl, fetchImpl), entry),
  );
}
