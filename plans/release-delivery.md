# Complete native release delivery

Status: release preparation active; Windows corrections awaiting native validation

## Scope and decisions

- Retain private GitHub Releases and the existing supported target manifest.
- Let local release-it prepare synchronized versions, changelog, commit, and tag;
  let CI alone publish after complete target and Node consumer certification.
- Bind certification to exact archive bytes and source identity, publish checksums,
  and verify downloaded assets before making the draft a published release.
- Keep routine CI on Linux. Full native coverage belongs to the release workflow;
  manual dispatch provides candidate certification without publication.
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

Hosted builds pass on both Linux targets and macOS. Windows diagnostics exposed
new-state ownership inherited from the process default rather than the current
user. Creation now specifies current-user ownership and a private protected ACL;
legacy-secret validation rejects shared data reads. Test fixtures create their
missing parent directories, and producer waits fail promptly on early errors.
Windows then reached atomic publication and exposed Win32 rename error 87. A
focused native reproduction isolates the state module from transport dependencies;
rename now uses the native handle-relative API with OS error conversion. Bounded
reviews and isolated Windows type/clippy checks passed; native runtime and archive
certification remain before tagging 1.8.2. No version tag or Release exists.

[Releasing](../docs/RELEASING.md) owns the operational procedure.
