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

- Oracle-backed adjustment semantics and regression fixtures: official KRX raw
  and adjusted captures now cover unchanged basis, split, consolidation, bonus
  issue, stock dividend, rights issue, and suspension boundaries with exact
  query provenance and rounding evidence.
- Exact, fail-closed adjustment engine: reduced `BigInt` rational factors,
  nearest-integer serialization, identity and market-data invariants, suspension
  reconciliation, and empty integrity failures are implemented and tested.
- Default CLI and MCP integration: eligible exact-code stock ranges adjust
  before user pipelines by default, preserve raw fields, expose metadata, and
  support explicit raw-only opt-out without changing ineligible queries.
- Public schema, documentation, package alignment, and acceptance validation:
  derived provenance is separate from the official KRX field registry and both
  installed entrypoints exercise the published contract.

### Current in-scope result

PR delivery and feedback resolution for the completed implementation slice.

### Next in-scope action

Commit the reviewed slice, create the single reviewable PR, address all
actionable feedback, merge it into the delivery base, and record terminal goal
metadata.

### Evidence and blockers

- Initialization boundary: necessary to satisfy the goal's Resume invariant and PR Delivery lifecycle.
- Planning scope is the ordinary unscoped namespace. The completed production-readiness goal remains historical and does not conflict with this active goal.
- Delivery base: `codex/adjusted-stock-prices-integration`, created from local `main` at `5acaf7a`; it carries the two previously committed, unpushed planning/skill commits and isolates direct lifecycle metadata from production `main`.
- Boundary classification: the current oracle-fixture result is explicitly included by the contract. No excluded work is authorized.
- Official KRX validation: authenticated screen 12003 captures established all
  checked-in oracle values and exact rounding; the credentialed Open API
  contract check passed all 31 registered endpoint probes with no drift.
- Market acceptance: live exact-code adjusted ranges succeeded for KOSPI,
  KOSDAQ, and KONEX; the Samsung split matched its official oracle and the CLI
  raw opt-out returned only original fields.
- Repository gate: `pnpm verify` passed with 42 test files and 364 tests, no
  production vulnerabilities, a successful build, and installed-package smoke
  covering 31 schemas and 12 MCP tools. `pnpm contract:dry-run` also passed.
- Required code review: delivery coverage is complete; Bucket I added
  deterministic CLI execution, inconsistent-rate, unreconciled-suspension,
  large exact-rational, and reproducible oracle-provenance coverage. Bucket II
  is empty. Fresh-context delegated reviewers correctly abstained because
  their isolated contexts could not recover the platform goal; the recovered
  root context completed the bounded implementation, system, design, and diet
  review.
