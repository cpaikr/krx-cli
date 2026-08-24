import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

import prettier from "prettier";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const prettierConfig =
  (await prettier.resolveConfig(import.meta.filename, {
    editorconfig: true,
  })) ?? {};

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function pathArgument(name, fallback) {
  return resolve(root, argument(name) ?? fallback);
}

const paths = {
  openapi: pathArgument("--openapi", "contracts/krx/openapi.yaml"),
  profile: pathArgument("--profile", "contracts/product/v1/profile.yaml"),
  errors: pathArgument("--errors", "contracts/product/v1/errors.yaml"),
  overlay: pathArgument("--overlay", "contracts/product/v1/cli-overlay.json"),
  cliCases: pathArgument("--cli-cases", "contracts/product/v1/cli-cases.json"),
  inventory: pathArgument("--inventory", "tests/compat/command-inventory.json"),
  nodeContract: pathArgument(
    "--node-contract",
    "contracts/product/v1/node-sdk.d.ts",
  ),
  rustContract: pathArgument(
    "--rust-contract",
    "contracts/product/v1/rust-sdk-consumer.rs",
  ),
  nodePackage: pathArgument(
    "--node-package",
    "contracts/product/v1/node-package-surface.json",
  ),
  nativeTargets: pathArgument(
    "--native-targets",
    "contracts/product/v1/native-targets.json",
  ),
  migrations: pathArgument(
    "--migrations",
    "contracts/product/v1/migrations.yaml",
  ),
  fixtures: pathArgument(
    "--fixtures",
    "contracts/product/v1/fixtures/manifest.yaml",
  ),
  runtimeCases: pathArgument(
    "--runtime-cases",
    "contracts/product/v1/consumers/node-runtime-cases.json",
  ),
  stateSchemaRoot: pathArgument(
    "--state-schema-root",
    "contracts/product/v1/state",
  ),
  product: pathArgument(
    "--product-artifact",
    "contracts/generated/product-v1.json",
  ),
  nodeOperations: pathArgument(
    "--node-operations",
    "contracts/generated/node-operations.d.ts",
  ),
  nodeErrors: pathArgument(
    "--node-errors",
    "contracts/generated/error-types.d.ts",
  ),
  rustOperations: pathArgument(
    "--rust-operations",
    "contracts/generated/operation-id.rs",
  ),
  candidateInventory: pathArgument(
    "--candidate-inventory",
    "contracts/generated/candidate-command-inventory.json",
  ),
  cliOptionMatrix: pathArgument(
    "--cli-option-matrix",
    "contracts/generated/cli-option-matrix.json",
  ),
  cacheV1Schema: pathArgument(
    "--cache-v1-schema",
    "contracts/generated/state/cache-v1.schema.json",
  ),
  cacheV2Schema: pathArgument(
    "--cache-v2-schema",
    "contracts/generated/state/cache-v2.schema.json",
  ),
};
const write = process.argv.includes("--write");
const skipArtifacts = process.argv.includes("--skip-artifacts");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  invariant(
    canonicalJson(actual) === canonicalJson(expected),
    `${message}\nexpected ${JSON.stringify(expected)}\nreceived ${JSON.stringify(actual)}`,
  );
}

function object(value, location) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${location} must be an object`,
  );
  return value;
}

function equalKeys(value, expected, location) {
  equal(
    Object.keys(object(value, location)).sort(),
    [...expected].sort(),
    `${location} must have exact keys`,
  );
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

async function formattedJson(value, filepath) {
  return prettier.format(JSON.stringify(value, null, 2), {
    ...prettierConfig,
    filepath,
    parser: "json",
  });
}

function dereference(document, value) {
  if (Array.isArray(value))
    return value.map((entry) => dereference(document, entry));
  if (value === null || typeof value !== "object") return value;
  if (typeof value.$ref === "string") {
    invariant(
      Object.keys(value).length === 1 &&
        value.$ref.startsWith("#/components/schemas/"),
      `cannot digest unsupported OpenAPI reference ${value.$ref}`,
    );
    return dereference(
      document,
      object(
        document.components?.schemas?.[
          value.$ref.slice("#/components/schemas/".length)
        ],
        value.$ref,
      ),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      dereference(document, child),
    ]),
  );
}

function localSchema(document, schema, location) {
  const candidate = object(schema, location);
  if (!("$ref" in candidate)) return candidate;
  equalKeys(candidate, ["$ref"], location);
  invariant(
    typeof candidate.$ref === "string" &&
      candidate.$ref.startsWith("#/components/schemas/"),
    `${location} must use a local OpenAPI schema reference`,
  );
  return object(
    document.components?.schemas?.[
      candidate.$ref.slice("#/components/schemas/".length)
    ],
    candidate.$ref,
  );
}

function pascalCase(value) {
  return value
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

const [
  openapiSource,
  profileSource,
  errorsSource,
  overlaySource,
  inventorySource,
] = await Promise.all([
  readFile(paths.openapi, "utf8"),
  readFile(paths.profile, "utf8"),
  readFile(paths.errors, "utf8"),
  readFile(paths.overlay, "utf8"),
  readFile(paths.inventory, "utf8"),
]);
const document = YAML.parse(openapiSource);
const profile = YAML.parse(profileSource);
const errors = YAML.parse(errorsSource);
const overlay = JSON.parse(overlaySource);
const cliCasesSource = await readFile(paths.cliCases, "utf8");
const cliCases = JSON.parse(cliCasesSource);
const inventory = JSON.parse(inventorySource);
const nodePackageSource = await readFile(paths.nodePackage, "utf8");
const nodePackage = JSON.parse(nodePackageSource);
const nativeTargetsSource = await readFile(paths.nativeTargets, "utf8");
const nativeTargets = JSON.parse(nativeTargetsSource);
const migrationsSource = await readFile(paths.migrations, "utf8");
const migrations = YAML.parse(migrationsSource);
const fixturesSource = await readFile(paths.fixtures, "utf8");
const fixtureManifest = YAML.parse(fixturesSource);
const runtimeCasesSource = await readFile(paths.runtimeCases, "utf8");
const runtimeCases = JSON.parse(runtimeCasesSource);

const operations = [];
const requestFieldsByOperation = new Map();
for (const [providerPath, pathItemValue] of Object.entries(
  object(document.paths, "openapi.paths"),
)) {
  const operation = object(pathItemValue.post, `${providerPath}.post`);
  const operationId = operation.operationId;
  invariant(
    typeof operationId === "string",
    `${providerPath} needs operationId`,
  );
  const response = object(
    operation.responses?.["200"]?.content?.["application/json"]?.schema,
    `${operationId}.response`,
  );
  const requestSchema = dereference(
    document,
    operation.requestBody?.content?.["application/json"]?.schema,
  );
  const requestProperties = object(
    requestSchema.properties,
    `${operationId}.request.properties`,
  );
  const requestRequired = new Set(requestSchema.required ?? []);
  const requestFields = Object.entries(requestProperties)
    .map(([name, fieldValue]) => {
      const field = object(fieldValue, `${operationId}.request.${name}`);
      return {
        name,
        type: field.type,
        required: requestRequired.has(name),
        description: field.description,
        schema: cloneJson(field),
      };
    })
    .sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
  equal(
    new Set(requestSchema.required ?? []).size,
    requestSchema.required?.length ?? 0,
    `${operationId} request required names must be unique`,
  );
  equal(
    requestFields.filter(({ required }) => required).length,
    requestFields.length,
    `${operationId} cache identity requires every request field`,
  );
  requestFieldsByOperation.set(operationId, requestFields);
  const responseSchema = dereference(document, response);
  invariant(
    Array.isArray(response.oneOf) && response.oneOf.length === 2,
    `${operationId} must have the canonical success/error response`,
  );
  const envelope = localSchema(
    document,
    response.oneOf[0],
    `${operationId}.success`,
  );
  const rows = object(envelope.properties?.OutBlock_1, `${operationId}.rows`);
  const row = localSchema(document, rows.items, `${operationId}.row`);
  const responseFields = Object.entries(
    object(row.properties, `${operationId}.row.properties`),
  ).map(([name, fieldValue]) => {
    const field = object(fieldValue, `${operationId}.${name}`);
    return { name, description: field.description };
  });
  operations.push({
    operationId,
    path: providerPath,
    category: operation.tags[0],
    description: operation.summary,
    descriptionKo: operation.description,
    legacyCommand: operation["x-krx-cli-command"],
    requestFields: requestFields.map(({ name, type, required }) => ({
      name,
      type,
      required,
    })),
    responseFields,
    contractId: sha256(
      canonicalJson({ operationId, requestSchema, responseSchema }),
    ),
  });
}
invariant(
  operations.length === 31,
  "product contract requires 31 OpenAPI operations",
);
const operationIds = operations.map(({ operationId }) => operationId);
invariant(
  new Set(operationIds).size === 31,
  "OpenAPI operation IDs must be unique",
);
const operationIdSet = new Set(operationIds);

equalKeys(
  profile,
  [
    "schemaVersion",
    "id",
    "wireSource",
    "direct",
    "operationSets",
    "approvalProbes",
    "composites",
    "defaults",
    "provenance",
  ],
  "profile",
);
equal(profile.schemaVersion, 1, "profile schemaVersion must be 1");
equal(profile.id, "krx-product/v1", "profile id must stay versioned");
equal(
  profile.wireSource,
  "../../krx/openapi.yaml",
  "profile wire source must be canonical",
);
equalKeys(
  profile.direct,
  ["operations", "requestDate", "emptyRows", "range"],
  "profile.direct",
);
equal(
  profile.direct.operations,
  { $openapi: "all" },
  "profile must derive every direct operation from OpenAPI",
);
equal(
  profile.direct.requestDate,
  "basDd",
  "profile request date must match OpenAPI",
);
equal(profile.direct.emptyRows, "success", "direct empty rows must be success");
equalKeys(
  profile.direct.range,
  ["calendar", "completeness"],
  "profile.direct.range",
);

function assertOperationReference(value, location) {
  invariant(
    typeof value === "string" && operationIdSet.has(value),
    `${location} must reference an OpenAPI operationId`,
  );
}

equalKeys(
  profile.operationSets,
  ["adjustedDailyStock"],
  "profile.operationSets",
);
invariant(
  Array.isArray(profile.operationSets.adjustedDailyStock) &&
    profile.operationSets.adjustedDailyStock.length === 3 &&
    new Set(profile.operationSets.adjustedDailyStock).size === 3,
  "adjustedDailyStock must contain three unique operations",
);
for (const operationId of profile.operationSets.adjustedDailyStock) {
  assertOperationReference(operationId, "adjustedDailyStock");
}

const categories = [...new Set(operations.map(({ category }) => category))];
equal(
  Object.keys(object(profile.approvalProbes, "profile.approvalProbes")),
  categories,
  "approval probes must cover OpenAPI categories in canonical order",
);
for (const [category, operationId] of Object.entries(profile.approvalProbes)) {
  assertOperationReference(operationId, `approvalProbes.${category}`);
  equal(
    operations.find((operation) => operation.operationId === operationId)
      ?.category,
    category,
    `${category} approval probe must stay inside its category`,
  );
}

equalKeys(
  profile.composites,
  ["stockSearch", "watchlistPrices", "marketSummary"],
  "profile.composites",
);
for (const [name, value] of Object.entries(profile.composites)) {
  const composite = object(value, `profile.composites.${name}`);
  equalKeys(
    composite,
    name === "marketSummary" ? ["components", "topCount"] : ["components"],
    `profile.composites.${name}`,
  );
  const components = object(composite.components, `${name}.components`);
  invariant(
    Object.keys(components).length >= 2,
    `${name} needs multiple components`,
  );
  for (const [component, operationId] of Object.entries(components)) {
    assertOperationReference(operationId, `${name}.components.${component}`);
  }
}
equal(
  profile.composites.watchlistPrices.components,
  {
    KOSPI: "stock_stk_bydd_trd",
    KOSDAQ: "stock_ksq_bydd_trd",
    KONEX: "stock_knx_bydd_trd",
  },
  "watchlist prices must cover every persisted watchlist market",
);
invariant(
  Number.isSafeInteger(profile.composites.marketSummary.topCount) &&
    profile.composites.marketSummary.topCount > 0,
  "marketSummary.topCount must be a positive integer",
);

equalKeys(
  profile.defaults,
  [
    "retries",
    "attemptTimeoutMs",
    "overallTimeoutMs",
    "cacheMaxAgeHours",
    "quotaPerKstDay",
    "approvalTtlSeconds",
  ],
  "profile.defaults",
);
for (const [name, value] of Object.entries(profile.defaults)) {
  invariant(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive integer`,
  );
}
invariant(profile.defaults.retries <= 3, "default retries must not exceed 3");
invariant(
  profile.defaults.attemptTimeoutMs <= profile.defaults.overallTimeoutMs,
  "attempt timeout must not exceed overall timeout",
);

