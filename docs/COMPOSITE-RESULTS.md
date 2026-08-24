# Composite results

Date ranges, stock search, market summary, and watchlist prices return a JSON
envelope with `success`, `data`, `completeness`, `provenance`, and an optional
typed `error`. `completeness.state` is `complete`, `partial`, `empty`, or
`failed`; requested, succeeded, failed, and skipped partitions explain every
component.

Partial data is never presented as complete. The CLI exits 7 for a usable
partial result, 3 for a genuine empty result, and the mapped typed-error exit
for a failed result. Market statistics are absent unless both required stock
components succeeded. Range results additionally expose fetched/failed day
counts, calendar provenance, and adjustment metadata when applicable.

The Rust definitions in `crates/krx-sdk/src/result.rs` are authoritative. The
public Node declaration is frozen in `contracts/product/v1/node-sdk.d.ts`.
