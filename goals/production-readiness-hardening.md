# Goal: Production-readiness hardening

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract
- Outcome: Bring krx-cli to the production-readiness baseline defined by tracker #11 across every open implementation issue.
- Goal state: goals/production-readiness-hardening.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Secure remote MCP and KRX credentials — GitHub issues #1–#2
  - Audited dependencies and reproducible cross-platform gates — GitHub issues #3 and #7
  - Bounded HTTP, accurate quota accounting, and trustworthy approval checks — GitHub issues #4 and #6
  - Explicit composite-result completeness — GitHub issue #5
  - Live KRX contract-drift detection — GitHub issue #8
  - Exchange-aware trading dates — GitHub issue #9
  - Consistent CLI and documentation contracts — GitHub issue #10
  - Versioned, fresh, atomic cache behavior — GitHub issue #12
  - Production-readiness definition — GitHub issue #11
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Publishing, releasing, or upstream contribution after the baseline; PR creation, pushes, merges, PR reviews, and GitHub issue mutation.
- Authority: Execute only included results and necessary supporting work; resolve remaining decisions within that closed outcome using best judgment; record anything else and ask before scope expansion or external authority.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: No PR — use $progress's no-PR lifecycle, preserve coherent commits for later reviewed aggregation, and reserve PR creation and PR-only feedback workflows for that later delivery.

## Authorized amendments

_None._

## Execution status

### Completed included results

- Secure remote MCP and KRX credentials — GitHub issues #1–#2.
- Audited dependencies and reproducible cross-platform gates — GitHub issues #3 and #7.
- Bounded HTTP, accurate quota accounting, and trustworthy approval checks — GitHub issues #4 and #6.
- Explicit composite-result completeness — GitHub issue #5.

### Current in-scope result

Live KRX contract-drift detection — GitHub issue #8.

### Next in-scope action

Add an opt-in credentialed contract suite with a deterministic dry run, a bounded probe budget, explicit endpoint coverage or exclusions, actionable schema drift reports, and documented registry-update workflow while retaining mocked fork-safe tests.

### Evidence and blockers

- Initialization boundary: necessary to satisfy the goal's Resume invariant and no-PR Delivery lifecycle.
- Planning scope is the ordinary unscoped namespace. No existing `ROADMAP.md`, work-item queue, or goal file was present at initialization.
- Issues #1–#2 decision: every Streamable HTTP `/mcp` request requires a static bearer token, including loopback, because a local tunnel can otherwise bypass a peer-address exception. The token is a single-user full-control credential; multi-user hosting remains out of scope.
- Non-loopback HTTP additionally requires an explicit DNS Host allowlist. Defaults bound each authenticated client to 120 requests/minute and 10 active sessions, with 100 sessions globally and 30-minute idle expiry.
- Credential persistence uses hidden interactive or stdin input, environment precedence, owner-only POSIX permissions, strict reads, sibling temporary writes with fsync/rename, and explicit removal. Windows follows profile ACLs without POSIX chmod assumptions.
- Security slice validation: `pnpm check` passed 239 tests; `pnpm build` passed; focused post-review validation passed 19 authentication, credential, and terminal-lifecycle tests.
- Dependency and gate slice: the MCP SDK is upgraded to 1.30.0 with zero locked production advisories; Node 22/24 runs on Ubuntu and Windows, and release verification smoke-tests the same packed artifact later passed to `npm publish` through its installed `krx` and `krx-mcp` entrypoints.
- Gate validation: `pnpm verify` passed 239 tests, all-source coverage of 56.47% statements / 48.21% branches / 64.45% functions / 56.05% lines, a clean production audit, both builds, and a packed artifact smoke covering 31 schemas and 12 MCP tools. Independent review found and verified fixes for Windows command-shim execution and direct-dist smoke bypass.
- HTTP reliability uses a 15-second attempt timeout and 45-second overall deadline across quota admission, fetch and body reads, retry delays, and caller cancellation. Retries are limited to network or attempt-timeout failures and HTTP 408/429/500/502/503/504, with bounded jitter and deadline-aware `Retry-After` handling.
- Every outbound attempt first reserves one advisory quota unit in a versioned, per-credential SHA-256 counter keyed to the KST calendar day. Owner locks serialize independent processes, atomic fsync-and-rename writes prevent malformed state, corrupt state fails closed, and concurrency tests prove exact admission at the 10,000-call boundary.
- Approval probes always bypass market-data cache and use the checked-in official category endpoint. Persisted observations are credential-bound, fresh for 15 minutes, and expose approved, rejected, or inconclusive states without credential identity; ambiguous KRX 401 responses remain inconclusive while explicit 403 approval denials are rejected.
- Typed timeout, cancellation, quota, authentication, approval, network, upstream, invalid-response, and local-state failures now survive direct and composite CLI/MCP paths. CLI SIGINT and MCP request cancellation reach all request families, cancellation dominates partial aggregate data, and body-stream network failures remain retryable.
- Reliability validation: `pnpm verify` passed 265 tests, all-source coverage of 61.05% statements / 53.57% branches / 68.42% functions / 60.85% lines, a clean production audit, both builds, and packed-artifact smoke for 31 schemas and 12 MCP tools. Independent review passed 94 targeted tests and reported no actionable P0–P2 findings.
- Composite operations now share a complete, partial, empty, or failed envelope with explicit requested, succeeded, failed, and skipped partitions. The envelope is limited to date ranges, stock search, market summary, and watchlist prices; direct single-endpoint CLI and MCP arrays remain compatible.
- Date-range partitions retain per-date typed failures and distinguish successful empty dates. Search and watchlist results prove KOSPI/KOSDAQ coverage, and watchlist add never mutates local state after a partial or empty prerequisite search.
- Market-summary failures produce `null` unavailable components and suppress all stock-derived statistics unless both stock markets succeeded, so missing input is never represented by a derived zero. CLI composite output remains JSON, warns on partial success with exit code 7, and uses exit code 3 for genuine empty results.
- MCP size truncation composes with the same completeness envelope for top-level rows and nested watchlist stocks; `_truncated.path` identifies only the transport-truncated collection without changing semantic completeness.
- Composite validation: `pnpm verify` passed 281 tests, all-source coverage of 63.25% statements / 57.42% branches / 71.87% functions / 63.08% lines, a clean production audit, both builds, and packed-artifact smoke for 31 schemas and 12 MCP tools. Structured review found and fixed nested watchlist truncation and unsupported generic pagination guidance, then reported no remaining actionable P0–P2 findings.
