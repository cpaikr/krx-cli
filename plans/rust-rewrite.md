# Rewrite krx-cli around a Rust SDK, native CLI, and Node SDK

Status: active

## Outcome

`krx-cli` becomes a native Rust CLI and a Node.js SDK backed by one shared Rust
SDK implementation of the KRX Open API. The existing `krx` executable is
rebuilt with Clap over that Rust SDK, while an idiomatic public Node SDK reaches
the same implementation through Node-API. The product preserves documented CLI
behavior except for deliberate corrections, removes MCP completely, and
produces private installable native tarballs for every supported platform
without requiring a Rust toolchain on consumer machines.

The rewrite is complete when the Rust SDK, native CLI, and Node SDK pass
contract, black-box, package-consumer, and continuous Linux GNU x64/ARM64
validation and the legacy TypeScript protocol and JavaScript CLI
implementations have been removed. macOS ARM64 and Windows x64 remain supported
artifact targets but are intentionally omitted from continuous CI to reduce
compute cost. Creating the first tag or GitHub Release remains a separate
publication decision.

## Current state

- The released implementation is a TypeScript/Node CLI and MCP server. Its
  source owns 31 KRX endpoints, composites, trading-calendar behavior,
  adjusted prices, caching, quota accounting, credentials, output rendering,
  and both CLI and MCP adapters.
- `docs/CLI-CONTRACT.md`, `docs/COMPOSITE-RESULTS.md`, the checked-in KRX
  calendar, endpoint registry, tests, and packaged skill describe the behavior
  that should survive the rewrite. Historical goal files are evidence, not
  active authority.
- The current cache stores file-per-request raw historical responses, but it
  can persist semantically empty results and has no request coalescing,
  cross-process refresh lease, bounded pruning, or offline stale-read mode.
- The current persisted KRX credential is plaintext in an owner-only file.
  KRX service-approval observations and advisory quota state also live in
  local files.
- The current package builds from source during private Git-tag installation.
  There is no public Node SDK contract or prebuilt native distribution.
- The recoverable legacy baseline is merge commit `3732598e461ec5d78bd1121dbbe86d56aa658376`.
  Its deterministic gate passes on Ubuntu and Windows under Node 22 and 24,
  the public contract-drift dry run passes for all 31 operations, and the
  installed-package judge rejects three independent compatibility mutations.
  Credentialed live drift remains separately blocked because the repository
  has no Actions `KRX_API_KEY` secret.
- The current contract branch establishes `contracts/krx/openapi.yaml` as the
  validated sole provider-wire authority for all 31 operations and freezes the
  project-owned Rust, Node, CLI, error, package, target, and persisted-state
  boundaries under `contracts/product/v1`. Checked projections include the
  exhaustive 425-entry CLI option matrix, generated language operation and
  error types, and strict operation-aware cache schemas. Nine maintained state
  schemas and classified fixtures cover credential, approval, cache, quota,
  and watchlist migration. The full deterministic gate passes 48 test files
  and 487 tests, including the targeted authority, product, and vertical-slice
  gate tests.
- The disposable workspace compiles the frozen Rust consumer and proves one
  OpenAPI-derived operation through reqwest/Rustls, a native Clap executable,
  and a private napi-rs binding. Before the 2026-08-24 CI-cost amendment,
  macOS ARM64 clean-install certification passed the same private tarball under
  Node 22 and 24. The historical hosted workflow built all four manifest
  targets once apiece, consumed each unchanged on both Node majors, aggregated
  the twelve required matrix jobs, and compared the portable payload, package
  metadata, and native capabilities reported by all eight consumers. The first
  hosted run passed all macOS and Linux work and
  every Windows step through package assembly, then exposed Node 24's inability
  to spawn `npm.cmd` directly. The next retry passed all four builds, including
  Windows assembly, pack, and upload, plus six non-Windows consumers. Its two
  Windows consumers installed the artifact before exposing a slash-specific
  declaration-containment assertion. The checked fix uses native relative-path
  semantics and an executable Win32 edge matrix. The next retry passed all
  builds and six non-Windows consumers; both Windows consumers completed every
  assertion and emitted matching passed reports before temporary cleanup failed
  on their still-loaded native DLL. Capability capture now comes from the
  child runtime probe so its process releases the module before cleanup. The
  next retry passed all four builds and all eight consumers, including Windows
  cleanup, before the aggregator exposed CRLF-only divergence in every Windows
  portable file. Checked attributes now pin the package sources to LF and are
  themselves a workflow input. Hosted run 32563560693 then passed all four
  builds, all eight exact-archive consumers under Node 22 and 24, and the final
  cross-target identity aggregator. An independent replay over the downloaded
  reports confirmed one portable digest, package metadata, and capability
  identity across all eight consumers. Documentation-head run 32564281020
  repeated the complete 13-job matrix successfully at commit
  `07fe73fe4c5500f3dcba0910a592b9d2c7a681ab`, the final implementation and
  certification-report head before PR delivery.
