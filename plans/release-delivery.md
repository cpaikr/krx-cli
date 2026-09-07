# Complete native release delivery

Status: release preparation active; Linux-only CI and all-platform builds awaiting hosted validation

## Scope and decisions

- Retain private GitHub Releases and the existing supported target manifest.
- Let local release-it prepare synchronized versions, changelog, commit, and tag;
  let CI alone publish after all target builds and Linux Node consumer certification.
- Bind certification to exact archive bytes and source identity, publish checksums,
  and verify downloaded assets before making the draft a published release.
- Keep routine CI on Linux. All target builds belong to the release workflow;
  manual dispatch provides candidate certification without publication.
- Automated tests and consumer certification run only on Linux by explicit owner
  request; macOS and Windows retain release build and packaging jobs only.
- The first publication is authorized; prepare version 1.8.2 only after hosted
  candidate validation passes.

## Evidence and progress

- Reproduced the old release-it patch bump in an isolated copy: package.json moved
  to 1.8.2 while Cargo.toml stayed at 1.8.1 after the verification hook passed.
- Implemented version synchronization, full release certification, checked release
  bundles, resumable publication without asset replacement, and operational docs.
- Full `pnpm verify` passed in the isolated candidate checkout, including Rust
  checks, dependency policy, calendar freshness, and production audit.
- The macOS ARM64 archive passed clean-install certification under Node 22 and
  24, with matching archive and portable-content hashes, and installed-product
  compatibility checks passed.
- Bounded code review found a draft-release lookup bug; it was corrected and
  publication regression tests and lint passed. Workflow syntax validation and
  release-documentation reconciliation are complete.
- Applied the validated candidate to `main` as requested; `pnpm check` and
  `git diff --check` passed in the repository.

## Delivery status

The previous candidate runs exposed Windows ownership, rename, and lock-contention
failures. Corrections are committed; all 12 focused native Windows state regressions
passed. The owner subsequently requested removal of Windows/macOS CI while
retaining their release builds and assets. The workflow now separates Linux Rust
verification and consumer certification from all-platform build/packaging jobs.
The bundle still requires all four archives and records certification only for
Linux. Bounded review and focused release tests passed. Hosted validation remains
before tagging 1.8.2. No version tag or Release exists.

[Releasing](../docs/RELEASING.md) owns the operational procedure.
