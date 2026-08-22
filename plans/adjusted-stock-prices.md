# Deliver trustworthy adjusted historical stock prices

Status: complete
Delivered by [PR #6](https://github.com/sjunepark/krx-cli/pull/6) to
`codex/adjusted-stock-prices-integration`.

## Outcome

Eligible single-security KOSPI, KOSDAQ, and KONEX date-range queries calculate
and return corporate-action-adjusted OHLC prices by default. Raw KRX values
remain available and clearly distinguished, while any incomplete or
unverifiable adjustment fails without returning price rows. The result is
suitable for price-history analysis without claiming cash-dividend total
returns.

## Delivered baseline

- Stock daily endpoints return raw KRX OHLCV rows and eligible exact-security
  ranges add fail-closed adjusted values. Date ranges fetch and merge one
  full-market response per requestable trading day before filtering by
  security code.
- KRX supplies `TDD_CLSPRC` and `CMPPREVDD_PRC`. For a later observation `i`,
  `TDD_CLSPRC[i] - CMPPREVDD_PRC[i]` is its reference price. A mismatch between
  that reference price and the preceding observed raw close identifies a KRX
  price-basis transition.
- The supplied reference derives earlier adjusted prices from those
  transitions, but also reports ambiguous cases involving multiple events
  during trading suspensions. The heuristic alone is therefore not sufficient
  evidence for publishing adjusted values.
- KRX documents adjusted reference prices for rights and bonus issues, stock
  dividends, splits and consolidations, and other changes to security value.
  The current API does not provide the cash-dividend data required for an
  accurate total-return series.
- The range-result completeness envelope distinguishes complete, partial,
  empty, and failed input. The delivered adjustment implementation requires
  complete, uniquely identified, internally consistent input.

## Public contract

- Adjustment is eligible only for stock daily endpoints when both ends of a
  date range and one exact `--code`/`isuCd` are present. Calculation is anchored
  to the last returned observation, exposed as the adjustment `asOf` date.
- Eligible queries adjust by default. CLI users may request the legacy raw-only
  result with `--no-adjusted`; MCP users may pass `adjusted: false`.
- Full-market, multi-security, base-information, and direct single-day queries
  retain their existing raw contract and never describe it as adjusted. Do not
  add batch or multi-security adjustment; callers can loop over exact codes and
  reuse the existing raw-response cache.
- Preserve the original `TDD_OPNPRC`, `TDD_HGPRC`, `TDD_LWPRC`, and
  `TDD_CLSPRC` strings. Add unambiguous adjusted fields (`ADJ_TDD_OPNPRC`,
  `ADJ_TDD_HGPRC`, `ADJ_TDD_LWPRC`, and `ADJ_TDD_CLSPRC`) plus an exact factor
  representation for each row.
- Add envelope-level adjustment metadata containing the method/version, actual
  `asOf` date, excluded cash dividends, raw source fields, and every detected
  basis-transition boundary. Do not label a transition as a specific corporate
  action unless the available evidence identifies it.
- Treat adjusted fields as derived output schema, not as fields supplied by a
  KRX endpoint. Schema discovery must make that provenance distinction explicit.
- If default adjustment is attempted and its inputs are partial, malformed,
  ambiguous, internally inconsistent, or fail validation, return a structured
  failed result with no price rows. Never copy raw prices into adjusted fields,
  silently omit adjusted fields, or downgrade to a raw-only success.
- Output remains string-based. Cash dividends and dividend reinvestment are
  explicitly out of scope, so the series is not a total-return series.

## Calculation and integrity model

For observations sorted by increasing `BAS_DD`, let raw close be `C[i]`, KRX
change be `D[i]`, and implied reference price be `R[i] = C[i] - D[i]`. At each
boundary after the first observation, the backward adjustment ratio is
`R[i] / C[i-1]`. The factor for row `j` is the product of all later boundary
ratios through the `asOf` row; the last row therefore has factor one. Apply the
same row factor to raw open, high, low, and close.

- Parse KRX integers and separators strictly and perform ratio reduction and
  accumulation with `BigInt` numerator/denominator arithmetic. Do not use
  binary floating point.
- Calculate adjustment before user filtering, sorting, field selection,
  offset, limit, or MCP transport truncation. Cache only raw KRX responses;
  derived values depend on the query's `asOf` boundary and must not pollute the
  endpoint cache.
- Require one resolved security identity, unique and strictly ordered dates,
  all required price/change fields, positive close/reference values, and valid
  raw and adjusted OHLC ordering. Preserve every raw OHLC field string exactly.
- Require complete upstream range input. Carry its requested, succeeded,
  failed, skipped, and calendar evidence into adjustment failure diagnostics.
- Cross-check `FLUC_RT`, listed shares, and market capitalization when those
  fields can independently validate a boundary. Treat them as validation
  evidence, not as substitutes for missing required inputs.
- Determine decimal serialization and rounding only from official KRX
  adjusted-price examples. Keep exact rational factors in metadata. If an
  official oracle cannot establish one deterministic price rule, stop and
  revise the contract rather than selecting a plausible rounding convention.
- Explicitly test gaps and trading suspensions. A boundary that cannot be
  reconciled with the oracle and invariants is an integrity error, even when a
  ratio can be computed mechanically.

## Implementation slices

1. **Freeze oracle fixtures and output semantics.** Capture provenance-stamped
   official KRX adjusted/raw examples for an unchanged series, split,
   consolidation, bonus issue, stock dividend, rights event, and an event
   spanning a suspension. Include Samsung Electronics' 2018 50:1 split and the
   documented Celltrion consolidation edge case. Use them to settle exact
   field names, rounding, transition metadata, and ambiguity rules before
   production code.
2. **Build a pure adjustment engine.** Introduce typed raw parsing, reduced
   rational arithmetic, transition detection, backward factor accumulation,
   adjusted OHLC serialization, and explicit integrity failures. Unit-test it
   independently from HTTP, cache, CLI, and MCP code.
3. **Integrate the default safely.** Route eligible stock ranges through the
   engine after exact code selection and before the output pipeline. Add the
   CLI raw opt-out and MCP boolean, preserve legacy behavior outside eligible
   queries, and map integrity failures to structured composite/MCP errors and
   nonzero CLI status without data.
4. **Align every public contract.** Update response-field/schema discovery,
   executable help, README, CLI and composite contracts, the packaged KRX
   skill, examples, and package-smoke expectations. State prominently that
   adjusted is the eligible-query default and excludes cash dividends.
5. **Review and release-gate.** Run the repository verification gate and the
   applicable live/oracle checks, then run the required code review. Resolve
   all correctness findings before treating the feature as deliverable.

## Acceptance validation

- Pure tests cover no transition, one split, one consolidation, multiple
  transitions, negative daily change, comma-formatted values, exact fractional
  factors, input reordering, duplicate dates, zero/missing/malformed fields,
  OHLC violations, and overflow-resistant long histories.
- Oracle regression fixtures match official adjusted OHLC exactly for every
  supported event class. Known ambiguous suspension cases produce a deliberate
  integrity failure unless independently reconciled.
- CLI and MCP integration tests prove eligible ranges adjust by default,
  explicit raw opt-out works, full-market and single-day compatibility remains,
  and computation precedes sorting/filtering/pagination/field selection.
- Partial or failed upstream ranges, ambiguous identity, and adjustment
  invariant failures return no rows and cannot be mistaken for raw success.
- Metadata reports the exact `asOf`, method version, factors, transitions, and
  cash-dividend exclusion; raw OHLC remains unchanged beside adjusted OHLC.
- Schema/help/documentation contract tests and installed-package smoke cover
  both entrypoints. `pnpm verify` passes, followed by the repository's required
  code-review workflow.

## Next action

_None within this plan. Promotion, release, and publication remain outside its
authority._
