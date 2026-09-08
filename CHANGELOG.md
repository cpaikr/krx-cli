# Changelog

## 1.8.2 (2026-09-07)

### Features

- add debug logging with the --verbose option ([181f4fc](https://github.com/cpaikr/krx-cli/commit/181f4fcfb23902727b2f1420a3654e0c34bc3fe8))
- add response field schemas for 31 endpoints ([6f77f18](https://github.com/cpaikr/krx-cli/commit/6f77f18c2fe494020a05caa5e2b0815cca335084))
- **adapters:** add native CLI and public Node SDK ([b6bf725](https://github.com/cpaikr/krx-cli/commit/b6bf7252420ccefad973f744e8b12a5c76c74374))
- **cache:** enforce versioned atomic response lifecycle ([5fba787](https://github.com/cpaikr/krx-cli/commit/5fba787021265bbf70c0bfecb8e1d12f645445be))
- **calendar:** use verified KRX trading sessions ([cd24712](https://github.com/cpaikr/krx-cli/commit/cd247126d4a74e087391b8b6504f07ad671c627f))
- **composites:** expose explicit result completeness ([cebe4ce](https://github.com/cpaikr/krx-cli/commit/cebe4ce77f397f66211f23121a6908a729666d9f))
- **contracts:** certify Rust rewrite candidate seams ([66d0756](https://github.com/cpaikr/krx-cli/commit/66d0756004a5a3fcba6aa45d552cf36b8a3667c9))
- **contracts:** detect live KRX contract drift ([55667a8](https://github.com/cpaikr/krx-cli/commit/55667a82331c85ff6e9c40ac896c03fe30cc9c42))
- **contracts:** establish canonical KRX wire authority ([82d940d](https://github.com/cpaikr/krx-cli/commit/82d940d4943b0ac14151a0ab3444fab76327261c))
- **contracts:** freeze public and local-state boundaries ([486e88a](https://github.com/cpaikr/krx-cli/commit/486e88a7f8af09544fa5076c9af6b95de345bff8))
- add CSV output and file saving (-o csv, --save) ([71fe66e](https://github.com/cpaikr/krx-cli/commit/71fe66e6ffc917e098c05e36f64f4301f1b1b2c3))
- **cutover:** make the native Rust product authoritative ([7a03ae5](https://github.com/cpaikr/krx-cli/commit/7a03ae545efa5abd44d76f71bdd8ec376484814a))
- set up the initial KRX CLI project and implement Phase 1 ([df197ba](https://github.com/cpaikr/krx-cli/commit/df197ba1ff7df830976da59fae6fce32bccbfc0e))
- add MCP resource support (krx://watchlist, rate-limit, service-status) ([9901763](https://github.com/cpaikr/krx-cli/commit/99017634e5cd0486f4e43c389893e1cf93777402))
- add an MCP server with Claude Desktop and ChatGPT Desktop support ([2417b2d](https://github.com/cpaikr/krx-cli/commit/2417b2d75d88ddaf70a2409b6af2e767f4a07dd3))
- **parity:** certify the installed native command surface ([2088ddb](https://github.com/cpaikr/krx-cli/commit/2088ddbd60484a472a891efb9112c247ece4b16a))
- implement Phase 2: commands for all categories and rate limit tracking ([dee5c96](https://github.com/cpaikr/krx-cli/commit/dee5c9670df495ca4ce2c6ab5089c18093c4803d))
- **reliability:** bound KRX requests and approval checks ([9f032bb](https://github.com/cpaikr/krx-cli/commit/9f032bb1056a35d1e8d128d40415687bc5aa6f1c))
- **sdk:** add canonical Rust conformer core ([797e323](https://github.com/cpaikr/krx-cli/commit/797e323a4167101d09a023cbac1bd1f8391d62b5))
- **sdk:** add private reliable KRX transport ([8cf47e8](https://github.com/cpaikr/krx-cli/commit/8cf47e82436149f896dbc8fd8054a8dd18f1df2a))
- **sdk:** add strict secure cache core ([12c9e9e](https://github.com/cpaikr/krx-cli/commit/12c9e9e103bd17812ab11d2e6d463842c3bbfe15))
- **sdk:** coordinate cache-backed direct queries ([27dab1e](https://github.com/cpaikr/krx-cli/commit/27dab1ea9df1cef93578e04a8d0a289a5337fb9c))
- **sdk:** expose the complete shared Rust API ([1471622](https://github.com/cpaikr/krx-cli/commit/1471622ff1f8d4c2bfa4e9e10b638edd50a32779))
- **sdk:** implement deterministic market policy ([b7104cd](https://github.com/cpaikr/krx-cli/commit/b7104cd36a0f477f856056c996191744e69fd9e2))
- **sdk:** secure credentials and approval state ([ecdb77f](https://github.com/cpaikr/krx-cli/commit/ecdb77f66f609619a837037e246a8e3c33493532))
- **sdk:** secure shared local quota state ([48bafe6](https://github.com/cpaikr/krx-cli/commit/48bafe6e54d5c1d769d10d911b486f86b1fc424f))
- **sdk:** secure Windows quota state ([e587a26](https://github.com/cpaikr/krx-cli/commit/e587a2644abb90cb4c7b3572fd981915d6474376))
- **security:** harden MCP and KRX credential boundaries ([155045a](https://github.com/cpaikr/krx-cli/commit/155045a26ed3256791daaf183e455ef89d177046)), closes [#1](https://github.com/cpaikr/krx-cli/issues/1) [#2](https://github.com/cpaikr/krx-cli/issues/2)
- add skill.md trigger conditions and synchronize release-it versions ([7e98f19](https://github.com/cpaikr/krx-cli/commit/7e98f191dfb621b692966a2ab047b7ac40d2b745))
- **skill:** restructure KRX skill and add safe access workflow ([c24aa1b](https://github.com/cpaikr/krx-cli/commit/c24aa1b02bfd17a545eeeee637da233647b77ab1))
- **stock:** add verified adjusted price ranges ([4e90c06](https://github.com/cpaikr/krx-cli/commit/4e90c061c8b53f3e4d40f2003510ed0bd2ba7f1a))
- add a Streamable HTTP MCP server (krx serve) ([b71f0cc](https://github.com/cpaikr/krx-cli/commit/b71f0ccd891f2425e3a663de335c074cee55fff2))
- add tool result truncation and offset pagination ([5d773c5](https://github.com/cpaikr/krx-cli/commit/5d773c5d726c82ac156267e1f6911c89027ff16e))
- add version checking and the update command ([83bb81a](https://github.com/cpaikr/krx-cli/commit/83bb81a25f41c825392365579737bc8127aab178))
- add date-range queries (--from/--to) ([9f724d2](https://github.com/cpaikr/krx-cli/commit/9f724d252f01eecbe4f7a3024fac287c19681f0f))
- add automatic retries for network errors (--retries) ([34de501](https://github.com/cpaikr/krx-cli/commit/34de501b224dd05622126904a86f5771b80f9c0f))
- add the market summary command and update documentation ([6b9f084](https://github.com/cpaikr/krx-cli/commit/6b9f0844c9b3faadf4e85eb588b5daec9de1bfaa))
- add watchlist functionality (add/remove/list/show) ([cb49a15](https://github.com/cpaikr/krx-cli/commit/cb49a1560d3abf2a2c9ca9c3c794ac911c39f4b6))
- add sorting (sort) and result limits (limit) ([7515c98](https://github.com/cpaikr/krx-cli/commit/7515c981eadda558bd4c10f72ed7be70f881dc4a))
- add stock search (stock search) ([9f7c562](https://github.com/cpaikr/krx-cli/commit/9f7c5624232faf06c213b189beb31f6f37ec7cc3))
- support the stock code (isuCd) parameter ([a8a7a38](https://github.com/cpaikr/krx-cli/commit/a8a7a38960977229908fc662da7b11e5c909ba27))
- add a file-based caching layer ([6407278](https://github.com/cpaikr/krx-cli/commit/6407278ed7f8ea2edc30745d2bda6f006c413b3c))
- add filter expressions (--filter "FLUC_RT > 5") ([deee528](https://github.com/cpaikr/krx-cli/commit/deee52873a0e418794ce6319e87d2c2a8c16d31d))

### Bug Fixes

- remove the --date requirement when using --from/--to ([a97d21b](https://github.com/cpaikr/krx-cli/commit/a97d21b71e0d2c17fb2df0897cc5f377eeb189ef))
- **adapters:** close native parity review findings ([a0efe0b](https://github.com/cpaikr/krx-cli/commit/a0efe0b6b6fe0f04d32ce0762a054cfd4b1de882))
- **certification:** make declaration checks portable ([1dc72af](https://github.com/cpaikr/krx-cli/commit/1dc72afad8a5dd199589f1cb524d01d816e059a3))
- **certification:** pin portable package bytes ([337d1d6](https://github.com/cpaikr/krx-cli/commit/337d1d658fbcc1b8276126ba269f4c4ab3e2490c))
- **certification:** release native binding before cleanup ([fba7390](https://github.com/cpaikr/krx-cli/commit/fba7390f5dca16df379be175bb209d278798170d))
- switch CI to Node.js 22 and fix lint errors ([030b67d](https://github.com/cpaikr/krx-cli/commit/030b67dc95776df12e8d4b4dc469ccc293c6570f))
- **ci:** launch npm through Node on Windows ([88f8e08](https://github.com/cpaikr/krx-cli/commit/88f8e086ef294e2522becbe865f09c4a530f3c5f))
- **ci:** repair Windows verification failures ([d3f840d](https://github.com/cpaikr/krx-cli/commit/d3f840d78e009aae54a7bb45ed4c77f55ac0975a))
- **ci:** restore portable legacy validation ([6eaef65](https://github.com/cpaikr/krx-cli/commit/6eaef6594ec40727447f2d54ae7a949f52cec8f1))
- **cli:** align executable and documented contracts ([8d02556](https://github.com/cpaikr/krx-cli/commit/8d025569f5e940a2144ad39a039b62731b11bdb1)), closes [#10](https://github.com/cpaikr/krx-cli/issues/10)
- **cli:** preserve frozen composite envelopes ([df3cf9d](https://github.com/cpaikr/krx-cli/commit/df3cf9dcc04f083a6a44f4f8889b7d769b7e332c))
- **compat:** harden baseline certification ([f8b97f9](https://github.com/cpaikr/krx-cli/commit/f8b97f965d126704aaa8608ddc0d5452ef5f586c))
- **contracts:** canonicalize generated JSON ([3dc8e79](https://github.com/cpaikr/krx-cli/commit/3dc8e7912ce51c1386bb38a3a81789830089b99f))
- **contracts:** close CodeRabbit probe findings ([f611d8a](https://github.com/cpaikr/krx-cli/commit/f611d8a775849b1fa57a26840f53144857269cc2))
- **contracts:** close native contract review gaps ([97b6d98](https://github.com/cpaikr/krx-cli/commit/97b6d98ff4d01517e3fa732ee6c3df671e6381cd))
- **contracts:** freeze complete Rust result surface ([6b46cc1](https://github.com/cpaikr/krx-cli/commit/6b46cc173f9a86d70d889379345c9e8070dac85e))
- **contracts:** make frozen SDK policy implementable ([e46dc1b](https://github.com/cpaikr/krx-cli/commit/e46dc1bc5e9b3dbe2bf44a1d565309118ea0d550))
- **contract:** restore live checks using a local environment file ([8ecc534](https://github.com/cpaikr/krx-cli/commit/8ecc5346b5543a3e3a23c692611b1bbdf343a995))
- **cutover:** close final certification gaps ([41fd9f9](https://github.com/cpaikr/krx-cli/commit/41fd9f9c025adfd7047180ceb197c9e7aeb5d27b))
- **cutover:** close hosted and Codex compatibility findings ([fe7592a](https://github.com/cpaikr/krx-cli/commit/fe7592a6e5ae22b34b1c77dd7b7c4c7bfb80703b))
- unify ISIN and short-code matching logic and fix stock queries ([7636baa](https://github.com/cpaikr/krx-cli/commit/7636baa4e1aa0d2f588a3ed5ef56b7d86124205e))
- fix single-stock queries with client-side isuCd filtering ([20299dc](https://github.com/cpaikr/krx-cli/commit/20299dc2ba1e55adfa8b7b6155a5237c8be8cdef))
- fix TypeScript type errors in the MCP server ([bedd41c](https://github.com/cpaikr/krx-cli/commit/bedd41cc206797301e05a9aac03a5c85972aa886))
- **node:** preserve raw range security selectors ([8b7b84c](https://github.com/cpaikr/krx-cli/commit/8b7b84c11129b45cdcc70524c968d99af665dadf))
- **packaging:** harden native artifact certification ([50fcd81](https://github.com/cpaikr/krx-cli/commit/50fcd818a603ecfce2020cf373fde067ebf793fc))
- **packaging:** ship and certify native archive license ([53fafab](https://github.com/cpaikr/krx-cli/commit/53fafab51a0eeccc2a5ba9099e26e86d2618facb))
- **release:** publish verified native assets after full certification ([e1211e6](https://github.com/cpaikr/krx-cli/commit/e1211e6c34274812d7887db2744c3c1a3ce79d44))
- suppress duplicate SDK DNS rebinding warnings ([d192ad3](https://github.com/cpaikr/krx-cli/commit/d192ad3e66342b9eb045532dea69aa6954876cc3))
- **sdk:** close production review findings ([3bb5397](https://github.com/cpaikr/krx-cli/commit/3bb539744d9659f93d3459855b83e103fe3b7fc6))
- **skill:** preserve valid existing KRX approval terms ([e33d5c7](https://github.com/cpaikr/krx-cli/commit/e33d5c7d6bcdb4dd6321dd9bf0e74f0a600168f0))
- **skill:** reconcile approval transitions and unprocessed endpoints ([15baa25](https://github.com/cpaikr/krx-cli/commit/15baa2576a737cb83cc40c98dd98becbafd3ef42))
- **stock:** preserve range failure semantics ([e2ffdca](https://github.com/cpaikr/krx-cli/commit/e2ffdca8f02d83dedbf5a70fff03f4f018124f34))
- improve tool result truncation and add isuCd usage guidance ([e78553a](https://github.com/cpaikr/krx-cli/commit/e78553a7fa5072be4c2d7f95ff1a1d8b70153b86))
- add Node.js 24 and the repository field for trusted publishing ([7cc3418](https://github.com/cpaikr/krx-cli/commit/7cc341888647ef709e5a66bd863f8c134bf62105))
- fix stock matching failures in watchlist show ([25f2f1b](https://github.com/cpaikr/krx-cli/commit/25f2f1b1ba34741ebd2cb7b19bd03daa290dc409))
- **windows:** borrow cache owner identity during publication check ([fd50cfb](https://github.com/cpaikr/krx-cli/commit/fd50cfbce6c4c8ea14d358f8d73cef07907d881e))
- **windows:** create private state with explicit user ownership ([3ec722c](https://github.com/cpaikr/krx-cli/commit/3ec722c51f385095c7315de4b49a8f0720fd424d))
- **windows:** preserve writable lock handles and deletion contention ([38e1442](https://github.com/cpaikr/krx-cli/commit/38e14420d3297786ed1cd13ef1a0d244ad0e1cc9))
- **windows:** use native handle-relative rename semantics ([79c53a6](https://github.com/cpaikr/krx-cli/commit/79c53a693d91774de5b85348e8fff27f8f048f88))
- correct response field schemas based on portal verification ([4bad087](https://github.com/cpaikr/krx-cli/commit/4bad08726d8ba76cb159b55a47b28a551c069327))

## Unreleased

### New Features

- Replace the JavaScript CLI and TypeScript protocol implementation with a native Clap CLI, public Node.js SDK, and shared Rust SDK.
- Add secure credential, cache, quota, approval, watchlist, offline, and legacy-state migration through the shared implementation.

### Build System

- Assemble private, install-script-free native archives for macOS ARM64, Linux GNU x64/ARM64, and Windows x64.
- Continuously certify Linux GNU x64/ARM64 under Node.js 22 and 24 on Blacksmith; macOS and Windows CI jobs are intentionally omitted to reduce compute cost.
- Remove the duplicate branch-push CI matrix and run the heavy gates for pull requests or manual dispatch.

### Breaking Changes

- Remove the legacy JavaScript package entry points, TypeScript runtime, and MCP binaries and server surface.

## [1.8.1](https://github.com/kyo504/krx-cli/compare/v1.8.0...v1.8.1) (2026-03-20)

### Bug Fixes

- remove the --date requirement when using --from/--to ([a97d21b](https://github.com/kyo504/krx-cli/commit/a97d21b71e0d2c17fb2df0897cc5f377eeb189ef))
- fix stock matching failures in watchlist show ([25f2f1b](https://github.com/kyo504/krx-cli/commit/25f2f1b1ba34741ebd2cb7b19bd03daa290dc409))

## [1.8.0](https://github.com/kyo504/krx-cli/compare/v1.7.3...v1.8.0) (2026-03-19)

### Features

- add debug logging with the --verbose option ([181f4fc](https://github.com/kyo504/krx-cli/commit/181f4fcfb23902727b2f1420a3654e0c34bc3fe8))

## [1.7.3](https://github.com/kyo504/krx-cli/compare/v1.7.2...v1.7.3) (2026-03-19)

### Bug Fixes

- unify ISIN and short-code matching logic and fix stock queries ([7636baa](https://github.com/kyo504/krx-cli/commit/7636baa))

## [1.7.2](https://github.com/kyo504/krx-cli/compare/v1.7.1...v1.7.2) (2026-03-18)

### Bug Fixes

- fix single-stock queries with client-side isuCd filtering ([20299dc](https://github.com/kyo504/krx-cli/commit/20299dc))

## [1.7.1](https://github.com/kyo504/krx-cli/compare/v1.7.0...v1.7.1) (2026-03-18)

### Bug Fixes

- improve tool result truncation and add isuCd usage guidance ([e78553a](https://github.com/kyo504/krx-cli/commit/e78553a))

## [1.7.0](https://github.com/kyo504/krx-cli/compare/v1.6.0...v1.7.0) (2026-03-17)

### New Features

- add tool result truncation and offset pagination ([5d773c5](https://github.com/kyo504/krx-cli/commit/5d773c5))

### Bug Fixes

- suppress duplicate SDK DNS rebinding warnings ([d192ad3](https://github.com/kyo504/krx-cli/commit/d192ad3))

## [1.6.0](https://github.com/kyo504/krx-cli/compare/v1.5.0...v1.6.0) (2026-03-16)

### New Features

- add a Streamable HTTP MCP server (krx serve) ([b71f0cc](https://github.com/kyo504/krx-cli/commit/b71f0cc))

## [1.5.0](https://github.com/kyo504/krx-cli/compare/v1.3.1...v1.5.0) (2026-03-15)

### New Features

- add MCP resource support (krx://watchlist, rate-limit, service-status) ([9901763](https://github.com/kyo504/krx-cli/commit/9901763))
- add automatic retries for network errors (--retries) ([34de501](https://github.com/kyo504/krx-cli/commit/34de501))
- add CSV output and file saving (-o csv, --save) ([71fe66e](https://github.com/kyo504/krx-cli/commit/71fe66e))
- add filter expressions (--filter "FLUC_RT > 5") ([deee528](https://github.com/kyo504/krx-cli/commit/deee528))
- add watchlist functionality (add/remove/list/show) ([cb49a15](https://github.com/kyo504/krx-cli/commit/cb49a15))
- add the market summary command and update documentation ([6b9f084](https://github.com/kyo504/krx-cli/commit/6b9f084))
- add date-range queries (--from/--to) ([9f724d2](https://github.com/kyo504/krx-cli/commit/9f724d2))
- add a file-based caching layer ([6407278](https://github.com/kyo504/krx-cli/commit/6407278))
- add sorting (sort) and result limits (limit) ([7515c98](https://github.com/kyo504/krx-cli/commit/7515c98))
- support the stock code (isuCd) parameter ([a8a7a38](https://github.com/kyo504/krx-cli/commit/a8a7a38))
- add stock search (stock search) ([9f7c562](https://github.com/kyo504/krx-cli/commit/9f7c562))

### Documentation

- update readme and skill.md and correct CLI help text ([37c5fed](https://github.com/kyo504/krx-cli/commit/37c5fed))

### Tests

- add an E2E scenario testing framework based on claude -p ([7bd5bd2](https://github.com/kyo504/krx-cli/commit/7bd5bd2))

### Refactoring

- extract shared CLI command logic and refactor infrastructure ([9c59999](https://github.com/kyo504/krx-cli/commit/9c59999))

## [1.3.1](https://github.com/kyo504/krx-cli/compare/v1.3.0...v1.3.1) (2026-03-13)

### Bug Fixes

- fix TypeScript type errors in the MCP server ([bedd41c](https://github.com/kyo504/krx-cli/commit/bedd41c))

## [1.3.0](https://github.com/kyo504/krx-cli/compare/v1.2.0...v1.3.0) (2026-03-13)

### New Features

- add an MCP server with Claude Desktop and ChatGPT Desktop support ([2417b2d](https://github.com/kyo504/krx-cli/commit/2417b2d))

## [1.2.0](https://github.com/kyo504/krx-cli/compare/v1.1.0...v1.2.0) (2026-03-12)

### New Features

- add version checking and the update command ([83bb81a](https://github.com/kyo504/krx-cli/commit/83bb81a))

### Refactoring

- switch the bundler from tsup to esbuild ([ded13d9](https://github.com/kyo504/krx-cli/commit/ded13d9))

## [1.1.0](https://github.com/kyo504/krx-cli/compare/v1.0.2...v1.1.0) (2026-03-11)

### New Features

- add skill.md trigger conditions and synchronize release-it versions ([7e98f19](https://github.com/kyo504/krx-cli/commit/7e98f19))
- add response field schemas for 31 endpoints ([6f77f18](https://github.com/kyo504/krx-cli/commit/6f77f18))

### Bug Fixes

- correct response field schemas based on portal verification ([4bad087](https://github.com/kyo504/krx-cli/commit/4bad087))

## [1.0.2](https://github.com/kyo504/krx-cli/compare/v1.0.1...v1.0.2) (2026-03-11)

### Bug Fixes

- add Node.js 24 and the repository field for trusted publishing ([7cc3418](https://github.com/kyo504/krx-cli/commit/7cc3418))

## [1.0.1](https://github.com/kyo504/krx-cli/compare/v1.0.0...v1.0.1) (2026-03-11)

### Build System

- switch to npm Trusted Publishing ([1bb0363](https://github.com/kyo504/krx-cli/commit/1bb0363))
- add an automated npm publishing workflow triggered by tag pushes ([e211bd3](https://github.com/kyo504/krx-cli/commit/e211bd3))

## [1.0.0](https://github.com/kyo504/krx-cli/releases/tag/v1.0.0) (2026-03-10)

### New Features

- set up the initial KRX CLI project and implement Phase 1 ([df197ba](https://github.com/kyo504/krx-cli/commit/df197ba))
- implement Phase 2: commands for all categories and rate limit tracking ([dee5c96](https://github.com/kyo504/krx-cli/commit/dee5c96))
