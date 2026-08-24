# Installed-package compatibility judge

The judge installs a tarball into an isolated prefix and invokes only its
installed `krx` executable. Every scenario gets a fresh home, working
directory, dummy credential, saturated quota state, and reviewed cache
fixtures. A cache-key mistake therefore fails locally instead of reaching KRX.

The frozen legacy run used the original compact v1 fixture rows. The native
profile projects those same reviewed values into the exact canonical OpenAPI
row shape before writing v1 cache entries, then requires exact output with no
additional fields. This is the classified
`strict-canonical-cache-row-migration` security fix: production legacy cache
rows came from complete provider responses, while partial test-only rows are
not a supported persisted state and unknown fields must not survive the strict
Rust decoder. The one pipeline scenario therefore drops the fixture-only
`ISU_SRT_CD` alias in favor of canonical `ISU_CD`.

The scenario set freezes package launch, the recursive command and option
inventory, the complete 31-endpoint schema document, argument and credential
failures, dry-run redaction, cached row output and pipeline behavior, an
adjusted-price provider oracle, missing-result exit semantics, composite
completeness, stdout/stderr separation, and cache inspection. The missing-result
case uses local watchlist state so the candidate remains free to reject legacy
persisted empty cache entries. Transport-only 401/403/retry behavior remains in
conformer tests because the legacy and native executables have no safe shared
transport-injection surface.

The merged legacy baseline remains the authoritative black-box mutation proof:
independent installed copies changed the bundled no-data exit, schema
description, and adjustment rounding behavior, and the unchanged judge rejected
only their named scenarios. Final native certification first requires the real
installed artifact to pass every candidate scenario. It then injects the same
three changes into captured process observations as oracle self-tests; these
prove the candidate assertions still reject changed exit, schema, and complete
adjustment results, without claiming that the immutable native executable was
rewritten in place.
