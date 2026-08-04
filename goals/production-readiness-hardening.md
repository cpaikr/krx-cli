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

_None._

### Current in-scope result

Secure remote MCP and KRX credentials — GitHub issues #1–#2.

### Next in-scope action

Read tracker #11 and issues #1–#2, reconcile their completion criteria with repository evidence, and implement the first coherent credential-security slice.

### Evidence and blockers

- Initialization boundary: necessary to satisfy the goal's Resume invariant and no-PR Delivery lifecycle.
- Planning scope is the ordinary unscoped namespace. No existing `ROADMAP.md`, work-item queue, or goal file was present at initialization.
