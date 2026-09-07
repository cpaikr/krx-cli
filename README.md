# krx-cli

A native CLI and Node.js SDK for the KRX (Korea Exchange) Open API. Both use a
shared Rust SDK for provider requests, credentials, caching, quota enforcement,
and errors. Query stocks, indices, exchange-traded products, bonds, derivatives,
commodities, and ESG data from the terminal or an ESM application.

## Installation

Use Node.js **22 or 24** and pnpm. Download the archive for your platform and
`SHA256SUMS` from [GitHub Releases](https://github.com/cpaikr/krx-cli/releases),
then verify the checksum using the
[installation guide](docs/RELEASING.md#install-and-upgrade).

| Platform                    | Archive target    |
| --------------------------- | ----------------- |
| macOS ARM64 (Apple silicon) | `darwin-arm64`    |
| Linux x64 (glibc)           | `linux-x64-gnu`   |
| Linux ARM64 (glibc)         | `linux-arm64-gnu` |
| Windows x64                 | `win32-x64-msvc`  |

```bash
pnpm add --global --ignore-scripts "./krx-cli-<version>-<target>.tgz"
krx --version
krx --help
```

Replace `<version>` and `<target>` with the downloaded asset's values. Each
archive includes the native CLI and Node binding; installation requires no Rust
toolchain or lifecycle scripts. Install a release archive rather than the
repository root, which is a maintainer workspace.

The [target manifest](contracts/product/v1/native-targets.json) defines supported
platforms. Release builds cover every target; automated tests and Node 22/24
consumer certification run only on Linux GNU x64 and ARM64.

## Credentials

Obtain an API key and approval for the services you need through the
[KRX Open API portal](https://openapi.krx.co.kr). Supply the key through
`KRX_API_KEY`, or save it in the operating-system credential store. The CLI does
not accept keys as command-line arguments.

If `KRX_API_KEY` is already set, persist it and check access with:

```bash
printf '%s\n' "$KRX_API_KEY" | krx auth set --stdin
krx auth status
krx auth check stock
```

Credential precedence is an explicit SDK key, then `KRX_API_KEY`, then the OS
credential store. A stored key requires a working credential store; an
environment key can be used without persisting it. Use `krx auth migrate` to
explicitly migrate a legacy plaintext credential. `auth check` probes service
access; it does not apply for approval.

## CLI examples

```bash
krx stock list --date 20260821 --market kospi --output json
krx stock list --from 20260801 --to 20260821 --code 005930
krx stock search "삼성전자"
krx market summary --date 20260821
krx cache status
krx schema --all
```

Dates use `YYYYMMDD`. Stock search matches security names; the example searches
for Samsung Electronics by its Korean name. Direct row output defaults to a table in a terminal and JSON when redirected; composite
queries such as `market summary` return JSON with explicit completeness status.
For scripts, handle empty and partial results using the documented
[output and exit-code contract](docs/CLI-CONTRACT.md).

Use `krx --help` and each subcommand's `--help` for the current command and option
inventory. [The CLI usage reference](skills/krx-cli/references/cli-usage.md)
covers date ranges, adjusted prices, filtering, and cache policies.

## Node.js SDK

Install the same platform archive as a project dependency:

```bash
pnpm add --ignore-scripts "./krx-cli-<version>-<target>.tgz"
```

Import the public SDK from the package's ESM root, for example in an `.mjs` file:

```js
import { KrxClient, KrxError } from "krx-cli";

const client = new KrxClient();
try {
  const result = await client.query({
    operation: "stock_stk_bydd_trd",
    date: "20260821",
  });
  console.log(result.data);
} catch (error) {
  if (error instanceof KrxError) {
    console.error(error.kind, error.code);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

The client also exposes date ranges, stock search, market summaries, watchlist
prices, credential management, and cache operations. Results include provenance;
composite results also report completeness. The native binding is an internal
implementation detail with no public import subpath.

See the [Node API contract](contracts/product/v1/node-sdk.d.ts) for methods and
request types, and the [Rust consumer fixture](contracts/product/v1/rust-sdk-consumer.rs)
for the supported Rust interface. [Product contracts](contracts/product/README.md)
explain how these surfaces are maintained and validated.

## Agent skill

Install the complete skill directory, including its references and workflows:

```bash
npx skills add cpaikr/krx-cli
# Or, from a repository checkout:
mkdir -p ~/.agents/skills
cp -R skills/krx-cli ~/.agents/skills/
```

If you previously installed a standalone `krx-cli.md`, rename that file to
`krx-cli.md.legacy` before installing the directory to avoid duplicate skill
instructions. Release archives include the same `skills/krx-cli` directory.

## Development

Use the pnpm version pinned in [package.json](package.json), the Rust toolchain
in [rust-toolchain.toml](rust-toolchain.toml), and cargo-deny for the full gate.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
```

Run `pnpm contract:dry-run` for the bounded contract-drift plan without live KRX
requests. Credentialed drift checks are separate from the repository gate.

- [Architecture](ARCHITECTURE.md): component boundaries and invariants.
- [Testing](docs/TESTING.md): repository checks and archive certification.
- [Provider contracts](contracts/krx/README.md): KRX wire authority and regeneration.
- [Compatibility judge](tests/compat/README.md): installed CLI regression checks.
- [Releasing](docs/RELEASING.md): version preparation, publication, and recovery.
- [Roadmap](ROADMAP.md): delivery status and ongoing operational obligations.