equalKeys(
  profile.provenance,
  ["observationScope", "sources", "freshness", "required", "contractId"],
  "profile.provenance",
);
equal(
  profile.provenance.observationScope,
  "every-present-observation",
  "provenance fields apply to every present direct or component observation",
);
equal(
  profile.provenance.sources,
  ["network", "cache"],
  "provenance sources must stay closed",
);
equal(
  profile.provenance.freshness,
  ["fresh", "stale"],
  "freshness must stay closed",
);
equal(
  profile.provenance.required,
  ["source", "fetchedAt", "freshness", "contractId"],
  "provenance fields must stay complete",
);
equal(
  profile.provenance.contractId,
  {
    algorithm: "sha256",
    encoding: "lowercase-hex",
    canonicalization: "RFC8785",
    document: ["operationId", "requestSchema", "responseSchema"],
  },
  "provenance contract identity must match cache schema identity",
);

equalKeys(
  errors,
  [
    "schemaVersion",
    "id",
    "publicFields",
    "kinds",
    "httpMappings",
    "responseMappings",
    "compositePriority",
    "resultExitPolicies",
  ],
  "errors",
);
equal(errors.schemaVersion, 1, "error schemaVersion must be 1");
equal(errors.id, "krx-errors/v1", "error id must stay versioned");
equalKeys(
  errors.publicFields,
  ["required", "optional", "forbidden"],
  "errors.publicFields",
);
equal(
  errors.publicFields.required,
  ["name", "kind", "code", "message", "retryable"],
  "public error fields must stay complete",
);
equal(
  errors.publicFields.optional,
  ["httpStatus", "providerCode", "operationId"],
  "optional public error fields must stay closed",
);
equal(
  errors.publicFields.forbidden,
  ["cause", "details", "rawBody", "dependencyMessage"],
  "forbidden public error fields must stay closed",
);
const kindEntries = Object.entries(object(errors.kinds, "errors.kinds"));
invariant(kindEntries.length > 0, "errors must define at least one kind");
const errorKinds = [];
const errorCodes = [];
const errorPairs = new Set();
for (const [kind, value] of kindEntries) {
  const contract = object(value, `errors.kinds.${kind}`);
  equalKeys(contract, ["cliExit", "codes"], `errors.kinds.${kind}`);
  invariant(
    Number.isSafeInteger(contract.cliExit) &&
      contract.cliExit >= 1 &&
      contract.cliExit <= 6,
    `${kind}.cliExit must be a stable failure exit`,
  );
  const codes = object(contract.codes, `${kind}.codes`);
  invariant(Object.keys(codes).length > 0, `${kind} must define codes`);
  errorKinds.push(kind);
  for (const [code, retryable] of Object.entries(codes)) {
    invariant(
      typeof retryable === "boolean",
      `${kind}/${code} retryability must be boolean`,
    );
    invariant(
      !errorPairs.has(code),
      `error code must be globally unique: ${code}`,
    );
    errorPairs.add(code);
    errorCodes.push(code);
  }
}
equal(
  [...errors.compositePriority].sort(),
  errorKinds.filter((kind) => kind !== "invalid_request").sort(),
  "composite priority must total-order all runtime error kinds",
);
invariant(
  new Set(errors.compositePriority).size === errors.compositePriority.length,
  "composite priority must not repeat an error kind",
);
equal(
  errors.resultExitPolicies,
  { noDataOrLocalTargetAbsent: 3, partialComposite: 7 },
  "result-only exits must remain separate from KrxError",
);

function assertErrorReference(mapping, location) {
  const value = object(mapping, location);
  invariant(errorKinds.includes(value.kind), `${location}.kind must exist`);
  invariant(
    Object.hasOwn(errors.kinds[value.kind].codes, value.code),
    `${location}.code must belong to ${value.kind}`,
  );
  invariant(
    typeof value.retryable === "boolean" || !("retryable" in value),
    `${location}.retryable must be boolean`,
  );
}
invariant(Array.isArray(errors.httpMappings), "httpMappings must be an array");
function httpMatchKey(match) {
  return Array.isArray(match)
    ? `array:${JSON.stringify(match)}`
    : `${typeof match}:${String(match)}`;
}
equal(
  errors.httpMappings.map(({ match }) => httpMatchKey(match)).sort(),
  [
    "number:401",
    "number:403",
    "number:408",
    "number:429",
    "array:[500,502,503,504]",
    "string:http200ProviderError",
    "string:otherNonSuccess",
  ].sort(),
  "HTTP mappings must cover every non-overlapping provider outcome",
);
equal(
  errors.httpMappings
    .filter(({ afterRetries }) => afterRetries)
    .map(({ match }) => httpMatchKey(match))
    .sort(),
  ["number:408", "number:429", "array:[500,502,503,504]"].sort(),
  "retry exhaustion mappings must stay exact",
);
for (const [index, mapping] of errors.httpMappings.entries()) {
  equalKeys(
    mapping,
    [
      "match",
      ...(mapping.afterRetries === true ? ["afterRetries"] : []),
      "kind",
      "code",
      "retryable",
    ],
    `httpMappings.${index}`,
  );
  assertErrorReference(mapping, `httpMappings.${index}`);
  equal(
    mapping.retryable,
    errors.kinds[mapping.kind].codes[mapping.code],
    `httpMappings.${index} retryability must match its stable error code`,
  );
}
equal(
  Object.keys(object(errors.responseMappings, "responseMappings")).sort(),
  ["invalidEnvelope", "invalidJson", "invalidRow"],
  "response mappings must cover every decode boundary",
);
for (const [name, mapping] of Object.entries(
  object(errors.responseMappings, "responseMappings"),
)) {
  equalKeys(mapping, ["kind", "code"], `responseMappings.${name}`);
  assertErrorReference(mapping, `responseMappings.${name}`);
}

