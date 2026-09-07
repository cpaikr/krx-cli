# Releasing

Releases are private GitHub Releases containing one prebuilt npm-format archive
for every target in `contracts/product/v1/native-targets.json`, `SHA256SUMS`, and
`release-manifest.json`. The manifest records the source commit, version, target,
archive digest, and certified Node majors (empty for macOS and Windows). Installation requires Node and a
package manager, but no Rust toolchain or install scripts.

## Prepare a release

Use a clean `main` checkout tracking `origin/main`. Install the pinned Rust
toolchain, Node, pnpm, and cargo-deny required by `pnpm verify`. Fetch dependencies:

```sh
pnpm install --frozen-lockfile --ignore-scripts
cargo fetch --locked
pnpm release
```

Choose the intended version when prompted. `release-it` first fetches `origin/main`
and requires the checkout to match it. After bumping `package.json` and the
changelog, it synchronizes the Cargo workspace and Cargo.lock through Cargo,
then runs `pnpm verify`. Only a successful gate permits the release commit, tag,
and push. The Node package's `0.0.0` version is an assembly template; assembly
replaces it with the root version.

Local preparation never creates a GitHub Release or publishes to npm. The pushed
`v<version>` tag starts `.github/workflows/release.yml`. It checks that the tag,
package and Cargo versions, and checkout agree and that the commit belongs to
`origin/main`.

## Certification and publication

The workflow verifies repository contracts and dependency policy on Linux, then
builds and packages every supported native target. Automated Rust tests, Node
22/24 clean-install certification, and frozen installed-product compatibility run
only on Linux GNU x64 and ARM64. macOS ARM64 and Windows x64 release jobs build
and package archives without test or consumer-certification jobs.

This project explicitly limits CI to Linux while retaining all-platform release
builds. All four archives and complete Linux reports are required before assembling
the release bundle. Each Linux report must identify the expected source, version,
and archive SHA-256; portable package contents and native capabilities must agree
across the certified Linux consumers. Every archive receives a checksum; macOS and
Windows entries have an empty `nodeMajors` list because they have no CI consumer
evidence.

CI owns publication with a job-scoped write token. It creates a draft, uploads
missing assets, downloads and compares their bytes with the assembled bundle,
then publishes. Published assets are never overwritten by this pipeline.
Workflow artifacts are temporary intermediates, not the supported download channel.

A manual run of **Native release** on a branch builds all targets, certifies Linux consumers, and produces
the bundle without publishing or creating a tag. Use it to validate workflow
changes before preparing a real release.

## Install and upgrade

Open the repository's Releases page while authenticated and download the matching
target archive and `SHA256SUMS`. Compare the archive's SHA-256 with its entry in
that file (`shasum -a 256` on macOS, `sha256sum` on Linux, or
`Get-FileHash -Algorithm SHA256` on Windows). Then install the downloaded file:

```sh
pnpm add --global --ignore-scripts "./krx-cli-<version>-<target>.tgz"
krx --version
krx --help
```

Replace the placeholders with the selected release and target. Use the same
package-manager installation path for upgrades. For the Node SDK, omit `--global`.
Keep credentials out of download URLs and package metadata.

## Failed or interrupted releases

- A preparation failure leaves local edits for inspection and creates no release
  commit or tag. Fix the failure and verify the intended version and changelog
  before retrying; do not blindly bump the version again.
- A failed build or consumer blocks publication. Diagnose the failed job. Retry
  infrastructure failures against the unchanged tag; source fixes use a new
  commit and version rather than moving the tag.
- An interrupted upload leaves a draft. Rerun failed jobs to reuse the assembled
  bundle. Existing assets are accepted only when downloaded bytes match; only
  missing assets are uploaded. If a rebuild differs from an existing draft,
  inspect the discrepancy before discarding that unpublished draft or choosing
  a new version.
- A rerun after successful publication verifies the existing release without
  modifying assets. Corrections to a published release require a new version.

Implementation and first-release validation status are tracked in
[the release delivery plan](../plans/release-delivery.md).
