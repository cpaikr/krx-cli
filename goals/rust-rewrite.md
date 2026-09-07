# Goal: Rust SDK, native CLI, and Node SDK rewrite

Status: complete

This document records the completed rewrite scope and its historical delivery
policy. Subsequent release-pipeline work is tracked in
[release-delivery.md](../plans/release-delivery.md); current release procedures
are in [RELEASING.md](../docs/RELEASING.md).
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Replace krx-cli with a shared Rust SDK, native Clap CLI, and public Node SDK, completing atomic cutover with certified private native artifacts.
- Goal state: goals/rust-rewrite.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Green frozen legacy baseline and mutation-tested compatibility judge — plans/rust-rewrite.md, docs/CLI-CONTRACT.md, docs/COMPOSITE-RESULTS.md
  - Canonical KRX OpenAPI and frozen SDK, CLI, error, and migration contracts — plans/rust-rewrite.md
  - Complete shared Rust SDK for all supported KRX behavior and local policy — plans/rust-rewrite.md
  - Native Clap CLI and public Node SDK over the shared Rust implementation — plans/rust-rewrite.md, docs/CLI-CONTRACT.md
  - Secure credential, cache, offline, quota, and legacy-state migration — plans/rust-rewrite.md, goals/production-readiness-hardening.md
  - Legacy parity and certified macOS ARM64, Linux GNU x64/ARM64, and Windows x64 artifacts — plans/rust-rewrite.md
  - Atomic production cutover and removal of TypeScript protocol, JavaScript CLI, and MCP — plans/rust-rewrite.md, ROADMAP.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Creating the first tag or GitHub Release.
- Authority: Execute only included results and necessary supporting work; resolve remaining decisions within that closed outcome using best judgment; record anything else and ask before scope expansion or external authority.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

- On 2026-08-24, the repository moved from `sjunepark/krx-cli` to the private
  `cpaikr/krx-cli` repository. The transferred repository, branches, PRs,
  reviews, and history remain the delivery authority.
- The four native artifact targets remain supported: macOS ARM64, Linux GNU
  x64/ARM64, and Windows x64. Continuous exact-head CI certification is reduced
  to Linux GNU x64/ARM64 under Node 22 and 24. macOS and Windows are
  intentionally omitted from continuous CI solely to reduce compute cost;
  their historical certification remains evidence but is no longer a rewrite
  completion gate.
- GitHub Actions jobs use Blacksmith runners. The heavy native certification
  runs for pull requests and manual dispatch only; branch pushes do not launch
  a duplicate matrix.

## Execution status

### Completed included results

- Green frozen legacy baseline and mutation-tested compatibility judge.
- Canonical KRX OpenAPI and frozen SDK, CLI, error, and migration contracts.
- Complete shared Rust SDK for all supported KRX behavior and local policy.
- Native Clap CLI and public Node SDK over the shared Rust implementation.
- Secure credential, approval, cache, offline, quota, watchlist, and legacy-state
  migration through the shared Rust implementation.
- Installed-product parity and certified private native package assembly for all
  four supported target definitions, with continuous Linux GNU x64/ARM64 gates.
- Local atomic package/export cutover and removal of the legacy TypeScript
  protocol, JavaScript CLI, and MCP implementation.

### Current in-scope result

All included results are complete. The shared Rust SDK, native Clap CLI, public
Node SDK, secure local-state behavior, certified private native artifacts, and
atomic removal of the legacy TypeScript/JavaScript/MCP runtime are merged on
`main`.

### Next in-scope action

None. Creating the first tag or GitHub Release remains explicitly excluded
from this goal and requires a separate publication decision.

### Evidence and blockers

