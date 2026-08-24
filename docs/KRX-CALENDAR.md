# KRX calendar

`src/calendar/krx-closures.json` is the checked-in official closure snapshot
used by `krx-sdk`. Covered weekdays not listed are verified sessions. Weekends
and listed closures are skipped without spending quota. Uncovered historical
weekdays remain observable probes; future fallback is conservative and emits a
diagnostic rather than silently claiming official coverage.

The Rust SDK owns runtime date selection and range partitioning. The maintainer
script owns only snapshot freshness:

```bash
pnpm calendar:check
pnpm calendar:update
```

Review every added, removed, or renamed closure before committing an update.
The scheduled contract workflow checks calendar freshness before credentialed
calls.