- On 2026-08-24, the repository moved to the private `cpaikr/krx-cli`
  repository. Continuous certification moved to Blacksmith Ubuntu 24.04 x64
  and ARM64 runners and now runs only for pull requests or manual dispatch.
  The manifest retains all four supported targets, while macOS and Windows are
  no longer continuous certification gates solely to reduce compute cost.
- `../ytm` supplies the target structural precedent. The accepted guidance in
  `../mytech` supplies the design rules: OpenAPI wire authority, a handwritten
  Rust conformer, narrow Node-API binding, boundary-owned contracts, pure
  cores, canonical sources, and source-to-consumer verification.

## Confirmed product decisions

### Product and compatibility boundary

- Keep this repository, its ordinary Git ancestry, the `krx` executable, and
  the existing package identity unless clean artifact assembly proves a
  package-name change unavoidable.
- Preserve documented CLI commands, output schemas, completeness envelopes,
  semantic exit codes, stdout/stderr separation, adjustment behavior, calendar
  policy, and supported KRX operations. Compatibility means documented
  behavior, not preservation of defects or internal TypeScript APIs.
- Deliberate corrections are part of the rewrite: remove secret-bearing argv
  input, reject options that previously appeared to work but were ineffective,
  avoid persistent negative caching of empty/current/future results, and make
  cache and credential provenance truthful.
- Remove MCP as a product surface. Delete `krx-mcp`, stdio and HTTP servers,
  Bearer-token authentication, MCP tools/resources, MCP dependencies, tests,
  workflows, help, and documentation. Do not replace them with another agent
  protocol.
- Support the native `krx` executable and Node.js SDK as runtime consumers of
  the Rust SDK. Browser, edge, Deno, Bun-runtime, Python, and other language
  bindings are outside the product boundary. The Rust SDK is a supported
  workspace boundary, but publishing it to crates.io is outside this release.

### Target architecture and authority

```text
contracts/krx/openapi.yaml
            |
            v
       crates/krx-sdk
 protocol + domain + local policy
        /           \
       v             v
crates/krx-cli   crates/krx-node
  Clap CLI       Node-API boundary
       |             |
       |             v
       |       packages/node/src
       |         public Node SDK
        \           /
         v         v
 private per-target npm tarballs
```

- `contracts/krx/openapi.yaml` is the sole authority for supported KRX wire
  operations, parameter serialization, headers, response envelopes, and known
  field shapes. Handwrite the Rust conformer; do not generate the client.
- `crates/krx-sdk` is independent of Clap and Node-API types. It exposes the
  reusable project-owned Rust API and owns KRX request preparation and
  decoding, validation, HTTP behavior, retry/deadline and cancellation policy,
  quota accounting, credentials, cache lifecycle, calendar selection,
  composites, adjusted prices, capability projection, and project-owned
  errors.
- Use reqwest with Rustls and disabled redirects. The application owns every
  retry and reserves quota before every outbound attempt; configure the
  transport so it cannot perform an uncounted automatic retry.
- `crates/krx-node` exposes a small asynchronous project-owned interface using
  napi-rs. It projects stable values and errors, accepts cancellation, and does
  not expose Rust internals, HTTP-library types, raw bodies, credentials,
  dependency messages, or panics.
- `crates/krx-cli` owns the native executable and uses Clap's derive API for
  parsing, nested subcommands, reusable argument groups, closed value enums,
  argv syntax and relationship checks, and generated help. It owns terminal-only
  secret prompting, rendering, stdout/stderr, and process exits, and invokes
  `crates/krx-sdk` directly for every operation. It owns no KRX wire facts,
  transport, cache rules, domain calculations, or shared semantic invariants.
