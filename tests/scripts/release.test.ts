import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const temporary: string[] = [];
const revision = "a".repeat(40);
const nativeTargets = JSON.parse(
  readFileSync(join(root, "contracts/product/v1/native-targets.json"), "utf8"),
);

function scratch() {
  const path = mkdtempSync(join(tmpdir(), "krx-release-test-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function run(
  script: string,
  cwd: string,
  args: string[] = [],
  env = process.env,
) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function cargoFixture() {
  const cwd = scratch();
  mkdirSync(join(cwd, "member/src"), { recursive: true });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "release-fixture",
      version: "1.2.3",
      private: true,
    }),
  );
  writeFileSync(
    join(cwd, "Cargo.toml"),
    '[workspace]\nmembers = ["member"]\nresolver = "3"\n[workspace.package]\nversion = "1.2.3"\nedition = "2024"\n',
  );
  writeFileSync(
    join(cwd, "member/Cargo.toml"),
    '[package]\nname = "release-fixture"\nversion.workspace = true\nedition.workspace = true\n',
  );
  writeFileSync(join(cwd, "member/src/lib.rs"), "pub fn example() {}\n");
  copyFileSync(
    join(root, "rust-toolchain.toml"),
    join(cwd, "rust-toolchain.toml"),
  );
  const result = spawnSync("cargo", ["generate-lockfile", "--offline"], {
    cwd,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  copyFileSync(
    join(root, "scripts/release-version.mjs"),
    join(cwd, "release-version.mjs"),
  );
  return cwd;
}
function prepareReleaseFixture(failVerification = false) {
  const cwd = cargoFixture();
  const packagePath = join(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg["release-it"] = {
    git: { requireBranch: false, requireUpstream: false, push: false },
    github: false,
    npm: { publish: false },
    hooks: {
      "after:bump": [
        "node release-version.mjs sync",
        failVerification ? "node fail.cjs" : "node release-version.mjs check",
      ],
    },
  };
  writeFileSync(packagePath, JSON.stringify(pkg));
  writeFileSync(join(cwd, "fail.cjs"), "process.exit(1);\n");
  git(cwd, "init", "-b", "release-fixture");
  git(cwd, "config", "user.name", "Release Fixture");
  git(cwd, "config", "user.email", "release-fixture@example.invalid");
  git(cwd, "config", "core.hooksPath", join(cwd, "no-hooks"));
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

describe("release version preparation", () => {
  it("uses the real release-it bump to synchronize Cargo and its lock before tagging", () => {
    const cwd = prepareReleaseFixture();
    const result = run("node_modules/release-it/bin/release-it.js", cwd, [
      "patch",
      "--ci",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version,
    ).toBe("1.2.4");
    expect(readFileSync(join(cwd, "Cargo.toml"), "utf8")).toContain(
      'version = "1.2.4"',
    );
    expect(readFileSync(join(cwd, "Cargo.lock"), "utf8")).toContain(
      'version = "1.2.4"',
    );
    expect(git(cwd, "tag", "--list")).toBe("1.2.4");
    expect(git(cwd, "status", "--short")).toBe("");
  });

  it("does not commit or tag a bump whose verification fails", () => {
    const cwd = prepareReleaseFixture(true);
    const before = git(cwd, "rev-parse", "HEAD");
    const result = run("node_modules/release-it/bin/release-it.js", cwd, [
      "patch",
      "--ci",
    ]);
    expect(result.status).not.toBe(0);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
    expect(git(cwd, "tag", "--list")).toBe("");
  });

  it("rejects a stale Cargo lockfile without repairing it", () => {
    const cwd = cargoFixture();
    const lock = readFileSync(join(cwd, "Cargo.lock"), "utf8");
    writeFileSync(
      join(cwd, "Cargo.toml"),
      readFileSync(join(cwd, "Cargo.toml"), "utf8").replace("1.2.3", "1.2.4"),
    );
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ version: "1.2.4" }),
    );
    const result = run("scripts/release-version.mjs", cwd, ["check"]);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(cwd, "Cargo.lock"), "utf8")).toBe(lock);
  });

  it("rejects a release tag that differs from the package version", () => {
    const cwd = cargoFixture();
    const result = run("scripts/release-version.mjs", cwd, ["check", "v9.9.9"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "release tag must match the package version",
    );
  });
});

