# Releasing

Releases are GitHub Releases containing one prebuilt npm-format archive
for every target in `contracts/product/v1/native-targets.json`, `SHA256SUMS`, and
`release-manifest.json`. The manifest records the source commit, version, target,
archive digest, and certified Node majors (empty for macOS and Windows).
Installation requires Node.js 22 or 24 and a package manager, but no Rust toolchain
or install scripts.

The repository and its published release assets are public. The package
`private: true` flag prevents npm publication; the target manifest retains the
`private-github-release-asset` policy label, but the publication script does not
enforce repository visibility. Neither setting makes GitHub downloads private.

## Prepare a release

Use a clean `main` checkout tracking `origin/main` on any supported OS. Install
Node, pnpm, and the pinned Rust toolchain (Cargo rewrites the workspace version
and lockfile). Fetch dependencies:

```sh
pnpm install --frozen-lockfile --ignore-scripts
cargo fetch --locked
pnpm release
```

Choose the intended version when prompted. `release-it` first fetches `origin/main`
and requires the checkout to match it. After bumping `package.json` and the
changelog, it synchronizes the Cargo workspace and Cargo.lock through Cargo and
checks that every version agrees before the release commit, tag, and push. It
does not rerun `pnpm verify`: pull-request CI already gated the merged source, and
the tag's release workflow runs the full gate again before anything is
published. This keeps preparation to seconds and avoids long local runs that a
sleep or reboot can interrupt. The Node package's `0.0.0` version is an assembly template; assembly
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

Open the repository's Releases page and download the matching
target archive and `SHA256SUMS`. Compare the archive's SHA-256 with its entry in
that file (`shasum -a 256` on macOS, `sha256sum` on Linux, or
`Get-FileHash -Algorithm SHA256` on Windows). Then install the downloaded file:

```sh
pnpm add --global --ignore-scripts "./krx-cli-<version>-<target>.tgz"
krx --version
krx --help
```

Replace the placeholders with the selected release and target. For the Node SDK,
omit `--global`. Keep credentials out of download URLs and package metadata.

A pnpm global installation upgrades itself:

```sh
krx version --check   # compare with the latest stable release
krx upgrade --check   # also confirm this installation is upgradable
krx upgrade
```

`krx upgrade` acts only when `pnpm list --global` lists the running `krx-cli`
package; project dependencies and other installations are refused unchanged.
It downloads the target archive from the latest stable release, requires its
SHA-256 to match both `release-manifest.json` and `SHA256SUMS` and its
`package.json` to name `krx-cli` at that version, then runs
`pnpm add --global --ignore-scripts` and confirms the installed `krx --version`.
pnpm records a global archive by path, so the verified archive is kept in the
user data directory (`%LOCALAPPDATA%\krx-cli\releases`,
`~/Library/Application Support/krx-cli/releases`, or
`$XDG_DATA_HOME/krx-cli/releases`, default `~/.local/share`), in one
subdirectory per pnpm global installation, while that version is installed; do
not delete it. pnpm runs from that directory. pnpm 10 keeps all
global packages in one project and re-reads each recorded archive, so when the
archive the running version was installed from is gone, the in-place install
fails; `krx upgrade` then removes the package, installs again, and on failure
names the `pnpm add` command that finishes it. Stage messages and pnpm output go
to stderr only in a terminal; stdout carries one JSON result.

Release evidence for `krx version --check` and for the update notice is cached
for a day in the user cache directory (`%LOCALAPPDATA%\krx-cli\cache`,
`~/Library/Caches/krx-cli`, or `$XDG_CACHE_HOME/krx-cli`). The notice waits an
hour after a failed refresh; an explicit check retries immediately. After a
successful KRX network command, an interactive terminal also shows a one-line
notice when a newer installable release exists; pipes, CI, and agents never see
it. Set `KRX_NO_UPDATE_CHECK=1` to disable release checks and the notice.

## Failed or interrupted releases

- A preparation failure leaves local edits for inspection and creates no release
  commit or tag. Fix the failure and verify the intended version and changelog
  before retrying; do not blindly bump the version again.
- A failed verification, build, or consumer blocks publication. Diagnose the
  failed job. Retry
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
