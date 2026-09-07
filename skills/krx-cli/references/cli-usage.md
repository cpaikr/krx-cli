# CLI usage

The native executable is the only command surface. Discover exact options with
`krx --help` and `krx <group> --help`.

## Credentials and approval

```bash
krx auth status
krx auth check stock
printf '%s\n' "$KRX_API_KEY" | krx auth set --stdin
krx auth migrate
krx auth remove
```

Do not put credentials in argv. `auth set`, `migrate`, and `remove` mutate
security state and require explicit user authority.

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

Use `--fields`, `--filter`, `--sort`, `--asc`, `--offset`, and `--limit` only
on endpoint queries. Use `--from` and `--to` together. `--code` selects one
security; eligible stock ranges are adjusted unless `--no-adjusted` is set.

## Composites

```bash
krx stock search 삼성전자
krx market summary --date 20260821
krx watchlist show --date 20260821
```

Inspect `completeness.state` and the requested/succeeded/failed/skipped
partitions before summarizing a composite result.

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

Offline mode never reads credentials or spends
quota and conflicts with refresh, bypass, dry-run, and explicit retries.

## Schema and failures

```bash
krx schema stock_stk_bydd_trd
krx schema --all
```

Exit 0 is success, 2 is invalid input, 3 is empty, 4 is authentication, 5 is
quota, 6 is approval, and 7 is usable partial composite data. Other typed
failures exit 1. Parse stderr diagnostics as `<kind>/<code>`; never infer a
credential or provider body from the human message.
