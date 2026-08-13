# Goal: Trustworthy adjusted historical stock prices

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Deliver trustworthy corporate-action-adjusted OHLC prices by default for eligible single-security KOSPI, KOSDAQ, and KONEX historical queries.
- Goal state: goals/adjusted-stock-prices.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Oracle-backed adjustment semantics and regression fixtures — plans/adjusted-stock-prices.md
  - Exact, fail-closed adjustment engine — plans/adjusted-stock-prices.md
  - Default CLI and MCP integration — plans/adjusted-stock-prices.md, docs/CLI-CONTRACT.md, docs/COMPOSITE-RESULTS.md
  - Public schema, documentation, package alignment, and acceptance validation — plans/adjusted-stock-prices.md, README.md, skills/krx-cli/references/cli-usage.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Multi-security adjusted queries, cash-dividend total returns, and release or publication after feature delivery.
- Authority: Execute only included results and necessary supporting work; record anything else and ask before scope expansion or external authority.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

_None._

## Execution status

### Completed included results

_None._

### Current in-scope result

Oracle-backed adjustment semantics and regression fixtures.

### Next in-scope action

Capture provenance-stamped official KRX adjusted/raw examples and use them to settle exact serialization, transition metadata, and ambiguity rules.

### Evidence and blockers

- Initialization boundary: necessary to satisfy the goal's Resume invariant and PR Delivery lifecycle.
- Planning scope is the ordinary unscoped namespace. The completed production-readiness goal remains historical and does not conflict with this active goal.
- Delivery base: `codex/adjusted-stock-prices-integration`, created from local `main` at `5acaf7a`; it carries the two previously committed, unpushed planning/skill commits and isolates direct lifecycle metadata from production `main`.
- Boundary classification: the current oracle-fixture result is explicitly included by the contract. No excluded work is authorized.
