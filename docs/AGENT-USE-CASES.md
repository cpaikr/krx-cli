# Agent use cases

Agents can invoke `krx` commands through Bash or process tools, or use the public
Node.js SDK. Both approaches use the same Rust SDK.

## Query and analyze

```bash
krx stock list --date 20260821 --market kospi --output json
krx stock list --from 20260801 --to 20260821 --code 005930
krx market summary --date 20260821
```

Single-date queries return a JSON array of rows. For date-range queries and
composite results, check `completeness` in the response object before analyzing
the data. If it is `partial`, identify the failed components. Do not interpret
`empty` as zero or as successful data. Distinguish the requested date from the
actual data date when reporting results.

## Stock discovery and watchlists

```bash
krx stock search 삼성전자
krx watchlist add 삼성전자
krx watchlist show --date 20260821
```

Run commands that modify state only within the user's explicit authorization.
Limit query requests to read-only state access and network calls. Do not infer
authorization to configure, migrate, or delete credentials, or to modify
watchlists.

## Safe operation

- Use `krx auth status` to diagnose authentication and service approval status;
  never print key values. This command uses the network and consumes quota, so
  do not run it as a prerequisite for offline queries. Results from a
  representative endpoint in each category do not establish approval for every
  endpoint.
- Use `krx cache status` to check cache status. For the current limitations of
  `cache inspect` and alternatives, see the
  [CLI usage reference](../skills/krx-cli/references/cli-usage.md#cache-and-offline).
- Use `--offline` when network access must be prohibited, and clearly report
  when the cache does not contain the requested data.
- Obtain exact field names from `krx schema <operation>` or `krx schema --all`.
- Classify errors using `<kind>/<code>` on standard error (stderr) and the exit
  code.

For detailed commands, see the bundled
`skills/krx-cli/references/cli-usage.md`.
