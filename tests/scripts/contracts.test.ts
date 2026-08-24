/* eslint-disable @typescript-eslint/no-explicit-any -- Contract mutants deliberately edit untyped YAML trees into invalid states. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = process.cwd();
const canonicalPath = join(root, "contracts/krx/openapi.yaml");

function run(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/contracts.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function mutatedOpenApi(
  name: string,
  mutate: (document: Record<string, any>) => void,
): string {
  const directory = mkdtempSync(join(tmpdir(), "krx-contract-mutation-"));
  const path = join(directory, `${name}.yaml`);
  const document = YAML.parse(readFileSync(canonicalPath, "utf8"));
  mutate(document);
  writeFileSync(path, YAML.stringify(document), "utf8");
  return path;
}

function expectRejected(path: string, pattern: RegExp) {
  const result = run("--openapi", path, "--skip-artifacts");
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(pattern);
}

describe("canonical contract gate", () => {
  it("accepts the canonical source and checked projections", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an unsupported root webhook surface", () => {
    const path = mutatedOpenApi("webhook", (document) => {
      document.webhooks = {
        providerEvent: Object.values(document.paths)[0],
      };
    });
    expectRejected(path, /root must not expose unsupported API surfaces/u);
  });

  it("rejects a provider path mutation", () => {
    const path = mutatedOpenApi("path", (document) => {
      const paths = document.paths;
      const [first] = Object.keys(paths);
      paths[`${first}_mutant`] = paths[first];
      delete paths[first];
    });
    expectRejected(path, /legacy schema oracle/u);
  });

  it("rejects an HTTP method mutation", () => {
    const path = mutatedOpenApi("method", (document) => {
      const item = Object.values(document.paths)[0] as Record<string, unknown>;
      item.get = item.post;
      delete item.post;
    });
    expectRejected(path, /POST only/u);
  });

  it("rejects an operation-level security override", () => {
    const path = mutatedOpenApi("operation-security", (document) => {
      const operation = Object.values(document.paths)[0] as Record<string, any>;
      operation.post.security = [];
    });
    expectRejected(path, /must inherit root security/u);
  });

  it("rejects an operation-level server override", () => {
    const path = mutatedOpenApi("operation-server", (document) => {
      const operation = Object.values(document.paths)[0] as Record<string, any>;
      operation.post.servers = [{ url: "https://mirror.invalid" }];
    });
    expectRejected(path, /must inherit the root server/u);
  });

  it("rejects an operation-level parameter", () => {
    const path = mutatedOpenApi("operation-parameter", (document) => {
      const operation = Object.values(document.paths)[0] as Record<string, any>;
      operation.post.parameters = [
        {
          name: "market",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
      ];
    });
    expectRejected(path, /must use its JSON request body only/u);
  });

  it("rejects an auth-header mutation", () => {
    const path = mutatedOpenApi("auth-header", (document) => {
      document.components.securitySchemes.KrxApiKey.name = "X_AUTH_KEY";
    });
    expectRejected(path, /security scheme must match reviewed evidence/u);
  });

  it("rejects a required-request-field mutation", () => {
    const path = mutatedOpenApi("request", (document) => {
      document.components.schemas.TradingDateRequest.required = [];
    });
    expectRejected(path, /must require its reviewed date field/u);
  });

  it("rejects an optional request-field mutation", () => {
    const path = mutatedOpenApi("optional-request", (document) => {
      document.components.schemas.TradingDateRequest.properties.market = {
        type: "string",
      };
    });
    expectRejected(path, /must accept only its reviewed request field/u);
  });

  it("rejects a success-envelope mutation", () => {
    const path = mutatedOpenApi("envelope", (document) => {
      const responseName = Object.keys(document.components.schemas).find(
        (name) => name.endsWith("Response"),
      );
      const response = document.components.schemas[responseName as string];
      response.required = ["OutBlock_2"];
    });
    expectRejected(path, /must require its reviewed success envelope/u);
  });

  it("rejects a non-array success-envelope container", () => {
    const path = mutatedOpenApi("envelope-container", (document) => {
      const responseName = Object.keys(document.components.schemas).find(
        (name) => name.endsWith("Response"),
      );
      const response = document.components.schemas[responseName as string];
      response.properties.OutBlock_1.type = "object";
    });
    expectRejected(path, /success envelope must contain an array/u);
  });

  it("rejects behavior added beside a schema reference", () => {
    const path = mutatedOpenApi("reference-sibling", (document) => {
      const operation = Object.values(document.paths)[0] as Record<string, any>;
      operation.post.responses["200"].content[
        "application/json"
      ].schema.oneOf[0].not = {};
    });
    expectRejected(path, /schema reference must not have sibling behavior/u);
  });

  it("rejects an additional success-response media type", () => {
    const path = mutatedOpenApi("response-media", (document) => {
      const operation = Object.values(document.paths)[0] as Record<string, any>;
      operation.post.responses["200"].content["application/xml"] = {
        schema: { type: "string" },
      };
    });
    expectRejected(path, /reviewed JSON media type only/u);
  });

  it("rejects an unsupported success-response header", () => {
    const path = mutatedOpenApi("response-header", (document) => {
      const operation = Object.values(document.paths)[0] as Record<string, any>;
      operation.post.responses["200"].headers = {
        "X-Provider-Version": { schema: { type: "string" } },
      };
    });
    expectRejected(path, /HTTP-200 response must stay bounded/u);
  });

  it("rejects a response-field mutation", () => {
    const path = mutatedOpenApi("response-field", (document) => {
      const rowName = Object.keys(document.components.schemas).find((name) =>
        name.endsWith("Row"),
      );
      const row = document.components.schemas[rowName as string];
      const [field] = Object.keys(row.properties);
      delete row.properties[field];
      row.required = row.required.filter((name: string) => name !== field);
    });
    expectRejected(path, /legacy schema oracle/u);
  });

  it("rejects a provider-error wire-field mutation", () => {
    const path = mutatedOpenApi("error-field", (document) => {
      const error = document.components.schemas.KrxError;
      error.properties.providerCode = error.properties.respCode;
      delete error.properties.respCode;
      error.anyOf[0].required = ["providerCode"];
    });
    expectRejected(path, /error fields must match reviewed evidence/u);
  });

  it("rejects a provider-error response reference mutation", () => {
    const path = mutatedOpenApi("error-reference", (document) => {
      const operation = Object.values(document.paths)[0] as Record<string, any>;
      operation.post.responses["200"].content[
        "application/json"
      ].schema.oneOf[1] =
        operation.post.responses["200"].content[
          "application/json"
        ].schema.oneOf[0];
    });
    expectRejected(path, /canonical KRX error envelope/u);
  });

  it("rejects a JSON body added to the opaque default response", () => {
    const path = mutatedOpenApi("default-body", (document) => {
      const operation = Object.values(document.paths)[0] as Record<string, any>;
      operation.post.responses.default.content = {
        "application/json": {
          schema: { $ref: "#/components/schemas/KrxError" },
        },
      };
    });
    expectRejected(
      path,
      /default response body must remain optional and opaque/u,
    );
  });

  it("rejects duplicate operation identities", () => {
    const path = mutatedOpenApi("operation-id", (document) => {
      const items = Object.values(document.paths) as Array<{
        post: { operationId: string };
      }>;
      items[1].post.operationId = items[0].post.operationId;
    });
    expectRejected(path, /duplicate operationId/u);
  });

  it("rejects a stale generated artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-contract-artifact-"));
    const registry = join(directory, "registry.ts");
    writeFileSync(registry, "// stale\n", "utf8");
    const sourceRoot = mkdtempSync(join(tmpdir(), "krx-empty-source-"));
    const result = run("--registry", registry, "--source-root", sourceRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/generated contract artifact is stale/u);
  });

  it("rejects an injected handwritten endpoint mirror", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "krx-contract-source-"));
    writeFileSync(
      join(sourceRoot, "mirror.ts"),
      'export const endpoint = "/svc/apis/sto/stk_bydd_trd";\n',
      "utf8",
    );
    const result = run("--source-root", sourceRoot, "--skip-artifacts");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/handwritten provider endpoint literal/u);
  });

  it("rejects an injected provider-path-prefix mirror", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "krx-contract-prefix-"));
    writeFileSync(
      join(sourceRoot, "mirror.js"),
      'export const prefix = "/svc/apis/";\n',
      "utf8",
    );
    const result = run("--source-root", sourceRoot, "--skip-artifacts");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/handwritten shared wire fact/u);
  });

  it("rejects a shared wire mirror in Rust sources", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "krx-contract-rust-source-"));
    writeFileSync(
      join(sourceRoot, "mirror.rs"),
      'pub const ERROR_FIELD: &str = "respCode";\n',
      "utf8",
    );
    const result = run("--source-root", sourceRoot, "--skip-artifacts");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/handwritten shared wire fact/u);
  });

  it("ignores generated Cargo target output while scanning maintained Rust", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "krx-contract-rust-target-"));
    const generated = join(
      sourceRoot,
      "target",
      "debug",
      "build",
      "probe",
      "out",
    );
    mkdirSync(generated, { recursive: true });
    writeFileSync(
      join(generated, "wire_contract.rs"),
      'pub const GENERATED_PATH: &str = "/svc/apis/sto/stk_bydd_trd";\n',
      "utf8",
    );
    writeFileSync(
      join(sourceRoot, "maintained.rs"),
      "pub struct Safe;\n",
      "utf8",
    );
    const result = run(
      "--source-root",
      sourceRoot,
      "--generated-source-root",
      join(sourceRoot, "target"),
      "--skip-artifacts",
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("does not let a maintained target directory bypass wire scanning", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "krx-maintained-target-"));
    const maintained = join(sourceRoot, "target");
    mkdirSync(maintained, { recursive: true });
    writeFileSync(
      join(maintained, "mirror.rs"),
      'pub const ENDPOINT: &str = "/svc/apis/sto/stk_bydd_trd";\n',
      "utf8",
    );
    const result = run("--source-root", sourceRoot, "--skip-artifacts");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/handwritten provider endpoint literal/u);
  });
});