equalKeys(
  overlay,
  [
    "schemaVersion",
    "id",
    "base",
    "candidateCases",
    "inventoryChanges",
    "behaviorChanges",
    "optionPolicy",
    "compatibilityPolicy",
    "diagnostics",
    "removedPackageSurfaces",
    "removedEnvironment",
  ],
  "cli overlay",
);
equal(overlay.schemaVersion, 1, "CLI overlay schemaVersion must be 1");
equal(overlay.id, "native-v1", "CLI overlay id must stay versioned");
equal(
  overlay.base,
  {
    scenarios: "tests/compat/scenarios.json",
    inventory: "tests/compat/command-inventory.json",
  },
  "CLI overlay must use frozen installed-package oracles",
);
equal(
  overlay.candidateCases,
  "contracts/product/v1/cli-cases.json",
  "CLI overlay must name its candidate-only cases",
);
equal(
  overlay.diagnostics,
  {
    error: "krx: error[{kind}/{code}]: {message}",
    provenance: "krx: provenance {json}",
  },
  "CLI diagnostics must remain machine-identifiable and sanitized",
);
invariant(
  Array.isArray(inventory),
  "legacy command inventory must be an array",
);
const candidateInventory = cloneJson(inventory);
function inventoryEntry(commandPath) {
  return candidateInventory.find(
    (entry) => JSON.stringify(entry.path) === JSON.stringify(commandPath),
  );
}
const changedKeys = new Set();
for (const [index, changeValue] of overlay.inventoryChanges.entries()) {
  const change = object(changeValue, `inventoryChanges.${index}`);
  equalKeys(
    change,
    [
      "change",
      "path",
      "name",
      "reason",
      ...(change.change === "add-command" ? ["options"] : []),
    ],
    `inventoryChanges.${index}`,
  );
  invariant(
    Array.isArray(change.path) &&
      change.path.every((part) => typeof part === "string"),
    `inventoryChanges.${index}.path must be a command path`,
  );
  invariant(
    typeof change.name === "string" && change.name.length > 0,
    `inventoryChanges.${index}.name is required`,
  );
  invariant(
    typeof change.reason === "string" && change.reason.length > 0,
    `inventoryChanges.${index}.reason is required`,
  );
  const key = `${change.change}:${JSON.stringify(change.path)}:${change.name}`;
  invariant(!changedKeys.has(key), `duplicate CLI inventory change: ${key}`);
  changedKeys.add(key);
  const parent = inventoryEntry(change.path);
  invariant(
    parent,
    `CLI inventory parent does not exist: ${JSON.stringify(change.path)}`,
  );
  if (change.change === "remove-command") {
    invariant(
      parent.commands?.includes(change.name),
      `removed command does not exist: ${change.name}`,
    );
    parent.commands = parent.commands.filter((name) => name !== change.name);
    for (let offset = candidateInventory.length - 1; offset >= 0; offset -= 1) {
      const entry = candidateInventory[offset];
      if (entry.path[0] === change.name && change.path.length === 0)
        candidateInventory.splice(offset, 1);
    }
  } else if (change.change === "add-command") {
    invariant(
      !parent.commands?.includes(change.name),
      `added command already exists: ${change.name}`,
    );
    parent.commands = [...(parent.commands ?? []), change.name];
    invariant(
      Array.isArray(change.options) &&
        change.options.length > 0 &&
        change.options.every((option) => typeof option === "string"),
      `added command ${change.name} needs exact options`,
    );
    invariant(
      new Set(change.options).size === change.options.length,
      `added command ${change.name} options must be unique`,
    );
    candidateInventory.push({
      path: [...change.path, change.name],
      options: change.options,
    });
  } else if (change.change === "add-option") {
    invariant(
      !parent.options?.includes(change.name),
      `added option already exists: ${change.name}`,
    );
    parent.options = [...(parent.options ?? []), change.name];
  } else {
    throw new Error(`unsupported CLI inventory change: ${change.change}`);
  }
}
invariant(
  Array.isArray(overlay.behaviorChanges) && overlay.behaviorChanges.length > 0,
  "CLI overlay needs classified behavior changes",
);
const behaviorIds = overlay.behaviorChanges.map((entry, index) => {
  equalKeys(entry, ["id", "classification"], `behaviorChanges.${index}`);
  invariant(
    ["security-fix", "defect-fix", "new-contract"].includes(
      entry.classification,
    ),
    `${entry.id} has an invalid classification`,
  );
  return entry.id;
});
invariant(
  new Set(behaviorIds).size === behaviorIds.length,
  "behavior change IDs must be unique",
);
equalKeys(
  overlay.optionPolicy,
  [
    "inactiveRootOptionExit",
    "scopeCommands",
    "activeRootOptionScopes",
    "offlineActiveScopes",
    "offlineConflicts",
  ],
  "CLI option policy",
);
equal(
  overlay.optionPolicy.inactiveRootOptionExit,
  2,
  "inactive root options must exit 2",
);
equalKeys(
  overlay.optionPolicy.scopeCommands,
  [
    "endpoint-rows",
    "stock-search",
    "market-summary",
    "watchlist-prices",
    "auth-status",
    "cache-status",
  ],
  "CLI scope commands",
);
for (const [scope, commandPaths] of Object.entries(
  overlay.optionPolicy.scopeCommands,
)) {
  invariant(
    Array.isArray(commandPaths) && commandPaths.length > 0,
    `${scope} must contain command paths`,
  );
  for (const commandPath of commandPaths) {
    invariant(
      inventoryEntry(commandPath),
      `${scope} references a command absent from candidate inventory`,
    );
  }
}
const candidateRoot = inventoryEntry([]);
const behavioralRootOptions = candidateRoot.options.filter(
  (name) => !["version", "help"].includes(name),
);
equal(
  Object.keys(overlay.optionPolicy.activeRootOptionScopes),
  behavioralRootOptions,
  "every behavioral root option needs an exact active scope",
);
for (const [option, scopes] of Object.entries(
  overlay.optionPolicy.activeRootOptionScopes,
)) {
  invariant(
    Array.isArray(scopes) && scopes.length > 0,
    `${option} needs an active scope`,
  );
  invariant(
    new Set(scopes).size === scopes.length,
    `${option} scopes must be unique`,
  );
  for (const scope of scopes) {
    invariant(
      Object.hasOwn(overlay.optionPolicy.scopeCommands, scope),
      `${option} references unknown scope ${scope}`,
    );
  }
}
equal(
  overlay.optionPolicy.offlineActiveScopes,
  overlay.optionPolicy.activeRootOptionScopes.offline,
  "offline active scopes must have one authority",
);
equal(
  overlay.optionPolicy.offlineConflicts,
  ["refresh", "no-cache", "dry-run", "retries"],
  "offline conflicts must block every network-forcing option",
);
equal(
  overlay.compatibilityPolicy.unclassifiedDifference,
  "reject",
  "unclassified CLI differences must block",
);
equal(
  overlay.removedPackageSurfaces,
  ["krx-mcp"],
  "MCP binary removal must stay explicit",
);
equal(
  overlay.removedEnvironment,
  ["KRX_MCP_TOKEN", "KRX_MCP_ALLOWED_HOSTS"],
  "MCP environment removal must stay explicit",
);

equalKeys(cliCases, ["schemaVersion", "cases"], "candidate CLI cases");
equal(cliCases.schemaVersion, 1, "candidate CLI case version must be 1");
invariant(
  Array.isArray(cliCases.cases) && cliCases.cases.length > 0,
  "candidate CLI cases are required",
);
const cliCaseIds = cliCases.cases.map((entry) => entry.id);
invariant(
  new Set(cliCaseIds).size === cliCaseIds.length,
  "candidate CLI case IDs must be unique",
);
for (const behaviorId of behaviorIds) {
  const polarities = cliCases.cases
    .filter((entry) => entry.coversBehavior === behaviorId)
    .map((entry) => entry.polarity);
  invariant(
    polarities.includes("positive") && polarities.includes("rejection"),
    `${behaviorId} needs positive and rejection candidate cases`,
  );
}
for (const conflict of overlay.optionPolicy.offlineConflicts) {
  invariant(
    cliCases.cases.some(
      (entry) =>
        entry.coversBehavior === "offline-conflicts" &&
        entry.polarity === "rejection" &&
        entry.args.includes("--offline") &&
        entry.args.includes(`--${conflict}`),
    ),
    `offline conflict --${conflict} needs a rejection case`,
  );
}
for (const changedKey of changedKeys) {
  const polarities = cliCases.cases
    .filter((entry) => entry.coversInventory === changedKey)
    .map((entry) => entry.polarity);
  invariant(
    polarities.includes("positive") && polarities.includes("rejection"),
    `${changedKey} needs positive and rejection candidate inventory cases`,
  );
}
for (const cliCase of cliCases.cases) {
  invariant(
    typeof cliCase.id === "string" && Array.isArray(cliCase.args),
    `${cliCase.id} must freeze argv`,
  );
  object(cliCase.expect, `${cliCase.id}.expect`);
  invariant(
    ["positive", "rejection"].includes(cliCase.polarity),
    `${cliCase.id} needs a polarity`,
  );
}
const konexWatchlistPositive = cliCases.cases.find(
  ({ id }) => id === "watchlist-konex-price-included",
);
equal(
  konexWatchlistPositive,
  {
    id: "watchlist-konex-price-included",
    coversBehavior: "watchlist-konex-prices",
    polarity: "positive",
    args: ["watchlist", "show", "--date", "20260102"],
    setup: "watchlist-with-konex-network-success",
    expect: {
      code: 0,
      requestedComponents: ["KOSPI", "KOSDAQ", "KONEX"],
      resultIncludesSecurityCode: "244690",
    },
  },
  "KONEX watchlist positive case must prove requested and returned coverage",
);
const konexWatchlistFailure = cliCases.cases.find(
  ({ id }) => id === "watchlist-konex-failure-is-not-silent",
);
equal(
  konexWatchlistFailure,
  {
    id: "watchlist-konex-failure-is-not-silent",
    coversBehavior: "watchlist-konex-prices",
    polarity: "rejection",
    args: ["watchlist", "show", "--date", "20260102"],
    setup: "watchlist-with-konex-konex-upstream-failure",
    expect: {
      code: 7,
      requestedComponents: ["KOSPI", "KOSDAQ", "KONEX"],
      failedComponents: ["KONEX"],
    },
  },
  "KONEX watchlist failure case must prevent silent omission",
);

