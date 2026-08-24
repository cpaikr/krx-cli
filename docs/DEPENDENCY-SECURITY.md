# Dependency and artifact security

The shipped target tarball is dependency-free and has no lifecycle scripts.
It contains one native executable, one private target binding, the public ESM
facade and declarations, and the packaged skill. Installation must use a
prebuilt private release asset with scripts disabled; Git/source installation
is not supported.

Rust dependencies are exact-pinned in `Cargo.toml` and `Cargo.lock`. The
maintainer-only Node toolchain is locked by `pnpm-lock.yaml` and never enters
the release archive. `pnpm audit:prod` therefore verifies that the root has no
production dependency graph.

`scripts/native-package/assemble.mjs`, `pack.mjs`, and `certify.mjs` reject
path traversal, symbolic links, missing or mismatched native files, incorrect
platform/architecture/libc, and non-executable Unix binaries. Package exports
do not expose the binding. Continuous certification installs the exact Linux
archives with scripts disabled under Node 22 and 24.
