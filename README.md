# Worktree Studio

티켓 하나당 git 워크트리 하나를 만들고, 그 안에서 로컬 Claude Code와 대화하며 개발하는 로컬 웹 도구입니다.
이 버전은 플랜 문서의 **Phase 3**까지 들어 있습니다.

## 문서

- `docs/plan.html` 개발 계획서 (범위, 아키텍처, 기능 명세, 데이터 모델, 로드맵, 리스크, 결정 사항)
- `docs/screens.html` 화면설계서 (화면 7개의 구성 요소, 동작 규칙, 구현 상태)

## 들어 있는 것

**Phase 1**
- 로컬에 클론한 폴더를 프로젝트로 등록 (git 저장소가 아니면 거부, BE/FE/통합 자동 감지 후 수정 가능)
- BE와 FE 프로젝트를 묶는 워크스페이스
- 새 세션: 기준 브랜치를 골라 프로젝트마다 워크트리와 새 브랜치 생성 (실패하면 만든 워크트리를 되돌림)
- 프롬프트 창: Claude Agent SDK로 워크트리에서 Claude Code 실행, 대화 스트리밍, 도구 실행 카드, 중단, 이어서 대화
- 이미지 첨부: 클립 버튼, 끌어다 놓기, 붙여넣기 (PNG/JPG/GIF/WEBP, 장당 5MB)
- 작업 완료 알림: OS 알림, 탭 제목 개수, 사이드바 "작업 완료 · 새 결과"

**Phase 2**
- 환경값 프로필: 프로젝트마다 여러 프로필(local, mock 등)을 두고 세션별로 고름
  - 처음 열면 워크트리를 정적으로 분석해 목록을 채움 (.env.example, application*.yml의 `${KEY}`, `process.env`, `import.meta.env`, `System.getenv`)
  - 원본 클론 폴더의 `.env`처럼 커밋되지 않아 워크트리에 없는 값을 가져옴
  - "AI로 분석": Claude에게 읽기 도구만 주고 필요한 변수와 필수 여부를 판단하게 함
  - 모든 행의 키, 값, 필수 여부를 고치거나 지우고, 직접 추가하거나 `.env`를 붙여넣을 수 있음
  - 저장 방식: 지금 프로필에 덮어쓰기 / 새 프로필로 저장 / 이번 세션에만 적용
- 서버 실행: 비어 있는 포트를 자동 배정(BE 8081~, FE 3401~)하고 실행 명령의 `{port}`와 포트 변수에 넣음. FE의 BE 주소 변수는 같은 세션 BE 포트로 자동 연결
- 필수 값이 비어 있으면 서버를 띄우지 않고 환경값 화면에서 빠진 키를 알려 줌
- 헬스체크로 실행 상태 표시, 예기치 않은 종료 시 알림
- FE 미리보기 (경로 이동, 새로고침, 새 창)
- 서버 로그: 프로젝트별 탭, WARN 이상 필터, 검색, 오류 줄을 앞뒤 맥락과 함께 프롬프트에 넣는 "Claude에게 보내기"
- 테스트 계정 풀: 세션 생성 시 자동 배정, 닫으면 반납, 비밀번호 보기·복사
- Claude에게 매 메시지마다 실행 중인 서버 주소와 배정 계정을 알려 줌
- gh CLI 로그인 상태 표시

**Phase 3**
- 푸시하고 PR 만들기 (상단 바)
  - 레포별로 바뀐 파일과 커밋을 모으고, Claude가 PR 템플릿(`.github/pull_request_template.md` 등) 형식대로 제목·본문·커밋 메시지를 씀. 보내기 전에 고칠 수 있음
  - 커밋 → PR 전 검사(프로젝트의 "PR 전 검사" 명령) → 푸시 → `gh pr create`. 모든 레포의 검사가 통과한 뒤에 푸시해서 한쪽만 PR이 올라가지 않음
  - 검사가 실패하면 멈추고, 출력 끝부분을 프롬프트로 넘길 수 있음
  - BE·FE PR은 본문 끝에 서로를 관련 PR로 연결. 환경값의 비밀값과 계정 비밀번호는 본문에서 가림
  - PR을 만들면 서버를 끔(설정), 상단 바에 PR 상태 표시, PR 닫기