- Final implementation PR
  [#11](https://github.com/cpaikr/krx-cli/pull/11) merged as
  `da55147cfef976f73c0f1a328a8bc48e95142a58` with all 58 implementation and
  review commits preserved. Exact head `df3cf9d` passes 138 maintainer tests,
  14 public Node facade tests, and 185 Rust tests with one intentional
  interoperability worker ignored, plus strict formatting, all-target and
  all-feature checks, Clippy, canonical contract validation, current calendar
  validation, Cargo advisory/license/source enforcement, and the production
  dependency audit. A clean detached-worktree `darwin-arm64` archive passes
  Node 24 certification with portable SHA-256
  `038e5e200a5bb85602f53d81e073b96223c8fcbc1548b5f260b24666f84b8064`,
  all 14 frozen compatibility scenarios, both cache-migration postconditions,
  and all three named mutation checks. Exact-head general CI run
  [32735382336](https://github.com/cpaikr/krx-cli/actions/runs/32735382336)
  passes Node 22/24, and native run
  [32735382507](https://github.com/cpaikr/krx-cli/actions/runs/32735382507)
  passes both Blacksmith Linux builds, all four unchanged-archive consumers,
  and the identity aggregator. The final feedback collection found every
  Codex thread resolved, no outside-diff finding, and no active review.
  CodeRabbit's single authorized retry was skipped because 294 files exceeded
  its 150-file limit; this was not a quota failure. No in-scope blocker
  remains.
- Adapter PR [#10](https://github.com/cpaikr/krx-cli/pull/10) merged as
  `9bd9bb5` with all seven reviewed commits preserved. Its final feedback
  collection covered exact head `9d28167`, found all 18 threads resolved with
  no outside-diff findings, and confirmed CodeRabbit successful. Exact-head
  Rust SDK run
  [32721404379](https://github.com/cpaikr/krx-cli/actions/runs/32721404379)
  passed Blacksmith Linux x64/ARM64. Native certification run
  [32721404374](https://github.com/cpaikr/krx-cli/actions/runs/32721404374)
  passed both Linux builds, all four Node 22/24 clean-install consumers, and
  the package-identity aggregator. The native CLI drives
  every supported command through `krx-sdk`, preserves the frozen rendering,
  validation, core diagnostic grammar, and exit behavior, and uses pinned
  `rpassword` 7.4.0 solely for cross-platform
  no-echo credential input; credential-bearing argv remains forbidden. The
  public Node facade owns one reusable native client, validates the frozen
  request policy strictly, contains synchronous and asynchronous Rust panics,
  and cleans up cancellation listeners. Production package assembly enforces
  path containment and certifies the native executable, binding, metadata,
  schema output, and portable identity. The heavy workflow runs only for pull
  requests or manual dispatch on `blacksmith-2vcpu-ubuntu-2404` and
  `blacksmith-2vcpu-ubuntu-2404-arm`; comments record that macOS ARM64 and
  Windows x64 remain supported but are omitted from continuous CI to reduce
  compute cost. Full dynamic verbose observations for cache, quota, retry,
  request timing, and range/calendar decisions were assigned to the final
  black-box parity result. The final branch now provides the sanitized shared
  SDK observation seam and certifies its installed CLI rendering.
- The final local adapter-remediation checkpoint passes workspace formatting,
  locked all-target/all-feature check, strict Clippy, 20 native CLI tests,
  eight native Node-boundary tests, and 150 SDK tests with the one intentional
  interoperability worker ignored. The public Node facade passes 14 tests and
  the focused SDK/artifact mutation gate passes 38 tests. Full `pnpm verify`
  passes 49 files and 516 tests, contract generation and types, lint,
  TypeScript checking, production audit, 13 installed-package scenarios, and
  packed-package smoke. A fresh release build, assembly, pack, and clean-install
  certification passes for the host `darwin-arm64` target under Node 24 with
  portable SHA-256
  `904b24002be491fdf4774da948c412218a665a6b59cdf02c6e4c0f1b804dfb9a`.
- The configured origin is the transferred private `cpaikr/krx-cli`
  repository. Its retained branch and PR history remain the delivery
  authority.
- Production SDK PR [#9](https://github.com/cpaikr/krx-cli/pull/9) merged as
  `9f11cda` with all eleven reviewed commits preserved. Its final feedback
  collection covered exact head `3bb5397`, found all 21 threads resolved with
  no outside-diff findings, and confirmed the PR mergeable. Exact-head Rust SDK
  run [32708825108](https://github.com/cpaikr/krx-cli/actions/runs/32708825108)
  passed Blacksmith Linux x64/ARM64. Native certification run
  [32708825088](https://github.com/cpaikr/krx-cli/actions/runs/32708825088)
  passed both Linux builds, all four Node 22/24 clean-install consumers, and the
  Linux package-identity aggregator. CodeRabbit accepted the reviewed
  compatibility and CI-cost dispositions; its exact-head status was successful
  with incremental review intentionally skipped by repository policy. The
  delivery had no GitHub Actions quota failure.
- Before its merge, production SDK PR
  [#9](https://github.com/cpaikr/krx-cli/pull/9) original implementation head
  `1471622` passed both Blacksmith SDK jobs,
  both Linux native builds, all four Node 22/24 consumers, and the identity
  aggregator. Codex and CodeRabbit completed reviews on that exact head. The
  checked remediation accepts the valid public-request, watchlist, workflow,
  contract, build-generation, cache, shared-client, credential, date, lock
  grammar, KST, and state-hardening findings; preserves the frozen manual
  exact-arithmetic GCD and legacy decimal `Retry-After` compatibility; and
  rejects a Windows continuous-CI expansion under the authorized compute-cost
  amendment. Five independent Luna/high public, credential, state, cache, and
  transport rereviews found no blocking defect after two narrow test-hardening
  follow-ups. The canonical `npm run rust:sdk` passes formatting, locked
  all-target/all-feature check, strict Clippy, and 147 tests with one
  intentional interop worker ignored. Full `pnpm verify` passes 49 files and
  508 tests, production audit, 13 installed-package scenarios, and package
  smoke. Exact-head push, thread closure, hosted validation, and merge remain.
- The complete shared Rust SDK now exposes the frozen concrete `Client`,
  builder, direct and range queries, generated composites, capabilities,
  credential and approval operations, bounded cache administration, and
  strict watchlist administration over the single private direct-query engine.
  Composite and range fan-out share one 45-second call deadline; ranges retain
  deterministic date order with concurrency five; KONEX remains present; and
  the unchanged frozen external Rust consumer compiles directly against the
  public crate. Cache administration derives every limit from the migration
  contract, prefers v2 on equal-time retention, rejects an oversized prune
  request before traversal, recognizes only exact platform temporary names,
  and bases conditional deletion, age, and byte accounting on the securely
  observed object. Unix and Windows cache enumeration is capability-rooted and
  never follows symlink or reparse children. Watchlist reads are strict and
  bounded, first mutation migrates v0 to v1 under the shared lock, concurrent
  writers preserve order, and invalid public arguments remain typed as
  `invalid_argument`. Three independent public/range, cache/security, and
  watchlist/migration reviews are clean after applying the cache parser,
  Windows recursion, descriptor-time/accounting, prune-bound, v2-preference,
  and traversal fixes. Workspace formatting, locked all-target/all-feature
  check and strict Clippy pass; 144 Rust tests pass with the one intentional
  interoperability worker ignored; all eight SDK mutation/interoperability
  tests pass; and full `pnpm verify` passes 49 files and 508 tests, production
  audit, 13 installed-package scenarios, and package smoke. Native Windows
  cross-check remains unavailable on this macOS host because `aws-lc-sys`
  requires absent Windows SDK headers; the Windows source mutation gate passes
  under the approved reduced-CI policy.
- The reviewed private direct-query checkpoint now composes validation,
  credential resolution, transport, cache policy, offline behavior, and the
  call-wide deadline without exposing a partial public client. Offline returns
  valid stale v1/v2 entries without credential, quota, network, or refresh
  lease effects; online probes are non-mutating until the lease owner rechecks;
  bypass never touches cache state; and every blocking online mutation retains
  the exact lease even if the awaiting caller is cancelled. State-root-scoped
  singleflight shares the successful producer response by v2 key, including
  empty or current/future responses that policy intentionally does not cache,
  while waiter cancellation cannot cancel the producer. Cross-process waiters
  accept a logical v2 generation published after their baseline even when the
  lease is free before their first mkdir; v1-to-v2 promotion preserves the
  generation and cannot satisfy network-forcing Refresh. Fresh v1 contention
  waits for lease-owned promotion instead of returning without migration.
  Unix stale recovery publishes one live exact claim in the observed lease,
  revalidates pathname, owner, and claim before rename, and rejects claimed new
  acquisitions, closing the paused two-stealer replacement race. Windows keeps
  its exact-handle rename/delete protocol and bounded incomplete-owner
  observation. The structural mutation gate rejects loss of state-root flight
  isolation, shared-result publication, refresh-generation comparison, creator
  claim checks, and exact claimant revalidation. Independent contract and
  security/concurrency rereviews are clean. Workspace formatting, strict
  all-target/all-feature Clippy, 130 Rust tests with one intentional
  interoperability worker ignored, the seven-test SDK mutation/source gate,
  and full `pnpm verify` with 49 files and 507 tests pass. Native Windows
  cross-check remains unavailable on this macOS host because `aws-lc-sys`
  requires absent Windows SDK headers; the Windows source mutation gate passes.
- The reviewed private cache-core checkpoint derives canonical v1/v2 keys,
  paths, schema identities, size limits, and timestamp bounds from the frozen
  product contracts. It strictly decodes exact operation rows and parameters,
  rejects empty/current/future writes, prefers valid v2 while allowing a valid
  v1 fallback after invalid-v2 quarantine, and conditionally quarantines or
  removes only identity-and-content-matching observations. Oversized entries
  are classified invalid without an unbounded read and are preserved when
  exact-content mutation cannot be proven. Online v1 promotion publishes a
  durable v2 entry before conditional v1 cleanup, and concurrent replacement
  tests prove newer legacy files are not removed. Windows cache mutations use
  exact validated handles and writable parent flushing. POSIX rejects links,
  foreign ownership, unsafe parents, and changed observations but accepts the
  documented final same-user pathname race because Linux and macOS lack one
  portable exact-handle conditional rename/unlink primitive; the residual is
  confined to credential-independent, refetchable cache data. Independent
  contract and security rereviews are clean. The private operational methods
  remain unreachable until the next layer adds lease-protected v2 rechecks,
  valid-v2 legacy cleanup, singleflight, and offline/client orchestration.
  Workspace formatting, 110 Rust tests with one intentional interoperability
  worker ignored, strict all-target/all-feature Clippy, the seven-test SDK
  mutation/source gate, and diff validation pass. Native Windows cross-check
  remains unavailable on this macOS host because `aws-lc-sys` requires absent
  Windows SDK headers; the Windows source mutation gate passes.
- The reviewed private transport checkpoint uses one reusable reqwest 0.13.4
  Rustls client with redirects, ambient proxies, and automatic retries
  disabled. It derives retry statuses, defaults, timeouts, cache age, and daily
  quota from the frozen product contracts; accepts only zero through three
  retries; reserves quota immediately before every actual attempt using the
  current KST day; and carries cancellation plus the call-wide deadline across
  quota waits, sends, full body streams, and retry sleeps. The exact legacy
  one-second/ten-second 50–100% jitter and delta-seconds/HTTP-date
  `Retry-After` policy is preserved, including saturating arbitrary-length
  integer delays so they cannot fall back to an extra request. The custom
  `AUTH_KEY` value is validated and marked sensitive before quota mutation,
  unsuccessful bodies remain opaque, successful streamed bodies are bounded at
  64 MiB, and quota deadline expiry cannot write state. Independent contract
  and security rereviews are clean. The exact checkpoint passes workspace
  formatting, locked all-target/all-feature check, 100 Rust tests with one
  intentional interoperability worker ignored, and strict Clippy. Full
  `pnpm verify` passes 49 files and 507 tests, including the real Node/Rust
  quota interoperability gate, production audit, 13 installed-package
  scenarios, and package smoke. Native Windows and Linux ARM cross-compilation
  is unavailable on this macOS host because their SDK/toolchains are absent;
  static review is clean and those targets are not continuous gates under the
  authorized compute-cost amendment.
- The reviewed credential and approval checkpoint derives the native keyring
  service/account, environment source, approval TTL, and fixed category probes
  from the frozen product contracts. Resolution is strictly explicit,
  environment, keychain, then missing; invalid present sources never fall
  through. Keyring 4.1.6 uses only native platform stores, with the rejected
  database fallback graph absent. Credential rotation acquires the
  legacy-secret-sensitive config lock, atomically clears credential-bound
  approvals before its sole keychain write, and requires zeroized exact
  readback. A partial write with exact readback reconciles, while every failure
  path is fail-closed and performs no restorative write that could resurrect a
  concurrently removed credential. Removal is keychain-only and does not
  create, inspect, or wait on local filesystem state. Approval persistence is
  strict, fingerprint-bound, redacted, 900-second UTC-millisecond state in the
  single config authority, with merge-on-write concurrency and exact legacy
  classification. Explicit plaintext migration validates the complete secure
  source before keychain access, preserves exact bytes, distinguishes
  pre-/post-commit failures, and rolls back only a newly created still-matching
  credential. Unix and Windows use non-repairing secret-sensitive lock paths
  for migration. Independent contract and security rereviews are clean. The
  exact checkpoint passes 87 Rust tests with one intentional interop worker
  ignored, the real Node/Rust interoperability gate, host and Windows locked
  all-feature checks and strict Clippy, the seven-test mutation/source gate,
  and full `pnpm verify` with 49 files and 507 tests, production audit, 13
  installed-package scenarios, and package smoke.
- The reviewed Windows state substrate now matches the frozen shared quota
  protocol with handle-rooted no-follow traversal and exact-handle create,
  link, rename, deletion, and cleanup. Local state enforces current-user
  ownership, fail-closed writable-ACL policy, bounded identity-stable reads,
  durable atomic writes, lowercase canonical owners, reserved-device-path
  rejection, and permanent nonempty tombstone fences. The Windows target
  passes locked all-target/all-feature check and strict Clippy; runtime Windows
  execution is not a continuous gate under the authorized compute-cost
  amendment. Independent parity and security rereviews are clean, and the
  source mutation gate rejects traversal, ACL, identity, publication,
  rollback, cleanup, and durability regressions. Numeric PID liveness remains
  intentionally byte-compatible with the frozen Node/Unix PID-UUID grammar;
  process-creation identity was rejected as contract divergence. Tombstone
  reclamation was rejected because the frozen policy is
  `permanent-nonempty-fence`. Full `pnpm verify` passes 49 files and 506 tests,
  the production audit, 13 installed-package scenarios, and package smoke;
  host all-feature tests pass 55 tests with the intentional interop worker
  ignored, while the actual Node/Rust quota interoperability gate passes.
- The reviewed shared quota checkpoint implements byte-compatible Node/Rust
  KST-day reservation with exact SHA-256 credential identities, strict bounded
  v0/v1 decoding, fail-closed byte preservation, 10,000-entry/count caps, and
  successful-write-only pruning. On Unix, the Rust state substrate uses
  descriptor-relative no-follow traversal, current-user ownership, strict
  `0700`/`0600` modes, durable atomic writes, and crash-recoverable plain-mkdir
  locks. Prepared hard-link owner/claim publication, identity-and-byte
  revalidation, retained deterministic tombstones, and identity-safe failed
  acquisition cleanup close replacement and paused-stealer races across both
  runtimes. Independent security/concurrency review is clean. `pnpm verify`
  passes 49 files and 506 tests, production audit, 13 installed-package
  scenarios, and package smoke; all-feature workspace format/check/strict
  Clippy pass, with 55 Rust tests passing and the intentional Node interop
  worker ignored because its mixed-runtime execution passed in the product
  gate. Windows secure state remains the next platform implementation.
- The repository transfer to private `cpaikr/krx-cli` preserved PR #8 and its
  branch topology. The checked amendment routes every Actions job to
  Blacksmith, removes the duplicate native branch-push matrix, retains all four
  supported native targets, and freezes Linux GNU x64/ARM64 as the continuous
  Node 22/24 certification subset. `pnpm verify` passes 48 files and 487 tests,
  the installed-package compatibility and package-smoke gates pass, and the
  Rust workspace passes formatting, 25 tests with two opt-in native checks
  ignored locally, and strict Clippy. Exact implementation-head Blacksmith run
  [32677073840](https://github.com/cpaikr/krx-cli/actions/runs/32677073840)
  passes both Linux builds, all four unchanged-archive Node consumers, and the
  Linux package-identity aggregator at `b9620e5`. No branch-push native run was
  created.
- Contract delivery PR
  [#8](https://github.com/cpaikr/krx-cli/pull/8) merged as `68256d2` after exact
  documentation-head Blacksmith run
  [32677605199](https://github.com/cpaikr/krx-cli/actions/runs/32677605199)
  passed both Linux builds, all four Node consumers, and the identity
  aggregator. The final feedback collection covered `1a7e158`, found all 19
  threads resolved with no outside-diff findings or active review, and
  CodeRabbit was successful.
- Contract delivery PR
  [#8](https://github.com/cpaikr/krx-cli/pull/8) completed its initial
  13-job four-target matrix at `c085b94`; all native builds, eight Node
  consumers, and the cross-target identity aggregator passed. Review feedback
  exposed six contract/probe defects plus an unsafe probe-origin hook. The
  checked remediation derives exact cache parameters from OpenAPI, rejects
  impossible quota dates without migration writes, sanitizes bounded provider
  codes at the Rust boundary, validates present environment credentials,
  freezes KONEX, binds native and npm versions, restricts probe traffic to a
  public dummy credential on numeric loopback, and pins workflow actions to
  reviewed immutable revisions. An independent complete-diff re-review is
  clean. A final contract-surface review then proved that name-only Rust result
  uses still admitted incomplete range, market-summary, approval, and cache
  shapes. The checked fix freezes every field with strongly typed consumer
  accesses, closed Rust enums, explicit cache options, and a hosted compiler
  path that cannot omit the consumer; twelve new mutants reject surface or
  build linkage loss. The bounded follow-up review is clean. Targeted mutation
  gates, all-feature Rust tests and Clippy, full `pnpm verify` (48 files, 481
  tests), and rebuilt clean installs under
  Node 22 and 24 pass locally; both consumers certify portable digest
  `7f5dc0f96e7c38fd458ebc203f599d5ff561712a3d88111cb28fb723d3c90180`.
  Final implementation-head push run
  [32617597910](https://github.com/cpaikr/krx-cli/actions/runs/32617597910)
  and PR run
  [32617600682](https://github.com/cpaikr/krx-cli/actions/runs/32617600682)
  each pass all four native builds, all eight unchanged-archive Node
  consumers, and the final identity aggregator at `6b46cc1`. A refreshed
  complete feedback collection confirms all six Codex threads are answered
  and resolved, with no outside-diff findings or active review. GitGuardian
  incident `36482895` is classified as
  `Ignored — Not a secret (false positive)`: it contains only a derived
  synthetic fixture fingerprint, has zero files requiring a code fix, and its
  two occurrences record the addition and later removal of the fixture value.
  A fresh GitGuardian check passes at `6b46cc1`. CodeRabbit's initial review
  failed to post because of a transient GitHub review-submission error. The
  authorized one-time full-review retry then completed at exact head `97bfe95`
  and posted 13 threads. The checked local remediation accepts eleven findings
  and rejects two contract-inconsistent suggestions, passes 48 files and 482
  tests plus all-feature Rust tests, Clippy, formatting, and rebuilt clean
  installs under Node 22 and 24; both consumers certify portable digest
  `c9bd7d93a971d977edc8aa0c0dc88d846c9f849326c2ff83f302f76ed34dac86`.
  At this local remediation checkpoint, delivery still requires the new head,
  thread closure, and exact-head hosted certification.
- A four-variant SDK design pass converged on one deep concrete `Client` module
  with a private shared direct-operation engine, crate-private local-state
  seams, and one true-external KRX HTTP seam. Contract review then closed three
  implementation blockers before production work: offline v1 hits are now
  explicitly read-only without refresh-lease acquisition, watchlist pricing
  covers persisted KONEX entries instead of silently omitting them, and the
  redundant Rust client-level cache-age authority is removed and negatively
  gated. Independent follow-up review is clean. The full deterministic gate
  passes 48 files and 481 tests; 66 focused product/vertical mutants, strict
  Node consumption, and all-feature Rust tests/Clippy/formatting also pass.
- Initialization boundary: necessary to satisfy the goal's Resume invariant and PR-delivery lifecycle.
- Delivery integration branch: `codex/rust-rewrite-integration`, created from local `main` at `1f3dbd2`; it preserves the two queued rewrite-planning commits without pushing the production branch.
- Contract-slice classification: one contract-authority PR must replace the
  active TypeScript drift source, freeze every public and persisted-state
  boundary, and complete the disposable candidate proof before production Rust
  implementation begins.
- `contracts/krx/openapi.yaml` is now the sole maintained provider-wire
  authority for all 31 supported operations. Checked TypeScript and
  language-neutral projections replace the former endpoint, field, envelope,
  method, path-prefix, and modification-date mirrors in the legacy runtime.
- The contract gate rejects 24 independent authority mutations, including
  paths, methods, root and operation overrides, request and response shapes,
  provider errors, schema-composition bypasses, stale artifacts, and
  handwritten JavaScript/TypeScript/Rust mirrors. HTTP-200 provider errors are
  classified and sanitized consistently by runtime and live-probe consumers.
- `contracts/product/v1` now freezes the project-owned Rust consumer, complete
  public Node declarations and package surface, CLI delta and intentional
  changes, paired error kinds/codes and retry/exit mappings, four private
  native target archives, and credential, approval, cache, quota, and
  watchlist state transitions. Provider operations and row types remain
  generated from OpenAPI rather than duplicated in the maintained profile.
- The product gate compiles nine strict maintained state schemas plus generated
  operation-aware cache schemas, exercises classified valid and invalid
  migration fixtures, typechecks a public Node consumer, and rejects stale or
  malformed public, state, error, target, and migration artifacts. Its checked
  projections include an exhaustive 425-entry CLI option matrix and generated
  Node and Rust operation/error types for all 31 operations.
- `pnpm verify` passes 48 test files and 481 tests on the candidate-proof
  checkpoint, including 92 targeted authority, product-contract, and
  vertical-slice gate tests,
  production audit, the 13-scenario installed-package judge with all three
  named mutants rejected, and packed-artifact smoke for 31 schemas and 12
  legacy MCP tools. Independent review findings on error redaction, mapping
  completeness, executable migrations, SDK surface coverage, CLI scope, empty
  approval observations, typed HTTP match sets, schema-reference resolution,
  version collisions, invalid approval sources, and exact-byte no-write
  preservation, empty-present credential handling, and credential source
  validation ordering are closed.
- The disposable Rust 1.92.0 workspace compiles the frozen public SDK consumer
  directly and derives every representative wire fact at build time from the
  canonical OpenAPI and generated product projection. Ten deterministic SDK
  tests cover exact request bytes, strict response decoding, HTTP mapping,
  redirect refusal, whole-response cancellation and deadlines, bounded
  chunked bodies, redaction, and an injected credential backend. Opt-in local
  checks pass the official Rustls handshake and a cleaned-up native keychain
  round-trip. The historical hosted workflow ran both on every target; the
  amended workflow runs them on the two continuously certified Linux targets.
- Five native CLI integration tests prove Clap-owned topology and conflicts,
  semantic rejection before credential or network access, the frozen
  diagnostic grammar, direct shared-SDK invocation, and a native executable
  without an authored JavaScript launcher.
- The private Node facade and napi-rs binding prove event-loop responsiveness,
  manual AbortSignal cancellation and listener cleanup, sync and async panic
  containment, stable KrxError projection, secret redaction, ESM named imports,
  package-local declarations, private binding exports, and unsupported-target
  classification.
- One locally assembled `darwin-arm64` tarball passes the clean-install gate
  unchanged under Node 22 and 24, including TypeScript consumer compilation and
  npm's direct native `krx` bin link. Both local consumers report identical
  portable payload, metadata, and capability identities. The historical
  workflow built macOS ARM64, Linux GNU x64/ARM64, and Windows x64 once per
  target, fanned each exact tarball out to both Node majors, and compared all
  eight reports. The amended workflow performs the same proof for Linux GNU
  x64/ARM64 only. At this historical pre-certification checkpoint, hosted
  certification was still pending; the successful certification and
  documentation-head reruns are recorded below.
- Hosted run
  [32560050687](https://github.com/cpaikr/krx-cli/actions/runs/32560050687)
  passed every build, test, Rustls, keyring, assembly, pack, and upload step on
  macOS ARM64 and Linux GNU x64/ARM64. Windows passed through assembly but Node
  24 could not directly spawn `npm.cmd`, yielding a null child-process status.
  The remediation invokes npm's JavaScript CLI with `node.exe`, adds a hosted
  path regression, preserves failure diagnostics, and updates the workflow to
  the current documented checkout, setup-node, and download-artifact majors.
- Hosted retry
  [32561033733](https://github.com/cpaikr/krx-cli/actions/runs/32561033733)
  passed all four build jobs, including Windows x64 assembly, pack, and upload,
  and six non-Windows clean-install consumers. Both Windows consumers installed
  the artifact successfully before exposing a POSIX-separator assumption in
  declaration containment. The checked fix uses `node:path` relative-path
  semantics and an executable Win32 regression covering nested, root, sibling,
  and cross-drive paths; its independent review is clean.
- Hosted retry
  [32561770761](https://github.com/cpaikr/krx-cli/actions/runs/32561770761)
  passed all four builds and six non-Windows consumers. Both Windows consumers
  completed every check and emitted matching `status: passed` reports before
  cleanup failed because the certifier process still held its imported native
  DLL open. Capability capture now comes from the existing child runtime probe,
  which exits and releases the module before the parent removes the temporary
  install. Local clean installs pass unchanged under Node 22 and 24.
- Hosted retry
  [32562681277](https://github.com/cpaikr/krx-cli/actions/runs/32562681277)
  passed all four builds and all eight clean-install consumers, including DLL
  release and cleanup on Windows under Node 22 and 24. The final aggregator
  then detected that Windows checkout had converted every portable JavaScript
  and declaration file to CRLF. Exact artifact comparison proves the payloads
  are otherwise byte-identical. Checked attributes now pin every portable
  source to LF, and the workflow watches that policy as a certification input.
- Hosted certification
  [32563560693](https://github.com/cpaikr/krx-cli/actions/runs/32563560693)
  passed all four target builds, all eight exact-archive clean-install
  consumers under Node 22 and 24, and the final package-identity aggregator.
  All eight reports share portable digest `7f5dc0f96e7c38fd458ebc203f599d5ff561712a3d88111cb28fb723d3c90180`,
  package metadata, and native capability identity. An independent download
  and local comparator replay passed against those reports.
- Documentation-head run
  [32564281020](https://github.com/cpaikr/krx-cli/actions/runs/32564281020)
  repeated the complete 13-job certification matrix successfully at commit
  `07fe73fe4c5500f3dcba0910a592b9d2c7a681ab`, the final implementation and
  certification-report head before the contract PR lifecycle.
- A six-mutant vertical-slice gate ties exact Rust dependencies, both workflow
  matrices, package exports, Node majors, and target identities to the frozen
  contracts and rejects cross-target portable-payload divergence. The canonical
  wire scanner ignores only the known generated Cargo output root while
  continuing to reject maintained Rust wire mirrors, including a maintained
  directory named `target`.
- Checked JSON generation now uses the repository Prettier configuration with
  an explicit JSON parser, remains byte-stable across generation and commit
  hooks, and writes all five JSON projections to extensionless custom paths.
- Reproduced hosted failures from CI run `31672062655`: Windows checkout
  newlines broke two LF-sensitive assertions, and npm 10 lifecycle output
  preceded `npm pack --json`. The fixes normalize only test input newlines and
  parse the final JSON report without weakening package assertions.
- Replaced the retired `global.krx.co.kr` holiday feed with the current official
  `open.krx.co.kr` feed while preserving every reviewed 2016-2026 closure and
  stable reason. `pnpm calendar:check` is current on 2026-08-22.
- The installed-package judge passes 13 isolated scenarios covering the
  recursive CLI inventory, complete 31-endpoint schema, cached row and adjusted
  range behavior, composites, diagnostics, local state, and exits. It rejects
  independent no-data-exit, schema-description, and adjustment-metadata mutants
  only in their named scenarios.
- Baseline delivery PR
  [#7](https://github.com/cpaikr/krx-cli/pull/7) completed the create-review,
  feedback, re-review, and merge lifecycle. CodeRabbit and Codex reviewed the
  implementation, all ten review threads were addressed and resolved, and the
  final bounded implementation re-review was clean.
- `pnpm verify` passes 45 test files and 384 tests on the reviewed head,
  including the production audit, installed-package judge, three named
  mutation proofs, and packed-artifact smoke. npm 10.9.8 compatibility and
  package-smoke runs pass separately.
- Hosted CI run
  [32549447464](https://github.com/cpaikr/krx-cli/actions/runs/32549447464)
  passes the complete deterministic gate on Ubuntu and Windows under Node 22
  and 24.
- Hosted deterministic contract-drift run
  [32549339039](https://github.com/cpaikr/krx-cli/actions/runs/32549339039)
  passes for all 31 registered endpoints with no exclusions. Live-mode run
  [32549366727](https://github.com/cpaikr/krx-cli/actions/runs/32549366727)
  passes the current official KRX calendar step and then stops at the missing
  repository credential boundary.
- Merge commit `3732598e461ec5d78bd1121dbbe86d56aa658376` is the
  recoverable green pre-rewrite ref on `codex/rust-rewrite-integration`.
- External blocker for credentialed drift validation: the origin repository has
  no Actions `KRX_API_KEY` secret. Deterministic calendar and dry-run contract
  validation remain separate and do not require that credential; provisioning
  the live secret requires external authority.
- Final boundary classification: contract authority, the production-shared
  Rust SDK, native CLI, Node binding/facade, production packaging,
  installed-product parity, migration promotion, atomic package/export
  cutover, legacy TypeScript and JavaScript removal, and MCP removal are merged
  on `main`. Exact-head hosted certification and feedback closure are complete;
  only the separately authorized first tag or GitHub Release can publish the
  certified private artifacts.
