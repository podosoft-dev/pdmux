# pdmux

개발에 쓰는 여러 대의 머신을 한 화면에서 본다. 호스트별 리소스 추세, 분할 터미널, 읽기 전용 커밋 그래프.

[English README](README.md)

![pdmux 대시보드. 왼쪽에 호스트 카드, 가운데에 터미널 둘, 오른쪽에 커밋 그래프](docs/media/dashboard.png)

각 호스트에는 작은 에이전트가 하나 뜨고, 이 에이전트가 서버로 **나가는** 연결을 연다. 그래서 노트북이든
사무실 구석의 서버든 클라우드 VM이든 똑같이 붙는다. 인바운드 포트를 열 필요도, VPN도, SSH 키를 뿌릴
일도 없다.

## 무엇을 볼 수 있나

- **호스트 카드** — CPU·메모리·디스크와 최근 추세, 그 호스트에서 도는 코딩 에이전트의 남은 사용량,
  그리고 그 호스트가 띄운 서비스로 바로 가는 링크.
- **터미널** — 탭 또는 2·4·9 분할로 플릿의 아무 호스트나 연다. 세션은 호스트의 멀티플렉서에 살아 있어서
  탭을 닫아도 돌던 작업은 그대로다.
- **커밋 그래프** — 브랜치·태그·미커밋 변경을 보고, 커밋을 클릭하면 그때 diff를 받는다. 읽기 전용이라
  수집기는 fetch·gc·checkout을 하지 않는다.
- **계정별 화면** — 분할 배치, 켜 둔 위젯, 기본 호스트가 계정에 저장된다. 다른 컴퓨터에서 열어도 같은
  화면이다.
