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
- Live KRX contract-drift detection — GitHub issue #8.
- Exchange-aware trading dates — GitHub issue #9.
- Versioned, fresh, atomic cache behavior — GitHub issue #12.

### Current in-scope result

Consistent CLI and documentation contracts — GitHub issue #10.

### Next in-scope action

Reconcile CLI help, examples, generated/reference documentation, and machine-readable output descriptions with implemented behavior; add deterministic checks that prevent maintained contracts from drifting again.

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
- The opt-in contract checker plans and probes every maintained endpoint (31 probes, zero exclusions), reserves at most one non-retried KRX call per probe, enforces 15-second attempt deadlines, and reports HTTP, KRX-envelope, `OutBlock_1`, empty-session, added/missing/type-changed field, and quota-admission outcomes without retaining market rows.
- Public KRX specification drift is bounded to 65 reads, restricted to the official origin, and compares service membership, duplicate paths, request/response fields and reviewed modification dates. A read-only live catalog validation on 2026-08-04 found exactly 31 services and no maintained-contract drift; the portal's sample credential was never parsed or reported.
- Dry-run validation performed no network requests or quota reservations and atomically produced an owner-only report with 31 registered probes, a 31-call credentialed maximum, 32 expected public reads and a 65-read public safety cap. No local `KRX_API_KEY` was present, so credentialed production execution remains an explicit scheduled/manual operational check using the repository secret.
- Contract validation: `pnpm verify` passed 301 tests, all-source coverage of 65.22% statements / 58.59% branches / 73.58% functions / 65.33% lines, a clean production audit, both builds, and packed-artifact smoke for 31 schemas and 12 MCP tools. Structured review corrected pnpm argument forwarding, report-directory permission mutation, non-JSON HTTP-failure classification, bounded official reads, catalog origin enforcement, and exact reservation terminology; a deterministic full-run test then exercised all 31 endpoints with 63 mocked public/live requests. No Bucket I or Bucket II issue remains; the only residual validation gap is the intentionally secret-dependent live market-data run.
- Trading-session selection now uses a checked-in KRX Market Closing snapshot for 2016–2026, treats every covered weekday not listed as a verified session, and performs all instant and calendar arithmetic explicitly in KST/UTC so host timezone cannot change results. A live public `pnpm calendar:check -- 2025 2026` comparison on 2026-08-04 found both maintained years current without using a credential or market-data quota.
- Recent defaults walk backward from KST T-1 to a verified session across weekends, Lunar New Year, Chuseok, elections, temporary closures, and year-end boundaries. Stale coverage never guesses a default across unknown weekdays: it returns the last verified session with `stale_fallback` metadata and an explicit `KRX_CALENDAR_FALLBACK` diagnostic, or fails after the bounded one-year search.
- Date ranges avoid KRX calls for verified non-trading dates, include all requested dates in completeness, classify known closures and weekends as skipped, keep upstream failures distinct, and expose calendar version/source/retrieval/coverage/fallback metadata. Explicit uncovered historical weekdays remain observable probes; conservative fixed-closure rules apply only beyond the latest official snapshot year.
- The maintainer update path performs bounded 15-second official reads, detects added, removed, and renamed closures, writes snapshot updates through a sibling temporary file and rename, and is checked before credentialed calls in the weekly contract workflow. Calendar behavior, fallback, and update operations are documented in `docs/KRX-CALENDAR.md`.
- Calendar validation: `pnpm verify` passed 303 tests, all-source coverage of 66.28% statements / 60.02% branches / 74.10% functions / 66.43% lines, a clean production audit, both builds, and packed-artifact smoke for 31 schemas and 12 MCP tools. Structured root review applied the safe historical fallback fix and found no actionable P0–P2 issue; delegated review was attempted but the agent thread limit rejected a new reviewer despite no live child task.
- Historical response cache entries now use format version 1 with a UTC fetch timestamp, exact endpoint and sorted request-parameter identity, and response rows. Legacy, incompatible, corrupt, identity-mismatched, or unreasonable future entries are ignored and quarantined with source and quarantine paths in the diagnostic; current-KST-day responses remain uncached and entries remain credential-independent.
- Historical entries are fresh for seven days by default, with a bounded `KRX_CACHE_MAX_AGE_HOURS` override from zero through one year. Stale entries revalidate on demand, `--refresh` bypasses and replaces only the endpoint/date/request identities selected by the command, `--no-cache` bypasses both reads and writes, and failed refreshes preserve the prior entry.
- Cache writes reuse the owner-only sibling-temporary, file-fsync, rename, and directory-fsync path, so readers see complete old or new JSON and concurrent writers are last-writer-wins without corrupting the entry. Tests cover metadata, default and configured staleness, format upgrades, corruption quarantine, explicit refresh, interrupted temporary files, and interleaved writers/readers.
- Cache validation: `pnpm verify` passed 324 tests, all-source coverage of 69.41% statements / 61.60% branches / 78.42% functions / 69.71% lines, a clean production audit, both builds, and packed-artifact smoke for 31 schemas and 12 MCP tools. The structured root review found and fixed an omitted executable `--refresh` registration and reported no Bucket II decision; delegated review stopped without inspection because child goal recovery returned no active goal.
