# Product contracts

These versioned contracts freeze the public and persisted-state boundary for
the Rust rewrite before production crates exist. They supplement, but never
duplicate, the provider wire authority in `contracts/krx/openapi.yaml`.

## Maintained authority

- `v1/profile.yaml` names only cross-operation sets, composites, defaults, and
  provenance rules. Every direct operation and row shape is derived from
  OpenAPI.
- `v1/errors.yaml` is the sole project error kind, code, retryability, and CLI
  exit catalog. Exit 3 and exit 7 remain result policies rather than errors.
- `v1/cli-overlay.json` is a delta over the frozen installed legacy inventory
  and scenarios. `v1/cli-cases.json` freezes every intentional difference.
- `v1/node-sdk.d.ts`, `v1/node-package-surface.json`, and the compile-only Rust
  consumer fixture freeze the supported SDK interfaces without exposing an
  adapter or transport dependency.
- `v1/native-targets.json` is the only supported-target and archive-path
  manifest. It fixes the four private, prebuilt npm-compatible artifacts and
  explicitly forbids installation builds and registry access.
- `v1/migrations.yaml` and `v1/state/*.schema.json` freeze the one-root,
  one-writer credential, approval, cache, quota, and watchlist lifecycle.
  JSON keychain state exists only as a test fixture; production secrets live
  only in the OS credential store.

The Rust SDK is one deep module. Direct calls select a generated `OperationId`
and return validated rows plus provenance. Composites return an explicit
completeness envelope even when every component fails; cancellation, invalid
input, and local-state failures remain ordinary SDK errors. Clap, Node-API,
HTTP, async-runtime, and keychain dependency types never cross that interface.

## Checked projections

`scripts/product-contracts.mjs` derives the following artifacts and rejects
staleness:

- `contracts/generated/product-v1.json`
- `contracts/generated/node-operations.d.ts`
- `contracts/generated/error-types.d.ts`
- `contracts/generated/operation-id.rs`
- `contracts/generated/candidate-command-inventory.json`
- `contracts/generated/cli-option-matrix.json`
- `contracts/generated/state/cache-v1.schema.json`
- `contracts/generated/state/cache-v2.schema.json`

The cache schemas expand all 31 OpenAPI operations into strict conditional row
validators. The profile never contains a second full operation inventory.

Run `pnpm contract:validate` to lint OpenAPI, validate both contract families,
compile all state schemas, exercise classified migration fixtures, and
typecheck the public Node consumer. Run `pnpm contract:artifacts` only after an
intentional maintained-contract change.
