# KRX trading calendar

`krx-cli` uses the Korea Exchange's official
[Market Closing (Holiday)](https://global.krx.co.kr/contents/GLB/05/0501/0501110000/GLB0501110000.jsp)
calendar. The checked-in snapshot covers 2016 through 2026 and records weekday
closures only; Saturdays and Sundays are classified directly in Korea Standard
Time (UTC+9).

The calendar applies to default dates and date ranges across CLI, MCP, approval,
search, market-summary, watchlist, and contract-check paths. Recent-date defaults
start at T-1 in KST and walk backward to a verified session. This covers public
holidays, Labor Day, Lunar New Year, Chuseok, election or temporary closures,
and the KRX year-end holiday without spending market-data quota on those dates.

## Coverage and fallback

Calendar classifications are one of `trading`, `non_trading`, or `unknown`.
Weekends are always known. A weekday in a covered year is a trading session
unless it appears in the official closing list.

For an explicit range outside snapshot coverage, weekday dates remain eligible
for a market-data probe so historical access is preserved. The returned range
envelope sets `calendar.coverage` to `fallback` and lists every such date in
`calendar.unverifiedDates`. Weekends are always skipped. For future years only,
fixed statutory holidays and the regular KRX year-end closure are also skipped;
these fallback classifications remain marked unverified. Upstream failures stay
in `completeness.failed`.

Default-date selection is stricter. It never guesses across uncovered weekdays:
it returns the most recent verified session, marks the resolution as a stale
fallback, and emits `KRX_CALENDAR_FALLBACK` on stderr. If no verified session is
available within 370 days, it fails with the official source and update action.

## Check and update

The weekly contract workflow checks the current KST year against the public KRX
calendar before spending credentialed quota. Ordinary CI and `pnpm verify` stay
network-free and deterministic.

```bash
pnpm calendar:check
pnpm calendar:check -- 2025 2026
pnpm calendar:update -- 2027
pnpm verify
```

`calendar:check` performs two public requests per year (one short-lived OTP and
one calendar read) and never uses `KRX_API_KEY`. `calendar:update` atomically
rewrites `src/calendar/krx-closures.json`; review added, removed, and renamed
closures against the linked KRX page before committing the result. Update the
snapshot when the weekly check reports drift, when KRX announces an ad-hoc
closure, and before the first default-date use of a new calendar year.