function artifactFixture() {
  const cwd = scratch();
  mkdirSync(join(cwd, "contracts/product/v1"), { recursive: true });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  writeFileSync(
    join(cwd, "contracts/product/v1/native-targets.json"),
    JSON.stringify(nativeTargets),
  );
  mkdirSync(join(cwd, "artifacts"));
  mkdirSync(join(cwd, "reports"));
  for (const target of nativeTargets.targets) {
    const bytes = Buffer.from(`archive bytes for ${target.id}`);
    const name = `krx-cli-1.2.3-${target.id}.tgz`;
    writeFileSync(join(cwd, "artifacts", name), bytes);
    for (const node of nativeTargets.distribution.continuousCertificationTargets.includes(
      target.id,
    )
      ? nativeTargets.distribution.nodeMajors
      : []) {
      writeFileSync(
        join(cwd, "reports", `${target.id}-node${node}.json`),
        JSON.stringify({
          status: "passed",
          target: target.id,
          node,
          packageVersion: "1.2.3",
          sourceRevision: revision,
          archiveSha256: createHash("sha256").update(bytes).digest("hex"),
          portableSha256: "b".repeat(64),
          packageMetadata: { name: "krx-cli" },
          capability: ["stock"],
        }),
      );
    }
  }
  return cwd;
}
function bundle(cwd: string) {
  return run("scripts/native-package/release-assets.mjs", cwd, [
    "--artifacts",
    "artifacts",
    "--reports",
    "reports",
    "--out",
    "bundle",
    "--revision",
    revision,
  ]);
}

describe("complete certified release bundle", () => {
  it("includes all four archives with Linux consumer evidence and accurate certification coverage", () => {
    const cwd = artifactFixture();
    const result = bundle(cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(cwd, "bundle"))).toHaveLength(6);
    const manifest = JSON.parse(
      readFileSync(join(cwd, "bundle/release-manifest.json"), "utf8"),
    );
    expect(manifest.sourceRevision).toBe(revision);
    expect(
      manifest.targets.map((target: { target: string }) => target.target),
    ).toEqual(nativeTargets.targets.map((target: { id: string }) => target.id));
    for (const target of manifest.targets) {
      expect(target.nodeMajors).toEqual(
        nativeTargets.distribution.continuousCertificationTargets.includes(
          target.target,
        )
          ? [22, 24]
          : [],
      );
      expect(readFileSync(join(cwd, "bundle/SHA256SUMS"), "utf8")).toContain(
        `${target.sha256}  ${target.archive}\n`,
      );
    }
  });

  it("requires non-Linux archives even without consumer reports", () => {
    const cwd = artifactFixture();
    rmSync(join(cwd, "artifacts/krx-cli-1.2.3-win32-x64-msvc.tgz"));
    expect(bundle(cwd).status).not.toBe(0);
    expect(existsSync(join(cwd, "bundle"))).toBe(false);
  });

  it.each([
    "missing consumer",
    "changed archive",
    "wrong source",
    "wrong version",
    "failed consumer",
    "divergent portable sources",
  ])("rejects %s before producing a bundle", (failure) => {
    const cwd = artifactFixture();
    const reportPath = join(cwd, "reports/linux-x64-gnu-node22.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (failure === "missing consumer") rmSync(reportPath);
    else if (failure === "changed archive")
      writeFileSync(
        join(cwd, "artifacts/krx-cli-1.2.3-linux-x64-gnu.tgz"),
        "changed",
      );
    else {
      if (failure === "wrong source") report.sourceRevision = "c".repeat(40);
      if (failure === "wrong version") report.packageVersion = "9.9.9";
      if (failure === "failed consumer") report.status = "failed";
      if (failure === "divergent portable sources")
        report.portableSha256 = "d".repeat(64);
      writeFileSync(reportPath, JSON.stringify(report));
    }
    expect(bundle(cwd).status).not.toBe(0);
    expect(existsSync(join(cwd, "bundle"))).toBe(false);
  });
});

