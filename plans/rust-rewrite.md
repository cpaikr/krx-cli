# Rewrite krx-cli as a Rust-backed Node SDK and CLI

Status: queued

## Outcome

`krx-cli` becomes a Node.js product backed by one Rust implementation of the
KRX Open API. It exposes an idiomatic public Node SDK and the existing `krx`
executable, preserves the documented CLI behavior except for deliberate
corrections, removes MCP completely, and produces private installable native
tarballs for every supported platform without requiring a Rust toolchain on
consumer machines.

The rewrite is complete when the Rust-backed product passes contract,
black-box, package-consumer, and supported-platform validation and the legacy
TypeScript protocol implementation has been removed. Creating the first tag or
GitHub Release remains a separate publication decision.

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
- The implementation baseline is `ac223a1`, but its latest CI run and scheduled
  KRX contract-drift run are failing. A green, frozen baseline is a
  prerequisite for trusting rewrite parity evidence.
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
- Support Node.js as the runtime consumer. Browser, edge, Deno, Bun-runtime,
  Python, standalone Rust CLI, and a public Rust crate are outside the product
  boundary.

### Target architecture and authority

```text
contracts/krx/openapi.yaml
            |
            v
      crates/krx-core
 protocol + domain + local policy
            |
            v
      crates/krx-node
       Node-API boundary
            |
            v
     packages/node/src
      public SDK + CLI
            |
            v
 private per-target npm tarballs
```

- `contracts/krx/openapi.yaml` is the sole authority for supported KRX wire
  operations, parameter serialization, headers, response envelopes, and known
  field shapes. Handwrite the Rust conformer; do not generate the client.
- `crates/krx-core` is independent of Node-API types. Rust owns KRX request
  preparation and decoding, validation, HTTP behavior, retry/deadline and
  cancellation policy, quota accounting, credentials, cache lifecycle,
  calendar selection, composites, adjusted prices, capability projection, and
  project-owned errors.
- Use reqwest with Rustls and disabled redirects. The application owns every
  retry and reserves quota before every outbound attempt; configure the
  transport so it cannot perform an uncounted automatic retry.
- `crates/krx-node` exposes a small asynchronous project-owned interface using
  napi-rs. It projects stable values and errors, accepts cancellation, and does
  not expose Rust internals, HTTP-library types, raw bodies, credentials,
  dependency messages, or panics.
- `packages/node` owns the public TypeScript types, ergonomic SDK facade,
  Commander CLI parsing, secret-prompt UX, help, rendering, stdout/stderr, and
  process exits. It owns no KRX wire facts, transport, cache rules, or domain
  calculations.
- Add `ARCHITECTURE.md` only when the candidate implementation makes this
  shape true. Until then this plan is the target-design authority.

### Public Node SDK

- Export a supported TypeScript/JavaScript SDK from the installable package;
  the native binding remains private. The SDK covers direct KRX operations,
  composites, schema/capability discovery, cancellation, and the local
  credential and cache operations needed by non-CLI consumers.
- Freeze an idiomatic typed SDK contract before implementation. Use
  project-owned request/result types, asynchronous operations, `AbortSignal`,
  immutable operation descriptions, and stable structured error categories.
  Do not expose CLI argv shapes, Commander objects, napi-rs objects, reqwest
  types, arbitrary transport injection, or unrestricted raw KRX bodies.
- SDK calls never prompt. An explicitly supplied in-memory API key takes
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
- Read version-1 entries only through strict validation and rewrite them to the
  new format after a successful use or refresh. Do not bulk-convert unknown or
  corrupt files.

### Runtime and private distribution

- Support macOS ARM64, Linux GNU x64, Linux GNU ARM64, and Windows x64. Other
  operating systems, architectures, libc variants, and WASM remain unclaimed.
- Keep the public SDK facade and CLI in `packages/node`; use a canonical native
  target manifest to drive binding names, release assembly, CI, and docs.
