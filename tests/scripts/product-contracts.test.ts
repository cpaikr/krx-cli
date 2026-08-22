/* eslint-disable @typescript-eslint/no-explicit-any -- Contract mutants deliberately create invalid untyped documents. */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = process.cwd();

function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/product-contracts.mjs", ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

function mutatedYaml(
  source: string,
  name: string,
  mutate: (document: Record<string, any>) => void,
): string {
  const directory = mkdtempSync(join(tmpdir(), "krx-product-contract-"));
  const target = join(directory, `${name}.yaml`);
  const document = YAML.parse(readFileSync(join(root, source), "utf8"));
  mutate(document);
  writeFileSync(target, YAML.stringify(document), "utf8");
  return target;
}

function mutatedJson(
  source: string,
  name: string,
  mutate: (document: Record<string, any>) => void,
): string {
  const directory = mkdtempSync(join(tmpdir(), "krx-product-contract-"));
  const target = join(directory, `${name}.json`);
  const document = JSON.parse(readFileSync(join(root, source), "utf8"));
  mutate(document);
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return target;
}

function mutatedText(source: string, name: string, mutation: string): string {
  const directory = mkdtempSync(join(tmpdir(), "krx-product-contract-"));
  const target = join(directory, basename(source));
  writeFileSync(
    target,
    `${readFileSync(join(root, source), "utf8")}\n${mutation}\n`,
    "utf8",
  );
  return target;
}

function mutatedFixtureManifest(
  name: string,
  mutate: (document: Record<string, any>, directory: string) => void,
): string {
  const directory = mkdtempSync(join(tmpdir(), "krx-product-fixtures-"));
  cpSync(join(root, "contracts/product/v1/fixtures"), directory, {
    recursive: true,
  });
  const target = join(directory, `${name}.yaml`);
  const document = YAML.parse(
    readFileSync(join(directory, "manifest.yaml"), "utf8"),
  );
  for (const schemaCase of document.schemaCases) {
    if (schemaCase.schema) {
      schemaCase.schema = join(
        root,
        "contracts/product/v1/fixtures",
        schemaCase.schema,
      );
    }
  }
  mutate(document, directory);
  writeFileSync(target, YAML.stringify(document), "utf8");
  return target;
}

function expectRejected(args: readonly string[], pattern: RegExp) {
  const result = run(...args, "--skip-artifacts");
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(pattern);
}

