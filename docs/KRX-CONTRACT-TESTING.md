# KRX contract testing

`contracts/krx/openapi.yaml` is the sole maintained provider-wire authority for
31 operations. `pnpm contract:validate` lints it, checks reviewed evidence and
the frozen schema oracle, compares generated projections, typechecks the public
Node consumer, and rejects handwritten wire mirrors. It also checks that the
production SDK includes the public Rust consumer fixture; `pnpm rust:sdk`
compiles that fixture through the workspace checks and tests.

## Plan

```bash
pnpm contract:dry-run
pnpm contract:dry-run -- --date 20260821 --report artifacts/plan.json
```

Dry-run performs no network or quota operation. It reports 31 native SDK calls,
32 expected public specification reads, and the hard 65-read official cap. An
omitted date selects the prior verified KRX session from the maintained
calendar; explicit impossible, closed, weekend, uncovered, or not-yet-completed
dates fail before any official-specification or SDK request.

## Live evidence

A live run requires a confirmed trading date, a credential approved for every
category, and an assembled native package:

```bash
cargo build --locked --release -p krx-cli -p krx-node
node scripts/native-package/assemble.mjs \
  --target darwin-arm64 \
  --binding target/release/libkrx_node.dylib \
  --executable target/release/krx \
  --out target/native-package/package
KRX_API_KEY=... pnpm contract:check -- \
  --date 20260821 \
  --package target/native-package/package \
  --report artifacts/krx-contract-report.json
```

The checker imports the packaged public Node facade, so all provider requests,
strict decoding, quota, cancellation, and error policy execute in the shared
Rust SDK. JavaScript retains no provider client. The report stores only bounded
status, row counts, field differences, and official metadata—never credentials
or market rows.

Official drift compares service membership, duplicate paths, request/response
fields, and reviewed modification dates. Evidence is review input; the checker
never rewrites the canonical contract.
