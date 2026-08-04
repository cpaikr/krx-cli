# Live KRX contract testing

The opt-in contract checker validates the maintained 31-endpoint registry
against both live KRX responses and the official KRX service specifications.
Ordinary `pnpm verify` remains deterministic and credential-free for forks.

## Plan before spending quota

```bash
pnpm contract:dry-run
pnpm contract:dry-run -- --date 20260310 --report artifacts/plan.json
```

Dry-run mode performs no network access. It reports the probe date, every
endpoint, exclusions, the number of public specification reads, and the
exact credentialed call maximum. The current plan has no exclusions and uses
one non-retried KRX request for each of 31 endpoints, so a run can reserve at
most 31 of the daily 10,000-call KRX allowance. It expects 32 public official
specification reads and enforces a hard maximum of 65 if upstream adds
services; those reads do not consume the credentialed API allowance.

## Credentialed run

Use a key approved for every KRX category and a confirmed trading date. The
key is read only from `KRX_API_KEY`, sent only as the `AUTH_KEY` request header,
and never included in plans or reports.

```bash
KRX_API_KEY=... pnpm contract:check -- --date 20260310
KRX_API_KEY=... pnpm contract:check -- \
  --date 20260310 \
  --report artifacts/krx-contract-report.json
```

Each credentialed attempt reserves one unit in the same local advisory quota
counter used by the CLI. Probes have a 15-second deadline and no retry, keeping
the call maximum deterministic. Reports contain only status, row counts,
field/type differences, bounded error text, and official metadata. Full market
rows and credentials are never retained or printed.

For every endpoint, the checker validates:

- HTTP success and a parseable JSON body;
- absence of a KRX `respCode`/`respMsg` error envelope;
- an array-valued `OutBlock_1` with at least one row;
- every maintained response field and its string type;
- added, missing, or type-changed observed fields.

An empty response is a failure, not schema evidence. Repeat the run with a
confirmed trading date rather than accepting an empty/no-trading-day result.
Credentials without all seven category approvals will produce explicit HTTP or
KRX error entries for the affected endpoints.

## Official specification drift

The checker reads the [official KRX service catalog](https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd)
and each linked development contract without using the sample credential shown
on those public pages. It compares:

- service additions, removals, duplicate paths, and path changes;
- required request field names and types;
- response field names and types;
- the reviewed official modification date for every endpoint.

The scheduled workflow runs once per week at 06:20 KST on Thursday and can use
at most 31 credentialed calls. Manual dispatch defaults to dry-run and accepts
an optional confirmed trading date. Configure the repository Actions secret
`KRX_API_KEY` only for live runs; pull-request CI never receives or requests it.

## Updating the maintained contract

Treat any report as a review request, not an instruction to copy upstream data
blindly:

1. Open the catalog link in the report and the endpoint's linked development
   specification.
2. Confirm the endpoint path, required `basDd` request contract, response field
   names/types, and whether a non-empty live response demonstrates the change.
3. Update `src/client/endpoints.ts` for service or request changes and
   `src/client/response-fields.ts` for response schema changes.
4. Update the endpoint date in `src/contracts/baseline.ts` only after the
   reviewed registry matches the official contract.
5. Add deterministic parser/drift fixtures, run `pnpm verify`, then run dry-run
   before the next credentialed check.

Do not commit generated reports or redistribute response datasets.
