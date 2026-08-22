# Rust vertical-slice probe

This workspace is disposable contract evidence, not the production rewrite. It
compiles the frozen Rust consumer and exercises one canonical KRX operation
through the shared SDK, native Clap executable, and private Node-API binding.
The SDK build script derives wire details from the maintained OpenAPI and
generated product contract; production Rust code must not copy a second wire
inventory from this probe.

The probe owns four checks:

- strict HTTP request and bounded streaming response behavior, cancellation,
  timeout, redaction, official Rustls negotiation, and native credential-store
  behavior;
- Clap-owned topology, semantic rejection before I/O, stable diagnostics, and
  a direct native npm executable;
- ESM Node consumption with a manual `AbortSignal` bridge, listener cleanup,
  event-loop responsiveness, panic containment, package-local declarations,
  and no public native-binding subpath;
- one private tarball per manifest target, built once and consumed unchanged by
  Node 22 and 24 on the matching host architecture, followed by an exact
  comparison of portable payloads, package metadata, and capabilities.

Run the host-native Rust checks with `cargo test --locked --workspace
--all-features`. Build and assemble a local target with the scripts under
`node/scripts`; the hosted workflow is the authority for all four private
targets.

See `REPORT.md` for the latest evidence checkpoint.
