# CLI contract

The executable source of truth is `src/cli/program.ts` for option syntax and
validation, `src/user-contract.ts` for output defaults, request defaults, and
environment names, and `src/cli/exit-codes.ts` for process exit semantics.
Contract tests keep this reference, `README.md`,
`skills/krx-cli/references/cli-usage.md`, and Commander help aligned.

This document freezes the installed legacy boundary until atomic cutover. The
native candidate is resolved as a delta over that boundary by
`contracts/product/v1/cli-overlay.json`, its candidate-only cases, and the
generated exhaustive option-scope matrix. The overlay removes MCP and `serve`,
removes secret-bearing argv input, adds explicit credential migration and
offline/cache maintenance, and makes formerly ineffective root options fail
with exit 2. It also fixes watchlist price coverage so persisted KONEX entries
are requested instead of silently omitted. Any difference absent from that
ledger blocks cutover.

## Output

Single-endpoint row commands default to `table` on an interactive TTY and
`json` when stdout is redirected or piped. `--output` accepts only `json`,
`table`, `ndjson`, or `csv`.

Date ranges, stock search, market summary, and watchlist prices are composite
commands. They always return a JSON envelope containing `data` and
`completeness`, regardless of TTY state, because rendering that envelope as a
table would discard failure information.

Eligible stock adjustment is narrower than the generic date-range contract. A
KOSPI, KOSDAQ, or KONEX daily-stock query with both range ends and one exact
`--code` returns adjusted OHLC by default. Raw `TDD_*` fields remain unchanged;
derived `ADJ_TDD_*` fields, `ADJ_FACTOR`, and envelope-level `adjustment`
metadata are added before the row pipeline. `krx stock list --no-adjusted`
requests the legacy raw-only range. Direct dates, full-market queries,
multi-security queries, and non-daily-stock endpoints remain raw-only.

Adjustment requires complete, uniquely identified, internally consistent input.
An integrity failure emits a structured failed envelope with `data: []` and
exits 1. It never returns partial/raw rows as an adjusted success. Adjustment
excludes cash dividends and is not a total-return series.

Root options are inherited syntactically, but their behavioral scope is
deliberate:

| Option family                                                  | Active command scope                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `--output`                                                     | Endpoint row commands and `auth status`; composite results remain JSON.     |
| `--verbose`                                                    | Endpoint row commands.                                                      |
| `--fields`                                                     | Endpoint row commands, date ranges, and stock search.                       |
| `--code`, `--sort`, `--asc`, `--offset`, `--limit`, `--filter` | Endpoint row commands and date ranges.                                      |
| `--from`, `--to`, `--save`, `--dry-run`                        | Endpoint row commands.                                                      |
| `--no-cache`, `--refresh`                                      | Endpoint row commands, market summary, and watchlist prices.                |
| `--retries`                                                    | Direct single-endpoint row requests; composites retain the bounded default. |
| `stock list --no-adjusted`                                     | Eligible exact-code KOSPI/KOSDAQ/KONEX date ranges only.                    |

The legacy executable accepts a root option outside its active scope without
changing that command. The native candidate rejects the same ineffective use
with exit `2`, as the classified `inactive-root-options-exit-2` defect fix.

Candidate-only command syntax is frozen as follows:

- `krx auth migrate [--help]`
- `krx cache inspect [--operation <id>] [--date <YYYYMMDD>] [--limit <1..1000>]`
- `krx cache prune [--older-than <instant>] [--max-entries <0..10000>]`

`auth migrate` is the only plaintext-credential migration trigger. Cache
inspection and pruning remain bounded by the local-state contract; exceeding a
command bound is invalid input and exits `2` before traversal.

## Environment

| Variable                  | Contract                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| `KRX_API_KEY`             | Optional alternative to `krx auth set`; takes precedence over the persisted key. |
| `KRX_MCP_TOKEN`           | Required Bearer credential for every Streamable HTTP `/mcp` request.             |
| `KRX_MCP_ALLOWED_HOSTS`   | Required DNS Host allowlist for non-loopback HTTP binds.                         |
| `KRX_CACHE_MAX_AGE_HOURS` | Optional historical-cache freshness from 0 through 8760 hours; defaults to 168.  |
| `KRX_CONTRACT_DATE`       | Optional date override for the maintainer-only contract checker.                 |

`AUTH_KEY` is the upstream KRX HTTP request-header field. It is not a supported
krx-cli environment variable.

## Exit status

| Code | Trigger                                                                                                                |
| ---: | ---------------------------------------------------------------------------------------------------------------------- |
|    0 | The command completed without a reportable failure or required-result miss.                                            |
|    1 | An upstream, network, timeout, cancellation, invalid-response, integrity, or local-state failure prevented completion. |
|    2 | Arguments or input were invalid or incomplete.                                                                         |
|    3 | The requested market data or local target was absent.                                                                  |
|    4 | No API key is configured, or KRX returned HTTP 401 (an ambiguous credential-or-approval failure).                      |
|    5 | Local quota admission or KRX HTTP 429 rejected the request.                                                            |
|    6 | KRX explicitly rejected service approval with HTTP 403.                                                                |
|    7 | A composite command returned usable data while one or more requested components failed.                                |

KRX HTTP 401 responses do not reliably distinguish an invalid credential from
missing category approval. Code 4 therefore means an authentication-shaped or
ambiguous access failure, not proof that the key itself is invalid. Only an
explicit HTTP 403 is classified as service-not-approved and exits 6. Approval
probes expose ambiguous 401 outcomes as `inconclusive`.

Code 3 applies when a command requires a matching result. An intentionally
empty state listing, such as an empty watchlist, is still a successful result.
