# Roadmap

## Current

_None._

## Plans

1. [Rewrite krx-cli around a Rust SDK, native CLI, and Node SDK](plans/rust-rewrite.md)
   — queued. Preserve the documented CLI contract while moving KRX protocol,
   reliability, credentials, caching, and domain policy into a shared Rust SDK;
   rebuild `krx` as a native Clap CLI, add a public Node SDK, remove MCP, and
   prepare private native release artifacts.

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
