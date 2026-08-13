# Composite result completeness

Only operations that combine multiple KRX requests use the composite envelope:
date ranges, stock search, market summary, and watchlist prices. Single-endpoint
CLI and MCP queries retain their existing row-array output.

```json
{
  "success": true,
  "data": [],
  "completeness": {
    "state": "partial",
    "requested": ["KOSPI", "KOSDAQ"],
    "succeeded": ["KOSPI"],
    "failed": [
      {
        "id": "KOSDAQ",
        "error": "KRX request deadline exceeded",
        "errorType": "timeout"
      }
    ],
    "skipped": []
  }
}
```

The four states are:

- `complete`: every required request succeeded and the final query has data.
- `partial`: at least one request succeeded or was safely skipped and at least
  one failed. Returned data is usable only with the failure partition.
- `empty`: every required request completed without failure, but the final
  query has no rows. For date ranges, successful empty dates appear in
  `skipped` rather than `succeeded`.
- `failed`: the operation did not produce an acceptable result. All-request
  failure and caller cancellation use this state; `error` and `errorType`
  retain the primary typed failure.

Eligible exact-code stock ranges are adjusted by default and add an
`adjustment` object with method/version, actual `asOf`, rounding, raw and
derived fields, factor field, detected basis-transition boundaries, and
`cashDividends: "excluded"`. Every row keeps raw OHLC and adds adjusted OHLC
plus an exact reduced `ADJ_FACTOR` such as `1/50`.

The generic statement that partial rows may be usable does not apply while
adjustment is attempted. Partial upstream input, an empty response from a
requestable date, missing security dates, ambiguous suspension boundaries,
malformed prices, or inconsistent identity become an integrity failure with
`data: []` and failed completeness. Callers must explicitly request raw-only
output (`--no-adjusted` or `adjusted: false`) to retain the ordinary
partial-range behavior.

Market-summary index components are `null` when unavailable. Stock-derived
statistics and movers are `null` unless both KOSPI and KOSDAQ stock inputs
succeeded, so missing markets can never be presented as observed zeroes.

Composite CLI operations always emit the JSON envelope so metadata cannot be
lost in table, CSV, or NDJSON rendering. Partial results write a warning to
stderr and exit `7`; empty results exit `3`; complete results exit `0`; failed
results use the existing typed failure exit. Watchlist add does not mutate the
watchlist when its prerequisite stock search is partial or empty.

MCP composite results use the same envelope. If row data exceeds the MCP size
budget, `_truncated` is added beside `data` while `completeness` remains intact.
The `adjustment` metadata also remains intact. The `path` field inside
`_truncated` identifies the truncated row collection. Truncation describes
transport size only and never changes completeness.
