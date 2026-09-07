# KRX provider contract

[openapi.yaml](openapi.yaml) is the sole maintained source for supported KRX
endpoint paths, request and response schemas, and provider-error fields.
Runtime code consumes this contract and its generated projections; it must not
maintain a second wire definition. Public CLI, SDK, and local-state policies
belong to the separate [product contracts](../product/README.md).

[reviewed-evidence.json](reviewed-evidence.json) records reviewed provider
evidence, not an alternative schema authority. The
[contract validator](../../scripts/contracts.mjs) checks OpenAPI against that
record and the frozen compatibility schema oracle, rejects handwritten wire
mirrors, and checks generated output for staleness.

Generated projections are checked in under [contracts/generated](../generated):

- [openapi-registry.ts](../generated/openapi-registry.ts) supplies the
  TypeScript registry used by maintainer tooling.
- [capabilities.json](../generated/capabilities.json) provides the
  language-neutral operation catalog consumed by the Rust SDK.
- The [product generator](../../scripts/product-contracts.mjs) derives SDK
  operation types and strict cache schemas from the same OpenAPI source.

After an intentional OpenAPI change, run these commands from the repository
root and review the generated diff:

```bash
pnpm contract:artifacts
pnpm contract:validate
pnpm verify
```

See [KRX contract testing](../../docs/KRX-CONTRACT-TESTING.md) for dry-run and
bounded live drift checks. Live observations are review evidence and do not
automatically change the maintained contract.
