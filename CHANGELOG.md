# Changelog

## Unreleased

### Security

- Upgrade the bundled Model Context Protocol SDK dependency and enforce a clean production dependency audit before release.

### Build System

- Gate releases on cross-platform validation and isolated smoke tests of the packed `krx` and `krx-mcp` binaries.

## [1.8.1](https://github.com/kyo504/krx-cli/compare/v1.8.0...v1.8.1) (2026-03-20)

### Bug Fixes

- --from/--to 사용 시 --date 필수 요구 제거 ([a97d21b](https://github.com/kyo504/krx-cli/commit/a97d21b71e0d2c17fb2df0897cc5f377eeb189ef))
- watchlist show에서 종목 매칭 실패하는 버그 수정 ([25f2f1b](https://github.com/kyo504/krx-cli/commit/25f2f1b1ba34741ebd2cb7b19bd03daa290dc409))

## [1.8.0](https://github.com/kyo504/krx-cli/compare/v1.7.3...v1.8.0) (2026-03-19)

### Features

- --verbose 옵션 구현으로 디버깅 로그 지원 ([181f4fc](https://github.com/kyo504/krx-cli/commit/181f4fcfb23902727b2f1420a3654e0c34bc3fe8))

## [1.7.3](https://github.com/kyo504/krx-cli/compare/v1.7.2...v1.7.3) (2026-03-19)

### Bug Fixes

- isin/단축코드 매칭 로직 통합 및 종목 조회 정상화 ([7636baa](https://github.com/kyo504/krx-cli/commit/7636baa))

## [1.7.2](https://github.com/kyo504/krx-cli/compare/v1.7.1...v1.7.2) (2026-03-18)

### Bug Fixes

- isuCd 클라이언트 필터링으로 단일 종목 조회 정상화 ([20299dc](https://github.com/kyo504/krx-cli/commit/20299dc))

## [1.7.1](https://github.com/kyo504/krx-cli/compare/v1.7.0...v1.7.1) (2026-03-18)

### Bug Fixes

- tool result truncation 개선 및 isuCd 사용 안내 추가 ([e78553a](https://github.com/kyo504/krx-cli/commit/e78553a))

## [1.7.0](https://github.com/kyo504/krx-cli/compare/v1.6.0...v1.7.0) (2026-03-17)

### New Features

- tool result truncation 및 offset 페이지네이션 추가 ([5d773c5](https://github.com/kyo504/krx-cli/commit/5d773c5))

### Bug Fixes

- sdk DNS rebinding 경고 중복 출력 억제 ([d192ad3](https://github.com/kyo504/krx-cli/commit/d192ad3))

## [1.6.0](https://github.com/kyo504/krx-cli/compare/v1.5.0...v1.6.0) (2026-03-16)

### New Features

- streamable HTTP MCP 서버 추가 (krx serve) ([b71f0cc](https://github.com/kyo504/krx-cli/commit/b71f0cc))

## [1.5.0](https://github.com/kyo504/krx-cli/compare/v1.3.1...v1.5.0) (2026-03-15)

### New Features

- mcp 리소스 지원 추가 (krx://watchlist, rate-limit, service-status) ([9901763](https://github.com/kyo504/krx-cli/commit/9901763))
- 네트워크 에러 자동 재시도 기능 추가 (--retries) ([34de501](https://github.com/kyo504/krx-cli/commit/34de501))
- csv 출력 포맷 및 파일 저장 기능 추가 (-o csv, --save) ([71fe66e](https://github.com/kyo504/krx-cli/commit/71fe66e))
- 필터 표현식 기능 추가 (--filter "FLUC_RT > 5") ([deee528](https://github.com/kyo504/krx-cli/commit/deee528))
- 워치리스트 기능 추가 (add/remove/list/show) ([cb49a15](https://github.com/kyo504/krx-cli/commit/cb49a15))
- 시장 요약 커맨드 및 문서 업데이트 ([6b9f084](https://github.com/kyo504/krx-cli/commit/6b9f084))
- 기간 조회 기능 추가 (--from/--to) ([9f724d2](https://github.com/kyo504/krx-cli/commit/9f724d2))
- 파일 기반 캐싱 레이어 추가 ([6407278](https://github.com/kyo504/krx-cli/commit/6407278))
- 정렬(sort) 및 결과 제한(limit) 기능 추가 ([7515c98](https://github.com/kyo504/krx-cli/commit/7515c98))
- 종목코드(isuCd) 파라미터 지원 ([a8a7a38](https://github.com/kyo504/krx-cli/commit/a8a7a38))
- 종목 검색 기능 추가 (stock search) ([9f7c562](https://github.com/kyo504/krx-cli/commit/9f7c562))

### Documentation

- readme, skill.md 최신화 및 cli help 텍스트 수정 ([37c5fed](https://github.com/kyo504/krx-cli/commit/37c5fed))

### Tests

- e2e 시나리오 테스트 프레임워크 추가 (claude -p 기반) ([7bd5bd2](https://github.com/kyo504/krx-cli/commit/7bd5bd2))

### Refactoring

- cli 커맨드 공통 로직 추출 및 인프라 리팩토링 ([9c59999](https://github.com/kyo504/krx-cli/commit/9c59999))

## [1.3.1](https://github.com/kyo504/krx-cli/compare/v1.3.0...v1.3.1) (2026-03-13)

### Bug Fixes

- mcp 서버 TypeScript 타입 에러 수정 ([bedd41c](https://github.com/kyo504/krx-cli/commit/bedd41c))

## [1.3.0](https://github.com/kyo504/krx-cli/compare/v1.2.0...v1.3.0) (2026-03-13)

### New Features

- mcp 서버 추가 (claude desktop / chatgpt desktop 지원) ([2417b2d](https://github.com/kyo504/krx-cli/commit/2417b2d))

## [1.2.0](https://github.com/kyo504/krx-cli/compare/v1.1.0...v1.2.0) (2026-03-12)

### New Features

- version 확인 및 update 명령어 추가 ([83bb81a](https://github.com/kyo504/krx-cli/commit/83bb81a))

### Refactoring

- tsup에서 esbuild로 번들러 전환 ([ded13d9](https://github.com/kyo504/krx-cli/commit/ded13d9))

## [1.1.0](https://github.com/kyo504/krx-cli/compare/v1.0.2...v1.1.0) (2026-03-11)

### New Features

- skill.md 트리거 조건 추가 및 release-it 버전 동기화 ([7e98f19](https://github.com/kyo504/krx-cli/commit/7e98f19))
- 31개 엔드포인트 응답 필드 스키마 추가 ([6f77f18](https://github.com/kyo504/krx-cli/commit/6f77f18))

### Bug Fixes

- 포털 검증 기반 응답 필드 스키마 수정 ([4bad087](https://github.com/kyo504/krx-cli/commit/4bad087))

## [1.0.2](https://github.com/kyo504/krx-cli/compare/v1.0.1...v1.0.2) (2026-03-11)

### Bug Fixes

- trusted publishing 위한 node 24 및 repository 필드 추가 ([7cc3418](https://github.com/kyo504/krx-cli/commit/7cc3418))

## [1.0.1](https://github.com/kyo504/krx-cli/compare/v1.0.0...v1.0.1) (2026-03-11)

### Build System

- npm Trusted Publishing 방식으로 변경 ([1bb0363](https://github.com/kyo504/krx-cli/commit/1bb0363))
- tag push 시 npm 자동 배포 워크플로우 추가 ([e211bd3](https://github.com/kyo504/krx-cli/commit/e211bd3))

## [1.0.0](https://github.com/kyo504/krx-cli/releases/tag/v1.0.0) (2026-03-10)

### New Features

- KRX CLI 초기 프로젝트 설정 및 Phase 1 구현 ([df197ba](https://github.com/kyo504/krx-cli/commit/df197ba))
- Phase 2 구현 - 전체 카테고리 명령어 + rate limit 추적 ([dee5c96](https://github.com/kyo504/krx-cli/commit/dee5c96))
