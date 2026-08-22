import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import prettier from "prettier";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const openapiPath = resolve(
  root,
  argument("--openapi") ?? "contracts/krx/openapi.yaml",
);
const legacyOraclePath = resolve(
  root,
  argument("--oracle") ?? "tests/compat/oracles/schema-all.json",
);
const evidencePath = resolve(
  root,
  argument("--evidence") ?? "contracts/krx/reviewed-evidence.json",
);
const registryPath = resolve(
  root,
  argument("--registry") ?? "src/contracts/generated/openapi-registry.ts",
);
const capabilitiesPath = resolve(
  root,
  argument("--capabilities") ?? "contracts/generated/capabilities.json",
);
const explicitSourceRoot = argument("--source-root");
const sourceRoots = explicitSourceRoot
  ? [resolve(root, explicitSourceRoot)]
  : ["src", "scripts", "probes", "packages", "crates"].map((path) =>
      resolve(root, path),
    );
const write = process.argv.includes("--write");
const skipArtifacts = process.argv.includes("--skip-artifacts");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, location) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${location} must be an object`,
  );
  return value;
}

function resolveSchema(document, schema, location) {
  const candidate = object(schema, location);
  if (!("$ref" in candidate)) return candidate;
  equalKeys(
    candidate,
    ["$ref"],
    `${location} schema reference must not have sibling behavior`,
  );
  invariant(
    typeof candidate.$ref === "string" &&
      candidate.$ref.startsWith("#/components/schemas/"),
    `${location} must use a local schema reference`,
  );
  const name = candidate.$ref.slice("#/components/schemas/".length);
  return object(document.components?.schemas?.[name], candidate.$ref);
}

function equal(actual, expected, message) {
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\nexpected ${JSON.stringify(expected)}\nreceived ${JSON.stringify(actual)}`,
  );
}

function equalKeys(value, expected, message) {
  equal(Object.keys(value).sort(), [...expected].sort(), message);
}

async function sourceFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && /\.(?:ts|js|mjs|rs)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const openapiSource = await readFile(openapiPath, "utf8");
const document = YAML.parse(openapiSource);
const legacyOracle = JSON.parse(await readFile(legacyOraclePath, "utf8"));
const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
equalKeys(
  document,
  [
    "openapi",
    "info",
    "servers",
    "x-krx-content-type",
    "security",
    "tags",
    "paths",
    "components",
  ],
  "OpenAPI root must not expose unsupported API surfaces",
);
equalKeys(
  object(document.components, "components"),
  ["securitySchemes", "schemas"],
  "OpenAPI components must stay bounded",
);
equal(evidence.version, 1, "reviewed evidence version must stay frozen");
equal(
  evidence.role,
  "non-authoritative-reviewed-evidence",
  "reviewed evidence must remain explicitly non-authoritative",
);
invariant(
  /^\d{4}-\d{2}-\d{2}$/u.test(evidence.reviewedAt),
  "reviewed evidence must record an ISO review date",
);
const wireEvidence = object(evidence.sharedWire, "reviewedEvidence.sharedWire");
const digest = createHash("sha256").update(openapiSource).digest("hex");

equal(document.openapi, "3.1.1", "OpenAPI version must stay frozen");
equal(
  document.servers,
  [{ url: wireEvidence.serverUrl }],
  "KRX server must stay exact",
);
equal(
  document["x-krx-content-type"],
  wireEvidence.requestContentType,
  "KRX request content type must stay exact",
);
equal(document.security, [{ KrxApiKey: [] }], "root security must stay exact");
equal(
  document.components?.securitySchemes?.KrxApiKey,
  {
    type: "apiKey",
    in: "header",
    name: wireEvidence.authHeaderName,
    description:
      "KRX Open API credential. Never log or persist in contract evidence.",
  },
  "KRX security scheme must match reviewed evidence",
);

