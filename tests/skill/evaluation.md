# krx-cli skill evaluation

This record preserves the behavior and trigger evidence used for the issue #5
skill migration and subsequent completion-rule correction. Initial trials ran
in fresh isolated agent contexts against the working tree candidate on
2026-08-06. No browser, KRX account, credential, or external
account state was used or changed.

## Acceptance assertions

- A CLI query reads the CLI reference, chooses a contract-valid command, and
  states the result checks needed before analysis.
- An uncertain application result stops the batch, is not retried, and prevents
  a complete-success claim.
- Existing approvals, pending applications, and ambiguous identities are not
  resubmitted in a mixed-state run.
- Reconciliation distinguishes `existing-approved`, `newly-approved`,
  `submitted-pending`, `failed`, and `unknown`.
- Triggering includes KRX query, status, and express application requests while
  excluding account registration, API-key reissue, and unrelated market data.

## Behavior trials

### CLI query

Prompt: request the top five KOSPI gainers for 2026-03-10 with only name, close,
and change rate.

Candidate result: selected `references/cli-usage.md` and returned:

```bash
krx stock list --date 20260310 --market kospi --sort FLUC_RT --limit 5 --fields ISU_NM,TDD_CLSPRC,FLUC_RT --output table
```

It also required checking the service date range, row count, exit status, string
field semantics, and approval-related failures. Pass.

### Ambiguous submission result

Prompt: after explicit all-endpoint authorization, one confirmation alert never
appears and the portal cannot show whether submission occurred.

The historical root skill and candidate both avoided a blind retry. The
candidate additionally selected `workflows/apply-service-access.md`, stopped the
entire batch, classified the endpoint as `unknown`, preserved completed records,
listed remaining endpoints as unprocessed, and rejected a complete-success
claim. Pass; candidate behavior is more explicit and auditable than baseline.

### Mixed approved and unapplied endpoints

Synthetic inventory:

- A: already approved for 365 days.
- B: already pending.
- C: unsubmitted, then submitted and finally approved for `12M`.
- D: unsubmitted, then rejected by an isolated validation error.
- E: ambiguous display-name collision with no stable code or URL.

Candidate result: preserved A and B, submitted only C and D, refused E, and
reconciled A as `existing-approved`, B as `submitted-pending`, C as
`newly-approved`, D as `failed`, and E as `unknown`. It reported partial rather
than complete success. Pass.

## Trigger trial

The first frontmatter-only trial exposed ambiguity around “all unapproved” and
inferred-subset application requests. After revising the description, a fresh
trial classified all eight frozen cases as expected:

- Activate: KRX closing-price query, all-unapproved application request, KRX
  approval-status query, KRX approval-error diagnosis, and an express request to
  apply for the needed KRX services.
- Do not activate: KRX account registration, API-key reissue, and an unrelated
  S&P 500 web query.

## Completion-rule regression review — 2026-09-06

An independent agent performed read-only walkthroughs of the original and
revised workflows against a synthetic, uniquely identified two-page inventory.
No live browser or account was used. The original rule reproduced the defect:
a valid existing 6M approval prevented complete success alongside a new 12M
approval because every approval was required to match the requested term.

The revised workflow produced these outcomes:

| Existing endpoint A | New endpoint B                                        | Result                                                                |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| Valid 6M approval   | Approved for requested 12M                            | Preserve A, submit B once, report complete success.                   |
| Expired approval    | Approved for requested 12M                            | Classify A as unknown without renewal; report partial completion.     |
| Valid 6M approval   | Confirmation missing and submission state unavailable | Stop without retry, classify B as unknown, report partial completion. |
| Valid 6M approval   | Approved for 6M despite requesting 12M                | Preserve A, report B's term mismatch, withhold complete success.      |

The skill validator and existing package tests passed against the candidate.
These checks and walkthroughs validate the documented decision rules, not portal
DOM behavior or actual submission execution.

## Decision and residual risk

The candidate preserves the existing CLI branch and adds safer, more observable
application behavior. Static validation, repository tests, Skills CLI discovery,
and packed-artifact validation cover structure and distribution. Actual portal
DOM compatibility and an authenticated end-to-end application remain unverified;
the workflow therefore requires dynamic discovery and stops on DOM drift or
ambiguous state.
