# Agent use cases

에이전트는 `krx` 명령을 Bash/프로세스 도구로 호출하거나 공개 Node.js SDK를
사용할 수 있습니다. 두 방식 모두 같은 Rust SDK를 사용합니다.

## 조회 후 분석

```bash
krx stock list --date 20260821 --market kospi --output json
krx stock list --from 20260801 --to 20260821 --code 005930
krx market summary --date 20260821
```

단일 날짜 조회의 JSON은 행 배열입니다. 기간 조회와 복합 결과는 envelope의
`completeness`를 확인한 뒤 분석합니다. `partial`이면 실패한 component를 명시하고,
`empty`를 0이나 성공 데이터로 해석하지 않습니다. 요청한 날짜와 실제 데이터 날짜도
구분해서 보고합니다.

## 종목 탐색과 watchlist

```bash
krx stock search 삼성전자
krx watchlist add 삼성전자
krx watchlist show --date 20260821
```

수정 명령은 사용자의 명시적 승인 범위에서만 실행합니다. 조회 요청은 읽기 전용
상태와 네트워크 호출로 제한하며, 자격 증명 설정·이전·삭제 또는 watchlist 변경을
추론해서 실행하지 않습니다.

## 안전한 운영

- 인증·승인 상태 진단에는 `krx auth status`를 사용하고 키 값 자체를 출력하지 않습니다.
  이 명령은 네트워크와 할당량을 사용하므로 오프라인 조회의 사전 단계로 실행하지
  않습니다. 카테고리별 대표 endpoint의 결과를 모든 endpoint의 승인으로 해석하지 않습니다.
- 캐시 현황은 `krx cache status`로 확인합니다. `cache inspect`의 현재 제약과
  대안은 [CLI 사용 참조](../skills/krx-cli/references/cli-usage.md#cache-and-offline)를 따릅니다.
- 네트워크를 금지해야 하면 `--offline`을 사용하고 cache miss를 명확히 보고합니다.
- 정확한 필드명은 `krx schema <operation>` 또는 `krx schema --all`에서 얻습니다.
- 오류는 stderr의 `<kind>/<code>`와 exit code로 분류합니다.

상세 명령은 패키지에 포함된 `skills/krx-cli/references/cli-usage.md`를 참고하세요.
