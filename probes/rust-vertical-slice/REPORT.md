# Rust vertical-slice certification report

Status: certified

This report preserves the historical four-target certification evidence. Since
2026-08-24, continuous exact-head certification covers Linux GNU x64/ARM64 under
Node 22 and 24 on Blacksmith. macOS ARM64 and Windows x64 remain supported
artifact targets but are intentionally omitted from continuous CI to reduce
compute cost.

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

- [Run 32560050687](https://github.com/cpaikr/krx-cli/actions/runs/32560050687)
  passed every build, test, live Rustls, native keyring, assembly, pack, and
  upload step on macOS ARM64 and Linux GNU x64/ARM64.
- Windows x64 passed the same checks through package assembly. Its pack step
  exposed that Node 24 cannot spawn `npm.cmd` directly: the child returned a
  null status without stderr. The checked remediation invokes npm's JavaScript
  CLI with `node.exe`, reports child-process errors, and has a platform-path
  regression test.
- [Run 32561033733](https://github.com/cpaikr/krx-cli/actions/runs/32561033733)
  passed all four build jobs, including Windows x64 assembly, pack, and upload.
  All six non-Windows Node consumers passed. Both Windows consumers installed
  the exact archive before a declaration-containment assertion combined a
  Windows root with a POSIX separator. The checked remediation uses native
  relative-path semantics and tests nested, exact-root, sibling-escape, and
  cross-drive Win32 paths.
- [Run 32561770761](https://github.com/cpaikr/krx-cli/actions/runs/32561770761)
  passed all four builds and all six non-Windows consumers. Both Windows
  consumers completed every certification assertion and printed matching
  `status: passed` reports before temporary cleanup failed: the certifier
  process had imported and still held open the native DLL. Capability capture
  now reuses the child runtime probe, whose exit releases the native module
  before parent-process cleanup. Local clean installs pass this flow under Node
  22 and 24 with identical portable identity.
- [Run 32562681277](https://github.com/cpaikr/krx-cli/actions/runs/32562681277)
  passed all four builds and all eight consumers. Both Windows consumers
  certified the exact archive and removed their temporary installs, closing
  the native DLL lifecycle defect. The final aggregator then rejected the
  Windows portable hash: artifact extraction proved that all seven JavaScript
  and declaration files differed only by CRLF checkout conversion. Checked
  attributes now pin the three portable source groups to LF, and the workflow
  watches that policy directly.
- [Run 32563560693](https://github.com/cpaikr/krx-cli/actions/runs/32563560693)
  passed all four target builds, all eight exact-archive clean-install
  consumers under Node 22 and 24, and the final cross-target aggregator. Every
  consumer reported the same package metadata and native capability identity;
  the portable JavaScript and declaration digest is
  `7f5dc0f96e7c38fd458ebc203f599d5ff561712a3d88111cb28fb723d3c90180`.
  An independent download and local replay of the checked report comparator
  passed against all eight hosted reports.

This disposable candidate is certified only for the frozen architecture and
contract boundary it exercises. It is not production implementation and does
not certify behavior outside the representative vertical slice.