const nodeContractSource = await readFile(paths.nodeContract, "utf8");
for (const forbidden of [
  "napi",
  "reqwest",
  "clap",
  "tokio",
  "keyring",
  "rawBody",
  "customTransport",
  "default export",
]) {
  invariant(
    !nodeContractSource.includes(forbidden),
    `Node public contract must not expose ${forbidden}`,
  );
}
for (const required of [
  "AbortSignal",
  "class KrxClient",
  "class KrxError",
  "../../generated/node-operations.js",
  "../../generated/error-types.js",
  "readonly credentials: CredentialStore",
  "readonly cache: CacheStore",
  'export type WatchlistMarket = SearchMarket | "KONEX";',
  'RowFor<"stock_knx_bydd_trd">',
  "CompositeResult<\n  WatchlistPrices,\n  WatchlistMarket\n>",
]) {
  invariant(
    nodeContractSource.includes(required),
    `Node public contract must expose ${required}`,
  );
}
const rustContractSource = await readFile(paths.rustContract, "utf8");
for (const forbidden of [
  "clap",
  "napi",
  "reqwest",
  "tokio",
  "keyring",
  "OutBlock_1",
]) {
  invariant(
    !rustContractSource.includes(forbidden),
    `Rust public contract must not expose ${forbidden}`,
  );
}
for (const required of [
  "DirectRequest",
  "RangeRequest",
  "OperationId",
  "CredentialMigrationResult",
  "CacheInspectOptions",
  "Cancellation",
  "RangeMode",
  "SecurityCode",
  "WatchlistEntry",
  ".watchlist()",
  ".api_key(",
  "CachePolicy::Bypass",
  "Cancellation::new()",
  ".cancel()",
  ".is_cancelled()",
  "OperationId::ALL",
  ".as_str()",
  "KrxErrorKind",
  "KrxErrorCode",
  "std::error::Error + Send + Sync",
  "Vec<SecurityCode>",
  "Option<&krx_sdk::WatchlistMarket>",
]) {
  invariant(
    rustContractSource.includes(required),
    `Rust consumer contract must exercise ${required}`,
  );
}

const requiredRustSurfaceGroups = new Map([
  [
    "composite results and provenance",
    [
      "fn assert_provenance(provenance: &ResultProvenance)",
      "assert_result_source(provenance.source)",
      "&provenance.fetched_at",
      "assert_freshness(provenance.freshness)",
      "provenance.contract_id",
      "fn assert_composite_result<Data, Id>(result: &CompositeResult<Data, Id>)",
      "assert_completeness_state(result.completeness.state)",
      "&result.completeness.requested",
      "&result.completeness.succeeded",
      "&result.completeness.skipped",
      "&result.completeness.failed",
      "result.provenance.values()",
      "&result.error",
    ],
  ],
  [
    "range calendar and adjustment metadata",
    [
      "fn assert_range_result(range: &RangeResult)",
      "range.fetched_days",
      "range.failed_days",
      "&range.calendar.version",
      "&range.calendar.source",
      "let calendar_retrieved_at: &CalendarDate = &range.calendar.retrieved_at",
      "calendar_retrieved_at.as_str()",
      "assert_calendar_coverage(range.calendar.coverage)",
      "&range.calendar.unverified_dates",
      "&range.adjustment",
      "&adjustment.method",
      "adjustment.version",
      "&adjustment.as_of",
      "&adjustment.rounding",
      "&adjustment.raw_fields",
      "&adjustment.adjusted_fields",
      "assert_adjustment_factor_field(adjustment.factor_field)",
      "&adjustment.basis_transitions",
      "assert_cash_dividend_treatment(adjustment.cash_dividends)",
    ],
  ],
  [
    "market summary and stock statistics",
    [
      "fn assert_market_summary(summary: &MarketSummary)",
      "&summary.date",
      "&summary.kospi_index",
      "&summary.kosdaq_index",
      "&summary.stock_stats",
      "&summary.top_gainers",
      "&summary.top_losers",
      "fn assert_stock_stats(stats: &StockStats)",
      "stats.advancing",
      "stats.declining",
      "stats.unchanged",
      "stats.total_volume",
      "stats.total_value",
    ],
  ],
  [
    "credential and approval results",
    [
      "fn assert_credential_status(status: &CredentialStatus)",
      "assert_credential_source(status.source)",
      "status.persisted",
      "fn assert_approval_observation(observation: &ApprovalObservation)",
      "observation.category",
      "assert_approval_state(observation.state)",
      "&observation.checked_at",
      "&observation.valid_until",
      "observation.fresh",
      "&observation.error",
      "fn assert_credential_migration(migration: &CredentialMigrationResult)",
      "migration.migrated",
      "migration.legacy_secret_removed",
      "migration.approvals_migrated",
    ],
  ],
  [
    "cache options inspection and pruning",
    [
      ".inspect(CacheInspectOptions {",
      "operation: Some(OperationId::StockStkByddTrd)",
      "date: Some(date)",
      "limit: Some(100)",
      ".prune(CachePruneOptions {",
      "older_than: Some(SystemTime::UNIX_EPOCH)",
      "max_entries: Some(100)",
      "fn assert_cache_inspection(inspection: &CacheInspection)",
      "&inspection.entries",
      "inspection.total_entries",
      "inspection.total_size_bytes",
      "inspection.truncated",
      "entry.operation",
      "&entry.date",
      "&entry.fetched_at",
      "assert_freshness(entry.freshness)",
      "entry.size_bytes",
      "&entry.contract_id",
      "fn assert_cache_prune_result(result: &CachePruneResult)",
      "result.removed_entries",
      "result.removed_bytes",
    ],
  ],
  [
    "search capability and watchlist results",
    [
      "fn assert_stock_search_match(stock: &StockSearchMatch)",
      "&stock.isu_cd",
      "&stock.isu_srt_cd",
      "&stock.isu_nm",
      "assert_search_market(stock.market)",
      "fn assert_watchlist_prices(prices: &WatchlistPrices)",
      "&prices.date",
      "&prices.stocks",
      "fn assert_operation_description(description: &OperationDescription)",
      "description.request_fields",
      "description.response_fields",
      "fn assert_watchlist_entry(entry: &WatchlistEntry)",
      "&entry.isin",
      "&entry.security_code",
      "&entry.name",
      "assert_watchlist_market(entry.market)",
    ],
  ],
  [
    "closed result metadata variants",
    [
      "fn assert_result_source(source: ResultSource)",
      "ResultSource::Network => {}",
      "ResultSource::Cache => {}",
      "fn assert_completeness_state(state: CompletenessState)",
      "CompletenessState::Complete => {}",
      "CompletenessState::Partial => {}",
      "CompletenessState::Empty => {}",
      "CompletenessState::Failed => {}",
      "fn assert_credential_source(source: CredentialSource)",
      "CredentialSource::Explicit => {}",
      "CredentialSource::Environment => {}",
      "CredentialSource::Keychain => {}",
      "CredentialSource::Missing => {}",
      "fn assert_search_market(market: SearchMarket)",
      "SearchMarket::Kospi => {}",
      "SearchMarket::Kosdaq => {}",
      "fn assert_market_component(component: MarketComponent)",
      "MarketComponent::KospiIndex => {}",
      "MarketComponent::KosdaqIndex => {}",
      "MarketComponent::KospiStocks => {}",
      "MarketComponent::KosdaqStocks => {}",
      "fn assert_watchlist_market(market: WatchlistMarket)",
      "WatchlistMarket::Kospi => {}",
      "WatchlistMarket::Kosdaq => {}",
      "WatchlistMarket::Konex => {}",
      "fn assert_calendar_coverage(coverage: CalendarCoverage)",
      "CalendarCoverage::Official => {}",
      "CalendarCoverage::Fallback => {}",
      "fn assert_adjustment_factor_field(field: AdjustmentFactorField)",
      "AdjustmentFactorField::AdjFactor => {}",
      "fn assert_cash_dividend_treatment(treatment: CashDividendTreatment)",
      "CashDividendTreatment::Excluded => {}",
      "fn assert_approval_state(state: ApprovalState)",
      "ApprovalState::Approved => {}",
      "ApprovalState::Rejected => {}",
      "ApprovalState::Inconclusive => {}",
      "fn assert_freshness(freshness: Freshness)",
      "Freshness::Fresh => {}",
      "Freshness::Stale => {}",
    ],
  ],
]);
for (const [group, requiredAnchors] of requiredRustSurfaceGroups) {
  for (const anchor of requiredAnchors) {
    invariant(
      rustContractSource.includes(anchor),
      `Rust consumer contract must freeze ${group} through ${anchor}`,
    );
  }
}

equalKeys(
  nodePackage,
  [
    "schemaVersion",
    "packageName",
    "moduleFormat",
    "nodeEngine",
    "exports",
    "declarations",
    "defaultExport",
    "commonJs",
    "publicNativeBindingSubpath",
  ],
  "Node package surface",
);
equal(nodePackage.schemaVersion, 1, "Node package surface version must be 1");
equal(
  nodePackage.packageName,
  "krx-cli",
  "existing npm package identity must be preserved",
);
equal(nodePackage.moduleFormat, "esm-only", "Node SDK must be ESM-only");
equal(
  nodePackage.nodeEngine,
  ">=22 <23 || >=24 <25",
  "Node SDK must admit only the certified Node majors",
);
equal(
  nodePackage.exports,
  {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./package.json": "./package.json",
  },
  "Node public exports must not expose the native binding",
);
equal(
  nodePackage.declarations,
  {
    entry: "dist/index.d.ts",
    generated: [
      "dist/generated/node-operations.d.ts",
      "dist/generated/error-types.d.ts",
    ],
    sourceImportPrefix: "../../generated/",
    packageImportPrefix: "./generated/",
    selfContained: true,
  },
  "Node declarations must assemble into a self-contained package-local graph",
);
equal(nodePackage.defaultExport, false, "Node SDK must use named exports");
equal(nodePackage.commonJs, false, "Node SDK must not claim CommonJS support");
equal(
  nodePackage.publicNativeBindingSubpath,
  false,
  "native Node binding must stay private",
);

