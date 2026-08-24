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
then runs 14 frozen compatibility scenarios plus two exact cache-migration
postconditions against the same archive.

Blacksmith continuous CI covers Linux GNU x64 and ARM64 under Node 22 and 24.
macOS ARM64 and Windows x64 remain supported artifact targets but are omitted
from CI solely to reduce compute cost; their prior four-target certification is
retained as historical evidence. Tag certification likewise runs only the two
Linux targets and uploads private workflow artifacts; it does not publish or
create a GitHub Release.

Credentialed contract drift is separate because it spends quota and requires a
repository secret. Use `pnpm contract:dry-run` before any live run.
