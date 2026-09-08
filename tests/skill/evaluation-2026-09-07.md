# KRX skill audit — 2026-09-07

## Scope and decision

Reviewed all three runtime files in `skills/krx-cli`. Revised the entry-point
credential boundary and CLI reference; retained the portal workflow and
frontmatter unchanged. The source package remains implicitly discoverable with
express authorization required for portal applications. No adapter, installation,
publication, removal, or migration was needed or performed.

Reusable outcome: reliable KRX queries and accurate access-status reporting.
Distinctive help: CLI option, result-shape, partial-result and approval contracts
that command help alone does not fully explain. Expected reuse: market queries,
offline analysis, and status questions.

Baseline: clean working tree at `4f7c1cd5a72c7f34978be1ac8352ceb5f21b27d9`.
[Cases, frozen versions, raw responses, and CLI check output](evaluation-2026-09-07.json)
preserve the comparison evidence. Historical portal evaluations remain in
[evaluation.md](evaluation.md); they are not new live-portal evidence.

## Corrections and retained behavior

| Resource                            | Disposition and evidence                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md`                          | Replace the blanket credential read/persistence ban with a boundary on agent inspection and disclosure; permit internal CLI credential resolution while keeping entry user-controlled. The old CLI reference included a conflicting secret-reading pipeline. Preserve description, routing, and completion rules. |
| `references/cli-usage.md`           | Correct search `--fields` support, disallow composite `--output`, document explicit daily dates, numeric strings, pipeline order, adjusted ranges, JSON shapes and empty/partial exits. Authorities: `crates/krx-cli/src/args.rs`, `output.rs`, and `crates/krx-sdk/src/calendar.rs`.                             |
| `references/cli-usage.md`           | Explain active representative-category approval probes and inconclusive observations despite exit 0; remove the credential pipeline and unnecessary auth preflights. Authorities: SDK `client.rs::check_approval_at` and CLI `output.rs::execute_auth` / `approval_value`.                                        |
| `references/cli-usage.md`           | Explain stale offline results and limited provenance availability. Retain the still-reproducible `cache inspect` limitation. Authorities: CLI `output.rs::execute_endpoint`, `composite_value`, `call_options`, and option validation.                                                                            |
| `workflows/apply-service-access.md` | Retain stable identity, approved/pending preservation, uncertain-submission stop, provenance of approvals, requested-term checks and final reconciliation. Existing regression evidence covers these decisions; no new portal behavior introduced.                                                                |

## Evaluation

Gates were set before editing: package/resource validation, three paired
synthetic decision cases, then bounded review and documentation reconciliation.
Each candidate must satisfy the frozen observable assertions without a material
regression. A review correction qualified offline provenance availability;
a fourth pair was frozen before execution and the affected original offline
case reran against candidate v2. Query/range results remain applicable because
their online preparation and partial/empty instructions did not change.

| Case                                               | Baseline observation                                                                    | Candidate observation                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Dated gainers and projected search                 | Fails: rejects valid search `--fields` and proposes invalid search `--output json`.     | Pass: correct option scopes, schema checks, date verification, numeric ranking and preserved search envelope.  |
| Raw chronological range; partial and empty results | Pass: safe template with pending date-field lookup; preserves partial/empty boundaries. | Pass: concrete date sort plus calendar/adjustment checks; no invented prices or silent date substitution.      |
| Offline query and mixed auth status                | Pass: no online calls or blanket approval claim; probe scope remains implicit.          | Pass in v1 and v2: explicit representative-endpoint limitation, inconclusive status and offline-only behavior. |
| Complete offline range without provenance          | Pass: freshness remains unverified.                                                     | Pass: explains absent range provenance and distinguishes date coverage from freshness.                         |

Four scenarios, nine isolated responses including the targeted rerun. One
baseline command-validity failure; none observed in candidate responses. All
trials were command preparation or interpretation, not real query execution.
Placeholders awaiting schema discovery are acceptable for preparation-only tasks;
wording is not scored. This small sample does not establish general reliability.
No new trigger trials: description and routing were preserved byte-for-byte;
existing trigger examples remain consistent. Portal behavior, credential setup,
and every latest-date/calendar edge were not empirically retried.

## Static and review gates

- Skill Creator validator: passed using isolated `uv run --with pyyaml` because
  the system Python lacked PyYAML; no repository dependency change.
- Existing skill-package suite: 5/5 passed. Direct resource containment, absence
  of external symlinks, metadata consistency and final diff whitespace checked.
- Eight local subprocess checks matched help, validation, and local-state
  outcomes with only PATH in the environment. They confirm invalid daily dates,
  filter syntax, search output flags, the cache-inspect limitation and acceptance
  of search fields before the local-state boundary. They do not fetch data.
  Schema execution requires a home directory, so schema field names were
  verified from repository contracts rather than claiming successful execution.
- One independent `code-review` pass found the provenance qualification, now
  applied. No other actionable implementation, system, design or diet findings.
- `harmonize-docs changes`: aligned `docs/AGENT-USE-CASES.md` on output shapes,
  status probes and cache inspection; linked the same cache limitation from
  `docs/CACHE.md`. README and CLI/composite contracts already matched and were
  retained. Evaluation artifacts own the audit evidence, not runtime guidance.

## Authoring and portability disposition

Each applicable rubric item in these groups passes on the cited evidence;
exceptions are explicit rather than implicit claims of testing.

| Rubric group              | Result and evidence                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope and purpose         | Pass: one KRX data/access skill with existing branches and explicit adjacent-task exclusions in the entry point.                                                                                                                |
| Trigger description       | Pass, unchanged: portable frontmatter and existing positive/near-miss cases agree. New empirical trigger test N/A; no discovery change. Client adapter checks N/A; no adapter in this package.                                  |
| Entry-point quality       | Pass: native CLI and authenticated-tab prerequisites are stated; universal credentials/completion rules and direct routing remain concise.                                                                                      |
| Progressive disclosure    | Pass: both runtime resources have exact direct relative links and when-to-read guidance; no orphaned resources or deep routing.                                                                                                 |
| Specificity               | Pass: source-verified option and output rules address observed invalid commands; portal invariants and routine judgment remain intact.                                                                                          |
| Workflow and completion   | Pass: partial/empty/unknown outcomes stay visible, credential and portal authority are scoped, validation is bounded.                                                                                                           |
| Robustness                | Pass: missing executable, inconclusive auth, absent/partial data, stale offline results and portal uncertainty have explicit handling.                                                                                          |
| Resources and portability | Pass: directory/name match; portable frontmatter; no required absolute path, external symlink or hidden client dependency. Script determinism and copied third-party licensing N/A: no scripts or external material added.      |
| Evaluation                | Pass for this narrow source revision: frozen paired cases, preserved raw results and targeted v2 rerun. Holdout/repetition beyond the rerun N/A for this small correction; live portal and broad reliability remain unverified. |
| Pruning and final quality | Pass: conflicting credential example removed; new text changes concrete decisions. No new adapters, resources, invocation migration or speculative workflow.                                                                    |

Completed: source revisions, targeted review, evaluation, and affected-document
reconciliation. Remaining uncertainty is live KRX/portal compatibility and the
limited breadth of simulated trials. No rollout step was requested.