const pathEntries = Object.entries(object(document.paths, "paths"));
invariant(pathEntries.length === 31, "OpenAPI must define exactly 31 paths");
invariant(
  legacyOracle.length === 31,
  "legacy oracle must remain frozen at 31 operations",
);
const firstPathParts = pathEntries[0][0].split("/");
invariant(
  firstPathParts.length >= 4 && firstPathParts[0] === "",
  "OpenAPI paths must use an absolute provider prefix",
);
const providerPathPrefix = `/${firstPathParts[1]}/${firstPathParts[2]}/`;

const methodKey = String(wireEvidence.method).toLowerCase();
const requestMediaType = wireEvidence.requestMediaType;
const requestDateField = wireEvidence.requestDateField;
const successEnvelopeField = wireEvidence.successEnvelopeField;
const errorSchema = object(
  document.components?.schemas?.KrxError,
  "components.schemas.KrxError",
);
equalKeys(
  errorSchema,
  ["type", "description", "anyOf", "properties", "additionalProperties"],
  "KRX error envelope must not add unsupported schema behavior",
);
equal(errorSchema.type, "object", "KRX error envelope must be an object");
equal(
  errorSchema.additionalProperties,
  true,
  "KRX error envelope must tolerate undocumented provider fields",
);
const errorProperties = object(
  errorSchema.properties,
  "components.schemas.KrxError.properties",
);
equal(
  Object.keys(errorProperties).length,
  2,
  "KRX error envelope must expose exactly the reviewed code and message fields",
);
const errorRoles = Object.values(errorProperties).map((value, index) => {
  const property = object(
    value,
    `components.schemas.KrxError.property${index}`,
  );
  return property["x-krx-error-role"];
});
equal(
  [...errorRoles].sort(),
  ["code", "message"],
  "KRX error roles must be unique and complete",
);
const errorFields = Object.fromEntries(
  Object.entries(errorProperties).map(([name, value]) => {
    const property = object(value, `components.schemas.KrxError.${name}`);
    equalKeys(
      property,
      ["type", "description", "x-krx-error-role"],
      `${name} provider error field schema must stay bounded`,
    );
    equal(
      property.type,
      "string",
      `${name} provider error field must be a string`,
    );
    invariant(
      property["x-krx-error-role"] === "code" ||
        property["x-krx-error-role"] === "message",
      `${name} must have a unique KRX error role`,
    );
    return [property["x-krx-error-role"], name];
  }),
);
equal(
  errorFields,
  wireEvidence.errorFields,
  "KRX error fields must match reviewed evidence",
);
equal(
  errorSchema.anyOf,
  [{ required: [errorFields.code] }, { required: [errorFields.message] }],
  "KRX error envelope must require a code or message",
);

