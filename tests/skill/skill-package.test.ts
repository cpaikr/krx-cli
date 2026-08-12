import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const skillRoot = resolve(repositoryRoot, "skills/krx-cli");

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function readSkillFile(path: string): string {
  return readFileSync(resolve(skillRoot, path), "utf8");
}

describe("krx-cli skill package", () => {
  it("uses one portable nested entry point with direct resource routing", () => {
    const entry = readSkillFile("SKILL.md");
    const frontmatter = entry.match(/^---\n([\s\S]*?)\n---/)?.[1];

    expect(frontmatter).toBeDefined();
    expect(frontmatter?.match(/^[a-z][a-z-]*:/gm)).toEqual([
      "name:",
      "description:",
    ]);
    expect(frontmatter).toContain("name: krx-cli");
    expect(entry.split("\n").length).toBeLessThan(100);
    expect(existsSync(resolve(repositoryRoot, "SKILL.md"))).toBe(false);

    const links = [...entry.matchAll(/\]\(([^)]+\.md)\)/g)].map(
      ([, path]) => path,
    );
    expect(links).toEqual([
      "references/cli-usage.md",
      "workflows/apply-service-access.md",
    ]);
    for (const path of links) {
      expect(existsSync(resolve(skillRoot, path))).toBe(true);
    }
  });

  it("keeps portable runtime guidance independent of named agent clients", () => {
    const runtime = [
      readSkillFile("SKILL.md"),
      readSkillFile("references/cli-usage.md"),
      readSkillFile("workflows/apply-service-access.md"),
    ].join("\n");

    expect(runtime).not.toMatch(/\b(?:ChatGPT|Chrome|Claude|Codex|Cursor)\b/);
    expect(runtime).not.toMatch(/(?:\/Users\/|~\/|\.\.\/)/);
  });

  it("separates read-only status requests from authorized applications", () => {
    const entry = readSkillFile("SKILL.md");
    const description = entry.match(/^description: (.+)$/m)?.[1];

    expect(description).toContain("Query and analyze");
    expect(description).toContain("express request");
    expect(description).toContain("all current or unapproved endpoints");
    expect(description).toContain("service-access applications");
    expect(description).toContain(
      "Route status-only questions exclusively to the CLI branch",
    );
    expect(entry).toContain("status-only requests");
    expect(entry).toContain("never submit applications");
  });

  it("defines stable identity, failure boundaries, and final reconciliation", () => {
    const workflow = readSkillFile("workflows/apply-service-access.md");
    const unwrappedWorkflow = workflow.replace(/\s+/g, " ");

    expect(workflow).toContain("Do not rely on a hard-coded endpoint count");
    expect(workflow).toContain("category + endpoint code");
    expect(workflow).toContain("category + canonical detail URL");
    expect(unwrappedWorkflow).toContain("Stop the batch immediately");
    expect(unwrappedWorkflow).toContain("unknown confirmation result");
    expect(unwrappedWorkflow).toContain(
      "Treat the notification as submission evidence",
    );

    for (const state of [
      "existing-approved",
      "newly-approved",
      "submitted-pending",
      "failed",
      "unknown",
    ]) {
      expect(workflow).toContain(`\`${state}\``);
    }
    expect(unwrappedWorkflow).toContain("Report complete success only when");
    expect(unwrappedWorkflow).toContain(
      "no endpoint is pending, failed, unknown",
    );
  });

  it("ships the nested skill and documents whole-directory installation", () => {
    const packageJson = JSON.parse(readRepositoryFile("package.json"));
    const readme = readRepositoryFile("README.md");

    expect(packageJson.files).toContain("skills");
    expect(packageJson.files).not.toContain("SKILL.md");
    expect(packageJson.scripts).not.toHaveProperty("sync-skill-version");
    expect(readme).toContain("npx skills add sjunepark/krx-cli");
    expect(readme).toContain("cp -R skills/krx-cli");
    expect(readme).toContain("krx-cli.md.legacy");
  });
});