equalKeys(
  nativeTargets,
  ["schemaVersion", "id", "distribution", "targets"],
  "native target manifest",
);
equal(nativeTargets.schemaVersion, 1, "native target version must be 1");
equal(
  nativeTargets.id,
  "krx-native-targets/v1",
  "native target manifest id must stay versioned",
);
equal(
  nativeTargets.distribution,
  {
    format: "npm-tgz",
    visibility: "private-github-release-asset",
    installBuild: false,
    registryAccess: false,
    publicBindingSubpath: false,
    nodeMajors: [22, 24],
    continuousCertificationTargets: ["linux-x64-gnu", "linux-arm64-gnu"],
    assetNameTemplate: "krx-cli-{version}-{target}.tgz",
  },
  "native distribution boundary must stay exact",
);
equal(
  nativeTargets.targets,
  [
    {
      id: "darwin-arm64",
      rustTarget: "aarch64-apple-darwin",
      nodePlatform: "darwin",
      nodeArch: "arm64",
      nodeLibc: null,
      nodeBinding: "native/krx.darwin-arm64.node",
      executable: "bin/krx",
    },
    {
      id: "linux-x64-gnu",
      rustTarget: "x86_64-unknown-linux-gnu",
      nodePlatform: "linux",
      nodeArch: "x64",
      nodeLibc: "glibc",
      nodeBinding: "native/krx.linux-x64-gnu.node",
      executable: "bin/krx",
    },
    {
      id: "linux-arm64-gnu",
      rustTarget: "aarch64-unknown-linux-gnu",
      nodePlatform: "linux",
      nodeArch: "arm64",
      nodeLibc: "glibc",
      nodeBinding: "native/krx.linux-arm64-gnu.node",
      executable: "bin/krx",
    },
    {
      id: "win32-x64-msvc",
      rustTarget: "x86_64-pc-windows-msvc",
      nodePlatform: "win32",
      nodeArch: "x64",
      nodeLibc: null,
      nodeBinding: "native/krx.win32-x64-msvc.node",
      executable: "bin/krx.exe",
    },
  ],
  "native target set and archive paths must stay exact",
);

equalKeys(
  migrations,
  [
    "formatVersion",
    "id",
    "root",
    "credential",
    "offline",
    "stores",
    "transitions",
    "cacheRefresh",
    "bounds",
    "acceptance",
  ],
  "migration contract",
);
equal(migrations.formatVersion, 1, "migration formatVersion must be 1");
equal(
  migrations.id,
  "krx-local-state/v1",
  "migration contract id must stay versioned",
);
equal(
  migrations.root.path,
  "~/.krx-cli",
  "local-state root must remain compatible",
);
equal(
  migrations.root.relocation,
  "forbidden",
  "migration must not create a second state root",
);
equal(
  migrations.root.symlinkPolicy,
  "reject-all-components",
  "state paths must reject links",
);
equal(
  migrations.credential.keychain,
  { service: "krx-cli", account: "default", plaintextFallback: "forbidden" },
  "keychain identity must stay exact",
);
equal(
  migrations.credential.resolutionPrecedence,
  ["explicit-sdk-argument", "KRX_API_KEY", "os-keychain"],
  "credential precedence must stay total",
);
equal(
  migrations.offline.resolvesCredential,
  false,
  "offline must not resolve credentials",
);
equal(
  migrations.offline.acquiresRefreshLease,
  false,
  "offline must not acquire refresh leases",
);
equalKeys(
  migrations.offline,
  [
    "resolvesCredential",
    "touchesKeychain",
    "touchesQuota",
    "touchesNetwork",
    "acquiresRefreshLease",
    "validStaleCache",
    "absentCacheError",
    "invalidCacheError",
    "validV1Action",
    "invalidV1Action",
  ],
  "offline policy",
);
equal(
  migrations.offline.validV1Action,
  "return-without-promotion-or-mutation",
  "offline version-1 hits must remain read-only",
);
equal(
  migrations.offline.invalidV1Action,
  "quarantine-if-unchanged-then-return-cache-invalid",
  "offline invalid version-1 entries need one safe disposition",
);
equal(
  migrations.stores.cacheV1.keyPreimage,
  "<endpoint>:<JSON(sortedParams)>",
  "legacy cache key preimage must stay exact",
);
equal(
  migrations.stores.cacheV1.keyDigest,
  "sha256-first-16-lowercase-hex",
  "legacy cache key digest must stay exact",
);
equal(
  migrations.stores.cacheV2.keyPreimage,
  "krx-cache-v2\\n<operationId>\\n<JSON(sortedParams)>",
  "cache v2 key preimage must stay exact",
);
equal(
  migrations.stores.cacheV2.keyDigest,
  "sha256-lowercase-hex",
  "cache v2 key digest must stay exact",
);
equal(
  migrations.offline.touchesQuota,
  false,
  "offline must not touch quota state",
);
equal(migrations.offline.touchesNetwork, false, "offline must not use network");
equal(
  migrations.stores.quota.targetVersion,
  1,
  "quota v1 must remain shared during coexistence",
);
equal(
  migrations.stores.quota.replacementVersion,
  "forbidden",
  "quota v2 would create a split budget",
);
for (const [name, store] of Object.entries(migrations.stores)) {
  if (Object.hasOwn(store, "writableAuthorities")) {
    equal(
      store.writableAuthorities,
      1,
      `${name} must have one writable authority`,
    );
  }
}
const transitionIds = migrations.transitions.map((transition) => transition.id);
equal(
  transitionIds,
  [
    "credential-config-v0-to-keychain-v1",
    "approval-config-v0-to-v1",
    "cache-v1-to-v2",
    "quota-root-v0-to-v1",
    "watchlist-v0-to-v1",
  ],
  "migration transition set must stay complete",
);
const cacheTransition = migrations.transitions.find(
  ({ id }) => id === "cache-v1-to-v2",
);
equal(
  cacheTransition.trigger,
  "lazy-per-key-after-strict-successful-online-read-or-successful-refresh",
  "cache promotion must be online-only",
);
equal(
  cacheTransition.lock,
  "per-key-cache-v2-lease-online-only",
  "cache migration must share the online refresh lease",
);
invariant(
  !cacheTransition.actions.some((action) => action.startsWith("offline-")),
  "online cache migration must not own offline behavior",
);
equal(
  migrations.cacheRefresh.lease.offline,
  "never-acquire",
  "offline must not contend on refresh leases",
);
equal(
  migrations.bounds.cacheEntryReadBytes,
  64 * 1024 * 1024,
  "cache read cap must be 64 MiB",
);
equal(
  migrations.bounds.inspectDefaultEntries,
  100,
  "cache inspect default must stay bounded",
);
equal(
  migrations.bounds.inspectMaximumEntries,
  1000,
  "cache inspect maximum must stay bounded",
);
equal(
  migrations.bounds.pruneScanMaximumFiles,
  100000,
  "cache prune scan must stay bounded",
);
equal(
  migrations.bounds.pruneDeleteBatchMaximum,
  10000,
  "cache prune delete batch must stay bounded",
);
equal(
  migrations.bounds.scanLimitBehavior,
  "local_state/cache_scan_limit",
  "bounded cache scans must map to the stable error catalog",
);

equalKeys(runtimeCases, ["schemaVersion", "cases"], "Node runtime cases");
equal(runtimeCases.schemaVersion, 1, "Node runtime cases version must be 1");
const runtimeCaseIds = runtimeCases.cases.map((entry) => entry.id);
equal(
  runtimeCaseIds,
  [
    "esm-named-import",
    "invalid-date",
    "empty-explicit-api-key",
    "abort-signal",
    "async-event-loop",
    "abort-listener-cleanup",
    "sync-panic-contained",
    "async-panic-contained",
    "adjusted-range-requires-exact-eligible-security",
    "error-instance",
    "secret-redaction",
    "supported-node-majors",
    "unsupported-native-target",
    "declaration-package-locality",
    "private-native-binding",
  ],
  "Node runtime consumer cases must stay complete",
);
equal(
  runtimeCases.cases.find(({ id }) => id === "supported-node-majors").versions,
  [22, 24],
  "Node runtime certification must cover supported majors",
);
const consumerSecret = runtimeCases.cases.find(
  ({ id }) => id === "secret-redaction",
).secret;
equal(
  runtimeCases.cases.find(({ id }) => id === "secret-redaction").forbiddenIn,
  [
    "message",
    "stack",
    "providerCode",
    "operationId",
    ...errors.publicFields.forbidden,
  ],
  "runtime redaction fields must include the complete error boundary",
);
invariant(
  !nodeContractSource.includes(consumerSecret) &&
    !rustContractSource.includes(consumerSecret),
  "consumer fixture secret must not enter public contracts",
);

const operationUnion = operationIds
  .map((id) => `  | ${JSON.stringify(id)}`)
  .join("\n");
const rowInterfaces = operations
  .map(
    ({ operationId, responseFields }) =>
      `export interface ${pascalCase(operationId)}Row {\n${responseFields
        .map(({ name }) => `  readonly ${JSON.stringify(name)}: string;`)
        .join("\n")}\n}`,
  )
  .join("\n\n");
const operationRows = operations
  .map(
    ({ operationId }) =>
      `  readonly ${JSON.stringify(operationId)}: ${pascalCase(operationId)}Row;`,
  )
  .join("\n");
const categoriesUnion = categories
  .map((category) => `  | ${JSON.stringify(category)}`)
  .join("\n");
const adjustedDailyStockUnion = profile.operationSets.adjustedDailyStock
  .map((operationId) => `  | ${JSON.stringify(operationId)}`)
  .join("\n");
