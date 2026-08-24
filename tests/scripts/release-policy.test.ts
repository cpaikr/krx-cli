import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

function readRepositoryFile(path: string): string {
  return readFileSync(
    new URL(`../../${path}`, import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
}

const approvedBlacksmithRunners = new Set([
  "blacksmith-2vcpu-ubuntu-2404",
  "blacksmith-2vcpu-ubuntu-2404-arm",
]);

function assertBlacksmithWorkflow(source: string): void {
  const workflow = YAML.parse(source) as {
    jobs?: Record<string, Record<string, unknown>>;
  };
  expect(workflow.jobs).toBeDefined();

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    if (job.uses !== undefined) {
      expect(
        job.uses,
        `${jobName} must call a local reusable workflow`,
      ).toMatch(/^\.\/\.github\/workflows\//u);
      continue;
    }

    const runsOn = job["runs-on"];
    expect(runsOn, `${jobName} must declare runs-on`).toBeTypeOf("string");
    if (runsOn === "${{ matrix.runner }}") {
      const strategy = job.strategy as {
        matrix?: {
          runner?: unknown;
          include?: Array<{ runner?: unknown }>;
        };
      };
      const matrix = strategy.matrix;
      const runnerAxis = Array.isArray(matrix?.runner) ? matrix.runner : [];
      const includeRunners = (matrix?.include ?? []).map(
        (candidate) => candidate.runner,
      );
      const candidates = [...runnerAxis, ...includeRunners];
      expect(
        candidates.length,
        `${jobName} must declare a nonempty matrix runner domain`,
      ).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(
          typeof candidate === "string" &&
            approvedBlacksmithRunners.has(candidate),
          `${jobName} has an unapproved matrix runner ${String(candidate)}`,
        ).toBe(true);
      }
      continue;
    }
    if (runsOn === "${{ matrix.target.runner }}") {
      const strategy = job.strategy as {
        matrix?: { target?: Array<{ runner?: string }> };
      };
      for (const candidate of strategy.matrix?.target ?? []) {
        expect(
          approvedBlacksmithRunners.has(candidate.runner ?? ""),
          `${jobName} has an unapproved target runner ${candidate.runner}`,
        ).toBe(true);
      }
      continue;
    }

    expect(
      approvedBlacksmithRunners.has(String(runsOn)),
      `${jobName} has an unapproved runner ${String(runsOn)}`,
    ).toBe(true);
  }
}

describe("private Git release policy", () => {
  it("uses Blacksmith Linux runners without macOS or Windows CI jobs", () => {
    const workflows = [
      ".github/workflows/ci.yml",
      ".github/workflows/contract-drift.yml",
      ".github/workflows/release.yml",
      ".github/workflows/rust-vertical-slice.yml",
    ].map(readRepositoryFile);

    for (const workflow of workflows) assertBlacksmithWorkflow(workflow);

    expect(workflows[0]).toContain(
      "macOS and Windows are intentionally omitted to reduce CI compute cost",
    );
    expect(workflows[3]).toContain(
      "continuous CI intentionally omits them to reduce compute cost",
    );
  });

  it("rejects non-Blacksmith literal, matrix, and added-job runners", () => {
    const ci = readRepositoryFile(".github/workflows/ci.yml");
    expect(() =>
      assertBlacksmithWorkflow(
        ci.replace(
          "runs-on: blacksmith-2vcpu-ubuntu-2404",
          "runs-on: self-hosted",
        ),
      ),
    ).toThrow(/unapproved runner self-hosted/u);

    const native = readRepositoryFile(
      ".github/workflows/rust-vertical-slice.yml",
    );
    expect(() =>
      assertBlacksmithWorkflow(
        native.replace(
          "runner: blacksmith-2vcpu-ubuntu-2404-arm",
          "runner: ubuntu-24.04-arm",
        ),
      ),
    ).toThrow(/unapproved matrix runner ubuntu-24\.04-arm/u);

    expect(() =>
      assertBlacksmithWorkflow(
        `${ci}\n  unauthorized:\n    runs-on: self-hosted\n    steps: []\n`,
      ),
    ).toThrow(/unauthorized has an unapproved runner self-hosted/u);

    expect(() =>
      assertBlacksmithWorkflow(
        `${ci}\n  unauthorized-matrix:\n    runs-on: \${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [self-hosted]\n    steps: []\n`,
      ),
    ).toThrow(
      /unauthorized-matrix has an unapproved matrix runner self-hosted/u,
    );
  });

  it("keeps the root maintainer-only and gates tags on verified upstream main", () => {
    const packageJson = JSON.parse(readRepositoryFile("package.json"));
    const release = packageJson["release-it"];

    expect(packageJson.private).toBe(true);
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.dependencies).toBeUndefined();
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
      expect(packageJson.scripts[hook]).toBeUndefined();
    }
    expect(packageJson.repository.url).toBe(
      "git+https://github.com/cpaikr/krx-cli.git",
    );
    expect(release.git).toMatchObject({
      requireBranch: "main",
      requireCleanWorkingDir: true,
      requireUpstream: true,
    });
    expect(release.hooks["after:init"]).toEqual([
      `test "$(git rev-parse HEAD)" = "$(git rev-parse '@{upstream}')"`,
      "pnpm verify",
    ]);
    expect(release.npm.publish).toBe(false);
  });

  it("certifies tagged private native archives without source installation", () => {
    const workflow = readRepositoryFile(".github/workflows/release.yml");
    const nativePackage = JSON.parse(
      readRepositoryFile("packages/node/package.json"),
    );

    expect(workflow).toContain("name: Tagged native release certification");
    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).toContain("scripts/native-package/assemble.mjs");
    expect(workflow).toContain("scripts/native-package/pack.mjs");
    expect(workflow).toContain("scripts/native-package/certify.mjs");
    expect(workflow).toContain(
      "macOS ARM64 and Windows x64 remain supported manifest targets",
    );
    expect(workflow).not.toContain("pnpm build");
    expect(workflow).not.toContain("git+file:");
    expect(workflow).not.toContain("allow-build");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("registry.npmjs.org");
    expect(nativePackage.files).toContain("LICENSE");
  });

  it("runs general CI only for pull requests or manual dispatch", () => {
    const source = readRepositoryFile(".github/workflows/ci.yml");
    const workflow = YAML.parse(source) as {
      on?: Record<string, unknown>;
    };
    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.on?.pull_request).toBeDefined();
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(source).toContain(
      "macOS and Windows are intentionally omitted to reduce CI compute cost",
    );
  });
});
