import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(
    new URL(`../../${path}`, import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
}

describe("private Git release policy", () => {
  it("builds Git dependencies and gates tags on verified upstream main", () => {
    const packageJson = JSON.parse(readRepositoryFile("package.json"));
    const release = packageJson["release-it"];

    expect(packageJson.scripts.prepare).toContain("pnpm build");
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

  it("certifies tagged Git installs without publishing to npm", () => {
    const workflow = readRepositoryFile(".github/workflows/release.yml");

    expect(workflow).toContain("name: Tagged release certification");
    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).toContain("Smoke-test Git installation");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("registry.npmjs.org");
  });
});
