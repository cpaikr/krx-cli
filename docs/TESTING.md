# Testing

The deterministic repository gate is:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
```

It runs the atomic-cutover absence/mutation gate, OpenAPI and product contracts,
the deterministic exchange-calendar-aware contract-drift dry run, lint and
public Node type checks, maintainer tests, Node facade tests, the full Rust
workspace check/Clippy/test suite, Rust advisory/license/source enforcement,
calendar freshness, and the production dependency audit.

Native archive certification builds `krx-cli` and `krx-node` once, assembles a
manifest target, packs it, and installs that exact archive with scripts
disabled. `scripts/native-package/certify.mjs` checks package layout, target
identity, executable behavior, public JavaScript/TypeScript consumers,
cancellation, binding privacy, and the packaged skill. The compatibility gate
then runs the frozen compatibility scenarios and exact cache-migration
postconditions against the same archive.

Blacksmith continuous CI covers Linux GNU x64 and ARM64 under Node 22 and 24.
The release workflow builds macOS ARM64, Linux GNU x64/ARM64, and Windows x64,
then certifies each unchanged archive under Node 22 and 24 and runs installed-product
compatibility. Complete reports bind source revision and archive SHA-256 before
publication. Manual release-workflow dispatch runs the same certification without
publishing; version-tag pushes publish only after the required jobs pass.
[Releasing](RELEASING.md) owns publication and recovery procedures.

`tests/scripts/release.test.ts` exercises the actual release-it version-bump
lifecycle in temporary Git/Cargo workspaces, rejects incomplete or mismatched
artifact evidence, and tests publication and recovery through a local GitHub CLI
fixture. These tests do not create real tags or releases on GitHub.

Credentialed contract drift is separate because it spends quota and requires a
repository secret. Use `pnpm contract:dry-run` before any live run.
