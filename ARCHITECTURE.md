# Architecture

krx-cli has one implementation of KRX behavior: the shared Rust SDK. The native
Clap executable and the public Node.js SDK are adapters over that crate. The
repository root is a private maintainer workspace, not an installable product.

## Component map

```text
contracts/krx/openapi.yaml
          |
          v
     crates/krx-sdk  <--- secure local state and the only KRX HTTP transport
        /       \
       v         v
crates/krx-cli  crates/krx-node ---> packages/node
   native CLI      private binding     public JS facade
        \_______________________________/
                        |
                        v
              private target tarball
```

- Start with `crates/krx-sdk/src/client.rs` to trace a query. It composes strict
  request/response handling, credentials, quota, cache, retry, calendar, and
  cancellation around the private transport in `transport.rs`.
- `crates/krx-cli` owns argument syntax and rendering only. Clap validation
  completes before SDK effects begin.
- `crates/krx-node` is the narrow Node-API boundary. `packages/node/dist` is the
  public ESM facade and keeps the target binding private.
- `scripts/native-package` assembles one target executable and one target
  binding with the portable facade, declarations, and packaged skill.
- `contracts/product/v1` freezes public surfaces, errors, state migrations, and
  artifact policy. Generated projections live in `contracts/generated`.

## Query flow

A frontend creates a shared `krx_sdk::Client` and submits a typed request. The
SDK validates the operation and date, resolves cache policy, and returns an
offline hit before touching credentials or quota. An online miss resolves the
credential, joins or owns the per-key flight and lease, reserves one KST-day
quota unit immediately before each actual HTTP attempt, and strictly decodes a
bounded response. Eligible historical results are published atomically to the
versioned cache. Frontends receive project-owned result and error types; they
never interpret provider wire data themselves.

## State and distribution

Credentials live in the operating-system keychain. Approval, cache, quota, and
watchlist files use the versioned contracts under `contracts/product/v1` and
the capability-rooted state implementation in `crates/krx-sdk/src/state.rs`
and `state_windows.rs`. Legacy plaintext credentials require the explicit
`krx auth migrate` operation; invalid state fails closed.

Release assets are private npm-format tarballs. Each contains no dependencies
or lifecycle scripts, a native `krx` executable, one private Node binding, the
public facade and declarations, and `skills/krx-cli`. macOS ARM64, Linux GNU
x64/ARM64, and Windows x64 remain supported manifest targets. Continuous
Blacksmith certification covers only Linux GNU x64/ARM64 under Node 22 and 24
to control compute cost.

## Invariants

- `contracts/krx/openapi.yaml` is the sole maintained provider-wire authority.
- `crates/krx-sdk/src/transport.rs` is the sole KRX HTTP conformer.
- The CLI and Node binding depend directly on `krx-sdk`; neither duplicates
  credential, quota, cache, retry, calendar, or migration policy.
- The JavaScript facade never exports a native-binding subpath and never parses
  CLI arguments or makes provider requests.
- Installation never builds source or runs package lifecycle scripts.
- Artifact assembly accepts exactly one manifest target and rejects traversal,
  links, mismatched binaries, and unsupported runtimes.
- Frozen legacy compatibility data remains test evidence, never executable
  production code.

## Maintainer entry points

- `pnpm verify`: complete deterministic repository gate.
- `pnpm contract:dry-run`: bounded live-contract plan without network access.
- `.github/workflows/rust-vertical-slice.yml`: Linux native archive
  certification.
- `docs/TESTING.md`: validation and release-operator commands.
- `docs/CLI-CONTRACT.md`: stable process behavior and environment contract.