- `packages/node` owns only the public TypeScript types and ergonomic Node SDK
  facade over `crates/krx-node`. It does not implement or parse the CLI and owns
  no KRX wire facts, transport, cache rules, or domain calculations.
- Add `ARCHITECTURE.md` only when the candidate implementation makes this
  shape true. Until then this plan is the target-design authority.
- The candidate toolchain is frozen at Rust 1.92.0. Direct dependency pins are
  Clap 4.6.6, reqwest 0.13.4, Tokio 1.53.1, tokio-util 0.7.19, napi-rs 3.12.2,
  napi-derive 3.6.3, napi-build 2.4.1, keyring-rs 4.1.6, serde 1.0.229,
  serde_json 1.0.151, serde-saphyr 1.1.0, thiserror 2.0.20, url 2.5.8,
  zeroize 1.9.0, futures-util 0.3.34, sha2 0.11.0, uuid 1.25.0, jiff 0.2.35,
  and num-bigint 0.5.1. SHA-256 identity, OS-random UUID-v4 lock identities,
  canonical UTC/KST time handling, and unbounded exact adjustment factors use
  those maintained crates rather than project-owned cryptography, randomness,
  timestamp parsing, or big-integer arithmetic. The contract gate rejects
  drift and the heavyweight fallback credential-database feature graph.

### Rust SDK and native CLI

- Treat `crates/krx-sdk` as the shared application API used by both adapters.
  Its asynchronous project-owned request, result, provenance, cancellation,
  credential, cache, and error types must not depend on Clap, Node-API, reqwest
  public types, terminal concerns, or unrestricted raw KRX bodies.
- Keep one deep concrete `Client` module at the public seam. The frozen client,
  request/result, composite, capability, credential, cache, watchlist, and
  error surface remains the complete supported interface; transport and
  local-state adapters are crate-private and never become caller extension
  points.
- Route direct calls, ranges, approval probes, and composites through one
  private direct-operation engine. Keep pure validation, preparation,
  decoding, calendar, adjustment, and completeness logic in-process; place
  private substitutable seams only around filesystem, clocks/timers,
  environment, and keychain, plus one true-external KRX HTTP seam whose
  production adapter is reqwest/Rustls and whose test adapter is scripted.
- Preserve the legacy market-summary numeric fallback at the derived boundary:
  malformed or out-of-range rate, volume, and value strings contribute zero.
  The SDK exposes `u64` totals and uses saturating addition so derived summaries
  cannot wrap; unavailable stock markets remain absent, never synthetic zero
  observations.
- Composite call-wide cancellation, invalid-request, local-state, and internal
  invariant failures reject the call. When more than one is observed,
  `compositePriority` selects deterministically; invalid requests are normally
  rejected before fan-out. Internal failures are call-wide because a broken
  SDK invariant cannot be represented as usable component data.
- The frozen four-state rule treats a provider failure beside a safely skipped
  calendar closure as `partial`, matching `docs/COMPOSITE-RESULTS.md`; this is
  an intentional correction to the legacy range reducer's `failed` result.
- `DateRange::new` accepts at most 10,000 inclusive calendar dates and returns
  `invalid_argument` before allocation when the bound is exceeded. Its fields
  remain private so callers cannot construct an unvalidated range.
- Adjustment `basisTransitions` strings use the lossless compact JSON grammar
  `krx-adjustment-transition/v1`, with exact field order `date`,
  `previousClose`, `previousDate`, `ratio` (`denominator`, `numerator`), then
  `referencePrice`. The values are canonical decimal strings and the grammar
  is regression-tested byte-for-byte for adapter parity.
- Build `crates/krx-cli` with Clap derive. Model the command tree with `Parser`
  and `Subcommand`, reusable option groups with `Args`, and closed command-line
  values with `ValueEnum`. Parser-level constraints reject invalid or
  conflicting combinations before SDK calls. The Rust SDK independently
  rejects every shared semantic violation so native and Node callers cannot
  diverge by bypassing Clap.
- Keep the CLI thin: translate parsed arguments into Rust SDK requests, invoke
  the SDK, then render the result and map project errors to the documented
  diagnostics and exit codes. Do not add a JavaScript command parser or a
  second CLI implementation.
- Rust SDK calls never prompt. Hidden input and stdin handling belong only to
  explicit native CLI credential commands.

### Public Node SDK

