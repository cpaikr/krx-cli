# Response cache lifecycle

`krx-cli` caches successful KRX responses only when the request contains a
historical `basDd`. The current KST date is never cached. Cache entries live
under `~/.krx-cli/cache/<YYYYMMDD>/` and are not keyed to the API credential
because KRX market data is not credential-specific.

Each entry uses format version 1 and records its UTC fetch timestamp, endpoint,
sorted request parameters, and response rows. Readers validate that metadata
against the file's request-derived key. Legacy arrays, unsupported versions,
malformed JSON, mismatched identities, and unreasonable future timestamps are
ignored and moved beside the original path with a `.corrupt-*` suffix. The
stderr diagnostic identifies both paths so the retained file can be inspected
or removed.

## Freshness and targeted refresh

Historical entries are fresh for seven days by default. A stale entry remains
on disk but is not returned; the next successful request atomically replaces
it. Override the bounded policy with `KRX_CACHE_MAX_AGE_HOURS` from `0` (always
revalidate) through `8760` (one year). Invalid values fall back to seven days
with a one-time diagnostic.

Use `--refresh` on a normal data command to bypass and replace only the entries
identified by that command's endpoint, date, and other request parameters:

```bash
krx stock list --market kospi --date 20260310 --refresh
krx index list --market kospi --from 20260301 --to 20260310 --refresh
```

`--no-cache` bypasses both reads and writes. It cannot be combined with
`--refresh`. A failed refresh leaves the previous entry intact, so a later
request can retry revalidation. `krx cache clear` remains available for
intentional whole-cache removal.

## Write integrity

Writers create a unique sibling temporary file, flush its contents, and rename
it over the final entry. Readers therefore observe either the previous complete
entry or the replacement, including when processes read and write the same key
concurrently. Interrupted temporary files are ignored. Successful files and
cache directories use owner-only POSIX permissions; Windows uses profile ACLs.
