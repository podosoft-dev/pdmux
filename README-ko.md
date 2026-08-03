# pdmux

*[English README](README.md)*

**여러 개발 머신을 한 화면에서 운영하는 셀프호스트 대시보드.**
호스트 카드(리소스 추세·에이전트 토큰 잔량·서비스 바로가기), 여러 터미널의 분할 화면, 읽기전용 커밋 그래프를
한 페이지에 모았다. 로그인한 사용자마다 자기 화면을 갖고, 어느 환경의 머신이든 **아웃바운드 연결만으로**
참여한다.

```
┌── hosts ────────────┬──────────── terminals ────────────┬── git ──┐
│ ● build-01     ⚙   │  #1 build-01 · main   #2 db-02 …  │ ● main  │
│   claude 3 ███░ 82% │  ┌──────────────┬──────────────┐  │ │ feat… │
│   cpu 13% ╱╲__      │  │              │              │  │ ├─╯     │
│   [● api      ▾][열기]│  └──────────────┴──────────────┘  │ …      │
└─────────────────────┴───────────────────────────────────┴─────────┘
```

- **어디서나** — 에이전트가 서버로 나가는 구조라 인바운드 포트·VPN·SSH 키 배포가 필요 없다.
- **사용자별** — 분할 배치·표시 위젯·기본 호스트가 계정에 저장돼 다른 기기에서도 그대로 열린다.
- **팀으로** — 조직·역할·초대·감사로그·관리자 설정(인증 기반은 [PodoKit](https://github.com/podosoft-dev/podokit)).
- **가져다 쓸 수 있게** — 대시보드 UI 는 `@pdmux/ui`, 로직은 `@pdmux/core` 로 분리돼 외부 프로젝트에서도 쓴다.

## 구성

| 워크스페이스 | 내용 |
|---|---|
| `apps/api` | NestJS + TypeORM(PostgreSQL) — 호스트 레지스트리, 에이전트 게이트웨이, 메트릭 보존, git 저장, 개인화 |
| `apps/web` | SvelteKit + Tailwind v4 + shadcn-svelte — 대시보드와 관리자 화면 |
| `agent` | 호스트에 설치하는 Go 데몬(워크스페이스 아님) — PTY·리소스·세션·서비스 프로브·읽기전용 git 스냅샷. 정적 바이너리로 배포된다 |
| `packages/protocol` | 에이전트↔서버 계약(zod). API·웹이 직접 쓰고, Go 에이전트는 여기서 생성된 JSON Schema 를 파생해 읽는다 |
| `packages/core` | 프레임워크 없는 로직 — 터미널 그리드 상태, 게이지, 스파크라인, 커밋 레인 배치 |
| `packages/ui` | Svelte 5 컴포넌트 라이브러리 |

## 개발 환경

```bash
npm install
cp .env.example .env                     # 포트가 겹치면 여기서 바꾼다
docker compose --env-file .env \
  -f infra/docker/docker-compose.yml -f infra/docker/minio.compose.yml -p pdmux \
  up -d postgres redis minio minio-init
npx @better-auth/cli migrate -y --config apps/api/src/auth/auth.ts
npm run migration:run -w pdmux-api
npm run dev                              # api :5002 · web :5001
```

기본 포트: web `5001` · api `5002` · postgres `5440` · redis `6390` · minio `9010`(콘솔 `9011`).
컨테이너 게이트웨이(`podo dev`)는 `127.0.0.1:80` 을 쓰므로, 80 을 이미 쓰는 워크스테이션에서는 위처럼
**호스트 프로세스 모드**로 띄운다.

에이전트는 각 머신에서 **한 줄**이다. 대시보드에서 호스트를 만들면 등록코드가 붙은 이 명령이 그대로 나온다:

```bash
curl -fsSL https://<pdmux>/install.sh | sh -s -- --code pdmxe_XXXXX-XXXXX-XXXXX-XXXXX
```

대상 머신에 언어 런타임도 컴파일러도 필요 없다(정적 Go 바이너리 하나). 코드는 **1회용·15분**이고, 장기
토큰은 스크립트가 아니라 **바이너리 안에서** 교환돼 0600 설정 파일로만 들어간다. `--user` 면 root 없이
per-user 서비스로 깔린다. 에어갭 머신은 바이너리를 옮겨 `pdmux-agent install --server … --token …` 으로
설치한다 — 절차는 [`docs/OPERATIONS.md`](docs/OPERATIONS.md) §2-4.

에이전트를 새 빌드로 바꾸는 것도 **대시보드에서** 한다. 각 에이전트는 교체 전에 후보가 서버에 닿는지
확인하고, 교체 후에도 유예기간 안에 접속하지 못하면 스스로 되돌린다
([`docs/OPERATIONS.md`](docs/OPERATIONS.md) §2-3).

에이전트 릴리즈 바이너리를 직접 만들려면 Go 툴체인이 필요하다(루트 `npm run build` 에는 **포함되지 않는다**):

```bash
npm run build:agent          # linux·darwin × amd64·arm64 + SHA256SUMS + manifest.json
cd agent && go test ./...
```

## 테스트

```bash
npm test                    # 워크스페이스 단위 테스트
cd agent && go test ./...   # 에이전트 — npm 워크스페이스가 아니므로 npm test 에 포함되지 않는다
npm run test:e2e            # Playwright (스택이 떠 있어야 함)
```

UI 는 **보이는지**(스크롤 컨테이너·뷰포트 안·hit-test)를 검사한다 — DOM 에 있는 것과 화면에 보이는 것은
다르다는 걸 비싸게 배웠다. 배경은 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §7.

## 문서

⚠ **문서는 영어다.** 이 저장소는 공개돼 있고, 한국어를 읽지 않는 사람이 아키텍처와 계약 문서를 못 읽으면
기여할 수 없기 때문이다. 한국어로 병기하는 것은 이 README 하나다.

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 왜 push 인가, 터미널을 동일 출처로 만든 이유, 읽기전용 git, 컴포넌트 분리, 기하 검증 |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | 에이전트↔서버 프로토콜(추가만 허용), 등록·원격 업데이트 프레임 |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | 배포 형태, **에이전트 온보딩**, 보존·백업, 자주 보는 상태 |
| [`docs/AGENT_GO.md`](docs/AGENT_GO.md) | Go 에이전트의 레이아웃, 생성물 vs 손으로 쓴 것, `go generate` 절차 |
| [`docs/VERSIONING.md`](docs/VERSIONING.md) | 두 개의 SemVer, `PROTOCOL_VERSION`, manifest 를 정직하게 유지하는 CI 검사 |
| [`docs/COMPONENTS.md`](docs/COMPONENTS.md) | `@pdmux/ui` 컴포넌트 props/이벤트 계약 |
| [`docs/USAGE-COLLECTION.md`](docs/USAGE-COLLECTION.md) | 코딩 CLI 사용량 — 남의 형식에 기대는 유일한 수집기 |
| [`docs/IME_INPUT.md`](docs/IME_INPUT.md) | 조합 문자(한글·일본어·중국어) 입력 경로와 **한계** |
| [`AGENTS.md`](AGENTS.md) | 이 저장소에서 코드를 쓰는 규칙(사람·AI 공통) |

## 라이선스

Apache-2.0 — [`LICENSE`](LICENSE) 참고.