- Export a supported TypeScript/JavaScript SDK from the installable package;
  the native binding remains private. The SDK covers direct KRX operations,
  composites, schema/capability discovery, cancellation, and the local
  credential and cache operations needed by non-CLI consumers.
- Freeze an idiomatic typed SDK contract before implementation. Use
  project-owned request/result types, asynchronous operations, `AbortSignal`,
  immutable operation descriptions, and stable structured error categories.
  Do not expose CLI argv shapes, Clap types, napi-rs objects, reqwest types,
  arbitrary transport injection, or unrestricted raw KRX bodies.
- Node SDK calls never prompt. An explicitly supplied in-memory API key takes
  precedence for that client, followed by `KRX_API_KEY`, then the OS keychain.
  Secrets may cross the private binding only for the requested operation and
  must never appear in errors, diagnostics, cache keys, or persisted state.
- Rust returns a result projection that can carry cache source and freshness.
  The new SDK exposes that provenance. The CLI preserves existing success
  payloads and uses structured stderr diagnostics where adding fields would
  break them; existing composite envelopes may carry compatible metadata.

### Credentials and approval state

- Use `KRX_API_KEY` for automation and an OS credential store through
  keyring-rs for interactive persistence. Environment configuration wins over
  keychain state. There is no plaintext secret fallback.
- `krx auth set` accepts hidden interactive input or stdin and writes the
  keychain. Headless systems without a usable credential service must use the
  environment and receive a clear, typed error from persistence commands.
- Add explicit `krx auth migrate`: read the legacy owner-only config, write and
  verify the keychain entry, then delete only the migrated plaintext secret.
  Failure at any step preserves the original. Normal startup never silently
  migrates or deletes credentials.
- Support one active persisted credential, not named profiles. `auth remove`
  removes only the keychain secret. Approval observations remain separate,
  credential-fingerprint-bound, expiring local state and never contain the
  secret.

### Cache, offline reads, and quota

- Cache only strictly validated raw KRX response rows. Adjustment, filtering,
  sorting, pagination, field selection, summaries, and other derived results
  are recomputed and never become cache authority.
- Keep a versioned, credential-independent file-per-entry format keyed by the
  canonical provider operation and sorted request parameters. Include contract
  identity, fetch time, and enough provenance to reject mismatched or obsolete
  entries. Preserve atomic owner-only writes and corrupt-entry quarantine.
- Do not persist empty responses or requests for the current or a future KST
  date. A failed refresh preserves a previously valid entry.
- Coalesce equal requests in-process and use a bounded per-key cross-process
  lease so concurrent processes do not spend duplicate quota refreshing the
  same entry. Retain one shared per-credential KST-day quota counter across any
  temporary legacy/candidate coexistence; never let two engines admit separate
  10,000-call budgets.
- Add explicit `--offline`. Offline operations never resolve a credential or
  perform network access and may return a validated stale entry. They identify
  cache source, fetch time, and freshness; a miss or invalid entry is a typed
  failure, not an empty market result. `--offline` conflicts with refresh and
  other network-forcing options.
- Provide explicit bounded cache inspection and pruning. Do not add an
  always-running daemon or a database for the observed small local cache.
- Read version-1 entries only through strict validation. Rewrite them to the new
  format after a successful online use or refresh; offline hits return the
  validated version-1 entry without mutation or refresh-lease acquisition. Do
  not bulk-convert unknown or corrupt files.

### Runtime and private distribution

- Support macOS ARM64, Linux GNU x64, Linux GNU ARM64, and Windows x64. Other
  operating systems, architectures, libc variants, and WASM remain unclaimed.
- Keep the public Node SDK facade in `packages/node` and the native CLI in
  `crates/krx-cli`; use a canonical native target manifest to drive binding and
  executable names, release assembly, and docs. Its explicit continuous-target
  subset drives CI.
- The release design uses one self-contained npm-compatible `.tgz` per
  supported target. Continuous CI assembles and certifies the Linux GNU
  x64/ARM64 assets; macOS ARM64 and Windows x64 remain release-assembly targets
  without continuous validation. A separately authorized release attaches the
  artifacts. Each tarball contains the same Node SDK JavaScript, exactly one
  matching `.node` artifact, and exactly one matching native `krx` executable.
  Package metadata may use only a minimal launcher when required to enter that
  binary; it must contain no command parsing or CLI behavior and must
  transparently forward argv, stdin, stdout, stderr, exit status, and
  termination signals. Installation needs Node but no Rust toolchain or
  registry access.
