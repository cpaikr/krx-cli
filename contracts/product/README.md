# Product contracts

These versioned contracts define the public CLI, Rust SDK, Node SDK, package,
and persisted-state boundaries used by the production Rust workspace. They
supplement the [KRX provider contract](../krx/README.md); direct operations and
provider row schemas are derived from OpenAPI rather than maintained here.

## Maintained authority

- [profile.yaml](v1/profile.yaml) defines operation sets, composites, defaults,
  and provenance rules, with direct operations selected from OpenAPI.
- [errors.yaml](v1/errors.yaml) owns project error kinds, codes, retryability,
  and CLI exit mappings. Exit 3 and exit 7 are result policies rather than errors.
- [cli-overlay.json](v1/cli-overlay.json) defines changes to the frozen legacy
  command inventory and scenarios; [cli-cases.json](v1/cli-cases.json) records
  the corresponding candidate cases. See the
  [CLI contract](../../docs/CLI-CONTRACT.md) for the user-facing rules.
- [node-sdk.d.ts](v1/node-sdk.d.ts),
  [node-package-surface.json](v1/node-package-surface.json), and the compile-only
  [Rust consumer](v1/rust-sdk-consumer.rs) define the supported SDK interfaces
  without exposing transport or adapter dependency types.
- [native-targets.json](v1/native-targets.json) owns supported targets, archive
  paths, Node versions, and the continuous-certification subset. Distribution
  uses prebuilt npm-format archives without installation builds or registry
  access. The manifest's `private-github-release-asset` label is a checked-in
  policy value; it does not enforce GitHub repository or asset visibility.
  Supported targets and consumer-certified targets are
  distinct; see [Releasing](../../docs/RELEASING.md) for delivery policy and status.
- [migrations.yaml](v1/migrations.yaml) and [state schemas](v1/state) define
  credential, approval, cache, quota, and watchlist storage and transitions
  under one state root. JSON keychain state is a test fixture. Persisted
  credentials use the OS credential store; explicit SDK credentials and
  `KRX_API_KEY` are also supported inputs.

The [Rust SDK](../../crates/krx-sdk/src/lib.rs) exposes a flat, project-owned
interface. Direct requests select a generated `OperationId` and return validated
rows with provenance. See [Composite results](../../docs/COMPOSITE-RESULTS.md)
for range and composite completeness, partial failure, and CLI output policy.

## Checked projections

[scripts/product-contracts.mjs](../../scripts/product-contracts.mjs) derives
the following artifacts under [contracts/generated](../generated) and rejects
stale output:

- `product-v1.json`
- `node-operations.d.ts` and `error-types.d.ts`
- `operation-id.rs`
- `candidate-command-inventory.json` and `cli-option-matrix.json`
- `state/cache-v1.schema.json` and `state/cache-v2.schema.json`

The cache schemas expand every OpenAPI operation into strict conditional row
validators. Edit the maintained contracts, then regenerate these projections;
do not edit generated files directly.

From the repository root:

```bash
pnpm contract:artifacts # Regenerate after an intentional contract change.
pnpm contract:validate  # Check contracts, projections, schemas, and Node types.
pnpm verify            # Run the full repository gate, including Rust checks.
```

`contract:validate` also exercises classified migration fixtures and checks
native package and workflow invariants. It verifies that the production SDK
includes the Rust consumer fixture; `verify` compiles that fixture through the
Rust workspace checks and tests. See [Testing](../../docs/TESTING.md) for the
validation boundaries.
