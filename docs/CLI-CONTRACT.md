# CLI contract

The executable authority is the Clap tree in `crates/krx-cli/src/args.rs`.
`crates/krx-cli/src/output.rs` owns process rendering, while public values and
errors come from `krx-sdk`. The generated inventory and classified differences
under `contracts/product/v1` freeze compatibility.

## Process behavior

- `krx --version` prints the bare package version and exits 0.
- Clap help exits 0. Syntax, validation, and inactive global options fail before
  credentials, local mutation, quota, or network access and exit 2.
- Direct endpoint success exits 0; a valid empty result exits 3; partial
  composite success exits 7.
- Authentication exits 4, quota exhaustion exits 5, and approval failure exits 6. Other typed SDK failures exit 1.
- Errors use `krx: error[<kind>/<code>]: <sanitized message>` on stderr.
- Direct rows default to a table on a terminal and JSON when redirected.
  Composite operations always return their explicit JSON completeness envelope.
- `--verbose` emits sanitized cache, range, request, quota, retry, and response
  observations. It never includes credentials, provider bodies, or local paths.

## Global option scope

Clap makes global options syntactically available, but policy validation keeps
them effective only for their documented request family. Offline conflicts
with refresh, bypass, dry-run, and explicit retries. A date range requires both
`--from` and `--to`; adjusted stock ranges require one exact security code.

Use `krx --help`, `krx <group> --help`, and `krx schema --all` for the exhaustive
current inventory. The frozen recursive inventory is
`tests/compat/command-inventory.json`.

## Environment

| Name                      | Meaning                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `KRX_API_KEY`             | Runtime credential after an explicit SDK key and before the OS keychain.  |
| `KRX_CACHE_MAX_AGE_HOURS` | Preferred-cache maximum age, integer 0–8760.                              |
| `HOME`                    | Unix home directory used for the fixed `${HOME}/.krx-cli` state root.     |
| `USERPROFILE`             | Windows home directory used for the fixed `${USERPROFILE}/.krx-cli` root. |
| `NO_COLOR`                | Disables terminal color where supported.                                  |

The local state root is fixed at `.krx-cli` below the platform home directory;
`XDG_CONFIG_HOME` and `LOCALAPPDATA` do not relocate it. No environment
variable enables another server or protocol surface.

## Migration differences

The native product intentionally replaces plaintext credential persistence,
strictly validates versioned local state, includes KONEX in watchlist pricing,
and accepts only canonical complete legacy cache rows. Every approved difference
is named in `contracts/product/v1/cli-overlay.json` and has positive and
rejection cases in `cli-cases.json`. Unclassified differences block cutover.
