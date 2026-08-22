# Installed-package compatibility judge

The judge installs a tarball into an isolated prefix and invokes only its
installed `krx` executable. Every scenario gets a fresh home, working
directory, dummy credential, saturated quota state, and reviewed legacy v1
cache fixtures. A cache-key mistake therefore fails locally instead of reaching
KRX.

The scenario set freezes package launch, the recursive command and option
inventory, the complete 31-endpoint schema document, argument and credential
failures, dry-run redaction, cached row output and pipeline behavior, an
adjusted-price provider oracle, missing-result exit semantics, composite
completeness, stdout/stderr separation, and cache inspection. The missing-result
case uses local watchlist state so the candidate remains free to reject legacy
persisted empty cache entries. Transport-only 401/403/retry behavior remains in
conformer tests because the legacy and native executables have no safe shared
transport-injection surface.

`pnpm test:compat` first requires the legacy package to pass every scenario.
It then installs independent copies, changes the bundled no-data exit code from
`3` to `2`, changes one endpoint description, and changes the adjusted-price
rounding policy. The unchanged judge must fail only `empty-result-exit`,
`schema-inventory`, and `adjusted-stock-range`, respectively. These deliberate
behavioral mutations certify that the judge detects process semantics, complete
schema drift, and the complete adjusted-result envelope rather than package
presence alone.
