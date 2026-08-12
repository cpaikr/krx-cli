# KRX CLI usage reference

Read this reference only for CLI queries, analysis, setup, authentication-status
checks, cache operations, schema lookup, or MCP operation.

## Contents

- [Operating contract](#operating-contract)
- [Setup](#setup)
- [Commands](#commands)
- [Root query flags](#root-query-flags)
- [Exit codes](#exit-codes)
- [Handling large results](#handling-large-results)
- [Common patterns](#common-patterns)
- [Response fields](#response-fields)
- [MCP resources](#mcp-resources)

## Operating contract

- Use the `krx` CLI for KRX market data instead of substituting web results.
- Format dates as `YYYYMMDD`, for example `20260310`.
- Treat KRX data as non-real-time and check the official catalog for each
  service's available date range.
- Expect single-endpoint output to default to table on a TTY and JSON when
  redirected. Composite commands always return JSON envelopes.
- Check `completeness.state` before analyzing a composite result.
- Treat KRX row values as strings, including numeric-looking values. Envelope
  metadata retains JSON types.
- Respect the 10,000-request daily limit. The local per-credential KST counter
  is advisory; KRX remains authoritative.
- Allow a 15-second attempt timeout and a 45-second overall deadline for
  uncached requests.
- Expect historical cache entries to expire after seven days unless
  `KRX_CACHE_MAX_AGE_HOURS` overrides the age.
- Do not apply for service access merely because a query reports missing
  approval. Return to the entry skill and require an explicit application
  request before using the service-access workflow.

## Setup

```bash
# From the repository root, register this local checkout
pnpm install
pnpm build
pnpm add --global .

# Set API key (official steps: https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp)
krx auth set                       # Hidden interactive input
# or: printf '%s' "$KRX_API_KEY" | krx auth set --stdin

# Check which services are approved
krx auth status
```

Review the official service catalog before requesting category access:
https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd

## Commands

### Authentication

```bash
krx auth set                 # Save API key via hidden prompt
krx auth set --stdin         # Save API key from stdin for automation
krx auth remove              # Remove the persisted key
krx auth status               # Check all service approvals (JSON)
krx auth check <category>     # Check specific category: index, stock, etp, bond, derivative, commodity, esg
```

### Index (지수)

```bash
krx index list --date 20260310 --market kospi     # KOSPI index
krx index list --date 20260310 --market kosdaq     # KOSDAQ index
krx index list --date 20260310 --market krx        # KRX index
krx index list --date 20260310 --market bond       # Bond index
krx index list --date 20260310 --market derivative # Derivative index
```

### Stock (주식)

```bash
krx stock list --date 20260310 --market kospi   # KOSPI stocks
krx stock list --date 20260310 --market kosdaq   # KOSDAQ stocks
krx stock list --date 20260310 --market konex    # KONEX stocks
krx stock info --market kospi                     # Stock base info
```

### ETP (ETF/ETN/ELW)

```bash
krx etp list --date 20260310 --type etf   # ETF
krx etp list --date 20260310 --type etn   # ETN
krx etp list --date 20260310 --type elw   # ELW
```

### Bond (채권)

```bash
krx bond list --date 20260310 --market kts       # Government bonds
krx bond list --date 20260310 --market general    # General bonds
krx bond list --date 20260310 --market small      # Small bonds
```

### Derivative (파생상품)

```bash
krx derivative list --date 20260310 --type futures          # Futures
krx derivative list --date 20260310 --type options           # Options
krx derivative list --date 20260310 --type futures-kospi     # KOSPI stock futures
krx derivative list --date 20260310 --type futures-kosdaq    # KOSDAQ stock futures
krx derivative list --date 20260310 --type options-kospi     # KOSPI stock options
krx derivative list --date 20260310 --type options-kosdaq    # KOSDAQ stock options
```

### Commodity (일반상품)

```bash
krx commodity list --date 20260310 --type gold       # Gold
krx commodity list --date 20260310 --type oil         # Oil
krx commodity list --date 20260310 --type emission    # Emission trading
```

### ESG

```bash
krx esg list --date 20260310 --type index       # ESG index
krx esg list --date 20260310 --type etp          # ESG ETP
krx esg list --date 20260310 --type sri-bond     # SRI bonds
```

### Stock Search (종목 검색)

```bash
krx stock search 삼성전자     # Search by name (KOSPI + KOSDAQ)
krx stock search SK           # Partial match
```

### Market Summary (시장 요약)

```bash
krx market summary                    # Most recent verified-session overview
krx market summary --date 20260310    # Specific date
```

Returns: KOSPI/KOSDAQ indices, top 5 gainers/losers, advancing/declining/unchanged counts, total volume/value.

Date ranges, stock search, market summary, and watchlist prices return a JSON
envelope with `data` and `completeness`. Check `completeness.state` before using
the data: `partial` means one or more requested components failed, `empty`
means all required requests completed but the final query has no rows, and
`failed` is unusable. Never treat a `null` market-summary component as zero.

### Watchlist (관심종목)

```bash
krx watchlist add 삼성전자          # Search and add to watchlist
krx watchlist remove 삼성전자       # Remove by exact name
krx watchlist remove KR7005930003   # Remove by ISU_CD
krx watchlist list                   # List all watchlist entries
krx watchlist show                   # Show prices for watchlist stocks
krx watchlist show --date 20260310  # Specific date
```

### Cache Management

```bash
krx cache status    # Show cache size, files, dates
krx cache clear     # Clear all cached data
krx stock list --market kospi --date 20260310 --refresh # Replace one matching entry
```

### MCP transports

`krx-mcp` uses local stdio: it opens no network listener and relies on the local
OS account and client configuration as its security boundary. `krx serve` is a
network service and requires the controls below.

```bash
export KRX_MCP_TOKEN="$(openssl rand -hex 32)"
krx serve                        # Authenticated http://127.0.0.1:3000/mcp
krx serve --port 8080            # Custom port

# Non-loopback additionally requires an explicit DNS Host allowlist.
export KRX_MCP_ALLOWED_HOSTS="mcp.example.com"
krx serve --host 0.0.0.0
```

Every `/mcp` request must send `Authorization: Bearer <KRX_MCP_TOKEN>`.
The static token is a single-user full-control credential, including watchlist
add/remove. Do not share it for multi-user hosting; use OAuth or an
identity-aware TLS proxy. Defaults: 120 requests/minute and 10 active sessions
per client, 100 sessions total, 30-minute idle expiry. `/health` is public and
contains no credential or session data.

### Schema (introspection)

```bash
krx schema --all              # All 31 endpoint schemas (JSON)
krx schema index.kospi_dd_trd # Specific endpoint schema
```

## Root Query Flags

These flags are parsed at the root, but each has a documented command scope.
Row pipeline and file flags apply to endpoint row queries; composite commands
retain their JSON completeness envelope. `--fields` also applies to stock
search, while cache flags additionally apply to market summary and watchlist
prices.

```
--output, -o <format>    json | table | ndjson | csv (TTY: table; redirected: JSON)
--fields, -f <fields>    Endpoint-row or stock-search fields
--code <isuCd>           Filter endpoint rows by stock code (ISU_CD)
--sort <field>           Sort endpoint rows by field name
--asc                    Sort ascending (default: descending)
--offset <n>             Skip first N results (for pagination)
--limit <n>              Limit number of results
--from <date>            Start date for range query (YYYYMMDD)
--to <date>              End date for range query (YYYYMMDD)
--no-cache               Bypass cache reads and writes
--refresh                Bypass and replace matching historical cache entries
--filter <expression>    Filter results (e.g. "FLUC_RT > 5", "MKT_NM == KOSPI")
--dry-run                Show request details without calling API
--save <path>            Save output to file instead of stdout
--retries <n>            Direct endpoint retry limit (default: 3)
--verbose, -v            Verbose logging to stderr
```

## Exit Codes

```
0 = No reportable failure or required-result miss
1 = Upstream/network/timeout/cancellation/invalid-response/local-state failure
2 = Invalid or incomplete arguments/input
3 = Requested market data or local target was absent
4 = Missing API key or ambiguous KRX HTTP 401 credential/approval failure
5 = Local quota admission rejection or KRX HTTP 429
6 = Explicit KRX HTTP 403 service-approval rejection
7 = Usable composite data with one or more failed components
```

KRX HTTP 401 does not reliably distinguish an invalid key from missing service
approval. Treat it as ambiguous; only HTTP 403 proves the approval rejection.

## Handling Large Results

Full market listings (e.g., all KOSPI stocks) output 900+ rows with 15+ fields each. This can exceed context limits. Always narrow results using these strategies:

### Strategy 1: Select only needed fields (preferred)

```bash
# Instead of all fields, select only what's needed
krx stock list --date 20260310 --market kospi --fields ISU_NM,TDD_CLSPRC,FLUC_RT
```

### Strategy 2: Paginate with offset + limit

```bash
# Page 1: first 100 rows
krx stock list --date 20260310 --market kospi --limit 100

# Page 2: next 100 rows
krx stock list --date 20260310 --market kospi --offset 100 --limit 100

# Page 3: next 100 rows
krx stock list --date 20260310 --market kospi --offset 200 --limit 100
```

### Strategy 3: Filter to relevant subset

```bash
# Only stocks with >5% change
krx stock list --date 20260310 --market kospi --filter "FLUC_RT > 5"
```

IMPORTANT: When the user asks for "all" data, prefer Strategy 1 (fields) first. If still too large, combine with Strategy 2 (pagination). Always tell the user the total count.

## Common Patterns

### Get KOSPI closing price for a specific date

```bash
krx index list --date 20260310 --market kospi --fields IDX_NM,CLSPRC_IDX,FLUC_RT
```

### Get Samsung Electronics stock price (by search)

```bash
krx stock search 삼성전자     # Find ISU_CD first
krx stock list --date 20260310 --market kospi --code KR7005930003
```

### Top 5 gainers

```bash
krx stock list --date 20260310 --market kospi --sort FLUC_RT --limit 5 --fields ISU_NM,TDD_CLSPRC,FLUC_RT
```

### Date range query (multi-day)

```bash
krx index list --market kospi --from 20260301 --to 20260310 --fields IDX_NM,BAS_DD,CLSPRC_IDX
```

### Quick market overview

```bash
krx market summary --date 20260310
```

### Track and monitor stocks

```bash
krx watchlist add 삼성전자           # Add to watchlist
krx watchlist show --date 20260310  # View prices for all watchlist stocks
```

### Check API availability before querying

```bash
krx auth status -o json
```

### Dry run to verify request

```bash
krx stock list --date 20260310 --market kospi --dry-run
```

## Response Fields

Use `krx schema <command>` to get full field definitions for any endpoint. All values are strings.

### Index (kospi/kosdaq/krx)

| Field         | Description         |
| ------------- | ------------------- |
| BAS_DD        | 기준일자 (YYYYMMDD) |
| IDX_CLSS      | 계열구분            |
| IDX_NM        | 지수명              |
| CLSPRC_IDX    | 종가                |
| CMPPREVDD_IDX | 전일대비            |
| FLUC_RT       | 등락률(%)           |
| OPNPRC_IDX    | 시가                |
| HGPRC_IDX     | 고가                |
| LWPRC_IDX     | 저가                |
| ACC_TRDVOL    | 거래량              |
| ACC_TRDVAL    | 거래대금            |
| MKTCAP        | 상장시가총액        |

### Stock (kospi/kosdaq/konex)

| Field         | Description         |
| ------------- | ------------------- |
| BAS_DD        | 기준일자 (YYYYMMDD) |
| ISU_CD        | 종목코드            |
| ISU_NM        | 종목명              |
| MKT_NM        | 시장구분            |
| SECT_TP_NM    | 소속부              |
| TDD_CLSPRC    | 종가                |
| CMPPREVDD_PRC | 전일대비            |
| FLUC_RT       | 등락률(%)           |
| TDD_OPNPRC    | 시가                |
| TDD_HGPRC     | 고가                |
| TDD_LWPRC     | 저가                |
| ACC_TRDVOL    | 거래량              |
| ACC_TRDVAL    | 거래대금            |
| MKTCAP        | 시가총액            |
| LIST_SHRS     | 상장주식수          |

### ETF

| Field          | Description     |
| -------------- | --------------- |
| ISU_CD         | 종목코드        |
| ISU_NM         | 종목명          |
| TDD_CLSPRC     | 종가            |
| FLUC_RT        | 등락률(%)       |
| NAV            | 순자산가치(NAV) |
| ACC_TRDVOL     | 거래량          |
| MKTCAP         | 시가총액        |
| IDX_IND_NM     | 기초지수명      |
| OBJ_STKPRC_IDX | 기초지수종가    |

### Futures

| Field          | Description    |
| -------------- | -------------- |
| PROD_NM        | 상품명         |
| ISU_NM         | 종목명         |
| TDD_CLSPRC     | 종가           |
| SPOT_PRC       | 현물가         |
| SETL_PRC       | 정산가         |
| ACC_OPNINT_QTY | 미결제약정수량 |

### Options

| Field          | Description      |
| -------------- | ---------------- |
| PROD_NM        | 상품명           |
| RGHT_TP_NM     | 권리유형 (콜/풋) |
| ISU_NM         | 종목명           |
| TDD_CLSPRC     | 종가             |
| IMP_VOLT       | 내재변동성       |
| ACC_OPNINT_QTY | 미결제약정수량   |

### Bond

| Field      | Description |
| ---------- | ----------- |
| ISU_NM     | 종목명      |
| CLSPRC     | 종가        |
| CLSPRC_YD  | 종가수익률  |
| ACC_TRDVOL | 거래량      |
| ACC_TRDVAL | 거래대금    |

### Commodity (gold/emission)

| Field      | Description |
| ---------- | ----------- |
| ISU_NM     | 종목명      |
| TDD_CLSPRC | 종가        |
| FLUC_RT    | 등락률(%)   |
| ACC_TRDVOL | 거래량      |

### Commodity (oil)

| Field      | Description  |
| ---------- | ------------ |
| OIL_NM     | 유종명       |
| WT_AVG_PRC | 가중평균가격 |
| ACC_TRDVOL | 거래량       |

### ESG Index

| Field       | Description |
| ----------- | ----------- |
| IDX_NM      | 지수명      |
| CLSPRC_IDX  | 종가        |
| PRV_DD_CMPR | 전일대비    |
| UPDN_RATE   | 등락률(%)   |

### Schema Introspection

For full response field definitions including all fields per endpoint:

```bash
krx schema index.kospi_dd_trd    # Shows params + responseFields
krx schema stock.stk_bydd_trd   # Stock endpoint fields
krx schema --all                  # All 31 endpoints
```

## MCP Resources

Read-only state data exposed as MCP Resources (for MCP clients):

| Resource               | Description                         |
| ---------------------- | ----------------------------------- |
| `krx://watchlist`      | Watchlist entries (JSON)            |
| `krx://rate-limit`     | Daily API call status (JSON)        |
| `krx://service-status` | Per-category approval status (JSON) |
