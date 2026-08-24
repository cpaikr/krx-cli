# Agent use cases

에이전트는 `krx` 명령을 Bash/프로세스 도구로 호출하거나 공개 Node.js SDK를
사용할 수 있습니다. 두 방식 모두 같은 Rust SDK를 사용합니다.

## 조회 후 분석

```bash
krx stock list --date 20260821 --market kospi --output json
krx stock list --from 20260801 --to 20260821 --code 005930
krx market summary --date 20260821
```

에이전트는 JSON을 파싱하고, `completeness`가 `complete`인지 확인한 뒤 분석해야
합니다. `partial`이면 실패한 component를 명시하고, `empty`를 0이나 성공 데이터로
해석하지 않습니다.

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

- 먼저 `krx auth status`로 상태를 확인하고, 키 값 자체를 출력하지 않습니다.
- 반복 조회 전에는 `krx cache status`와 `krx cache inspect`를 사용합니다.
- 네트워크를 금지해야 하면 `--offline`을 사용하고 cache miss를 명확히 보고합니다.
- 정확한 필드명은 `krx schema <operation>` 또는 `krx schema --all`에서 얻습니다.
- 오류는 stderr의 `<kind>/<code>`와 exit code로 분류합니다.

상세 명령은 패키지에 포함된 `skills/krx-cli/references/cli-usage.md`를 참고하세요.
