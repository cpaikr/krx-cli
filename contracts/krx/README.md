# Canonical KRX provider contract

`openapi.yaml` is the sole maintained provider-wire authority for every
supported KRX operation. Runtime code consumes checked projections generated
from it; it must not maintain endpoint paths, shared request or response field
names, or provider-error field names independently.

`reviewed-evidence.json` records the shared wire facts used when the authority
was reviewed. It is deliberately marked non-authoritative. Change it only when
new provider evidence demonstrates that one of those shared facts changed, and
review that change together with the corresponding OpenAPI change.

Generated projections are checked into the repository:

- `src/contracts/generated/openapi-registry.ts` supplies the legacy runtime;
- `contracts/generated/capabilities.json` is language-neutral input for the
  Rust and Node implementations.

After editing the OpenAPI authority, run:

```bash
pnpm contract:artifacts
pnpm contract:validate
pnpm verify
```

The validation gate enforces the 31-operation inventory, reviewed shared wire
facts, exact legacy schema projection, generated-artifact freshness, provider
error and default-response semantics, and the prohibition on handwritten wire
mirrors in TypeScript, JavaScript, and Rust sources.

See `docs/KRX-CONTRACT-TESTING.md` for official-drift review and credentialed
live-check procedures.
