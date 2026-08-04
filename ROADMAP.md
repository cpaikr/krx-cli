# Roadmap

## Current baseline

The production-readiness baseline tracked by
[CPAiKR issue #11](https://github.com/cpaikr/krx-cli/issues/11) is implemented
as of 2026-08-04. The repository is ready for normal review and delivery; a
release, publication, and upstream contribution are separate decisions.

The baseline requires all of the following:

- [x] Local CLI and stdio MCP remain functional and documented. See
      [README.md](README.md).
- [x] Remote HTTP MCP fails closed without a Bearer token and requires an
      explicit Host allowlist for non-loopback binds. See [README.md](README.md).
- [x] KRX credentials use hidden or stdin input, owner-only POSIX persistence,
      and `KRX_API_KEY` precedence without appearing in recommended command
      arguments.
- [x] The locked production dependency tree has no accepted advisories, and
      both distributed entrypoints are rebuilt. See
      [dependency security](docs/DEPENDENCY-SECURITY.md).
- [x] Ubuntu and Windows CI use frozen installs on Node.js 22 and 24. See
      [test tiers](docs/TESTING.md).
- [x] Releases reuse the CI gate before smoke-testing and publishing the exact
      packed artifact.
- [x] HTTP deadlines, retries, cancellation, and per-credential KST quota
      reservations have explicit tested behavior. See
      [request reliability](docs/HTTP-RELIABILITY.md).
- [x] Multi-request operations expose complete, partial, empty, and failed
      states without presenting missing inputs as observed zeroes. See
      [composite results](docs/COMPOSITE-RESULTS.md).
- [x] Approval probes bypass market-data cache and distinguish explicit
      rejection from inconclusive failures. See
      [request reliability](docs/HTTP-RELIABILITY.md).
- [x] A bounded weekly check compares all maintained endpoints with live
      responses and official KRX specifications. See
      [contract testing](docs/KRX-CONTRACT-TESTING.md).
- [x] Default and range dates use a versioned KRX closing calendar with explicit
      stale and uncovered-date fallback. See
      [trading calendar](docs/KRX-CALENDAR.md).
- [x] Historical cache entries are versioned, freshness-bounded, quarantined
      when invalid, selectively refreshable, and atomically replaced. See
      [cache lifecycle](docs/CACHE.md).
- [x] README, SKILL, executable help, environment variables, output defaults,
      and exit statuses follow one tested contract. See
      [CLI contract](docs/CLI-CONTRACT.md).

`pnpm verify` is the deterministic local and CI acceptance gate. It covers
linting, type checking, tests and coverage, the production audit, both bundled
entrypoints, and an installed-package smoke test. Live KRX checks remain a
credentialed scheduled or manual operational gate and are intentionally not
part of pull-request or release-blocking tests.

The local acceptance run on 2026-08-04 passed 327 tests, the production audit,
both builds, and installed-package smoke checks for 31 schemas and 12 MCP tools.
The current commits have not been pushed, so their configured cross-platform CI
run belongs to the later delivery step rather than this no-push baseline work.

## Ongoing operations

- Keep the weekly contract-drift workflow supplied with a repository
  `KRX_API_KEY` approved for every category and review any redacted report.
- Update the checked-in trading calendar before default-date use in a new year
  or when KRX announces an exceptional closure.
- Keep dependencies and GitHub Actions current without weakening the clean
  production-audit policy or packed-artifact release gate.

## Beyond this baseline

Publishing a release, offering fixes upstream, multi-tenant hosting, a public
programmatic SDK, redistributed KRX datasets, and abstractions for hypothetical
services are not part of this completed baseline. Add them only through a new
approved roadmap decision.