- 영향받는 화면 체크리스트 (오른쪽 패널)
  - Claude가 바뀐 파일에서 라우터와 import를 따라 화면 경로를 찾음 (BE API가 바뀌면 그 API를 부르는 화면도). 직접 추가·삭제 가능
  - 경로를 누르면 미리보기에서 열리고, 직접 보고 확인 표시. 자동 촬영·비교는 하지 않음
  - 미리보기 "프롬프트에 전달": 지금 페이지를 찍어 프롬프트에 첨부하고 경로를 입력창에 넣음. 설정의 FE 로그인 경로가 있으면 배정 계정으로 로그인한 뒤 찍음. 첨부한 이미지는 ✏️로 펜·네모·화살표·글자를 표시할 수 있음
- 화면 테스트 (오른쪽 패널 "화면 테스트")
  - Claude가 바뀐 내용과 대화를 보고 이번 기능을 확인하는 테스트 케이스(역할, 시작 화면, 단계, 기대 결과)를 만듦. 고치기·삭제·직접 추가 가능
  - 케이스에 필요한 역할마다 쓸 계정을 사용자가 고름. 고르기 전에는 그 역할의 케이스를 실행하지 않음
  - 실행하면 Claude가 Playwright MCP로 Chrome을 열어 단계를 따라가며 화면을 찍고 통과·실패·확인 불가를 판정
  - 실패한 케이스는 마지막 화면과 판정 내용을 프롬프트에 넣을 수 있음
- 리소스 정리 (사이드바)
  - 세션별 PR 상태, 서버, 워크트리 용량·미커밋 여부, 계정, 상태(정리 대기 / 보호됨 / 머지 대기 / 작업 중)
  - 서버 종료 → 워크트리 삭제 → 로컬 브랜치 삭제 → (원격 브랜치 삭제) → 계정 반납 → 스크린샷 삭제 → 세션 보관
  - 미커밋 변경이 있는 워크트리는 자동으로 지우지 않음. 직접 고르면 확인 후 변경을 버리고 정리
  - 설정한 간격(기본 10분)으로 `gh pr view`로 PR 상태 확인, 머지·닫히면 알림(설정하면 확인 없이 정리), 오래 쉰 세션 알림
  - 시작할 때 `git worktree prune`, 닫힌 세션에 묶인 계정 반납

## 지원하는 프로젝트

프로젝트를 등록하면 폴더를 보고 실행·설치·검사 명령과 헬스체크를 채웁니다. 모두 설정에서 고칠 수 있습니다.

| 종류 | 알아보는 기준 | 실행 | 처음 설치 |
| --- | --- | --- | --- |
| Spring (Gradle/Maven) | `build.gradle`, `pom.xml` | `./gradlew bootRun` (포트는 `SERVER_PORT`) | 없음 |
| Node FE (Vite, Next, Nuxt 등) | `package.json` 의존성 | `npm run dev -- --port {port}` 등 | `npm ci` / `pnpm install` / `yarn install` |
| Python FastAPI·Starlette | `pyproject.toml`, `requirements.txt`, 코드의 `FastAPI(` | `uv run uvicorn 패키지.main:app --port {port}` | `uv sync` / `poetry install` / `pipenv install` / venv+pip |
| Python Django, Flask | `manage.py`, `Flask(` | `manage.py runserver`, `flask run` | 위와 같음 |

새 워크트리에는 `.venv`나 `node_modules`가 없어서, 워크트리마다 처음 실행할 때 설치 명령을 먼저 돌립니다.
Python은 `os.environ[...]`(필수), `os.environ.get`·`os.getenv`(선택)로 읽는 환경변수를 찾습니다.

## 준비물

- Node.js 20 이상
- git
- Claude Code 로그인: 터미널에서 `claude`를 실행해 `/login`을 한 번 해 두거나, `ANTHROPIC_API_KEY` 환경변수를 설정합니다.
  로그인이 안 되어 있으면 프롬프트를 보냈을 때 대화창에 "Not logged in" 메시지가 나옵니다.

## 실행

```bash
npm install

# 개발 모드: 서버(4317)와 화면(5317)을 함께 띄웁니다.
npm run dev
# 브라우저에서 http://localhost:5317

# 실행 모드: 화면을 빌드해 서버 하나로 띄웁니다.
npm run build
npm start
# 브라우저에서 http://localhost:4317
```

## 처음 쓰는 순서

1. 왼쪽 아래 **프로젝트와 설정**에서 클론 폴더 경로를 넣어 등록합니다. 예: `~/IdeaProjects/be-drms`
2. 프로젝트 표에서 실행 명령을 확인합니다. 포트를 인자로 받는 경우 `{port}`를 넣습니다. 예: `pnpm dev --port {port} --strictPort`.
   Spring Boot는 포트 변수 `SERVER_PORT`로 받으므로 `./gradlew bootRun` 그대로 둡니다. FE는 BE 주소 변수(예: `VITE_API_URL`)를 확인합니다.
