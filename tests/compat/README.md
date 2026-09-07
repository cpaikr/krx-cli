# Installed-package compatibility judge

The compatibility judge checks the installed CLI against frozen legacy behavior
and explicitly approved native differences. It installs a target archive into
an isolated prefix and invokes its installed `krx` executable, without importing
production CLI internals.

## Run certification

From the repository root, with Node.js 22 or 24, npm, and pnpm available:

```bash
pnpm test:compat --candidate-tarball "/path/to/krx-cli-<version>-<target>.tgz"
```

Use an archive matching the host platform. The runner installs it with lifecycle
scripts disabled, runs the candidate scenarios and cache-migration checks, then
runs assertion self-tests. Any failed check makes certification fail. Installation
and scenario directories are temporary and removed after the run.

Each scenario has a fresh home and working directory. Query scenarios use a
dummy credential, saturated quota state, and reviewed cache fixtures so an
unexpected cache miss fails locally before reaching KRX. Credential-failure
scenarios omit the environment key; the OS credential store remains a host
facility, so use a clean test environment. An unavailable headless credential
store is accepted only through the classified
`headless-credential-store-fails-closed` case.

## Evidence and coverage

- [scenarios.json](scenarios.json) defines launch, argument and credential errors,
  dry-run redaction, cached rows and pipelines, adjusted stock ranges, missing
  results, composite completeness, stdout/stderr separation, and cache status.
- [command-inventory.json](command-inventory.json) freezes the recursive legacy
  command and option inventory.
- [oracles](oracles) holds the complete legacy schema and adjusted-range output.
- [fixtures/cache-rows.json](fixtures/cache-rows.json) holds reviewed cache values.
- [The CLI overlay](../../contracts/product/v1/cli-overlay.json) classifies
  intentional native differences;
  [CLI cases](../../contracts/product/v1/cli-cases.json) defines their positive and
  rejection cases. The installed judge directly executes the cache-migration
  cases in addition to the frozen scenarios.

The missing-result scenario uses an empty local watchlist so the native CLI can
reject persisted empty cache entries. Transport-only 401/403/retry behavior is
covered by [Rust conformer tests](../../crates/krx-sdk/src/conformer.rs); legacy
and native executables have no shared transport-injection surface for this judge.
See [Testing](../../docs/TESTING.md) for the wider certification boundary.

## Native projections and migration

The native profile projects compact legacy fixture rows into the full canonical
OpenAPI row shape before writing v1 cache entries. Expected output is compared
exactly, including the absence of additional fields. This implements the
`strict-canonical-cache-row-migration` classification: partial test fixtures are
not supported production cache state, and unknown provider fields must fail strict
decoding. The pipeline projection drops the fixture-only `ISU_SRT_CD` alias and
retains canonical `ISU_CD`.

The candidate schema expectation removes only the legacy MCP opt-out metadata,
as recorded by `mcp-schema-metadata-removed`. Remaining adjustment metadata is
compared exactly. These projections leave the frozen legacy oracles unchanged.

Installed cache-migration checks require a canonical v1 hit to create a v2 entry
with the expected operation, parameters, canonical rows, and a SHA-256-shaped
schema digest, then remove the matching v1 file. A row with an unknown provider
field must fail offline with `cache_invalid`, emit no rows, and create no v2
entry. The judge checks the digest's format, not its equality to the current
provider contract hash.

## Assertion self-tests

[compat-certify.mjs](../../scripts/compat-certify.mjs) first requires the real
installed archive to pass. It then changes captured process observations for the
no-data exit, schema description, and adjustment metadata. Each mutation must
fail only its named scenario. These checks prove that the assertions detect those
changes; they do not modify the native executable.

The [completed rewrite plan](../../plans/rust-rewrite.md) records the recoverable
legacy baseline and its earlier mutation evidence. Keep that historical evidence
distinct from the current native assertion self-tests.
