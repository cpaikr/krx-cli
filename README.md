# krx-cli

[![npm version](https://img.shields.io/npm/v/krx-cli.svg)](https://www.npmjs.com/package/krx-cli)
[![npm downloads](https://img.shields.io/npm/dm/krx-cli.svg)](https://www.npmjs.com/package/krx-cli)
[![license](https://img.shields.io/npm/l/krx-cli.svg)](https://github.com/kyo504/krx-cli/blob/main/LICENSE)

AI 에이전트를 위한 KRX(한국거래소) Open API CLI & MCP 서버입니다.

Claude Code, GPT, Cursor 등의 AI 에이전트가 Bash tool 또는 MCP를 통해 한국 주식시장 데이터(KOSPI, KOSDAQ, ETF, 채권, 파생상품)를 조회할 수 있습니다.

## 특징

- **Agent-Native**: 파이프에서는 JSON, TTY에서는 표, 시맨틱 exit code, 스키마 인트로스펙션
- **전체 시장 커버리지**: 지수, 주식, ETF/ETN/ELW, 채권, 파생상품, 일반상품, ESG (31개 엔드포인트)
- **종목 검색**: 종목명으로 검색 후 코드 조회 (`krx stock search`)
- **시장 요약**: 한 번의 호출로 지수/상승·하락/Top movers 확인 (`krx market summary`)
- **워치리스트**: 관심 종목 저장 및 일괄 시세 조회 (`krx watchlist`)
- **기간 조회**: `--from/--to`로 여러 날짜 데이터 병렬 조회
- **데이터 파이프라인**: `--sort`, `--limit`, `--code` 로 로컬 결과 필터링
- **파일 캐싱**: 과거 데이터 자동 캐싱으로 rate limit 절약
- **안전한 사용**: 입력 검증, rate limit 추적, dry-run 지원
- **서비스 승인 관리**: API별 승인 상태 자동 확인

## 설치

```bash
npm install -g krx-cli
# 또는
pnpm add -g krx-cli
# 또는
yarn global add krx-cli
```

## 설정

### 1. API 키 발급

[KRX Open API 포털](https://openapi.krx.co.kr/)에서 회원가입 후 API 키를 발급받습니다.
공식 [서비스 이용방법](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp)은
인증키 신청과 API별 활용 신청 절차를 설명하며,
[서비스 목록](https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd)에서
현재 제공 API와 데이터 시작일을 확인할 수 있습니다.

### 2. API 키 등록

```bash
krx auth set

# 자동화에서 영구 저장이 필요할 때 (표준 입력은 터미널에 표시되지 않음)
printf '%s' "$KRX_API_KEY" | krx auth set --stdin

# 또는 저장하지 않고 환경변수 사용 (저장된 키보다 우선)
export KRX_API_KEY=<your-api-key>

# 저장된 키 삭제
krx auth remove
```

대화형 `auth set`은 키를 argv나 터미널 에코에 노출하지 않습니다. POSIX에서는
설정 디렉터리를 `0700`, 파일을 `0600`으로 만들고 기존의 안전하지 않은 권한도
수정합니다. Windows에서는 사용자 프로필의 ACL을 따르며 POSIX `chmod`를
가정하지 않습니다.

### 3. 서비스 승인 확인

KRX Open API는 카테고리별로 별도 승인이 필요합니다.

```bash
krx auth status
```

```json
{
  "api_key_set": true,
  "services": {
    "index": {
      "state": "approved",
      "approved": true,
      "fresh": true,
      "checkedAt": "2026-08-04T01:00:00.000Z",
      "validUntil": "2026-08-04T01:15:00.000Z"
    },
    "esg": {
      "state": "inconclusive",
      "fresh": true,
      "checkedAt": "2026-08-04T01:00:00.000Z",
      "validUntil": "2026-08-04T01:15:00.000Z",
      "failureType": "authentication",
      "error": "KRX returned an ambiguous authentication response"
    }
  }
}
```

`approved`는 `state`가 `approved` 또는 `rejected`일 때만 포함됩니다. 네트워크,
시간 초과, 모호한 인증 응답은 `inconclusive`이며 서비스 거절로 간주하지 않습니다.
승인 검사는 일반 데이터 캐시를 우회하고, 동일 자격 증명에 대해 15분 동안 결과를
신선한 관측값으로 표시합니다. `auth status`와 `auth check` 실행 자체는 항상 KRX를
다시 확인합니다.

## 사용법

### 지수 조회

```bash
krx index list --date 20260310 --market kospi
krx index list --date 20260310 --market kosdaq
```

### 주식 조회

```bash
krx stock list --date 20260310 --market kospi
krx stock list --date 20260310 --market kosdaq
krx stock info --market kospi
krx stock search 삼성전자     # 종목 검색
```

### 시장 요약

```bash
krx market summary                    # 최근 거래일 시장 요약
krx market summary --date 20260310    # 특정 날짜
```

### 기간 조회

```bash
krx index list --market kospi --from 20260301 --to 20260310
krx stock list --market kospi --from 20260301 --to 20260305 --code KR7005930003
```

### 정렬 및 제한

```bash
krx stock list --date 20260310 --market kospi --sort FLUC_RT --limit 10
krx stock list --date 20260310 --market kospi --sort ACC_TRDVAL --asc --limit 5
```

### 워치리스트

```bash
krx watchlist add 삼성전자          # 종목 검색 후 워치리스트 추가
krx watchlist remove 삼성전자       # 정확한 이름으로 제거
krx watchlist remove KR7005930003   # 종목코드로 제거
krx watchlist list                   # 워치리스트 조회
krx watchlist show                   # 워치리스트 종목 시세 조회
krx watchlist show --date 20260310  # 특정 날짜 시세
```

### 캐시 관리

```bash
krx cache status    # 캐시 현황 조회
krx cache clear     # 캐시 전체 삭제
krx stock list --market kospi --date 20260310 --refresh  # 해당 항목만 갱신
```

과거 응답은 기본 7일 동안 유효하며 `KRX_CACHE_MAX_AGE_HOURS`로 조정할 수
있습니다. `--refresh`는 일치하는 날짜/엔드포인트만 다시 받아 원자적으로 교체하고,
`--no-cache`는 읽기와 쓰기를 모두 건너뜁니다. 버전, 손상 격리, 동시 쓰기 계약은
[캐시 수명주기 문서](docs/CACHE.md)를 참고하세요.

### 요청 안정성 및 승인 확인

캐시되지 않은 KRX 요청은 시도당 15초, 전체 45초로 제한됩니다. 네트워크
오류, 타임아웃 및 HTTP 408/429/500/502/503/504만 재시도하며 `Retry-After`와
지터가 포함된 지수 백오프를 적용합니다. 각 실제 HTTP 시도는 KST 날짜와 API
키별 로컬 카운터에 원자적으로 먼저 예약됩니다. 이 카운터는 보조 지표이며
KRX 서버의 한도가 최종 기준입니다. 자세한 계약은
[요청 안정성 문서](docs/HTTP-RELIABILITY.md)를 참고하세요.

`krx auth status`와 `krx auth check`는 데이터 캐시를 사용하지 않습니다. 승인
결과는 현재 API 키에만 연결되고 15분 후 오래된 상태로 표시됩니다. 네트워크
오류, 타임아웃, 빈 응답 및 판별할 수 없는 HTTP 401은 승인 거절이 아니라
`inconclusive`로 보고됩니다.

HTTP 401은 잘못된 키와 미승인 카테고리를 안정적으로 구분하지 못하므로 exit code
`4`는 인증 형태의 모호한 접근 실패를 뜻합니다. 명시적인 HTTP 403만 서비스
미승인으로 분류해 exit code `6`을 사용합니다.

### 복합 결과 완전성

기간 조회, 종목 검색, 시장 요약, 워치리스트 시세는 여러 KRX 요청을 결합하므로
항상 JSON envelope로 `data`와 `completeness`를 함께 반환합니다.
`completeness.state`는 `complete`, `partial`, `empty`, `failed` 중 하나이며,
`requested`, `succeeded`, `failed`, `skipped` 파티션으로 누락 원인을 기계적으로
확인할 수 있습니다. 시장 요약에서 실패한 입력은 빈 배열이나 파생된 0이 아니라
`null`로 표시됩니다.

부분 성공은 데이터를 출력하면서 stderr에 경고하고 exit code `7`을 사용합니다.
정상적인 빈 결과는 `empty`와 exit code `3`으로 구분됩니다. MCP에서 결과가
잘리더라도 `_truncated`와 `completeness`가 같은 envelope에 유지됩니다. 자세한
계약과 호환성 범위는 [복합 결과 문서](docs/COMPOSITE-RESULTS.md)를 참고하세요.

### 버전 관리

```bash
krx version    # 현재 버전 확인 및 최신 버전 비교
krx update     # 최신 버전으로 업데이트
```

### ETF/ETN/ELW 조회

```bash
krx etp list --date 20260310 --type etf
krx etp list --date 20260310 --type etn
```

### 채권 조회

```bash
krx bond list --date 20260310 --market kts
krx bond list --date 20260310 --market general
krx bond list --date 20260310 --market small
```

### 파생상품 조회

```bash
krx derivative list --date 20260310 --type futures
krx derivative list --date 20260310 --type options
krx derivative list --date 20260310 --type futures-kospi
krx derivative list --date 20260310 --type futures-kosdaq
krx derivative list --date 20260310 --type options-kospi
krx derivative list --date 20260310 --type options-kosdaq
```

### 일반상품 조회

```bash
krx commodity list --date 20260310 --type gold
krx commodity list --date 20260310 --type oil
krx commodity list --date 20260310 --type emission
```

### ESG 조회

```bash
krx esg list --date 20260310 --type index
krx esg list --date 20260310 --type sri-bond
```

### 스키마 조회

```bash
krx schema --all
krx schema stock.stk_bydd_trd
```

## 루트 조회 옵션

이 옵션들은 루트에서 파싱되지만 명령별 적용 범위가 다릅니다. 행 필터와 파일 저장은
엔드포인트 행 조회에 적용되고, 복합 명령은 JSON 완전성 envelope를 유지합니다.
정확한 적용 범위는 [CLI 계약 문서](docs/CLI-CONTRACT.md)의 표를 참고하세요.

| 옵션                    | 설명                                            | 기본값                         |
| ----------------------- | ----------------------------------------------- | ------------------------------ |
| `-o, --output <format>` | 출력 형식: json, table, ndjson, csv             | json (파이프) / table (터미널) |
| `-f, --fields <fields>` | 출력 필드 필터 (쉼표 구분)                      | 전체                           |
| `--code <isuCd>`        | 종목코드 필터 (ISU_CD)                          | -                              |
| `--sort <field>`        | 결과 정렬 기준 필드                             | -                              |
| `--asc`                 | 오름차순 정렬 (기본: 내림차순)                  | -                              |
| `--offset <n>`          | 처음 N개 건너뛰기 (페이지네이션)                | -                              |
| `--limit <n>`           | 결과 개수 제한                                  | -                              |
| `--from <date>`         | 기간 조회 시작일 (YYYYMMDD)                     | -                              |
| `--to <date>`           | 기간 조회 종료일 (YYYYMMDD)                     | -                              |
| `--no-cache`            | 캐시 읽기와 쓰기를 모두 건너뜀                  | -                              |
| `--refresh`             | 일치하는 과거 캐시를 다시 받아 교체             | -                              |
| `--filter <expression>` | 필터 표현식 (예: "FLUC_RT > 5")                 | -                              |
| `--save <path>`         | 결과를 파일로 저장                              | -                              |
| `--retries <n>`         | 재시도 가능한 실패의 최대 재시도 횟수 (기본: 3) | -                              |
| `--dry-run`             | API 호출 없이 요청 내용 출력                    | -                              |
| `-v, --verbose`         | 상세 로그 (stderr)                              | -                              |

단일 엔드포인트 행 출력은 TTY에서는 `table`, 파이프 또는 리다이렉션에서는
`json`이 기본입니다. 기간 조회와 다른 복합 명령은 완전성 정보를 보존하기 위해
항상 JSON envelope를 반환합니다. 전체 사용자 계약은
[CLI 계약 문서](docs/CLI-CONTRACT.md)를 참고하세요.

## Exit Codes

| 코드 | 정확한 조건                                                        |
| ---: | ------------------------------------------------------------------ |
|    0 | 보고할 실패나 필수 결과 누락 없이 명령 완료                        |
|    1 | upstream, 네트워크, timeout, 취소, 잘못된 응답 또는 로컬 상태 오류 |
|    2 | 잘못되었거나 불완전한 인자/입력                                    |
|    3 | 요청한 시장 데이터 또는 로컬 대상이 없음                           |
|    4 | API 키가 없거나 KRX HTTP 401인 모호한 인증/승인 실패               |
|    5 | 로컬 quota admission 거절 또는 KRX HTTP 429                        |
|    6 | KRX HTTP 403으로 명시된 서비스 미승인                              |
|    7 | 일부 구성요소가 실패했지만 사용 가능한 데이터를 반환한 복합 결과   |

## AI 에이전트 연동

krx-cli는 AI 에이전트가 Bash tool로 직접 호출하도록 설계되었습니다. 연동은 2단계입니다:

1. **CLI 설치** — 실제 실행 가능한 `krx` 바이너리
2. **스킬 설치** — 에이전트에게 사용법을 알려주는 SKILL.md

### Step 1: CLI 설치

```bash
npm install -g krx-cli
# 또는
pnpm add -g krx-cli
# 또는
yarn global add krx-cli
```

### Step 2: 스킬 설치

[skills.sh](https://skills.sh)를 통해 SKILL.md를 에이전트에 등록합니다.

```bash
# 모든 에이전트에 글로벌 설치 (권장)
npx skills add kyo504/krx-cli -g

# 특정 에이전트만 지정
npx skills add kyo504/krx-cli -g -a claude-code
npx skills add kyo504/krx-cli -g -a cursor

# 프로젝트 단위 설치 (팀 공유 시)
npx skills add kyo504/krx-cli
```

### Step 3: API 키 설정

```bash
krx auth set
# 또는
export KRX_API_KEY=<your-api-key>
```

### 지원 에이전트

skills.sh는 40개 이상의 에이전트를 지원합니다:

| 에이전트       | 스킬 설치 경로              |
| -------------- | --------------------------- |
| Claude Code    | `~/.claude/skills/`         |
| Cursor         | `~/.cursor/skills/`         |
| GitHub Copilot | `~/.github-copilot/skills/` |
| Cline          | `~/.cline/skills/`          |
| Windsurf       | `~/.windsurf/skills/`       |
| 기타           | `~/.agents/skills/`         |

### 사용 예시

스킬 설치 후 에이전트에게 자연어로 요청합니다:

```
"오늘 코스피 지수 보여줘"
→ krx index list --date 20260310 --market kospi --fields IDX_NM,CLSPRC_IDX,FLUC_RT

"삼성전자 주가 알려줘"
→ krx stock list --date 20260310 --market kospi --fields ISU_NM,TDD_CLSPRC,FLUC_RT -o json

"금 시세 확인해줘"
→ krx commodity list --date 20260310 --type gold

"어떤 API가 승인되어 있어?"
→ krx auth status
```

### 스킬 관리

```bash
npx skills list -g          # 설치된 스킬 확인
npx skills check             # 업데이트 확인
npx skills update            # 업데이트
npx skills remove krx-cli    # 제거
```

### 수동 연동 (skills.sh 없이)

SKILL.md를 직접 에이전트 설정 디렉토리에 복사할 수도 있습니다:

```bash
# Claude Code
mkdir -p ~/.claude/skills && cp SKILL.md ~/.claude/skills/krx-cli.md

# Cursor
mkdir -p ~/.cursor/skills && cp SKILL.md ~/.cursor/skills/krx-cli.md
```

## MCP 서버

CLI 외에 MCP(Model Context Protocol) 서버도 제공합니다. 두 가지 전송 방식을 지원합니다:

| 전송 방식       | 바이너리    | 지원 클라이언트                            |
| --------------- | ----------- | ------------------------------------------ |
| stdio           | `krx-mcp`   | Claude Desktop                             |
| Streamable HTTP | `krx serve` | Bearer 헤더를 지원하는 원격 MCP 클라이언트 |

KRX API 키는 `krx auth set`으로 등록한 것이 자동으로 사용되며,
`KRX_API_KEY`가 있으면 환경변수가 우선합니다.
`krx-mcp`는 `npm install -g krx-cli`로 설치하면 함께 설치됩니다.

### Claude Desktop (stdio)

설정 파일 위치:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "krx": {
      "command": "krx-mcp"
    }
  }
}
```

설정 후 앱을 재시작하면 MCP 도구가 활성화됩니다.
stdio 전송은 네트워크 포트를 열지 않고 로컬 클라이언트가 자식 프로세스를 직접
실행하므로 별도 Bearer 토큰이 없습니다. 로컬 OS 계정과 설정 파일 접근 권한이
보안 경계입니다.

### Streamable HTTP

HTTP 전송은 로컬 바인딩도 포함해 모든 `/mcp` 요청에 Bearer 인증을 요구합니다.
32자 이상의 고엔트로피 단일 사용자 토큰을 환경변수로 설정하고, 클라이언트가
`Authorization: Bearer <token>` 헤더를 전송하도록 구성하세요.

```bash
# 기본 루프백 서버
export KRX_MCP_TOKEN="$(openssl rand -hex 32)"
krx serve --port 3000

# 비루프백 바인딩에는 DNS rebinding 방지용 Host 허용 목록도 필수
export KRX_MCP_ALLOWED_HOSTS="mcp.example.com"
krx serve --host 0.0.0.0 --port 3000
```

HTTP 전송은 네트워크 서비스입니다. 공개 배포는 TLS와 인증 헤더 전달을 지원하는
역방향 프록시 뒤에서만 사용하세요.
정적 토큰은 단일 사용자 전체 권한 자격 증명으로, 보유자는 관심종목 추가/삭제도
수행할 수 있습니다. 토큰을 공유하는 다중 사용자 운영은 지원하지 않으며 OAuth
또는 identity-aware proxy가 필요합니다. 기본 제한은 클라이언트당 분당 120개
요청과 활성 세션 10개, 전체 세션 100개, 세션 유휴 시간 30분입니다.

인증이 필요 없는 health check는 상태와 버전만 노출합니다:
`http://localhost:3000/health`.

### 제공 Tool

| Tool                 | 설명                                         |
| -------------------- | -------------------------------------------- |
| `krx_index`          | 지수 일별시세 (KOSPI/KOSDAQ/KRX/채권/파생)   |
| `krx_stock`          | 주식 일별매매정보 + 종목 기본정보            |
| `krx_etp`            | ETF/ETN/ELW 일별매매정보                     |
| `krx_bond`           | 채권 일별매매정보 (국채/일반/소액)           |
| `krx_derivative`     | 선물/옵션 일별매매정보                       |
| `krx_commodity`      | 금/석유/배출권 일별매매정보                  |
| `krx_esg`            | ESG 지수/채권/ETP 정보                       |
| `krx_search`         | 종목명 검색 (KOSPI + KOSDAQ)                 |
| `krx_market_summary` | 시장 요약 (지수/상승·하락/Top movers/거래량) |
| `krx_watchlist`      | 관심종목 관리 (추가/제거/조회/시세)          |
| `krx_schema`         | 엔드포인트 응답 필드 스키마 조회             |
| `krx_rate_limit`     | 일일 API 호출 현황 조회                      |

### 제공 Resource

MCP Resource로 읽기 전용 상태 데이터를 노출합니다.

| Resource               | 설명                               |
| ---------------------- | ---------------------------------- |
| `krx://watchlist`      | 워치리스트 종목 목록 (JSON)        |
| `krx://rate-limit`     | 일일 API 호출 현황 (JSON)          |
| `krx://service-status` | 카테고리별 서비스 승인 상태 (JSON) |

### 활용 가이드

AI 에이전트와 함께 할 수 있는 다양한 활용 사례는 [에이전트 활용 가이드](docs/AGENT-USE-CASES.md)를 참고하세요. 포트폴리오 모니터링, 시장 분석 리포트, 종목 스크리닝, 백테스트 등 11가지 구체적인 시나리오를 소개합니다.

### 사용 예시

MCP 클라이언트에서 자연어로 요청하면 됩니다:

```
"오늘 코스피 지수 보여줘"
→ krx_index tool 호출 (endpoint: "kospi_dd_trd")

"삼성전자 주가 알려줘"
→ krx_stock tool 호출 (endpoint: "stk_bydd_trd", fields: ["ISU_NM", "TDD_CLSPRC", "FLUC_RT"])

"오늘 API 몇 번 호출했어?"
→ krx_rate_limit tool 호출
```

## 개발

```bash
pnpm install
pnpm verify       # pull request와 release를 막는 결정적 CI gate

# 선택적 수동 agent 시나리오: build, claude CLI, 유료 인증 세션 필요
pnpm build
pnpm test:e2e
```

`test:e2e`는 모델 출력과 외부 서비스 상태에 의존하므로 일반 CI나 release gate에서
실행하지 않습니다. 테스트 계층은 [테스트 문서](docs/TESTING.md)를 참고하세요.

KRX upstream 계약 드리프트는 일반 테스트와 분리된 opt-in 검사로 확인합니다.
`pnpm contract:dry-run`은 네트워크나 일일 할당량을 사용하지 않고 정확한 호출
계획을 출력합니다. 자격 증명, 31회 상한, 공식 명세 비교 및 업데이트 절차는
[KRX 계약 테스트 문서](docs/KRX-CONTRACT-TESTING.md)를 참고하세요.

기본 날짜와 기간 조회는 KST 기준 [KRX 거래일 캘린더](docs/KRX-CALENDAR.md)를
사용하여 공휴일과 거래소 휴장일을 호출 전에 제외합니다. 캘린더 범위 밖의
명시적 과거 조회는 결과의 `calendar` 메타데이터에 fallback 상태를 표시합니다.

## 라이선스

MIT
