# Canonical KRX provider contract

`openapi.yaml` is the sole maintained provider-wire authority for every
supported KRX operation. Runtime code must not redefine endpoint paths, shared
request/response fields, or provider-error fields.

`reviewed-evidence.json` is a non-authoritative review record. Generated
projections are checked in under `contracts/generated`: the TypeScript registry
supports maintainer gates, while the language-neutral capabilities and product
projection feed Rust and package validation.

After editing OpenAPI, run:

```bash
pnpm contract:artifacts
pnpm contract:validate
pnpm verify
```

See `docs/KRX-CONTRACT-TESTING.md` for bounded official/live drift evidence.