- The release design uses one self-contained npm-compatible `.tgz` per
  supported target. The rewrite assembles and certifies all four as attachable
  private GitHub Release assets; a separately authorized release attaches
  them. Each tarball contains the same SDK/CLI JavaScript and exactly one
  matching `.node` artifact, so installation needs Node but no Rust toolchain
  or registry access.
- Clean-install every exact tarball on its native runner and test both SDK
  import and `krx` execution. Installation and update docs use authenticated
  GitHub Release download followed by local tarball installation; tokens never
  appear in package URLs or lockfiles.
- Retire Git-tag source builds after the prebuilt path passes on all targets.
  Version, JavaScript, declarations, native artifact, package metadata, and
  capability output must agree exactly.

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
- Freeze the public Node SDK API, CLI compatibility ledger, intentional-change
  ledger, project error taxonomy, and cache/credential migration contracts.
- Add a disposable Rust vertical slice proving official TLS, headers,
  representative decoding, cancellation, timeouts, keychain behavior, and
  Node-API async execution. Discard probe secrets and raw live payloads.
- Select exact Rust and Node dependency versions through current official
  documentation and record only decisions that affect the public contract or
  long-term maintenance.

### 2. Implement the Rust core

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

### 3. Build the binding, public SDK, and CLI

- Expose the minimum asynchronous Node-API operations needed by the public SDK,
  including cancellation, capabilities, typed result provenance, and stable
  errors.
- Implement the typed Node SDK facade and contract tests. Generate or compare
  declarations deterministically and test plain JavaScript and TypeScript
  consumers.
- Rebuild the `krx` command tree as a thin Commander adapter over the SDK.
  Preserve documented output and exits, add auth migration and offline/cache
  operations, and reject unsupported or ineffective combinations.
- Remove MCP only at cutover; before then, prevent the candidate from acquiring
  an MCP compatibility layer.

### 4. Prove parity, migration, and distributability

- Run the reviewed black-box judge against legacy and candidate installed
  products. Classify every difference as a fixed defect, approved intentional
  change, or regression; unclassified differences block cutover.
- Test clean legacy credential, cache, approval, quota, and watchlist state
  migration, including interrupted migrations, corrupt files, concurrent
  readers/writers, offline stale hits, and offline misses without credentials.
- Assemble all four private target tarballs and clean-install each on its native
  runner across every supported Node major. Exercise SDK imports, CLI help,
  representative commands, missing-native failures, cancellation, and package
  contents from the tarballs rather than the source tree.
- Run source, binding, package-consumer, security, dependency, license, contract
  freshness, and deliberate-mutation checks. Run credentialed live smoke only
  as a separate bounded validation.

### 5. Cut over atomically

- Switch package exports, the executable, tests, documentation, packaged skill,
  CI, contract drift, and release assembly to the Rust-backed SDK and CLI in one
  reviewable cutover.
- Delete the legacy TypeScript KRX transport/domain implementation and every MCP
  source, entrypoint, dependency, test, workflow path, environment variable,
  help item, and documentation claim. Preserve only thin public Node adapters.
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
- SDK contract tests cover every public operation, TypeScript declarations,
  plain JavaScript imports, `AbortSignal`, stable errors, provenance, and
  credential-free offline stale hits and misses without exposing private
  binding or transport types.
- CLI contract tests preserve documented commands, output, completeness, exit
  codes, and stdout/stderr behavior while proving removed MCP and corrected
  option/secret/cache behavior.
- Clean consumers install each macOS ARM64, Linux GNU x64/ARM64, and Windows x64
  tarball and run both the SDK and executable without a compiler or Rust
  toolchain. Package inspection finds exactly one matching native artifact.
- Deterministic merge validation, supported-platform CI, code review, and
  documentation freshness pass. Live credentialed checks remain separately
  reported and cannot weaken or block credential-free correctness evidence.
- The final repository has no legacy TypeScript protocol/domain code, MCP
  surface, plaintext credential fallback, generated-client authority, or
  install-time native build path.

## Next action

Authorize a long-running goal boundary from this plan. The recommended boundary
is the complete rewrite through atomic cutover and release-ready private
artifacts, stopping before creation of the first tag or GitHub Release.