const nodeOperations = await prettier.format(
  `/* Generated by scripts/product-contracts.mjs from OpenAPI and the product profile. */\n\nexport type OperationId =\n${operationUnion};\n\nexport type ApprovalCategory =\n${categoriesUnion};\n\nexport type AdjustedDailyStockOperation =\n${adjustedDailyStockUnion};\n\n${rowInterfaces}\n\nexport interface OperationRows {\n${operationRows}\n}\n\nexport type RowFor<O extends OperationId> = OperationRows[O];\n\nexport interface OperationFieldDescription {\n  readonly name: string;\n  readonly description: string;\n}\n\nexport interface OperationDescription {\n  readonly operationId: OperationId;\n  readonly category: ApprovalCategory;\n  readonly description: string;\n  readonly descriptionKo: string;\n  readonly contractId: string;\n  readonly requestFields: readonly OperationFieldDescription[];\n  readonly responseFields: readonly OperationFieldDescription[];\n}\n`,
  { parser: "typescript" },
);
const nodeErrors = await prettier.format(
  `/* Generated by scripts/product-contracts.mjs from contracts/product/v1/errors.yaml. */\n\nexport type KrxErrorKind =\n${errorKinds.map((kind) => `  | ${JSON.stringify(kind)}`).join("\n")};\n\nexport interface KrxErrorCodeByKind {\n${kindEntries
    .map(
      ([kind, value]) =>
        `  readonly ${JSON.stringify(kind)}:\n${Object.keys(value.codes)
          .map((code) => `    | ${JSON.stringify(code)}`)
          .join("\n")};`,
    )
    .join(
      "\n",
    )}\n}\n\nexport type KrxErrorCode<K extends KrxErrorKind = KrxErrorKind> =\n  KrxErrorCodeByKind[K];\n`,
  { parser: "typescript" },
);
const rustVariants = operationIds
  .map((id) => `    ${pascalCase(id)},`)
  .join("\n");
const rustNames = operationIds
  .map((id) => `            Self::${pascalCase(id)} => ${JSON.stringify(id)},`)
  .join("\n");
const rustAll = operationIds
  .map((id) => `        Self::${pascalCase(id)},`)
  .join("\n");
const rustOperations = `// Generated by scripts/product-contracts.mjs from contracts/krx/openapi.yaml.\n\n#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]\npub enum OperationId {\n${rustVariants}\n}\n\nimpl OperationId {\n    pub const ALL: [Self; 31] = [\n${rustAll}\n    ];\n\n    pub const fn as_str(self) -> &'static str {\n        match self {\n${rustNames}\n        }\n    }\n}\n`;

const stateSchemaDirectory = paths.stateSchemaRoot;
const stateSchemaNames = (await readdir(stateSchemaDirectory))
  .filter((name) => name.endsWith(".schema.json"))
  .sort();
equal(
  stateSchemaNames,
  [
    "approval-config-v1.schema.json",
    "cache-v1.schema.json",
    "cache-v2.schema.json",
    "credential-keychain-fixture-v1.schema.json",
    "legacy-config-v0.schema.json",
    "quota-root-v0.schema.json",
    "quota-v1.schema.json",
    "watchlist-v0.schema.json",
    "watchlist-v1.schema.json",
  ],
  "maintained state schema set must stay exact",
);
const stateSchemaSources = Object.fromEntries(
  await Promise.all(
    stateSchemaNames.map(async (name) => [
      name,
      await readFile(resolve(stateSchemaDirectory, name), "utf8"),
    ]),
  ),
);
const stateSchemas = Object.fromEntries(
  Object.entries(stateSchemaSources).map(([name, source]) => [
    name,
    JSON.parse(source),
  ]),
);
const approvalCategories =
  stateSchemas["approval-config-v1.schema.json"]?.properties?.serviceStatus
    ?.propertyNames?.enum;
equal(
  approvalCategories,
  Object.keys(profile.approvalProbes),
  "approval schema categories must derive from the semantic profile",
);

async function generatedCacheSchema(
  templateName,
  outputPath,
  selector,
  rowsProperty,
  selectValue,
) {
  const template = cloneJson(stateSchemas[templateName]);
  template.$id = template.$id.replace(".schema.json", "-generated.schema.json");
  template.properties[selector].enum = operations.map(selectValue);
  template.allOf = operations.map((operation) => {
    const requestFields = requestFieldsByOperation.get(operation.operationId);
    invariant(requestFields, `${operation.operationId} request fields missing`);
    return {
      if: {
        required: [selector],
        properties: { [selector]: { const: selectValue(operation) } },
      },
      then: {
        properties: {
          params: {
            type: "array",
            prefixItems: requestFields.map(({ name, schema }) => ({
              type: "array",
              prefixItems: [{ const: name }, schema],
              items: false,
              minItems: 2,
              maxItems: 2,
            })),
            items: false,
            minItems: requestFields.length,
            maxItems: requestFields.length,
          },
          [rowsProperty]: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: operation.responseFields.map(({ name }) => name),
              properties: Object.fromEntries(
                operation.responseFields.map(({ name, description }) => [
                  name,
                  { type: "string", description },
                ]),
              ),
              additionalProperties: false,
            },
          },
        },
      },
    };
  });
  return formattedJson(template, outputPath);
}
const generatedCacheV1 = await generatedCacheSchema(
  "cache-v1.schema.json",
  paths.cacheV1Schema,
  "endpoint",
  "data",
  (operation) => operation.path,
);
const generatedCacheV2 = await generatedCacheSchema(
  "cache-v2.schema.json",
  paths.cacheV2Schema,
  "operationId",
  "rows",
  (operation) => operation.operationId,
);
const generatedCacheSchemaObjects = {
  [paths.cacheV1Schema]: JSON.parse(generatedCacheV1),
  [paths.cacheV2Schema]: JSON.parse(generatedCacheV2),
};

const migrationSchemaReferences = {
  credential: {
    source: migrations.stores.credential.sourceSchema,
    fixture: migrations.stores.credential.fixtureSchema,
  },
  approval: { target: migrations.stores.approval.targetSchema },
  cacheV1: {
    template: migrations.stores.cacheV1.schemaTemplate,
    expanded: migrations.stores.cacheV1.schema,
  },
  cacheV2: {
    template: migrations.stores.cacheV2.schemaTemplate,
    expanded: migrations.stores.cacheV2.schema,
  },
  quota: {
    source: migrations.stores.quota.sourceSchema,
    target: migrations.stores.quota.targetSchema,
  },
  watchlist: {
    source: migrations.stores.watchlist.sourceSchema,
    target: migrations.stores.watchlist.targetSchema,
  },
};
equal(
  migrationSchemaReferences,
  {
    credential: {
      source: "state/legacy-config-v0.schema.json",
      fixture: "state/credential-keychain-fixture-v1.schema.json",
    },
    approval: { target: "state/approval-config-v1.schema.json" },
    cacheV1: {
      template: "state/cache-v1.schema.json",
      expanded: "../../generated/state/cache-v1.schema.json",
    },
    cacheV2: {
      template: "state/cache-v2.schema.json",
      expanded: "../../generated/state/cache-v2.schema.json",
    },
    quota: {
      source: "state/quota-root-v0.schema.json",
      target: "state/quota-v1.schema.json",
    },
    watchlist: {
      source: "state/watchlist-v0.schema.json",
      target: "state/watchlist-v1.schema.json",
    },
  },
  "migration schema references must stay exact",
);
for (const reference of Object.values(migrationSchemaReferences).flatMap(
  (roles) => Object.values(roles),
)) {
  const schema = reference.startsWith("state/")
    ? stateSchemas[basename(reference)]
    : generatedCacheSchemaObjects[
        reference.endsWith("cache-v1.schema.json")
          ? paths.cacheV1Schema
          : paths.cacheV2Schema
      ];
  invariant(
    schema,
    `migration schema reference does not resolve: ${reference}`,
  );
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addFormat("krx-compact-date", {
  type: "string",
  validate: validCalendarDate,
});
for (const keyword of [
  "x-krx-openapi-row-discriminator",
  "x-krx-schema-digest",
]) {
  ajv.addKeyword({ keyword, schemaType: "object", valid: true });
}
for (const [name, schema] of Object.entries(stateSchemas)) {
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new Error(
      `state schema does not compile: ${name}: ${error.message}`,
      {
        cause: error,
      },
    );
  }
}
for (const [name, source] of [
  ["generated cache v1", generatedCacheV1],
  ["generated cache v2", generatedCacheV2],
]) {
  try {
    ajv.compile(JSON.parse(source));
  } catch (error) {
    throw new Error(`${name} schema does not compile: ${error.message}`, {
      cause: error,
    });
  }
}

equalKeys(
  fixtureManifest,
  [
    "formatVersion",
    "asOfKstDate",
    "asOfInstant",
    "fixtureSecret",
    "schemaCases",
    "transitionCases",
    "proceduralCases",
  ],
  "fixture manifest",
);
equal(fixtureManifest.formatVersion, 1, "fixture manifest version must be 1");
const credentialFingerprint = sha256(fixtureManifest.fixtureSecret);

const fixturesDirectory = dirname(paths.fixtures);
const fixtureCache = new Map();
async function fixture(name) {
  if (!fixtureCache.has(name)) {
    fixtureCache.set(
      name,
      await readFile(resolve(fixturesDirectory, name), "utf8"),
    );
  }
  return fixtureCache.get(name);
}

function paramsSorted(params) {
  if (!Array.isArray(params)) return false;
  const sorted = [...params].sort((left, right) => {
    const nameOrder = Buffer.from(left[0]).compare(Buffer.from(right[0]));
    return nameOrder || Buffer.from(left[1]).compare(Buffer.from(right[1]));
  });
  return JSON.stringify(params) === JSON.stringify(sorted);
}