function publicationFixture() {
  const cwd = artifactFixture();
  const result = bundle(cwd);
  expect(result.status, result.stderr).toBe(0);
  mkdirSync(join(cwd, "bin"));
  mkdirSync(join(cwd, "assets"));
  copyFileSync(
    join(root, "tests/fixtures/release/gh.cjs"),
    join(cwd, "bin/gh"),
  );
  chmodSync(join(cwd, "bin/gh"), 0o755);
  writeFileSync(
    join(cwd, "state.json"),
    JSON.stringify({ revision, release: null, calls: [] }),
  );
  return cwd;
}
function publish(cwd: string, extra: Record<string, string> = {}) {
  return run(
    "scripts/native-package/publish-release.mjs",
    cwd,
    ["bundle", "v1.2.3"],
    {
      ...process.env,
      PATH: `${join(cwd, "bin")}${delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: "fixture/release",
      FAKE_GH_ROOT: cwd,
      ...extra,
    },
  );
}
function state(cwd: string) {
  return JSON.parse(readFileSync(join(cwd, "state.json"), "utf8"));
}

describe("release publication through the GitHub CLI boundary", () => {
  it("publishes only after uploading and downloading the complete bundle, and reruns without mutations", () => {
    const cwd = publicationFixture();
    const result = publish(cwd);
    expect(result.status, result.stderr).toBe(0);
    const first = state(cwd);
    expect(first.release.draft).toBe(false);
    expect(readdirSync(join(cwd, "assets")).sort()).toEqual(
      readdirSync(join(cwd, "bundle")).sort(),
    );
    const commands = first.calls.map((args: string[]) =>
      args.slice(0, 2).join(" "),
    );
    expect(commands.indexOf("release download")).toBeLessThan(
      commands.indexOf("release edit"),
    );
    expect(publish(cwd).status).toBe(0);
    const subsequent = state(cwd).calls.slice(first.calls.length);
    expect(
      subsequent.every(
        (args: string[]) =>
          args[0] === "api" || args[1] === "view" || args[1] === "download",
      ),
    ).toBe(true);
  });

  it("resumes an interrupted draft upload without replacing existing assets", () => {
    const cwd = publicationFixture();
    expect(publish(cwd, { FAKE_GH_INTERRUPT_UPLOAD: "1" }).status).not.toBe(0);
    expect(state(cwd).release.draft).toBe(true);
    expect(readdirSync(join(cwd, "assets"))).toHaveLength(1);
    const result = publish(cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(state(cwd).release.draft).toBe(false);
  });

  it("leaves a draft unpublished when downloaded bytes differ", () => {
    const cwd = publicationFixture();
    const result = publish(cwd, { FAKE_GH_CORRUPT_DOWNLOAD: "1" });
    expect(result.status).not.toBe(0);
    expect(state(cwd).release.draft).toBe(true);
  });

  it("does not replace differing published assets", () => {
    const cwd = publicationFixture();
    expect(publish(cwd).status).toBe(0);
    const path = join(cwd, "assets/SHA256SUMS");
    writeFileSync(path, "different published bytes");
    const before = state(cwd).calls.length;
    expect(publish(cwd).status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe("different published bytes");
    expect(
      state(cwd)
        .calls.slice(before)
        .every(
          (args: string[]) =>
            args[0] === "api" || args[1] === "view" || args[1] === "download",
        ),
    ).toBe(true);
  });

  it("does not mistake an authorization failure for a missing release", () => {
    const cwd = publicationFixture();
    expect(publish(cwd, { FAKE_GH_DENIED: "1" }).status).not.toBe(0);
    expect(state(cwd).release).toBeNull();
  });
});
