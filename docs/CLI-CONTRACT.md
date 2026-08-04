# CLI contract

The executable source of truth is `src/cli/program.ts` for option syntax and
validation, `src/user-contract.ts` for output defaults, request defaults, and
environment names, and `src/cli/exit-codes.ts` for process exit semantics.
Contract tests keep this reference, `README.md`, `SKILL.md`, and Commander help
aligned.

## Output

Single-endpoint row commands default to `table` on an interactive TTY and
`json` when stdout is redirected or piped. `--output` accepts only `json`,
`table`, `ndjson`, or `csv`.

Date ranges, stock search, market summary, and watchlist prices are composite
commands. They always return a JSON envelope containing `data` and
`completeness`, regardless of TTY state, because rendering that envelope as a
table would discard failure information.

Root options are inherited syntactically, but their behavioral scope is
deliberate:

| Option family                                                  | Active command scope                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `--output`                                                     | Endpoint row commands and `auth status`; composite results remain JSON.     |
| `--fields`                                                     | Endpoint row commands, date ranges, and stock search.                       |
| `--code`, `--sort`, `--asc`, `--offset`, `--limit`, `--filter` | Endpoint row commands and date ranges.                                      |
| `--from`, `--to`, `--save`, `--dry-run`                        | Endpoint row commands.                                                      |
| `--no-cache`, `--refresh`                                      | Endpoint row commands, market summary, and watchlist prices.                |
| `--retries`                                                    | Direct single-endpoint row requests; composites retain the bounded default. |

Passing a root option outside its active scope does not change that command.

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

| Code | Trigger                                                                                                     |
| ---: | ----------------------------------------------------------------------------------------------------------- |
|    0 | The command completed without a reportable failure or required-result miss.                                 |
|    1 | An upstream, network, timeout, cancellation, invalid-response, or local-state failure prevented completion. |
|    2 | Arguments or input were invalid or incomplete.                                                              |
|    3 | The requested market data or local target was absent.                                                       |
|    4 | No API key is configured, or KRX returned HTTP 401 (an ambiguous credential-or-approval failure).           |
|    5 | Local quota admission or KRX HTTP 429 rejected the request.                                                 |
|    6 | KRX explicitly rejected service approval with HTTP 403.                                                     |
|    7 | A composite command returned usable data while one or more requested components failed.                     |

KRX HTTP 401 responses do not reliably distinguish an invalid credential from
missing category approval. Code 4 therefore means an authentication-shaped or
ambiguous access failure, not proof that the key itself is invalid. Only an
explicit HTTP 403 is classified as service-not-approved and exits 6. Approval
probes expose ambiguous 401 outcomes as `inconclusive`.

Code 3 applies when a command requires a matching result. An intentionally
empty state listing, such as an empty watchlist, is still a successful result.
