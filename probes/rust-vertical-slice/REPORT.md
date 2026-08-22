# Rust vertical-slice certification report

Status: hosted certification pending

Local evidence on 2026-08-22:

- Rust 1.92.0 formatting, workspace check, warning-free Clippy, frozen consumer
  compile, and tests pass on macOS ARM64.
- The SDK has ten passing deterministic tests and two opt-in native-runner
  tests; the official Rustls handshake and a disposable native keychain
  round-trip both pass locally. The native CLI has five passing integration
  tests.
- One `darwin-arm64` tarball built from the shared SDK passes the clean-install
  consumer unchanged on Node 22 and Node 24, including declaration typecheck
  and direct native npm-bin execution. Both consumers report the same portable
  payload digest, package metadata, and native capability projection.

The GitHub workflow must pass four target builds and eight clean-install Node
consumers, then compare all eight reports, before this report can be promoted
to certified. No target is certified solely by this local checkpoint.