3. 같은 화면에서 워크스페이스를 만들고, 필요하면 테스트 계정을 풀에 추가합니다.
4. **+ 새 세션**에서 티켓 번호와 기준 브랜치를 고르면 `../be-drms-424` 같은 워크트리가 만들어지고 계정이 배정됩니다.
5. 오른쪽 서버 패널에서 **환경값**을 눌러 값을 확인한 뒤 **저장하고 서버 실행**을 누릅니다.
6. 프롬프트를 보냅니다. Enter로 보내고 Shift+Enter로 줄을 바꿉니다. 한글 입력 중 Enter는 보내지 않습니다.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `WTS_PORT` | `4317` | 서버 포트 (개발 모드 화면의 프록시도 이 값을 씀) |
| `WTS_HOST` | `127.0.0.1` | 바인딩 주소. 외부에 열지 마세요. |
| `WTS_DATA_DIR` | `~/.worktree-studio` | SQLite DB, 첨부 이미지, 암호화 키(`secret.key`) 저장 위치 |
| `WTS_CLAUDE_PATH` | (자동) | 특정 Claude Code 실행 파일을 쓰고 싶을 때 경로 |

## 구조

```
server/src
  index.ts      HTTP API, WebSocket, 빌드된 화면 서빙
  claude.ts     Agent SDK 실행기 (streaming input으로 텍스트+이미지 전달, resume, 중단, 완료 알림)
  sessions.ts   세션과 워크트리 생성/종료, 메시지 저장
  projects.ts   로컬 폴더 등록, 워크스페이스
  git.ts        git 명령 래퍼 (fetch, worktree add/remove, 브랜치 목록)
  detect.ts     BE/FE/통합 감지, 기본 실행·검사 명령 추정
  notify.ts     OS 알림 (node-notifier), 보고 있는 세션은 건너뜀
  hub.ts        WebSocket 브로드캐스트, 화면이 보고 있는 세션 추적
  db.ts         SQLite 스키마와 마이그레이션
  envscan.ts    환경변수 정적 분석, 클론 .env 가져오기, AI 분석
  envstore.ts   프로필, 세션별 덮어쓰기, 실행용 값 계산
  envapi.ts     환경값 화면 상태
  runner.ts     서버 실행·종료, 포트 배정, 헬스체크, 로그 버퍼, 남은 프로세스 정리
  ports.ts      빈 포트 찾기 (IPv4, IPv6)
  accounts.ts   테스트 계정 풀
  secret.ts     환경값·비밀번호 암호화, 로그 마스킹
  github.ts     gh 로그인 상태
web/src
  App.tsx, components/  사이드바, 대화, 프롬프트 입력, 새 세션, 설정, 환경값 화면, 서버·미리보기·로그 패널
```

## 알아 둘 점

- **auto 권한 모드**는 Claude Code 계정과 버전에 따라 쓸 수 없을 수 있습니다. 그런 경우 설정에서 `acceptEdits`로 바꾸세요.
- Claude는 시스템 프롬프트로 "세션 워크트리 밖은 수정하지 말 것, 커밋·푸시는 요청받을 때만"을 안내받습니다. 강제 제한은 아니므로 auto 모드에서 실행된 명령은 대화의 도구 카드로 확인하세요.
- macOS에서 OS 알림이 안 보이면 시스템 설정 › 알림에서 `terminal-notifier` 알림을 허용하세요.
- 도구가 비정상 종료되면 다음 실행 때 "작업 중"으로 남은 세션을 대기로 되돌리고, 이 도구가 띄웠던 서버 프로세스를 정리합니다. Ctrl+C로 끄면 띄운 서버도 같이 꺼집니다.
- 환경값과 계정 비밀번호는 `secret.key`로 암호화해 DB에 저장합니다. 키 파일을 지우면 저장된 값을 읽을 수 없습니다.
- 서버 로그에서는 비밀값으로 표시된 변수(이름에 PASSWORD, SECRET, TOKEN, KEY 등)의 값을 가립니다.
- 배정된 테스트 계정의 아이디와 비밀번호는 화면 확인용으로 Claude에게 전달됩니다. 운영 계정은 풀에 넣지 마세요.
- 미리보기에서 로그인 쿠키가 안 붙으면 새 창으로 여세요. 다른 포트의 iframe이라 SameSite 설정에 따라 막힐 수 있습니다.
- 세션 닫기에서 "닫고 워크트리 삭제"는 커밋하지 않은 변경도 지웁니다. 확인 창을 거칩니다.