- Clean-install every continuously certified Linux tarball on its native runner
  and test both SDK import and `krx` execution. macOS and Windows release-time
  validation is deferred to the separately authorized publication decision.
  Installation and update docs use authenticated GitHub Release download
  followed by local tarball installation; tokens never appear in package URLs
  or lockfiles.
- Retire Git-tag source builds after the continuously certified Linux prebuilt
  path passes. macOS and Windows artifacts require separate release-time
  validation before attachment. Version, JavaScript, declarations, Node
  binding, CLI executable, package metadata, and capability output must agree
  exactly wherever an artifact is produced.

## Execution plan

### 0. Repair and freeze the legacy baseline

- Reproduce and repair the current CI and scheduled contract-drift failures
  without weakening their assertions. Run the complete deterministic gate on
  supported development hosts and keep credentialed/live checks separate.
- Inventory the documented CLI, package contents, endpoint and field schemas,
  composites, adjustment behavior, local-state formats, diagnostics, and exit
  semantics. Resolve documentation-versus-implementation conflicts explicitly.
- Build a process-isolated black-box judge around the installed legacy package.
  Record reviewed scenarios and prove the judge fails against a deliberate
  behavioral mutation before using it as rewrite evidence.
- Preserve a recoverable pre-rewrite ref after the baseline is green. Keep the
  legacy product runnable until the atomic cutover.

### 1. Establish contracts and candidate architecture

- Create and validate the KRX OpenAPI source plus any explicitly named
  language-neutral profile needed for constraints OpenAPI cannot express.
  Derive validators or capability views as checked artifacts, never as a
  parallel authority.
- Freeze the Rust SDK API, public Node SDK API, Clap CLI compatibility ledger,
  intentional-change ledger, project error taxonomy, and cache/credential
  migration contracts.
- Add a disposable Rust vertical slice proving official TLS, headers,
  representative decoding, cancellation, timeouts, keychain behavior, one
  representative Clap command over the Rust SDK, and Node-API async execution.
  Prove whether package-manager entrypoints can invoke the native executable
  directly on every target; permit the transparent launcher only where direct
  invocation cannot meet the CLI contract. Discard probe secrets and raw live
  payloads.
- Select exact Rust and Node dependency versions through current official
  documentation and record only decisions that affect the public contract or
  long-term maintenance.

### 2. Implement the Rust SDK

- Deliver the complete frozen `crates/krx-sdk` surface in one SDK PR, organized
  as reviewable commits rather than public placeholder methods. Begin with the
  all-31-operation catalog, project-owned types/errors, and pure strict request
  preparation/response decoding; then add transport/retry/cancellation/quota,
  domain composites/adjustment, and local state/cache/credential migration.
- Implement pure request preparation and response decoding against OpenAPI,
  followed by bounded transport, typed failures, explicit application retries,
  cancellation, and exact shared quota admission.
- Port endpoint capabilities, strict row validation, calendar behavior,
  completeness envelopes, stock search, market summary, watchlist pricing,
  and adjusted-price calculation as testable Rust domain modules.
- Implement keychain/env credential resolution, approval observations, the
  cache lifecycle, offline stale reads, request coalescing, leases, pruning,
  and version-1 migration.
- Keep fixture and provider-evidence tests in Rust. No Node test double may
  become a second transport implementation.

### 3. Build the native CLI, Node binding, and public Node SDK

- Expose the minimum asynchronous Node-API operations needed by the public SDK,
  including cancellation, capabilities, typed result provenance, and stable
  errors.
- Implement the typed Node SDK facade and contract tests. Generate or compare
  declarations deterministically and test plain JavaScript and TypeScript
  consumers.
- Rebuild the `krx` command tree in `crates/krx-cli` with Clap derive over the
  Rust SDK. Preserve documented output and exits, add auth migration and
  offline/cache operations, and reject unsupported or ineffective combinations
  before invoking the SDK.
- Remove MCP only at cutover; before then, prevent the candidate from acquiring
  an MCP compatibility layer.

### 4. Prove parity, migration, and distributability

- Run the reviewed black-box judge against legacy and candidate installed
  products. Classify every difference as a fixed defect, approved intentional
  change, or regression; unclassified differences block cutover.
- Test clean legacy credential, cache, approval, quota, and watchlist state
  migration, including interrupted migrations, corrupt files, concurrent
  readers/writers, offline stale hits, and offline misses without credentials.
