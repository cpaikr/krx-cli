import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  credentialFingerprint,
  reserveCall,
} from "../../src/client/rate-limit.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const workspaceDependencyLines = [
  'clap = { version = "=4.6.6", features = ["derive"] }',
  'futures-util = "=0.3.34"',
  'jiff = { version = "=0.2.35", default-features = false, features = ["serde", "std"] }',
  'keyring = "=4.1.6"',
  'napi = { version = "=3.12.2", default-features = false, features = ["async", "napi8", "tokio_rt"] }',
  'napi-build = "=2.4.1"',
  'napi-derive = "=3.6.3"',
  'num-bigint = "=0.5.1"',
  'reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls", "stream"] }',
  'rustix = { version = "=1.1.4", default-features = false, features = ["fs", "process", "std"] }',
  'serde = { version = "=1.0.229", features = ["derive"] }',
  'serde_json = "=1.0.151"',
  'serde-saphyr = { version = "=1.1.0", default-features = false, features = ["deserialize"] }',
  'sha2 = "=0.11.0"',
  'thiserror = "=2.0.20"',
  'tokio = { version = "=1.53.1", features = ["fs", "io-util", "macros", "net", "rt-multi-thread", "signal", "sync", "time"] }',
  'tokio-util = "=0.7.19"',
  'url = "=2.5.8"',
  'uuid = { version = "=1.25.0", features = ["serde", "v4"] }',
  'zeroize = { version = "=1.9.0", features = ["derive"] }',
] as const;

function assertWorkspaceDependencyPins(source: string): void {
  for (const line of workspaceDependencyLines) {
    if (!source.includes(line)) {
      throw new Error(`workspace dependency contract is missing ${line}`);
    }
  }
}

function assertDomainPolicySources(sources: {
  readonly adjustment: string;
  readonly build: string;
  readonly request: string;
  readonly result: string;
}): void {
  const transitionStart = sources.adjustment.indexOf("fn transition_string(");
  const transitionEnd = sources.adjustment.indexOf(
    "pub(crate) fn adjust_stock_rows(",
    transitionStart,
  );
  const transitionFormatter = sources.adjustment.slice(
    transitionStart,
    transitionEnd,
  );
  const exactTransitionFormat =
    '{{\\"date\\":\\"{}\\",\\"previousClose\\":\\"{}\\",\\"previousDate\\":\\"{}\\",\\"ratio\\":{{\\"denominator\\":\\"{}\\",\\"numerator\\":\\"{}\\"}},\\"referencePrice\\":\\"{}\\"}}';
  const required = [
    [sources.build, 'deserialize_with = "ordered_string_map"'],
    [sources.request, "pub const MAX_DAYS: usize = 10_000;"],
    [sources.result, "krx-adjustment-transition/v1"],
    [sources.adjustment, "krx-adjustment-transition/v1"],
    [transitionFormatter, exactTransitionFormat],
  ] as const;
  for (const [source, marker] of required) {
    if (!source.includes(marker)) {
      throw new Error(`Rust SDK domain policy is missing ${marker}`);
    }
  }
}

function assertQuotaStateProtocolSource(source: string): void {
  const ownerStart = source.indexOf("fn write_lock_owner(");
  const ownerEnd = source.indexOf("fn abandon_new_lock(", ownerStart);
  const ownerPublication = source.slice(ownerStart, ownerEnd);
  const ownerSync = ownerPublication.indexOf("file.sync_all()");
  const ownerLink = ownerPublication.indexOf("rustix::fs::linkat(");
  const publicationStart = source.indexOf("fn publish_steal_claim(");
  const publicationEnd = source.indexOf(
    "fn read_steal_claim(",
    publicationStart,
  );
  const publication = source.slice(publicationStart, publicationEnd);
  const mismatchStart = publication.indexOf("if claim.owner != claimant");
  const mismatchEnd = publication.indexOf("Ok(Some(claim))", mismatchStart);
  const mismatch = publication.slice(mismatchStart, mismatchEnd);
  if (
    ownerStart < 0 ||
    ownerEnd < 0 ||
    ownerSync < 0 ||
    ownerLink <= ownerSync ||
    !ownerPublication.includes(
      'let candidate = OsString::from(format!(".owner.{owner}.tmp"));',
    ) ||
    !ownerPublication.includes(
      '&candidate,\n            lock_directory,\n            "owner",',
    ) ||
    publicationStart < 0 ||
    publicationEnd < 0 ||
    mismatchStart < 0 ||
    mismatchEnd < 0 ||
    !publication.includes("let mut published = None;") ||
    !publication.includes("let Some(claim) = &published") ||
    !publication.includes("release_steal_claim(lock_directory, claim);") ||
    mismatch.includes("release_steal_claim")
  ) {
    throw new Error(
      "Rust quota owner/claim publication protocol is incomplete",
    );
  }
}

