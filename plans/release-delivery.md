# Complete native release delivery

Status: complete — v1.8.2 published and downloaded assets verified

Visibility reconciliation (2026-09-07): GitHub reports this repository as public,
so published release assets are public. The private-release wording below records
the original scope; it is not an access-control guarantee.
[Releasing](../docs/RELEASING.md) owns the current distribution boundary.

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
- Version 1.8.2 was prepared only after the hosted candidate workflow passed.

## Evidence and progress

- Reproduced the old release-it patch bump in an isolated copy: package.json moved
  to 1.8.2 while Cargo.toml stayed at 1.8.1 after the verification hook passed.
- Implemented version synchronization, Linux consumer certification, checked release
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

[v1.8.2](https://github.com/cpaikr/krx-cli/releases/tag/v1.8.2) is published from
`d9c300f6b7afd2b782cfef11a82a995f769827cc`.
[The release workflow](https://github.com/cpaikr/krx-cli/actions/runs/34096532610)
passed all four native builds, Linux Rust verification, Node 22/24 Linux consumer
checks, bundle assembly, and publication. Full local `pnpm verify` passed before
the release commit and tag.

All four published archives, `SHA256SUMS`, and `release-manifest.json` were
downloaded after publication. Their hashes, source revision, version, exact asset
inventory, and Linux-only certification coverage matched. macOS and Windows
entries correctly contain no certified Node majors. The earlier Windows state
corrections also passed 12 focused native regressions before the CI scope changed.

[Releasing](../docs/RELEASING.md) owns the operational procedure.