const operationIds = new Set();
const operations = [];
for (const [path, pathItemValue] of pathEntries) {
  invariant(
    path.startsWith(providerPathPrefix),
    `unsupported provider path: ${path}`,
  );
  const pathItem = object(pathItemValue, `paths.${path}`);
  equal(
    Object.keys(pathItem),
    [methodKey],
    `${path} must expose ${wireEvidence.method} only`,
  );
  const operation = object(pathItem[methodKey], `${path}.${methodKey}`);
  invariant(
    !("security" in operation),
    `${operation.operationId ?? path} must inherit root security`,
  );
  invariant(
    !("servers" in operation),
    `${operation.operationId ?? path} must inherit the root server`,
  );
  invariant(
    !("parameters" in operation),
    `${operation.operationId ?? path} must use its JSON request body only`,
  );
  equalKeys(
    operation,
    [
      "operationId",
      "tags",
      "summary",
      "description",
      "x-krx-cli-command",
      "x-krx-official-modified",
      "requestBody",
      "responses",
    ],
    `${operation.operationId ?? path} must not add unsupported operation behavior`,
  );
  invariant(
    typeof operation.operationId === "string" &&
      operation.operationId.length > 0,
    `${path} must define operationId`,
  );
  invariant(
    !operationIds.has(operation.operationId),
    `duplicate operationId: ${operation.operationId}`,
  );
  operationIds.add(operation.operationId);
  invariant(
    Array.isArray(operation.tags) && operation.tags.length === 1,
    `${operation.operationId} must have exactly one category tag`,
  );
  invariant(
    /^\d{4}\/\d{2}\/\d{2}$/u.test(operation["x-krx-official-modified"]),
    `${operation.operationId} must record its reviewed official modification date`,
  );

  const requestBody = object(
    operation.requestBody,
    `${operation.operationId}.requestBody`,
  );
  equalKeys(
    requestBody,
    ["required", "content"],
    `${operation.operationId} request body must stay bounded`,
  );
  equal(
    requestBody.required,
    true,
    `${operation.operationId} request body must be required`,
  );
  equal(
    Object.keys(
      object(
        requestBody.content,
        `${operation.operationId}.requestBody.content`,
      ),
    ),
    [requestMediaType],
    `${operation.operationId} must accept JSON only`,
  );
  const requestSchema = resolveSchema(
    document,
    requestBody.content[requestMediaType].schema,
    `${operation.operationId}.request`,
  );
  equalKeys(
    object(
      requestBody.content[requestMediaType],
      `${operation.operationId}.requestBody.mediaType`,
    ),
    ["schema"],
    `${operation.operationId} request media type must stay bounded`,
  );
  equalKeys(
    requestSchema,
    ["type", "additionalProperties", "required", "properties"],
    `${operation.operationId} request schema must stay bounded`,
  );
  equal(
    requestSchema.required,
    [requestDateField],
    `${operation.operationId} must require its reviewed date field`,
  );
  equal(
    requestSchema.additionalProperties,
    false,
    `${operation.operationId} request must be closed`,
  );
  equal(
    Object.keys(
      object(
        requestSchema.properties,
        `${operation.operationId}.request.properties`,
      ),
    ),
    [requestDateField],
    `${operation.operationId} must accept only its reviewed request field`,
  );
  equal(
    requestSchema.properties?.[requestDateField],
    {
      type: "string",
      pattern: "^[0-9]{8}$",
      description: "Trading date in YYYYMMDD format",
    },
    `${operation.operationId} date-field contract must stay exact`,
  );

  const responses = object(
    operation.responses,
    `${operation.operationId}.responses`,
  );
  equal(
    Object.keys(responses),
    ["200", "default"],
    `${operation.operationId} responses must stay bounded`,
  );
  const successResponseContent = object(
    responses["200"]?.content,
    `${operation.operationId}.responses.200.content`,
  );
  equalKeys(
    object(responses["200"], `${operation.operationId}.responses.200`),
    ["description", "content"],
    `${operation.operationId} HTTP-200 response must stay bounded`,
  );
  equal(
    Object.keys(successResponseContent),
    [requestMediaType],
    `${operation.operationId} must return the reviewed JSON media type only`,
  );
  const responseSchema = object(
    successResponseContent[requestMediaType]?.schema,
    `${operation.operationId}.responses.200.schema`,
  );
  equalKeys(
    responseSchema,
    ["oneOf"],
    `${operation.operationId} response composition must stay bounded`,
  );
  equalKeys(
    object(
      successResponseContent[requestMediaType],
      `${operation.operationId}.responses.200.mediaType`,
    ),
    ["schema"],
    `${operation.operationId} response media type must stay bounded`,
  );
  equal(
    responseSchema?.oneOf?.length,
    2,
    `${operation.operationId} must model success and provider-error envelopes`,
  );
  const successChoice = responseSchema.oneOf[0];
  const providerErrorChoice = responseSchema.oneOf[1];
  invariant(
    resolveSchema(
      document,
      providerErrorChoice,
      `${operation.operationId}.responses.200.error`,
    ) === errorSchema,
    `${operation.operationId} must use the canonical KRX error envelope`,
  );
  const defaultResponse = object(
    responses.default,
    `${operation.operationId}.responses.default`,
  );
  equal(
    Object.keys(defaultResponse),
    ["description"],
    `${operation.operationId} default response body must remain optional and opaque`,
  );
  invariant(
    typeof defaultResponse.description === "string" &&
      defaultResponse.description.length > 0,
    `${operation.operationId} default response needs a description`,
  );
  const successSchema = resolveSchema(
    document,
    successChoice,
    `${operation.operationId}.responses.200.success`,
  );
  equalKeys(
    successSchema,
    ["type", "additionalProperties", "required", "properties"],
    `${operation.operationId} success envelope must stay bounded`,
  );
  equal(
    successSchema.required,
    [successEnvelopeField],
    `${operation.operationId} must require its reviewed success envelope`,
  );
  equal(
    successSchema.additionalProperties,
    false,
    `${operation.operationId} success envelope must be closed`,
  );
  equal(
    Object.keys(
      object(
        successSchema.properties,
        `${operation.operationId}.success.properties`,
      ),
    ),
    [successEnvelopeField],
    `${operation.operationId} success envelope must expose only the reviewed field`,
  );
  const successEnvelopeProperty = object(
    successSchema.properties?.[successEnvelopeField],
    `${operation.operationId}.success.${successEnvelopeField}`,
  );
  equalKeys(
    successEnvelopeProperty,
    ["type", "items"],
    `${operation.operationId} success-envelope container must stay bounded`,
  );
  equal(
    successEnvelopeProperty.type,
    "array",
    `${operation.operationId} success envelope must contain an array`,
  );
  const rowSchema = resolveSchema(
    document,
    successEnvelopeProperty.items,
    `${operation.operationId}.row`,
  );
  equalKeys(
    rowSchema,
    ["type", "additionalProperties", "required", "properties"],
    `${operation.operationId} row schema must stay bounded`,
  );
  equal(
    rowSchema.type,
    "object",
    `${operation.operationId} row must be an object`,
  );
  equal(
    rowSchema.additionalProperties,
    false,
    `${operation.operationId} row must be closed`,
  );
  const rowProperties = object(
    rowSchema.properties,
    `${operation.operationId}.row.properties`,
  );
  const responseFields = Object.entries(rowProperties).map(([name, value]) => {
    const field = object(value, `${operation.operationId}.row.${name}`);
    equalKeys(
      field,
      ["type", "description"],
      `${operation.operationId}.${name} field schema must stay bounded`,
    );
    equal(
      field.type,
      "string",
      `${operation.operationId}.${name} must be a string`,
    );
    invariant(
      typeof field.description === "string" && field.description.length > 0,
      `${operation.operationId}.${name} needs a description`,
    );
    return { name, description: field.description };
  });
  equal(
    rowSchema.required,
    responseFields.map(({ name }) => name),
    `${operation.operationId} must require every known row field`,
  );

  const legacyCommand = operation["x-krx-cli-command"];
  invariant(
    typeof legacyCommand === "string" && legacyCommand.length > 0,
    `${operation.operationId} needs its legacy schema command`,
  );
  operations.push({
    operationId: operation.operationId,
    path,
    description: operation.summary,
    descriptionKo: operation.description,
    category: operation.tags[0],
    legacyCommand,
    reviewedOfficialModified: operation["x-krx-official-modified"],
    requestFields: [{ name: requestDateField, type: "string", required: true }],
    responseFields,
  });
}