function assertNodeQuotaStateProtocolSource(source: string): void {
  const ownerStart = source.indexOf("function publishLockOwner(");
  const ownerEnd = source.indexOf("function publishStealClaim(", ownerStart);
  const ownerPublication = source.slice(ownerStart, ownerEnd);
  const ownerWrite = ownerPublication.indexOf("fs.writeFileSync(candidatePath");
  const ownerLink = ownerPublication.indexOf(
    "fs.linkSync(candidatePath, ownerPath)",
  );
  const claimStart = source.indexOf("function publishStealClaim(");
  const claimEnd = source.indexOf("function tryStealStaleLock(", claimStart);
  const claimPublication = source.slice(claimStart, claimEnd);
  const acquisitionStart = source.indexOf("async function acquireLock(");
  const acquisitionEnd = source.indexOf(
    "/**\n * Atomically reserve one local quota unit",
    acquisitionStart,
  );
  const acquisition = source.slice(acquisitionStart, acquisitionEnd);
  const publishedOwner = acquisition.indexOf(
    "const publishedOwner = publishLockOwner(",
  );
  const inspectionCatch = acquisition.indexOf(
    "} catch (error) {",
    publishedOwner,
  );
  const failedInspectionCleanup = acquisition.indexOf(
    "releasePublishedOwner(lockPath, acquiredLock, publishedOwner);",
    inspectionCatch,
  );
  const inspectionRethrow = acquisition.indexOf(
    "throw error;",
    failedInspectionCleanup,
  );
  const ownerValidation = acquisition.indexOf(
    "if (\n          claim ||",
    inspectionRethrow,
  );
  if (
    ownerStart < 0 ||
    ownerEnd < 0 ||
    ownerWrite < 0 ||
    ownerLink <= ownerWrite ||
    !ownerPublication.includes("readLockOwner(lockPath)") ||
    claimStart < 0 ||
    claimEnd < 0 ||
    !claimPublication.includes("claim.owner !== claimant") ||
    acquisitionStart < 0 ||
    acquisitionEnd < 0 ||
    publishedOwner < 0 ||
    inspectionCatch <= publishedOwner ||
    failedInspectionCleanup <= inspectionCatch ||
    inspectionRethrow <= failedInspectionCleanup ||
    ownerValidation <= inspectionRethrow ||
    failedInspectionCleanup >= ownerValidation ||
    source.includes('fs.writeFileSync(path.join(lockPath, "owner")')
  ) {
    throw new Error("Node quota owner publication must be atomic and verified");
  }
}

