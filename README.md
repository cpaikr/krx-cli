# krx-cli

KRX(한국거래소) Open API를 위한 네이티브 CLI와 Node.js SDK입니다. 모든 KRX
동작과 로컬 정책은 공유 Rust SDK가 담당하며, CLI와 Node SDK는 같은 결과,
오류, 캐시, 할당량, 자격 증명 정책을 사용합니다.

## 설치

배포 경로는 비공개 GitHub Release 자산입니다. 첫 릴리스 게시와 검증 상태는
[릴리스 진행 기록](plans/release-delivery.md)을 참고하세요. 게시된 릴리스는
저장소 접근 권한으로 운영체제에 맞는 tarball과 `SHA256SUMS`를 내려받아
체크섬을 확인한 뒤 설치합니다. [다운로드 및 설치 절차](docs/RELEASING.md#install-and-upgrade)를
따르세요. 설치 과정에서 소스 빌드나 lifecycle script를 실행하지 않습니다.

```bash
pnpm add --global --ignore-scripts "./krx-cli-<version>-<target>.tgz"
krx --version
krx --help
```

`<version>`과 `<target>`을 선택한 릴리스와 대상 이름으로 바꾸세요.
지원 대상은 macOS ARM64, Linux GNU x64/ARM64, Windows x64입니다. 릴리스는
모든 대상과 Node 22/24를 인증하며, 일상적인 CI는 비용 절감을 위해 Linux로 제한합니다.

## 자격 증명

[KRX Open API](https://openapi.krx.co.kr)에서 키를 발급하고 필요한 서비스를
승인받으세요. 키는 명령행 인자로 받지 않습니다.

```bash
printf '%s\n' "$KRX_API_KEY" | krx auth set --stdin
krx auth status
krx auth check stock
```

명시적 SDK 키, `KRX_API_KEY`, 운영체제 keychain 순으로 해석합니다. 이전
평문 설정은 `krx auth migrate`로 한 번만 명시적으로 이전합니다.

## CLI 예시

```bash
krx stock list --date 20260821 --market kospi --output json
krx stock list --from 20260801 --to 20260821 --code 005930
krx stock search 삼성전자
krx market summary --date 20260821
krx cache inspect --limit 20
krx schema --all
```

전체 명령과 옵션은 `krx --help` 및 하위 명령의 `--help`가 권위입니다. 출력과
exit code 계약은 [docs/CLI-CONTRACT.md](docs/CLI-CONTRACT.md)를 참고하세요.

## Node.js SDK

동일한 target tarball을 프로젝트 의존성으로 설치하면 ESM 루트에서 공개 SDK를
가져올 수 있습니다. 네이티브 binding은 공개 subpath가 아닙니다.

```js
import { KrxClient, KrxError } from "krx-cli";

const client = new KrxClient();
try {
  const result = await client.query({
    operation: "stock_stk_bydd_trd",
    date: "20260821",
  });
  console.log(result.data);
} catch (error) {
  if (error instanceof KrxError) console.error(error.kind, error.code);
  else throw error;
}
```

타입 계약은 `contracts/product/v1/node-sdk.d.ts`, Rust 공개 계약은
`contracts/product/v1/rust-sdk-consumer.rs`에 고정되어 있습니다.

## Agent skill

저장소의 중첩 skill 전체를 설치합니다.

```bash
npx skills add cpaikr/krx-cli
# 또는 저장소 checkout에서
cp -R skills/krx-cli ~/.agents/skills/
```

이전 단일 파일을 사용했다면 충돌 방지를 위해 `krx-cli.md.legacy`로 이름을
바꾼 뒤 `skills/krx-cli/` 디렉터리를 설치하세요. 네이티브 tarball에도 같은
skill 디렉터리가 포함됩니다.

## 유지보수

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
pnpm contract:dry-run
```

구조와 불변식은 [ARCHITECTURE.md](ARCHITECTURE.md), 검증 경계는
[docs/TESTING.md](docs/TESTING.md)에 정리되어 있습니다. 버전 준비, 전체 대상
인증, 게시 및 실패 복구 절차는 [docs/RELEASING.md](docs/RELEASING.md)를 따릅니다.
