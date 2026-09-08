# Response cache lifecycle

The shared Rust SDK caches only strict, nonempty responses for historical
`basDd` requests. Empty results and current or future dates are never cached.
State lives below the platform-specific `krx-cli` state root; cache data never
contains an API credential because KRX market rows are not credential-specific.

The native cache format is v2 and uses a full SHA-256 identity derived from the
operation and canonical sorted parameters. Strict legacy v1 entries remain
readable. A successful online read or refresh lazily promotes an unchanged,
canonical v1 entry to v2 and removes the matching v1 file only after the v2
write is durable. Offline reads never promote state. Invalid entries are
reported and quarantined only when their observed identity and bytes are still
unchanged.

## Freshness and request policy

Historical entries are fresh for seven days by default. Set
`KRX_CACHE_MAX_AGE_HOURS` to an integer from `0` through `8760` to override that
bounded policy. Invalid present values are rejected before credential or
network access.

Use `--refresh` to force a network result and replace the matching entry.
`--no-cache` bypasses cache reads and writes. `--offline` accepts valid stale
entries without resolving credentials, reserving quota, acquiring refresh
leases, or using the network. It conflicts with `--refresh`, `--no-cache`,
`--dry-run`, and `--retries`.

```bash
krx stock list --market kospi --date 20260310 --refresh
krx --offline stock list --market kospi --date 20260310
```

Use `krx cache status`, `prune`, and `clear` for bounded maintenance. The current
`cache inspect` limitation is documented in the
[CLI usage reference](../skills/krx-cli/references/cli-usage.md#cache-and-offline).
Cache maintenance recognizes only contract-defined cache files and refuses
unsafe children rather than traversing them.

## Concurrency and integrity

Within a process, refreshes use singleflight by v2 key. Across processes,
per-key leases serialize promotion and replacement. Writes use owner-restricted
state, atomic publication, and platform durability rules. Unix traversal is
descriptor-relative and no-follow; Windows traversal and mutation are rooted
in validated handles and reject reparse components. Stale lock recovery uses
exact observed claims so a replacement owner cannot be removed accidentally.