- Retain assembly definitions for all four private target tarballs and
  continuously assemble and clean-install Linux GNU x64/ARM64 on native
  Blacksmith runners across every supported Node major. Exercise SDK imports,
  CLI help, representative native CLI commands, OS/CPU/libc rejection, Unix
  executable permissions, independent missing or mismatched binding and
  executable failures, cancellation, and package contents from the tarballs
  rather than the source tree. macOS and Windows remain supported manifest
  targets without continuous CI execution.
- Run source, binding, package-consumer, security, dependency, license, contract
  freshness, and deliberate-mutation checks. Run credentialed live smoke only
  as a separate bounded validation.

### 5. Cut over atomically

- Switch package exports, the executable, tests, documentation, packaged skill,
  CI, contract drift, and release assembly to the Rust SDK, native CLI, and
  Node SDK in one reviewable cutover.
- Delete the legacy TypeScript KRX transport/domain implementation and every MCP
  source, entrypoint, dependency, test, workflow path, environment variable,
  help item, and documentation claim. Preserve only the Rust SDK, native Clap
  CLI, narrow Node binding, and thin public Node SDK adapters.
- Replace source-build installation guidance with private release-tarball
  installation and migration instructions. Create `ARCHITECTURE.md` describing
  the implemented state and reconcile every durable document with its single
  authority.
- Run the complete gate and required code review from a clean checkout. The
  tree must contain one HTTP conformer, one credential policy, one cache policy,
  and no dormant legacy or MCP path.

## Acceptance validation

- The OpenAPI source validates, every supported request/response conformer test
  passes, and no handwritten mirror can redefine wire facts.
- The legacy judge first passes the frozen baseline and demonstrably fails its
  mutation. The candidate passes every preserved scenario and every intentional
  difference is named and tested.
- Rust tests cover all 31 endpoints, strict malformed inputs and responses,
  retry/deadline/cancellation boundaries, exact quota reservation, calendar and
  composite semantics, adjusted-price oracles, and sanitized errors.
- Credential tests prove explicit SDK keys, environment precedence, keychain
  persistence, headless failure, verified plaintext migration, removal, and
  secret-free errors/state. No plaintext fallback remains.
- Cache tests prove validated raw-only entries, no negative/current/future
  persistence, atomicity, quarantine, singleflight, cross-process leases,
  shared quota, bounded pruning, version-1 migration, and offline stale reads
  without credential or network access.
- Rust SDK contract tests cover every supported operation, stable project-owned
  types and errors, shared invalid and conflicting request states, cancellation,
  provenance, and credential-free offline stale hits and misses without
  exposing adapter or transport types.
- Node SDK contract tests cover every public operation, TypeScript declarations,
  plain JavaScript imports, `AbortSignal`, stable errors, provenance, and parity
  with the Rust SDK without exposing private binding or transport types.
- Native Clap CLI contract tests preserve documented commands, help, output,
  completeness, exit codes, and stdout/stderr behavior while proving parser
  constraints, removed MCP, and corrected option/secret/cache behavior. No
  JavaScript CLI parser or alternate command implementation remains.
- Clean consumers install each Linux GNU x64/ARM64 tarball under Node 22 and 24
  and run both the SDK and executable without a compiler or Rust toolchain.
  Package inspection finds exactly one matching `.node` binding and one
  matching native `krx` executable; wrong-platform artifacts, missing
  artifacts, mismatched artifacts, and missing Unix executable permissions
  fail explicitly. macOS ARM64 and Windows x64 remain supported manifest
  targets but are not continuous CI completion criteria.
- Deterministic merge validation, continuous Linux CI, code review, and
  documentation freshness pass. Live credentialed checks remain separately
  reported and cannot weaken or block credential-free correctness evidence.
- The final repository has no legacy TypeScript protocol/domain code, JavaScript
  CLI implementation, MCP surface, plaintext credential fallback,
  generated-client authority, or install-time native build path.

## Next action

Deliver the complete frozen `crates/krx-sdk` surface in one production SDK PR,
using reviewable commits for the all-operation catalog and strict conformer,
transport/retry/cancellation/quota and domain behavior, then credential,
cache/offline, local-state, and migration policy. Do not begin the native CLI
or Node adapter implementation until the SDK PR completes feedback and merge.
