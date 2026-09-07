# Complete native release delivery

Status: implemented and locally validated; hosted release validation pending

## Scope and decisions

- Retain private GitHub Releases and the existing supported target manifest.
- Let local release-it prepare synchronized versions, changelog, commit, and tag;
  let CI alone publish after complete target and Node consumer certification.
- Bind certification to exact archive bytes and source identity, publish checksums,
  and verify downloaded assets before making the draft a published release.
- Keep routine CI on Linux. Full native coverage belongs to the release workflow;
  manual dispatch provides candidate certification without publication.
- Creating the first real tag or publishing a release is a separate operation.

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

No release was published by this implementation task. Hosted execution across all targets and
the real GitHub publication boundary remain to be validated through
the workflow. [Releasing](../docs/RELEASING.md) owns the operational procedure.
