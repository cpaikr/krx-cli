# Rust vertical-slice certification report

Status: hosted certification retry pending

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

Hosted evidence on 2026-08-22:

- [Run 32560050687](https://github.com/sjunepark/krx-cli/actions/runs/32560050687)
  passed every build, test, live Rustls, native keyring, assembly, pack, and
  upload step on macOS ARM64 and Linux GNU x64/ARM64.
- Windows x64 passed the same checks through package assembly. Its pack step
  exposed that Node 24 cannot spawn `npm.cmd` directly: the child returned a
  null status without stderr. The checked remediation invokes npm's JavaScript
  CLI with `node.exe`, reports child-process errors, and has a platform-path
  regression test.
- [Run 32561033733](https://github.com/sjunepark/krx-cli/actions/runs/32561033733)
  passed all four build jobs, including Windows x64 assembly, pack, and upload.
  All six non-Windows Node consumers passed. Both Windows consumers installed
  the exact archive before a declaration-containment assertion combined a
  Windows root with a POSIX separator. The checked remediation uses native
  relative-path semantics and tests nested, exact-root, sibling-escape, and
  cross-drive Win32 paths.

The remediation retry must pass four target builds and eight clean-install
Node consumers, then compare all eight reports, before this report can be
promoted to certified. No target is certified solely by a partial hosted run
or this local checkpoint.
