import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(repositoryRoot, "package.json");
const skillPath = resolve(repositoryRoot, "SKILL.md");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const version = packageJson.version;

if (
  typeof version !== "string" ||
  !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)
) {
  throw new Error("package.json does not contain a valid version");
}

const skill = await readFile(skillPath, "utf8");
const versionPattern = /^(\s*version:\s*)"[^"]*"(\s*)$/gm;
const matches = [...skill.matchAll(versionPattern)];

if (matches.length !== 1) {
  throw new Error(
    `Expected exactly one quoted metadata version in SKILL.md, found ${matches.length}`,
  );
}

const updatedSkill = skill.replace(versionPattern, `$1"${version}"$2`);
await writeFile(skillPath, updatedSkill, "utf8");