const oracleProjection = operations.map((operation) => ({
  command: operation.legacyCommand,
  endpoint: operation.path,
  description: operation.description,
  descriptionKo: operation.descriptionKo,
  category: operation.category,
  params: [
    {
      name: requestDateField,
      type: "string",
      required: true,
      description: "Trading date in YYYYMMDD format",
    },
  ],
  responseFields: operation.responseFields,
}));
const legacyWireOracle = legacyOracle.map((entry) => ({
  command: entry.command,
  endpoint: entry.endpoint,
  description: entry.description,
  descriptionKo: entry.descriptionKo,
  category: entry.category,
  params: entry.params,
  responseFields: entry.responseFields,
}));
equal(
  oracleProjection,
  legacyWireOracle,
  "canonical OpenAPI projection must match the frozen legacy schema oracle",
);

const allowedWireConsumers = new Set([
  registryPath,
  resolve(root, "src/contracts/generated/openapi-registry.ts"),
  resolve(root, "scripts/contracts.mjs"),
  resolve(root, "scripts/compat-judge.mjs"),
]);
const sharedWireValues = [
  wireEvidence.serverUrl,
  wireEvidence.authHeaderName,
  wireEvidence.requestContentType,
  requestDateField,
  successEnvelopeField,
  errorFields.code,
  errorFields.message,
  providerPathPrefix,
];
for (const sourceRoot of sourceRoots) {
  for (const path of await sourceFiles(sourceRoot)) {
    if (allowedWireConsumers.has(path)) continue;
    const source = await readFile(path, "utf8");
    invariant(
      !/["']\/svc\/apis\/(?:idx|sto|etp|bon|drv|gen|esg)\//u.test(source),
      `handwritten provider endpoint literal is forbidden outside OpenAPI projections: ${path}`,
    );
    for (const value of sharedWireValues) {
      invariant(
        !source.includes(value),
        `handwritten shared wire fact ${JSON.stringify(value)} is forbidden outside OpenAPI projections: ${path}`,
      );
    }
  }
}

const endpointProjection = operations.map((operation) => ({
  path: operation.path,
  legacyCommand: operation.legacyCommand,
  description: operation.description,
  descriptionKo: operation.descriptionKo,
  category: operation.category,
  requestFields: operation.requestFields,
  responseFields: operation.responseFields,
}));
const modifiedDates = Object.fromEntries(
  operations.map(({ path, reviewedOfficialModified }) => [
    path,
    reviewedOfficialModified,
  ]),
);
const operationPaths = Object.fromEntries(
  operations.map(({ operationId, path }) => [operationId, path]),
);
const registry = await prettier.format(
  `/* Generated by scripts/contracts.mjs from contracts/krx/openapi.yaml.\n * Do not edit: OpenAPI is the sole maintained provider-wire authority.\n */\n\nexport const OPENAPI_CONTRACT_SHA256 = ${JSON.stringify(digest)};\n\nexport const OPENAPI_WIRE = ${JSON.stringify(
    {
      serverUrl: document.servers[0].url,
      method: wireEvidence.method,
      providerPathPrefix,
      authHeaderName: document.components.securitySchemes.KrxApiKey.name,
      requestContentType: document["x-krx-content-type"],
      requestDateField,
      successEnvelopeField,
      errorCodeField: errorFields.code,
      errorMessageField: errorFields.message,
    },
    null,
    2,
  )} as const;\n\nexport const OPENAPI_ENDPOINTS = ${JSON.stringify(endpointProjection, null, 2)} as const;\n\nexport const OPENAPI_OPERATION_PATHS = ${JSON.stringify(operationPaths, null, 2)} as const;\n\nexport const OPENAPI_OFFICIAL_MODIFIED_DATES = ${JSON.stringify(modifiedDates, null, 2)} as const;\n`,
  { parser: "typescript" },
);
const capabilities = `${JSON.stringify(
  {
    version: 1,
    generatedFrom: "contracts/krx/openapi.yaml",
    openapiSha256: digest,
    operations: operations.map((operation) => ({
      operationId: operation.operationId,
      path: operation.path,
      description: operation.description,
      descriptionKo: operation.descriptionKo,
      category: operation.category,
      legacyCommand: operation.legacyCommand,
      requestFields: operation.requestFields,
      responseFields: operation.responseFields,
    })),
  },
  null,
  2,
)}\n`;

async function emit(path, expected) {
  if (write) {
    await writeFile(path, expected, "utf8");
    return;
  }
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    throw new Error(`generated contract artifact is missing: ${path}`);
  }
  invariant(
    actual === expected,
    `generated contract artifact is stale: ${path}`,
  );
}

if (!skipArtifacts) {
  await emit(registryPath, registry);
  await emit(capabilitiesPath, capabilities);
}
process.stdout.write(
  `${write ? "wrote" : "validated"} 31 KRX operations (${digest.slice(0, 12)})\n`,
);
