# Goal: Rust SDK, native CLI, and Node SDK rewrite

Status: active
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

_None._

## Execution status

### Completed included results

- Green frozen legacy baseline and mutation-tested compatibility judge.

### Current in-scope result

Canonical KRX OpenAPI and frozen SDK, CLI, error, and migration contracts.

### Next in-scope action

Reconcile the current 31-operation provider and product contracts into one
validated OpenAPI authority and bounded language-neutral profiles, then freeze
the Rust SDK, Node SDK, CLI compatibility and intentional-change ledgers, error
taxonomy, and credential/cache migration contracts around that authority.

### Evidence and blockers

- Initialization boundary: necessary to satisfy the goal's Resume invariant and PR-delivery lifecycle.
- Delivery integration branch: `codex/rust-rewrite-integration`, created from local `main` at `1f3dbd2`; it preserves the two queued rewrite-planning commits without pushing the production branch.
- Candidate classification: included under the frozen legacy baseline and compatibility-judge result; proceed with the smallest reviewable baseline slice after this metadata is pushed.
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
  [#7](https://github.com/sjunepark/krx-cli/pull/7) completed the create-review,
  feedback, re-review, and merge lifecycle. CodeRabbit and Codex reviewed the
  implementation, all ten review threads were addressed and resolved, and the
  final bounded implementation re-review was clean.
- `pnpm verify` passes 45 test files and 384 tests on the reviewed head,
  including the production audit, installed-package judge, three named
  mutation proofs, and packed-artifact smoke. npm 10.9.8 compatibility and
  package-smoke runs pass separately.
- Hosted CI run
  [32549447464](https://github.com/sjunepark/krx-cli/actions/runs/32549447464)
  passes the complete deterministic gate on Ubuntu and Windows under Node 22
  and 24.
- Hosted deterministic contract-drift run
  [32549339039](https://github.com/sjunepark/krx-cli/actions/runs/32549339039)
  passes for all 31 registered endpoints with no exclusions. Live-mode run
  [32549366727](https://github.com/sjunepark/krx-cli/actions/runs/32549366727)
  passes the current official KRX calendar step and then stops at the missing
  repository credential boundary.
- Merge commit `3732598e461ec5d78bd1121dbbe86d56aa658376` is the
  recoverable green pre-rewrite ref on `codex/rust-rewrite-integration`.
- External blocker for credentialed drift validation: the origin repository has
  no Actions `KRX_API_KEY` secret. Deterministic calendar and dry-run contract
  validation remain separate and do not require that credential; provisioning
  the live secret requires external authority.
- Current boundary classification: contract-authority and public-contract
  freeze work is included; Rust production implementation remains the next
  semantic result and will not begin until this contract slice completes its
  review PR.
