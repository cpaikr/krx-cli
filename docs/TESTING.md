# Test tiers

krx-cli separates deterministic release evidence from paid or live upstream
checks. A release never depends on credentials, model output, or current market
availability.

## Per-change and release-blocking

The reusable CI gate runs on Blacksmith Ubuntu 24.04 x64 with supported Node.js
LTS versions. macOS and Windows are intentionally omitted from continuous CI to
reduce compute cost; their native artifact targets remain supported. The gate
requires a frozen install, lint, type checking, unit and integration tests with
coverage thresholds, a clean production dependency audit, both bundled builds,
and an isolated smoke test of the npm package.

Run the same gate locally with:

```bash
pnpm verify
```

The package smoke test installs an `npm pack` artifact in a temporary directory
and exercises `krx --help`, schema output, an invalid-argument exit code,
`krx-mcp` startup, and MCP `tools/list`.

## Credentialed and nondeterministic

`pnpm test:e2e` drives the built CLI through Claude Code. It requires the
`claude` executable, an authenticated paid session, and `pnpm build` first.
Model output and external service availability make this suite unsuitable for
pull-request or release blocking; run it manually when changing agent-facing
prompts or workflows.

Live KRX contract checks use real credentials and a documented request budget.
They belong in a scheduled or manually dispatched credentialed tier, not the
deterministic gate.
