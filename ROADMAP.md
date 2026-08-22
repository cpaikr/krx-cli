# Roadmap

## Current

[Rewrite krx-cli around a Rust SDK, native CLI, and Node SDK](plans/rust-rewrite.md)
— active under [the durable goal contract](goals/rust-rewrite.md). The current
slice repairs and freezes the legacy baseline and certifies the compatibility
judge before candidate implementation begins.

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
