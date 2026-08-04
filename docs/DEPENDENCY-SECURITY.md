# Dependency security

Both published entrypoints are bundled by esbuild. Production dependencies can
therefore become part of `dist/cli.js` and `dist/mcp.js` even when they are not
present as separate files in an installed package. The locked production tree
and rebuilt package artifact are the security boundary.

## Policy

- `pnpm audit:prod` must report no known production vulnerabilities at any
  severity.
- `pnpm-lock.yaml` is the source of truth for an audit. Historical issue counts
  and an unlocked manifest resolution are not release evidence.
- Dependency changes must rebuild both entrypoints and pass the packed-package
  smoke test before release.
- CI and release installation must use `pnpm install --frozen-lockfile`.

There are currently no accepted production advisory exceptions. If an
exception becomes necessary, record the advisory identifier, affected locked
path and bundle, reachability analysis, mitigation, owner, and expiry here
before weakening the gate. High and critical advisories are never accepted for
release.

## Maintenance

Dependabot checks npm and GitHub Actions dependencies monthly in grouped updates.
Security updates may arrive outside that cadence. Review updates by regenerating
the lockfile and running:

```bash
pnpm audit:prod
pnpm check
pnpm test:coverage
pnpm build
pnpm test:package
```

The release workflow packs, installs, and smoke-tests the same tarball passed to
`npm publish`; a manifest-only dependency update is not remediation.
