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

### Current in-scope result

Audited dependencies and reproducible cross-platform gates — GitHub issues #3 and #7.

### Next in-scope action

Upgrade the bundled MCP SDK dependency, establish a zero-high/critical production-audit gate, and add reproducible cross-platform packed-binary validation.

### Evidence and blockers

- Initialization boundary: necessary to satisfy the goal's Resume invariant and no-PR Delivery lifecycle.
- Planning scope is the ordinary unscoped namespace. No existing `ROADMAP.md`, work-item queue, or goal file was present at initialization.
- Issues #1–#2 decision: every Streamable HTTP `/mcp` request requires a static bearer token, including loopback, because a local tunnel can otherwise bypass a peer-address exception. The token is a single-user full-control credential; multi-user hosting remains out of scope.
- Non-loopback HTTP additionally requires an explicit DNS Host allowlist. Defaults bound each authenticated client to 120 requests/minute and 10 active sessions, with 100 sessions globally and 30-minute idle expiry.
- Credential persistence uses hidden interactive or stdin input, environment precedence, owner-only POSIX permissions, strict reads, sibling temporary writes with fsync/rename, and explicit removal. Windows follows profile ACLs without POSIX chmod assumptions.
- Security slice validation: `pnpm check` passed 239 tests; `pnpm build` passed; focused post-review validation passed 19 authentication, credential, and terminal-lifecycle tests.
