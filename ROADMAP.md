# Roadmap

## Current

[Rewrite krx-cli around a Rust SDK, native CLI, and Node SDK](plans/rust-rewrite.md)
— active under [the durable goal contract](goals/rust-rewrite.md). The green
legacy baseline, canonical OpenAPI/contracts, and production shared Rust SDK
are merged. The native Clap CLI, public Node SDK, and production artifact slice
are also merged after exact-head Blacksmith certification and feedback closure.
Secure migration promotion, installed-product parity, legacy removal, and the
atomic package/export cutover remain in the final slice.

## Plans

_None._

## Tasks

_None._

## Baseline

The completed production-readiness baseline and its validation evidence remain
recorded in
[production-readiness-hardening.md](goals/production-readiness-hardening.md).
Continue its operational obligations: run the credentialed weekly contract
drift check, update the checked-in KRX calendar before uncovered years or
exceptional closures, and keep dependencies and GitHub Actions current without
weakening the production audit or packed-artifact release gate.

These obligations remain in force during and after the queued rewrite. The
rewrite may replace their implementation only after its cutover and acceptance
gates pass; it does not remove the operational duties.