describe("production Rust SDK gate", () => {
  it("owns a pinned workspace without probe or adapter dependencies", () => {
    const workspace = read("Cargo.toml");
    const sdk = read("crates/krx-sdk/Cargo.toml");
    const lock = read("Cargo.lock");

    expect(workspace).toContain('members = ["crates/krx-sdk"]');
    expect(workspace).toContain('rust-version = "1.92"');
    expect(sdk).not.toMatch(/probes|clap|napi/u);
    assertWorkspaceDependencyPins(workspace);
    for (const [name, version] of [
      ["serde", "1.0.229"],
      ["serde_json", "1.0.151"],
      ["serde-saphyr", "1.1.0"],
      ["jiff", "0.2.35"],
      ["num-bigint", "0.5.1"],
      ["rustix", "1.1.4"],
      ["tokio-util", "0.7.19"],
      ["zeroize", "1.9.0"],
    ]) {
      expect(lock).toMatch(
        new RegExp(
          `name = "${name}"\\nversion = "${version.replaceAll(".", "\\.")}"`,
          "u",
        ),
      );
    }

    expect(() =>
      assertWorkspaceDependencyPins(
        workspace.replace('sha2 = "=0.11.0"', 'sha2 = "0.11"'),
      ),
    ).toThrow(/workspace dependency contract is missing sha2/u);
  });

  it("derives production wire tables into Cargo output from canonical artifacts", () => {
    const build = read("crates/krx-sdk/build.rs");
    const source = read("crates/krx-sdk/src/operation.rs");

    expect(build).toContain('join("contracts/krx/openapi.yaml")');
    expect(build).toContain('join("contracts/generated/product-v1.json")');
    expect(build).toContain('env::var_os("OUT_DIR")');
    expect(build).toContain("product.operations.len()");
    expect(source).toContain(
      'concat!(env!("OUT_DIR"), "/operation_contract.rs")',
    );
    expect(source).not.toContain("probes/");
  });

  it("freezes ordered composites, bounded ranges, and transition grammar", () => {
    const sources = {
      adjustment: read("crates/krx-sdk/src/adjustment.rs"),
      build: read("crates/krx-sdk/build.rs"),
      request: read("crates/krx-sdk/src/request.rs"),
      result: read("crates/krx-sdk/src/result.rs"),
    };
    expect(() => assertDomainPolicySources(sources)).not.toThrow();
    expect(() =>
      assertDomainPolicySources({
        ...sources,
        adjustment: sources.adjustment.replace(
          "krx-adjustment-transition/v1",
          "krx-adjustment-transition/v2",
        ),
      }),
    ).toThrow(/domain policy is missing krx-adjustment-transition\/v1/u);
    expect(() =>
      assertDomainPolicySources({
        ...sources,
        adjustment: sources.adjustment.replace(
          '\\"denominator\\":\\"{}\\",\\"numerator\\":\\"{}\\"',
          '\\"numerator\\":\\"{}\\",\\"denominator\\":\\"{}\\"',
        ),
      }),
    ).toThrow(/Rust SDK domain policy is missing/u);
  });

  it("runs locked strict validation on both Blacksmith Linux architectures", () => {
    const workflow = YAML.parse(read(".github/workflows/rust-sdk.yml"));
    const paths = workflow.on.pull_request.paths as string[];
    const job = workflow.jobs.sdk;

    expect(workflow.on.push).toBeUndefined();
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(true);
    expect(paths).toEqual([
      ".github/workflows/rust-sdk.yml",
      "Cargo.lock",
      "Cargo.toml",
      "contracts/generated/**",
      "contracts/krx/**",
      "contracts/product/**",
      "crates/krx-sdk/**",
      "rust-toolchain.toml",
      "src/calendar/krx-closures.json",
      "tests/fixtures/adjusted-stock-prices/oracles.json",
      "tests/scripts/release-policy.test.ts",
      "tests/scripts/rust-sdk.test.ts",
    ]);
    expect(job.strategy.matrix.include).toEqual([
      { arch: "x64", runner: "blacksmith-2vcpu-ubuntu-2404" },
      { arch: "arm64", runner: "blacksmith-2vcpu-ubuntu-2404-arm" },
    ]);
    expect(
      job.steps.map((step: { run?: string }) => step.run).filter(Boolean),
    ).toEqual(
      expect.arrayContaining([
        "cargo fmt --all --check",
        "cargo check --locked --workspace --all-targets --all-features",
        "cargo clippy --locked --workspace --all-targets --all-features -- -D warnings",
        "cargo test --locked --workspace --all-features",
      ]),
    );
  });

  it("freezes the crash-recoverable shared quota lock protocol", () => {
    const migrations = YAML.parse(
      read("contracts/product/v1/migrations.yaml"),
    ) as {
      transitions: Array<{ id: string; lockProtocol?: unknown }>;
    };
    const quota = migrations.transitions.find(
      (migration) => migration.id === "quota-root-v0-to-v1",
    );
    expect(quota?.lockProtocol).toEqual({
      acquisition: "mkdir",
      directoryMode: "0700",
      directoryOwnership: "current-user",
      ownerFile: "owner",
      ownerMode: "0600",
      ownerOwnership: "current-user",
      ownerMaximumBytes: 128,
      ownerGrammar:
        "^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      ownerCandidate: "rate-limit.json.lock/.owner.<owner>.tmp",
      ownerPublication:
        "in-created-directory-prepared-file-hard-link-no-replace",
      creatorReturnRevalidation: "same-created-directory-identity",
      failedAcquisitionCleanup:
        "descriptor-relative-owner-removal-no-pathname-directory-delete",
      pollMs: 25,
      timeoutMs: 5000,
      staleAfterMs: 30000,
      stealRequiresOwnerDead: true,
      stealClaimFile: "steal",
      stealClaimMode: "0600",
      stealClaimOwnership: "current-user",
      stealClaimMaximumBytes: 128,
      stealClaimOwnerGrammar:
        "^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      stealClaimCandidate: "rate-limit.json.lock/.steal.<owner>.tmp",
      stealClaimPublication:
        "in-observed-directory-prepared-file-hard-link-no-replace",
      stealClaimRecovery:
        "dead-published-claim-races-one-deterministic-retained-tombstone",
      stealTombstone: ".rate-limit.json.lock.stale-<steal-owner>",
      stealTombstoneRetention: "permanent-nonempty-fence",
      ownerPublicationRevalidation: "no-steal-claim-after-owner-durable",
      stealRevalidation: [
        "same-lock-directory-identity",
        "same-regular-owner-only-owner-identity-and-bytes",
        "unchanged-dead-lock-owner",
        "same-regular-owner-only-claim-identity-and-bytes",
      ],
      steal: "rename-to-claim-derived-nonempty-tombstone-and-retain",
      symlinkPolicy: "reject",
    });
    const nodeQuota = read("src/client/rate-limit.ts");
    expect(nodeQuota).toContain("const claim = readStealClaim(lockPath);");
    expect(nodeQuota).toContain(
      "sameProtocolFileObservation(readLockOwner(lockPath), observedOwner)",
    );
    expect(nodeQuota).toContain(
      "path.join(lockPath, `.steal.${claimant}.tmp`)",
    );
    expect(nodeQuota).toContain("path.join(lockPath, `.owner.${owner}.tmp`)");
    expect(() => assertNodeQuotaStateProtocolSource(nodeQuota)).not.toThrow();
    expect(() =>
      assertNodeQuotaStateProtocolSource(
        nodeQuota.replace(
          "fs.linkSync(candidatePath, ownerPath)",
          "fs.renameSync(candidatePath, ownerPath)",
        ),
      ),
    ).toThrow(/owner publication must be atomic/u);
    expect(() =>
      assertNodeQuotaStateProtocolSource(
        nodeQuota.replace("claim.owner !== claimant", "false"),
      ),
    ).toThrow(/owner publication must be atomic/u);
    expect(() =>
      assertNodeQuotaStateProtocolSource(
        nodeQuota.replace(
          "releasePublishedOwner(lockPath, acquiredLock, publishedOwner);",
          "void publishedOwner;",
        ),
      ),
    ).toThrow(/owner publication must be atomic/u);
    const rustState = read("crates/krx-sdk/src/state.rs");
    expect(rustState).toContain(
      "match read_steal_claim(&lock_directory, error_code)",
    );
    expect(rustState).toContain(
      "rustix::fs::openat(\n        lock_directory,\n        &candidate,",
    );
    expect(rustState).toContain(
      'let candidate = OsString::from(format!(".owner.{owner}.tmp"));',
    );
    expect(rustState).toContain(
      "path_matches_directory(&parent, &leaf[0], &created_identity, error_code)",
    );
    expect(rustState).toContain(
      "fn abandon_new_lock(lock_directory: &OwnedFd)",
    );
    expect(() => assertQuotaStateProtocolSource(rustState)).not.toThrow();
    expect(() =>
      assertQuotaStateProtocolSource(
        rustState.replace("rustix::fs::linkat(", "rustix::fs::renameat("),
      ),
    ).toThrow(/owner\/claim publication protocol/u);
    expect(() =>
      assertQuotaStateProtocolSource(
        rustState.replace(
          'return Err(state_error(\n                error_code,\n                "local steal claim identity changed",\n            ));',
          'release_steal_claim(lock_directory, &claim);\n            return Err(state_error(\n                error_code,\n                "local steal claim identity changed",\n            ));',
        ),
      ),
    ).toThrow(/owner\/claim publication protocol/u);
  });

  it.skipIf(process.platform === "win32")(
    "serializes byte-compatible quota reservations across Node and Rust",
    async () => {
      mkdirSync(resolve("target"), { recursive: true });
      const parent = mkdtempSync(resolve("target", "quota-interop-"));
      const stateRoot = join(parent, ".krx-cli");
      const quotaPath = join(stateRoot, "rate-limit.json");
      const callsPerRuntime = 40;
      let stdout = "";
      let stderr = "";
      const child = spawn(
        "cargo",
        [
          "test",
          "--locked",
          "-p",
          "krx-sdk",
          "quota::tests::node_interop_worker",
          "--",
          "--ignored",
          "--exact",
          "--nocapture",
        ],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            KRX_TEST_QUOTA_ROOT: stateRoot,
            KRX_TEST_QUOTA_CALLS: String(callsPerRuntime),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const childDone = new Promise<void>((resolveChild, rejectChild) => {
        child.on("error", rejectChild);
        child.on("close", (code) => {
          if (code === 0) resolveChild();
          else
            rejectChild(
              new Error(`Rust quota worker exited ${code}: ${stderr}${stdout}`),
            );
        });
      });
      const childClosed = new Promise<void>((resolveChild) => {
        child.on("close", () => resolveChild());
        child.on("error", () => resolveChild());
      });

      try {
        const readyDeadline = Date.now() + 30_000;
        while (!existsSync(join(parent, "rust-ready"))) {
          if (Date.now() >= readyDeadline) {
            throw new Error(
              `Rust quota worker did not become ready: ${stderr}`,
            );
          }
          await Promise.race([delay(25), childDone]);
        }
        const lockPath = `${quotaPath}.lock`;
        const deadOwner = "2147483647-00000000-0000-4000-8000-000000000000";
        mkdirSync(lockPath, { recursive: true, mode: 0o700 });
        writeFileSync(join(lockPath, "owner"), deadOwner, { mode: 0o600 });
        writeFileSync(join(lockPath, "steal"), deadOwner, { mode: 0o600 });
        chmodSync(lockPath, 0o700);
        const stale = new Date(Date.now() - 31_000);
        utimesSync(lockPath, stale, stale);
        writeFileSync(join(parent, "start"), "start");
        const fixedNow = () => new Date("2026-01-01T15:00:00.000Z");
        const nodeReservations = Promise.all(
          Array.from({ length: callsPerRuntime }, () =>
            reserveCall("shared-key", { filePath: quotaPath, now: fixedNow }),
          ),
        );
        const [nodeResults] = await Promise.all([nodeReservations, childDone]);
        expect(nodeResults.every((result) => result.reserved)).toBe(true);
        const persisted = JSON.parse(readFileSync(quotaPath, "utf8")) as {
          credentials: Record<string, { count: number }>;
        };
        expect(
          persisted.credentials[credentialFingerprint("shared-key")]?.count,
        ).toBe(callsPerRuntime * 2);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await childClosed;
        rmSync(parent, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
