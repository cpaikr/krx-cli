# Roadmap

## Current

_None._

## Plans

_None._

## Tasks

_None._

## Completed

[Complete native release delivery](plans/release-delivery.md) — published
[v1.8.2](https://github.com/cpaikr/krx-cli/releases/tag/v1.8.2) with all four native
archives, checksums, and Linux-only automated tests and consumer certification.

[Rewrite krx-cli around a Rust SDK, native CLI, and Node SDK](plans/rust-rewrite.md)
— completed under [the durable goal contract](goals/rust-rewrite.md). The
shared Rust SDK, native Clap CLI, public Node SDK, secure local-state behavior,
certified native artifacts, and atomic legacy/MCP cutover are merged on
`main`. Continuous Blacksmith certification covers Linux GNU x64/ARM64 under
Node 22/24; macOS ARM64 and Windows x64 remain supported artifact targets but
are intentionally omitted from continuous CI solely to reduce compute cost.
The first GitHub Release is published. See [Releasing](docs/RELEASING.md) for
distribution and visibility.

## Baseline

The completed production-readiness baseline and its validation evidence remain
recorded in
[production-readiness-hardening.md](goals/production-readiness-hardening.md).
Continue its operational obligations: run the credentialed weekly contract
drift check, update the checked-in KRX calendar before uncovered years or
exceptional closures, and keep dependencies and GitHub Actions current without
weakening the production audit or packed-artifact release gate.

These obligations remain in force after the completed rewrite. The rewrite
replaced their implementation only after its cutover and acceptance gates
passed; it does not remove the operational duties.