function validCalendarDate(value) {
  if (!/^[0-9]{8}$/u.test(value)) return false;
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

function approvalSemantic(value) {
  return Object.values(value.serviceStatus).every((observation) => {
    const checked = new Date(observation.checkedAt);
    const validUntil = new Date(observation.validUntil);
    return (
      checked.toISOString() === observation.checkedAt &&
      validUntil.toISOString() === observation.validUntil &&
      validUntil.getTime() - checked.getTime() ===
        profile.defaults.approvalTtlSeconds * 1000 &&
      [...(observation.error ?? "")].length <= 240 &&
      !(observation.error ?? "").includes(fixtureManifest.fixtureSecret)
    );
  });
}

function cacheSemantic(value, version) {
  const params = value.params;
  if (!paramsSorted(params)) return false;
  const operation =
    version === 1
      ? operations.find((candidate) => candidate.path === value.endpoint)
      : operations.find(
          (candidate) => candidate.operationId === value.operationId,
        );
  if (!operation) return false;
  const expectedNames = requestFieldsByOperation
    .get(operation.operationId)
    .map(({ name }) => name);
  if (
    params.length !== expectedNames.length ||
    params.some(([name], index) => name !== expectedNames[index])
  ) {
    return false;
  }
  const date = params.find(([name]) => name === "basDd")?.[1];
  if (!validCalendarDate(date) || date >= fixtureManifest.asOfKstDate)
    return false;
  const fetchedAt = new Date(value.fetchedAt);
  if (
    fetchedAt.toISOString() !== value.fetchedAt ||
    fetchedAt.getTime() >
      new Date(fixtureManifest.asOfInstant).getTime() + 5 * 60 * 1000
  ) {
    return false;
  }
  const rows = version === 1 ? value.data : value.rows;
  if (rows.some((row) => row.BAS_DD !== date)) return false;
  if (version === 2 && value.schemaSha256 !== operation.contractId)
    return false;
  return true;
}

function watchlistSemantic(value, version) {
  const entries = version === 0 ? value : value.entries;
  return (
    new Set(entries.map((entry) => entry.isuCd)).size === entries.length &&
    entries.every(
      (entry) =>
        entry.name === entry.name.trim() &&
        entry.isuCd === entry.isuCd.trim() &&
        entry.isuSrtCd === entry.isuSrtCd.trim(),
    )
  );
}

const schemaByPath = new Map(
  Object.entries(stateSchemas).map(([name, schema]) => [
    resolve(stateSchemaDirectory, name),
    schema,
  ]),
);
for (const [path, schema] of Object.entries(generatedCacheSchemaObjects)) {
  schemaByPath.set(path, schema);
}
function validateState(schema, value, message) {
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  invariant(
    validate(value),
    `${message}: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
  );
}
function stateValid(schema, value) {
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  return Boolean(validate(value));
}
const caseIds = new Set();
for (const [index, schemaCase] of fixtureManifest.schemaCases.entries()) {
  equalKeys(
    schemaCase,
    [
      "id",
      "fixture",
      "valid",
      ...(schemaCase.schema ? ["schema"] : []),
      ...(schemaCase.semantic ? ["semantic"] : []),
      ...(schemaCase.parse ? ["parse"] : []),
    ],
    `schemaCases.${index}`,
  );
  invariant(
    !caseIds.has(schemaCase.id),
    `duplicate fixture case ${schemaCase.id}`,
  );
  caseIds.add(schemaCase.id);
  let parsed;
  let parsedSuccessfully = true;
  try {
    parsed = JSON.parse(await fixture(schemaCase.fixture));
  } catch {
    parsedSuccessfully = false;
  }
  let actualValid = parsedSuccessfully;
  if (actualValid && schemaCase.schema) {
    const schemaPath = resolve(fixturesDirectory, schemaCase.schema);
    const schema = schemaByPath.get(schemaPath);
    invariant(schema, `${schemaCase.id} references an unknown schema`);
    const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
    actualValid = validate(parsed);
  }
  if (actualValid && schemaCase.semantic === "approval") {
    actualValid = approvalSemantic(parsed);
  } else if (actualValid && schemaCase.semantic === "cache-v1") {
    actualValid = cacheSemantic(parsed, 1);
  } else if (actualValid && schemaCase.semantic === "cache-v2") {
    actualValid = cacheSemantic(parsed, 2);
  } else if (actualValid && schemaCase.semantic === "watchlist-v0") {
    actualValid = watchlistSemantic(parsed, 0);
  } else if (actualValid && schemaCase.semantic === "watchlist-v1") {
    actualValid = watchlistSemantic(parsed, 1);
  }
  equal(
    Boolean(actualValid),
    schemaCase.valid,
    `${schemaCase.id} validity must stay classified`,
  );
}

const transitionCaseIds = new Set();
for (const transitionCase of fixtureManifest.transitionCases) {
  const expectedKeys = {
    "credential-config-v0-to-keychain-v1": [
      "id",
      "transition",
      "source",
      "keychain",
      "expectedConfig",
      "expectedKeychain",
      "expectedKeychainWrites",
      "result",
    ],
    "approval-config-v0-to-v1": [
      "id",
      "transition",
      "source",
      "expected",
      "result",
    ],
    "cache-v1-to-v2": ["id", "transition", "source", "expected", "result"],
    "quota-root-v0-to-v1": ["id", "transition", "source", "expected", "result"],
    "watchlist-v0-to-v1": ["id", "transition", "source", "expected", "result"],
  }[transitionCase.transition];
  invariant(expectedKeys, `${transitionCase.id} has an unknown transition`);
  equalKeys(transitionCase, expectedKeys, `transition ${transitionCase.id}`);
  invariant(
    transitionIds.includes(transitionCase.transition),
    `${transitionCase.id} references an unknown migration transition`,
  );
  invariant(
    !transitionCaseIds.has(transitionCase.id),
    `duplicate transition case ${transitionCase.id}`,
  );
  transitionCaseIds.add(transitionCase.id);
}
for (const transitionId of transitionIds) {
  invariant(
    fixtureManifest.transitionCases.some(
      (entry) => entry.transition === transitionId,
    ),
    `${transitionId} needs an executable fixture case`,
  );
}

for (const transitionCase of fixtureManifest.transitionCases.filter(
  ({ transition }) => transition === "credential-config-v0-to-keychain-v1",
)) {
  const sourceBytes = await fixture(transitionCase.source);
  const expectedConfigBytes = await fixture(transitionCase.expectedConfig);
  const expectedKeychainBytes = await fixture(transitionCase.expectedKeychain);
  const source = JSON.parse(sourceBytes);
  const expectedConfig = JSON.parse(expectedConfigBytes);
  invariant(
    typeof source.apiKey === "string" && source.apiKey.length > 0,
    `${transitionCase.id} needs a nonempty legacy credential`,
  );
  const validCredentialSource = stateValid(
    stateSchemas["legacy-config-v0.schema.json"],
    source,
  );
  const keychainBytes =
    transitionCase.keychain === "absent"
      ? undefined
      : await fixture(transitionCase.keychain);
  let keychain;
  let invalidPresentKeychain = false;
  if (validCredentialSource && keychainBytes !== undefined) {
    try {
      keychain = JSON.parse(keychainBytes);
    } catch {
      invalidPresentKeychain = true;
    }
  }
  const conflict =
    !invalidPresentKeychain &&
    keychain !== undefined &&
    keychain.secret !== source.apiKey;
  const noWrite = !validCredentialSource || invalidPresentKeychain || conflict;
  const actualConfig = noWrite
    ? source
    : Object.fromEntries(
        Object.entries(source).filter(([key]) => key !== "apiKey"),
      );
  const actualKeychain =
    !validCredentialSource || invalidPresentKeychain
      ? undefined
      : (keychain ?? {
          version: 1,
          service: migrations.credential.keychain.service,
          account: migrations.credential.keychain.account,
          secret: source.apiKey,
        });
  const result = !validCredentialSource
    ? "legacy-state-invalid-no-writes"
    : invalidPresentKeychain
      ? "invalid-present-keychain-no-writes"
      : conflict
        ? "migration-conflict-no-writes"
        : "migrated";
  equal(
    transitionCase.result,
    result,
    `${transitionCase.id} result must follow exact keychain identity`,
  );
  equal(
    transitionCase.expectedKeychainWrites,
    noWrite ? 0 : keychainBytes === undefined ? 1 : 0,
    `${transitionCase.id} keychain writes must be exact`,
  );
  equal(actualConfig, expectedConfig, `${transitionCase.id} config result`);
  if (validCredentialSource && !invalidPresentKeychain) {
    equal(
      actualKeychain,
      JSON.parse(expectedKeychainBytes),
      `${transitionCase.id} keychain result`,
    );
  }
  if (noWrite) {
    equal(
      sourceBytes,
      expectedConfigBytes,
      `${transitionCase.id} must preserve exact config bytes`,
    );
    equal(
      keychainBytes,
      expectedKeychainBytes,
      `${transitionCase.id} must preserve exact keychain fixture bytes`,
    );
  }
  if (!noWrite) {
    validateState(
      stateSchemas["legacy-config-v0.schema.json"],
      actualConfig,
      `${transitionCase.id} config output must validate`,
    );
    validateState(
      stateSchemas["credential-keychain-fixture-v1.schema.json"],
      actualKeychain,
      `${transitionCase.id} keychain output must validate`,
    );
  }
}

function approvalSourceKind(observation) {
  if (
    observation &&
    typeof observation === "object" &&
    typeof observation.state === "string" &&
    typeof observation.validUntil === "string" &&
    typeof observation.credentialId === "string"
  ) {
    return "bound";
  }
  if (
    observation &&
    typeof observation === "object" &&
    typeof observation.approved === "boolean" &&
    typeof observation.checkedAt === "string"
  ) {
    return "unbound";
  }
  return "invalid";
}
for (const transitionCase of fixtureManifest.transitionCases.filter(
  ({ transition }) => transition === "approval-config-v0-to-v1",
)) {
  const sourceBytes = await fixture(transitionCase.source);
  const expectedBytes = await fixture(transitionCase.expected);
  const source = JSON.parse(sourceBytes);
  const expected = JSON.parse(expectedBytes);
  const sourceHasApiKey =
    source !== null &&
    typeof source === "object" &&
    Object.hasOwn(source, "apiKey");
  invariant(
    !sourceHasApiKey,
    `${transitionCase.id} must run after credential migration`,
  );
  const validLegacySource = stateValid(
    stateSchemas["legacy-config-v0.schema.json"],
    source,
  );
  const observations = validLegacySource
    ? Object.values(source.serviceStatus ?? {})
    : [];
  const kinds = new Set(observations.map(approvalSourceKind));
  const allBound =
    observations.length > 0 && kinds.size === 1 && kinds.has("bound");
  const allUnbound =
    observations.length === 0 || (kinds.size === 1 && kinds.has("unbound"));
  const versionCollision =
    validLegacySource &&
    Object.hasOwn(source, "version") &&
    source.version !== 1;
  const actual =
    !validLegacySource || versionCollision
      ? source
      : allBound
        ? { ...source, version: 1 }
        : allUnbound
          ? { ...source, version: 1, serviceStatus: {} }
          : source;
  const result =
    !validLegacySource || versionCollision
      ? "legacy-state-invalid-no-writes"
      : allBound
        ? "bound-service-status-preserved"
        : allUnbound
          ? "empty-service-status-preserve-other-keys"
          : "legacy-state-invalid-no-writes";
  equal(transitionCase.result, result, `${transitionCase.id} result`);
  equal(actual, expected, `${transitionCase.id} approval result`);
  if (result === "legacy-state-invalid-no-writes") {
    equal(
      sourceBytes,
      expectedBytes,
      `${transitionCase.id} must preserve exact source bytes`,
    );
  }
  if (result !== "legacy-state-invalid-no-writes") {
    validateState(
      stateSchemas["approval-config-v1.schema.json"],
      actual,
      `${transitionCase.id} approval output must validate`,
    );
    invariant(
      approvalSemantic(actual),
      `${transitionCase.id} approval output must be semantically valid`,
    );
  }
}
for (const transitionCase of fixtureManifest.transitionCases.filter(
  ({ transition }) => transition === "cache-v1-to-v2",
)) {
  const sourceBytes = await fixture(transitionCase.source);
  const expectedBytes = await fixture(transitionCase.expected);
  const source = JSON.parse(sourceBytes);
  const operation = operations.find(({ path }) => path === source.endpoint);
  const validSource =
    stateValid(generatedCacheSchemaObjects[paths.cacheV1Schema], source) &&
    cacheSemantic(source, 1) &&
    operation !== undefined;
  const actual = validSource
    ? {
        version: 2,
        operationId: operation.operationId,
        schemaSha256: operation.contractId,
        fetchedAt: source.fetchedAt,
        params: source.params,
        rows: source.data,
      }
    : source;
  const result = validSource ? "migrated" : "legacy-state-invalid-no-writes";
  equal(transitionCase.result, result, `${transitionCase.id} result`);
  equal(actual, JSON.parse(expectedBytes), `${transitionCase.id} cache result`);
  if (validSource) {
    validateState(
      generatedCacheSchemaObjects[paths.cacheV2Schema],
      actual,
      `${transitionCase.id} cache output must validate`,
    );
  } else {
    equal(
      sourceBytes,
      expectedBytes,
      `${transitionCase.id} must preserve exact source bytes`,
    );
  }
}
for (const transitionCase of fixtureManifest.transitionCases.filter(
  ({ transition }) => transition === "quota-root-v0-to-v1",
)) {
  const sourceBytes = await fixture(transitionCase.source);
  const expectedBytes = await fixture(transitionCase.expected);
  const source = JSON.parse(sourceBytes);
  const validSource = stateValid(
    stateSchemas["quota-root-v0.schema.json"],
    source,
  );
  const actual = validSource
    ? {
        version: 1,
        credentials: {
          [credentialFingerprint]: {
            date: source.date,
            count: source.count + 1,
          },
        },
      }
    : source;
  const result = validSource ? "reserved" : "legacy-state-invalid-no-writes";
  equal(transitionCase.result, result, `${transitionCase.id} result`);
  equal(actual, JSON.parse(expectedBytes), `${transitionCase.id} quota result`);
  if (validSource) {
    validateState(
      stateSchemas["quota-v1.schema.json"],
      actual,
      `${transitionCase.id} quota output must validate`,
    );
  } else {
    equal(
      sourceBytes,
      expectedBytes,
      `${transitionCase.id} must preserve exact source bytes`,
    );
  }
}
const watchlistV0Fixture = JSON.parse(await fixture("watchlist-v0.json"));
const watchlistV1Fixture = JSON.parse(await fixture("watchlist-v1.json"));
const watchlistTransition = { version: 1, entries: watchlistV0Fixture };
equal(
  watchlistTransition,
  watchlistV1Fixture,
  "watchlist fixture transition must preserve order and values",
);
validateState(
  stateSchemas["watchlist-v1.schema.json"],
  watchlistTransition,
  "watchlist transition output must validate",
);
invariant(
  fixtureManifest.proceduralCases.length >= 10 &&
    new Set(fixtureManifest.proceduralCases).size ===
      fixtureManifest.proceduralCases.length,
  "migration contract needs unique concurrency, crash, link, and coexistence cases",
);
invariant(
  fixtureManifest.proceduralCases.includes(
    "stale-v1-offline-read-without-promotion",
  ) && !fixtureManifest.proceduralCases.includes("stale-v1-offline-promotion"),
  "offline version-1 fixture must prove a read without promotion",
);

const sourceDigests = {
  openapiSha256: sha256(openapiSource),
  profileSha256: sha256(profileSource),
  errorsSha256: sha256(errorsSource),
  cliOverlaySha256: sha256(overlaySource),
  cliCasesSha256: sha256(cliCasesSource),
  nodeSdkSha256: sha256(nodeContractSource),
  rustSdkConsumerSha256: sha256(rustContractSource),
  nodePackageSha256: sha256(nodePackageSource),
  nativeTargetsSha256: sha256(nativeTargetsSource),
  migrationsSha256: sha256(migrationsSource),
  fixturesSha256: sha256(fixturesSource),
  runtimeCasesSha256: sha256(runtimeCasesSource),
  stateSchemasSha256: sha256(
    stateSchemaNames
      .map((name) => `${name}\n${stateSchemaSources[name]}`)
      .join("\n"),
  ),
};
const product = await formattedJson(
  {
    schemaVersion: 1,
    id: profile.id,
    generatedFrom: {
      openapi: "contracts/krx/openapi.yaml",
      profile: "contracts/product/v1/profile.yaml",
      errors: "contracts/product/v1/errors.yaml",
      cliOverlay: "contracts/product/v1/cli-overlay.json",
      cliCases: "contracts/product/v1/cli-cases.json",
      nodeSdk: "contracts/product/v1/node-sdk.d.ts",
      rustSdkConsumer: "contracts/product/v1/rust-sdk-consumer.rs",
      nodePackage: "contracts/product/v1/node-package-surface.json",
      nativeTargets: "contracts/product/v1/native-targets.json",
      migrations: "contracts/product/v1/migrations.yaml",
      fixtures: "contracts/product/v1/fixtures/manifest.yaml",
      runtimeCases: "contracts/product/v1/consumers/node-runtime-cases.json",
      stateSchemas: "contracts/product/v1/state/*.schema.json",
    },
    sourceDigests,
    operations,
    operationSets: profile.operationSets,
    approvalProbes: profile.approvalProbes,
    composites: profile.composites,
    defaults: profile.defaults,
    provenance: profile.provenance,
    errors: {
      publicFields: errors.publicFields,
      kinds: Object.fromEntries(
        kindEntries.map(([kind, value]) => [
          kind,
          { cliExit: value.cliExit, codes: value.codes },
        ]),
      ),
      httpMappings: errors.httpMappings,
      responseMappings: errors.responseMappings,
      compositePriority: errors.compositePriority,
      resultExitPolicies: errors.resultExitPolicies,
    },
  },
  paths.product,
);
const candidateInventorySource = await formattedJson(
  candidateInventory,
  paths.candidateInventory,
);
const activePathsByScope = Object.fromEntries(
  Object.entries(overlay.optionPolicy.scopeCommands).map(
    ([scope, commandPaths]) => [
      scope,
      new Set(commandPaths.map((commandPath) => JSON.stringify(commandPath))),
    ],
  ),
);
const candidateLeafPaths = candidateInventory
  .filter((entry) => !entry.commands || entry.commands.length === 0)
  .map((entry) => entry.path);
const cliOptionMatrix = await formattedJson(
  {
    schemaVersion: 1,
    generatedFrom: {
      inventory: "contracts/generated/candidate-command-inventory.json",
      policy: "contracts/product/v1/cli-overlay.json#optionPolicy",
    },
    entries: behavioralRootOptions.flatMap((option) =>
      candidateLeafPaths.map((commandPath) => ({
        option,
        commandPath,
        active: overlay.optionPolicy.activeRootOptionScopes[option].some(
          (scope) => activePathsByScope[scope].has(JSON.stringify(commandPath)),
        ),
        inactiveExit: overlay.optionPolicy.inactiveRootOptionExit,
      })),
    ),
  },
  paths.cliOptionMatrix,
);

async function emit(path, expected) {
  if (write) {
    await writeFile(path, expected, "utf8");
    return;
  }
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    throw new Error(`generated product contract artifact is missing: ${path}`);
  }
  invariant(
    actual === expected,
    `generated product contract artifact is stale: ${path}`,
  );
}

if (!skipArtifacts) {
  await Promise.all([
    emit(paths.product, product),
    emit(paths.nodeOperations, nodeOperations),
    emit(paths.nodeErrors, nodeErrors),
    emit(paths.rustOperations, rustOperations),
    emit(paths.candidateInventory, candidateInventorySource),
    emit(paths.cliOptionMatrix, cliOptionMatrix),
    emit(paths.cacheV1Schema, generatedCacheV1),
    emit(paths.cacheV2Schema, generatedCacheV2),
  ]);
}

process.stdout.write(
  `${write ? "wrote" : "validated"} product contract ${profile.id} (${operations.length} derived operations)\n`,
);
