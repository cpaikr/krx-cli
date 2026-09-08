# CLI usage

This branch requires the native `krx` executable. Discover exact options with
`krx --help` and `krx <group> <command> --help`; if unavailable, report the missing
executable before attempting queries.

## Credentials and approval

```bash
krx auth status
krx auth check stock
```

These commands actively probe one representative endpoint per category, consume
network requests and quota, and may persist local approval observations. Use them
for status questions or diagnosis, not as a prerequisite for every query or for
offline work. Category approval does not establish access to every endpoint.
Inspect each observation's `state`, `fresh`, `failureType`, and `error`; exit 0
can still contain rejected or inconclusive observations.

For credential setup, direct the user to `krx auth set --stdin` in their own
terminal. Do not ask for secrets in the conversation or construct commands that
extract them. `auth set`, `auth migrate`, and `auth remove` change local security
state and require explicit user authority; they do not apply for portal access.

## Endpoint queries

```bash
krx index list --date 20260821 --market kospi --output json
krx stock list --date 20260821 --market kospi --output json
krx stock info --market kospi --output json
krx etp list --date 20260821 --type etf --output json
krx bond list --date 20260821 --market general --output json
krx derivative list --date 20260821 --type futures --output json
krx commodity list --date 20260821 --type gold --output json
krx esg list --date 20260821 --type index --output json
```

### Dates and fields

- Daily `list` queries require `--date YYYYMMDD` or both `--from` and `--to`.
  Preserve explicit dates. Empty results do not authorize silently substituting
  an earlier session. `stock info`, search, and omitted summary/watchlist dates
  use a calendar-resolved trading date strictly before today in Asia/Seoul.
  For a latest-data request, verify and report the actual returned data date;
  do not describe these daily snapshots as live prices.
- Verify operation fields with `krx schema <operation>` or `krx schema --all`
  before filtering, sorting, or projection. `--fields` takes comma-separated
  names; unknown fields can silently disappear. Row values are strings: preserve
  leading zeros in security codes and parse numeric strings before arithmetic.
- `--fields` supports endpoint queries and `stock search`. `--filter`, `--sort`,
  `--asc`, `--offset`, and `--limit` support endpoint queries only. Quote a filter
  expression with spaces around one operator: `--filter 'FLUC_RT > 5'`.
  Supported operators are `==`, `!=`, `>`, `<`, `>=`, and `<=`.
- The pipeline selects `--code`, filters, sorts descending (or ascending with
  `--asc`), applies offset/limit, then projects fields. These operations run after
  fetching and do not reduce provider requests. Keep the date field when needed
  to verify freshness, even if the final answer omits it.
- Stock date ranges with one exact security code use adjusted prices by default.
  Use `--no-adjusted` only with that exact-code range to request raw prices;
  inspect adjustment metadata before calculating returns.

For an unadjusted chronological stock range:

```bash
krx stock list --from 20260803 --to 20260821 --market kospi --code 005930 --no-adjusted --sort BAS_DD --asc
```

## Composites

```bash
krx stock search 삼성전자
krx market summary --date 20260821
krx watchlist show --date 20260821
```

Single-date endpoint queries with `--output json` return a bare row array.
Date ranges, search, market summary, and populated watchlist prices return JSON
envelopes. Ranges retain their envelope even with another `--output` value;
do not add `--output` to search, summary, or watchlist commands, where it is invalid.

Inspect `completeness.state` and the requested/succeeded/failed/skipped
partitions before summarizing a range or composite. For ranges also inspect
`failedDays`, `calendar`, and any `adjustment` metadata. Disclose missing
components and calendar uncertainty; do not treat partial coverage as a complete
period or market. An empty watchlist instead returns its empty `entries` message.

## Cache and offline

```bash
krx cache status
krx cache prune --max-entries 100
krx cache clear
krx --offline stock list --date 20260821 --market kospi --output json
```

`status` is read-only. `prune` and `clear` mutate cache state and require
explicit authority.

Known limitation: `krx cache inspect` currently exits 2 with
`--limit is not valid for this command`, even when `--limit` is omitted. Its
local limit option conflicts with global-option validation. Use `cache status`
for aggregate cache information.

Offline mode never reads credentials or spends quota. It can return stale cache
rows. For a direct single-date query, inspect the provenance diagnostic on stderr.
Range and composite CLI envelopes omit cache provenance, so do not claim verified
cache freshness from those payloads. Report the actual data date in either case.
It conflicts with `--refresh`, `--no-cache`, `--dry-run`, and explicit `--retries`.
`--refresh` bypasses cache reads and can update cache; `--no-cache` bypasses both
reads and writes. They are mutually exclusive.

## Schema and failures

```bash
krx schema stock_stk_bydd_trd
krx schema --all
```

Capture exit status, stdout, and stderr separately. Exit 0 is command success,
2 is invalid input, 3 is empty, 4 is authentication, 5 is quota, 6 is approval,
and 7 is usable partial range/composite data. Other typed failures exit 1.
An empty direct query may have no stdout; exit 3 means no data, not zero prices
or malformed JSON. An envelope can carry failure details without typed stderr.
Inspect both the envelope and any `<kind>/<code>` stderr diagnostic; never infer
a credential or provider body from the human message.