describe("product contract gate", () => {
  it("accepts every canonical public and persisted-state contract", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it("writes and validates every JSON projection at extensionless paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-product-projections-"));
    const jsonProjections = [
      ["--product-artifact", "product"],
      ["--candidate-inventory", "inventory"],
      ["--cli-option-matrix", "option-matrix"],
      ["--cache-v1-schema", "cache-v1"],
      ["--cache-v2-schema", "cache-v2"],
    ] as const;
    const supportProjections = [
      ["--node-operations", "node-operations"],
      ["--node-errors", "node-errors"],
      ["--rust-operations", "rust-operations"],
    ] as const;
    const args = [...jsonProjections, ...supportProjections].flatMap(
      ([option, name]) => [option, join(directory, name)],
    );
    const fixtures = mutatedFixtureManifest(
      "extensionless-projections",
      (document) => {
        for (const schemaCase of document.schemaCases) {
          if (schemaCase.schema?.endsWith("cache-v1.schema.json")) {
            schemaCase.schema = join(directory, "cache-v1");
          } else if (schemaCase.schema?.endsWith("cache-v2.schema.json")) {
            schemaCase.schema = join(directory, "cache-v2");
          }
        }
      },
    );
    args.push("--fixtures", fixtures);

    const writeResult = run(...args, "--write");
    expect(writeResult.status, writeResult.stderr).toBe(0);
    for (const [, name] of jsonProjections) {
      expect(() =>
        JSON.parse(readFileSync(join(directory, name), "utf8")),
      ).not.toThrow();
    }

    const validateResult = run(...args);
    expect(validateResult.status, validateResult.stderr).toBe(0);
  });

  it("rejects a second maintained operation inventory", () => {
    const profile = mutatedYaml(
      "contracts/product/v1/profile.yaml",
      "operation-inventory",
      (document) => {
        document.operations = ["stock_stk_bydd_trd"];
      },
    );
    expectRejected(["--profile", profile], /profile must have exact keys/u);
  });

  it("rejects a semantic reference outside canonical OpenAPI", () => {
    const profile = mutatedYaml(
      "contracts/product/v1/profile.yaml",
      "unknown-operation",
      (document) => {
        document.composites.stockSearch.components.KOSPI =
          "arbitrary_operation";
      },
    );
    expectRejected(
      ["--profile", profile],
      /must reference an OpenAPI operationId/u,
    );
  });

  it("rejects an unbounded retry default", () => {
    const profile = mutatedYaml(
      "contracts/product/v1/profile.yaml",
      "retries",
      (document) => {
        document.defaults.retries = 4;
      },
    );
    expectRejected(["--profile", profile], /must not exceed 3/u);
  });

  it("rejects an error code assigned to multiple kinds", () => {
    const errors = mutatedYaml(
      "contracts/product/v1/errors.yaml",
      "duplicate-code",
      (document) => {
        document.kinds.network.codes.deadline_exceeded = true;
      },
    );
    expectRejected(["--errors", errors], /error code must be globally unique/u);
  });

  it("rejects an incomplete composite error ordering", () => {
    const errors = mutatedYaml(
      "contracts/product/v1/errors.yaml",
      "priority",
      (document) => {
        document.compositePriority.pop();
      },
    );
    expectRejected(
      ["--errors", errors],
      /total-order all runtime error kinds/u,
    );
  });

  it("rejects weakening the public error redaction boundary", () => {
    const errors = mutatedYaml(
      "contracts/product/v1/errors.yaml",
      "public-error-fields",
      (document) => {
        document.publicFields.forbidden = ["rawBody"];
      },
    );
    expectRejected(
      ["--errors", errors],
      /forbidden public error fields must stay closed/u,
    );
  });

  it("rejects a missing provider error mapping", () => {
    const errors = mutatedYaml(
      "contracts/product/v1/errors.yaml",
      "missing-provider-mapping",
      (document) => {
        document.httpMappings.pop();
      },
    );
    expectRejected(
      ["--errors", errors],
      /must cover every non-overlapping provider outcome/u,
    );
  });

  it("rejects a scalar lookalike for the 5xx status set", () => {
    const errors = mutatedYaml(
      "contracts/product/v1/errors.yaml",
      "scalar-5xx-mapping",
      (document) => {
        document.httpMappings.find((mapping: Record<string, unknown>) =>
          Array.isArray(mapping.match),
        ).match = "500,502,503,504";
      },
    );
    expectRejected(
      ["--errors", errors],
      /must cover every non-overlapping provider outcome/u,
    );
  });

  it("rejects a CLI overlay removal with no legacy target", () => {
    const overlay = mutatedJson(
      "contracts/product/v1/cli-overlay.json",
      "unknown-command",
      (document) => {
        document.inventoryChanges[0].name = "unknown";
      },
    );
    expectRejected(["--overlay", overlay], /removed command does not exist/u);
  });

  it("rejects permissive handling of unclassified CLI differences", () => {
    const overlay = mutatedJson(
      "contracts/product/v1/cli-overlay.json",
      "unclassified",
      (document) => {
        document.compatibilityPolicy.unclassifiedDifference = "accept";
      },
    );
    expectRejected(["--overlay", overlay], /must block/u);
  });

  it("rejects an added command without exact option topology", () => {
    const overlay = mutatedJson(
      "contracts/product/v1/cli-overlay.json",
      "added-command-options",
      (document) => {
        delete document.inventoryChanges[1].options;
      },
    );
    expectRejected(
      ["--overlay", overlay],
      /inventoryChanges\.1 must have exact keys/u,
    );
  });

  it("rejects dependency types in the Node public boundary", () => {
    const nodeContract = mutatedText(
      "contracts/product/v1/node-sdk.d.ts",
      "node-sdk.d.ts",
      "export type LeakedTransport = reqwest;",
    );
    expectRejected(
      ["--node-contract", nodeContract],
      /must not expose reqwest/u,
    );
  });

  it("rejects adapter types in the Rust public boundary", () => {
    const rustContract = mutatedText(
      "contracts/product/v1/rust-sdk-consumer.rs",
      "rust-sdk-consumer.rs",
      "// clap must remain adapter-private",
    );
    expectRejected(["--rust-contract", rustContract], /must not expose clap/u);
  });

  it("rejects a public native-binding export", () => {
    const nodePackage = mutatedJson(
      "contracts/product/v1/node-package-surface.json",
      "native-export",
      (document) => {
        document.publicNativeBindingSubpath = true;
      },
    );
    expectRejected(
      ["--node-package", nodePackage],
      /native Node binding must stay private/u,
    );
  });

  it("rejects an unsupported native target claim", () => {
    const nativeTargets = mutatedJson(
      "contracts/product/v1/native-targets.json",
      "native-targets",
      (document) => {
        document.targets.push({
          id: "linux-x64-musl",
          rustTarget: "x86_64-unknown-linux-musl",
          nodePlatform: "linux",
          nodeArch: "x64",
          nodeBinding: "native/krx.linux-x64-musl.node",
          executable: "bin/krx",
        });
      },
    );
    expectRejected(
      ["--native-targets", nativeTargets],
      /native target set and archive paths must stay exact/u,
    );
  });

  it("rejects local-state relocation", () => {
    const migrations = mutatedYaml(
      "contracts/product/v1/migrations.yaml",
      "state-root",
      (document) => {
        document.root.path = "~/.config/krx-cli";
      },
    );
    expectRejected(
      ["--migrations", migrations],
      /root must remain compatible/u,
    );
  });

  it("rejects offline network access", () => {
    const migrations = mutatedYaml(
      "contracts/product/v1/migrations.yaml",
      "offline-network",
      (document) => {
        document.offline.touchesNetwork = true;
      },
    );
    expectRejected(
      ["--migrations", migrations],
      /offline must not use network/u,
    );
  });

  it("rejects an untyped bounded-scan failure", () => {
    const migrations = mutatedYaml(
      "contracts/product/v1/migrations.yaml",
      "cache-scan-error",
      (document) => {
        document.bounds.scanLimitBehavior = "stop";
      },
    );
    expectRejected(
      ["--migrations", migrations],
      /bounded cache scans must map to the stable error catalog/u,
    );
  });

  it("rejects a dangling migration schema reference", () => {
    const migrations = mutatedYaml(
      "contracts/product/v1/migrations.yaml",
      "dangling-schema",
      (document) => {
        document.stores.approval.targetSchema =
          "state/missing-approval.schema.json";
      },
    );
    expectRejected(
      ["--migrations", migrations],
      /migration schema references must stay exact/u,
    );
  });

  it("rejects a fixture identity that does not match exact secret bytes", () => {
    const fixtures = mutatedYaml(
      "contracts/product/v1/fixtures/manifest.yaml",
      "fingerprint",
      (document) => {
        document.credentialFingerprint = "0".repeat(64);
      },
    );
    expectRejected(
      ["--fixtures", fixtures],
      /fingerprint must use exact UTF-8/u,
    );
  });

  it("rejects a mislabeled credential migration conflict", () => {
    const fixtures = mutatedFixtureManifest(
      "credential-conflict",
      (document) => {
        document.transitionCases.find(
          (entry: Record<string, unknown>) =>
            entry.id === "credential-conflicting-keychain",
        ).result = "migrated";
      },
    );
    expectRejected(
      ["--fixtures", fixtures],
      /result must follow exact keychain identity/u,
    );
  });

  it("rejects an empty present keychain as absent", () => {
    const fixtures = mutatedFixtureManifest(
      "credential-empty-present",
      (document) => {
        document.transitionCases.find(
          (entry: Record<string, unknown>) =>
            entry.id === "credential-empty-present-keychain",
        ).result = "migrated";
      },
    );
    expectRejected(
      ["--fixtures", fixtures],
      /result must follow exact keychain identity/u,
    );
  });

  it("rejects keychain conflict classification before credential source validation", () => {
    const fixtures = mutatedFixtureManifest(
      "credential-invalid-source-precedence",
      (document) => {
        document.transitionCases.find(
          (entry: Record<string, unknown>) =>
            entry.id === "credential-invalid-source-precedes-keychain-conflict",
        ).result = "migration-conflict-no-writes";
      },
    );
    expectRejected(
      ["--fixtures", fixtures],
      /result must follow exact keychain identity/u,
    );
  });

  it("rejects a mislabeled approval version collision", () => {
    const fixtures = mutatedFixtureManifest(
      "approval-version-collision",
      (document) => {
        document.transitionCases.find(
          (entry: Record<string, unknown>) =>
            entry.id === "approval-bound-version-collision",
        ).result = "bound-service-status-preserved";
      },
    );
    expectRejected(
      ["--fixtures", fixtures],
      /approval-bound-version-collision result/u,
    );
  });

  it("rejects a mislabeled invalid approval source", () => {
    const fixtures = mutatedFixtureManifest(
      "approval-invalid-source",
      (document) => {
        document.transitionCases.find(
          (entry: Record<string, unknown>) =>
            entry.id === "approval-invalid-source-preserved",
        ).result = "empty-service-status-preserve-other-keys";
      },
    );
    expectRejected(
      ["--fixtures", fixtures],
      /approval-invalid-source-preserved result/u,
    );
  });

  it("rejects semantic-only preservation of invalid approval state", () => {
    const fixtures = mutatedFixtureManifest(
      "approval-invalid-source-bytes",
      (document, directory) => {
        const transition = document.transitionCases.find(
          (entry: Record<string, unknown>) =>
            entry.id === "approval-invalid-source-preserved",
        );
        transition.expected = "legacy-config-invalid-status-reordered-v0.json";
        writeFileSync(
          join(directory, transition.expected),
          '{\n    "serviceStatus": null,\n    "owner": "legacy"\n}\n',
          "utf8",
        );
      },
    );
    expectRejected(
      ["--fixtures", fixtures],
      /must preserve exact source bytes/u,
    );
  });

  it("rejects a state schema that does not compile", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-state-schemas-"));
    cpSync(join(root, "contracts/product/v1/state"), directory, {
      recursive: true,
    });
    const schemaPath = join(directory, "quota-root-v0.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    schema.properties.count.type = "not-a-json-schema-type";
    writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    expectRejected(
      ["--state-schema-root", directory],
      /state schema does not compile/u,
    );
  });

  it("rejects a stale generated product artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "krx-product-artifact-"));
    const artifact = join(directory, "product.json");
    writeFileSync(artifact, "{}\n", "utf8");
    const result = run("--product-artifact", artifact);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /generated product contract artifact is stale/u,
    );
  });
});