- **팀 단위** — 조직·역할·초대·감사 로그. 인증 기반은 [PodoKit](https://github.com/podosoft-dev/podokit).

## 동작 방식

```
브라우저 ──── HTTPS / WebSocket ────▶ pdmux ◀──── WebSocket (아웃바운드) ──── 에이전트 (호스트마다 1개)
                                       │
                                       ├─ PostgreSQL   호스트·서비스·레이아웃·지표·커밋 메타
                                       ├─ Redis        세션·pub/sub·레이트리밋·작업 큐
                                       └─ S3 / MinIO   커밋 패치
```

에이전트는 정적 Go 바이너리 하나다. 아웃바운드 웹소켓 하나를 열고 그 위에서 전부 처리한다. 하트비트,
PTY, git 스냅샷, 서비스 프로브까지. 수집 주기·git 루트·프로브 대상 같은 설정은 서버가 갖고 있고 바뀌면
바로 내려보내므로, 설정을 고치려고 호스트에 다시 들어갈 일이 없다.

에이전트 자체를 새 버전으로 바꾸는 것도 대시보드에서 한다. 교체하기 전에 도는 에이전트가 새 바이너리를
직접 실행해 핸드셰이크까지 시켜 보고, 교체한 뒤에도 일정 시간 안에 접속하지 못하면 옛 바이너리로
되돌린다. 이렇게 만든 이유는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2-1에 있다.

## 띄우기

의존 서비스와 두 앱을 올린다.

```bash
npm install
cp .env.example .env
docker compose --env-file .env \
  -f infra/docker/docker-compose.yml -f infra/docker/minio.compose.yml -p pdmux \
  up -d postgres redis minio minio-init
npx @better-auth/cli migrate -y --config apps/api/src/auth/auth.ts
npm run migration:run -w pdmux-api
npm run dev
```

web `5001`, api `5002`, Postgres `5440`, Redis `6390`, MinIO `9010`(콘솔 `9011`). 포트가 겹치면
`.env`에서 바꾼다.

UI에서 호스트를 추가하면 등록 코드가 박힌 설치 명령이 그대로 나온다.

```bash
curl -fsSL https://<pdmux 주소>/install.sh | sh -s -- --code pdmxe_XXXXX-XXXXX-XXXXX-XXXXX
```

대상 머신에 미리 깔아 둘 것은 없다. 런타임도 컴파일러도 필요 없다. 코드는 1회용이고 15분 뒤 만료된다.
장기 토큰은 바이너리 안에서 교환해 0600 파일로 바로 쓰기 때문에 셸 히스토리에 남지 않는다. `--user`를
붙이면 root 없이 per-user 서비스로 깔린다. 외부망이 막힌 머신은 토큰을 발급해 설치한다
([docs/OPERATIONS.md](docs/OPERATIONS.md) §2-4).

운영 배포(컨테이너 구성, 게이트웨이, 보존 정책, 백업)는 [docs/OPERATIONS.md](docs/OPERATIONS.md) §1.

### 머신 없이 화면만 보고 싶을 때

`tools/demo-agent.mjs`가 에이전트 쪽 프로토콜을 대신 말해 준다. 호스트가 하나도 없어도 대시보드를 채울 수
있다. UI에서 호스트를 만들고 상세 화면에서 토큰을 발급한 뒤,

```bash
node tools/demo-agent.mjs --server http://localhost:5001 --token pdmux_… --profile build
node tools/demo-agent.mjs --list-profiles     # build · db · laptop
```

위 스크린샷도 이렇게 찍었다. 편의를 위한 도구이지 테스트 더블은 아니다. 두 구현을 같은 계약에 묶는 것은
`packages/protocol/conformance`다.

## 저장소 구조

| | |
|---|---|
| `apps/api` | NestJS + TypeORM(PostgreSQL). 호스트 레지스트리, 에이전트 게이트웨이, 지표 보존, git 저장, 개인화 |
| `apps/web` | SvelteKit + Tailwind v4 + shadcn-svelte. 대시보드와 관리자 화면 |
| `agent` | 호스트에서 도는 Go 데몬. PTY·리소스·세션·서비스 프로브·읽기 전용 git. npm 워크스페이스가 아니다 |
| `packages/protocol` | 에이전트↔서버 계약(zod). 앱은 이 파일을 직접 쓰고, 에이전트는 여기서 생성한 JSON Schema를 embed한다 |
| `packages/core` | 프레임워크 없는 로직. 터미널 그리드 상태, 게이지, 스파크라인, 커밋 레인 배치 |
| `packages/ui` | Svelte 5 컴포넌트. 따로 배포할 수 있다 |

`@pdmux/ui`와 `@pdmux/core`는 이 앱 밖에서도 쓸 수 있게 만들었다. 데이터는 props로 들어가고 동작은
콜백으로 나오며 문구는 쓰는 쪽이 주입한다. 계약은 [docs/COMPONENTS.md](docs/COMPONENTS.md).

## 개발

```bash
npm run lint                # 두 앱과 패키지 타입 체크
npm test                    # 워크스페이스 단위 테스트
cd agent && go test ./...   # 에이전트는 Go 모듈이라 npm test에 안 들어간다
npm run test:e2e            # Playwright. 스택이 떠 있어야 한다
```

UI 테스트는 DOM만 보지 않고 **기하**를 잰다. 목록이 실제로 스크롤 컨테이너인지, 클릭한 패널이 뷰포트
안에 있는지, 페이지 자체는 안 밀리는지. "클릭해도 아무 일도 안 난다"는 같은 버그를 세 번 고치는 동안
DOM 질의는 매번 "내용은 있다"고 답했기 때문이다([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §7).

에이전트 바이너리 빌드는 Go 툴체인이 필요하고 `npm run build`에는 들어 있지 않다.

```bash
npm run build:agent         # linux·darwin × amd64·arm64, SHA256SUMS와 manifest.json까지
```

## 문서

문서는 영어로 쓴다. 한국어로 병기하는 것은 이 README 하나다.

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 왜 pull이 아니라 push인지, 터미널을 동일 출처로 만든 이유, 읽기 전용 git을 구조로 강제하는 법, UI를 기하로 검증하는 이유 |
| [CONTRACTS.md](docs/CONTRACTS.md) | 에이전트↔서버 프로토콜. 봉투, 등록, 원격 업데이트, 그리고 추가만 허용하는 규칙 |
| [OPERATIONS.md](docs/OPERATIONS.md) | 배포, 에이전트 온보딩, 보존, 백업과 복구, 증상별 대처표 |
| [AGENT_GO.md](docs/AGENT_GO.md) | 에이전트 구조, 생성물과 손으로 쓴 것의 구분, `go generate` 절차 |
| [VERSIONING.md](docs/VERSIONING.md) | 두 개의 SemVer가 따로 움직이는 이유, `PROTOCOL_VERSION`, 이를 지키는 CI 검사 |
| [COMPONENTS.md](docs/COMPONENTS.md) | `@pdmux/ui`의 props와 이벤트, 스타일 경계가 어디인지 |
| [USAGE-COLLECTION.md](docs/USAGE-COLLECTION.md) | CLI를 실행하지 않고 코딩 에이전트 사용량을 읽는 법, 형식이 바뀌었을 때 다시 찾는 절차 |
| [IME_INPUT.md](docs/IME_INPUT.md) | 모바일 조합 입력(한글·일본어·중국어)과 지원하지 않는 범위 |

이 저장소에서 코드를 쓸 때의 규칙은 [AGENTS.md](AGENTS.md)에 있다. 사람과 코딩 에이전트 모두 대상이다.

## 라이선스

Apache-2.0. [LICENSE](LICENSE) 참고.
