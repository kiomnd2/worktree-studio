# Worktree Studio

티켓 하나당 git 워크트리 하나를 만들고, 그 안에서 로컬 Claude Code와 대화하며 개발하는 로컬 웹 도구입니다.
이 버전은 플랜 문서의 **Phase 1** 범위입니다.

## Phase 1에 들어 있는 것

- 로컬에 클론한 폴더를 프로젝트로 등록 (git 저장소가 아니면 거부, BE/FE/통합 자동 감지 후 수정 가능)
- BE와 FE 프로젝트를 묶는 워크스페이스
- 새 세션: 기준 브랜치를 골라 프로젝트마다 워크트리와 새 브랜치 생성 (실패하면 만든 워크트리를 되돌림)
- 프롬프트 창: Claude Agent SDK로 워크트리에서 Claude Code 실행, 대화 스트리밍, 도구 실행 카드, 중단, 세션 이어서 대화(resume)
- 이미지 첨부: 클립 버튼, 끌어다 놓기, 붙여넣기 (PNG/JPG/GIF/WEBP, 장당 5MB)
- 작업 완료 알림: OS 알림, 탭 제목 개수 표시, 사이드바 "작업 완료 · 새 결과"
- 권한 모드 설정 (기본 auto)

서버 실행·미리보기·로그(Phase 2), PR 자동화·화면 비교·리소스 정리(Phase 3)는 아직 없습니다.

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
2. 같은 화면에서 워크스페이스를 만듭니다. 처음 고른 프로젝트가 Claude의 작업 위치(cwd)가 되고, 나머지 워크트리는 추가 디렉터리로 열립니다.
3. **+ 새 세션**에서 티켓 번호와 기준 브랜치를 고르면 `../be-drms-424` 같은 워크트리가 만들어집니다.
4. 프롬프트를 보냅니다. Enter로 보내고 Shift+Enter로 줄을 바꿉니다. 한글 입력 중 Enter는 보내지 않습니다.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `WTS_PORT` | `4317` | 서버 포트 (개발 모드 화면의 프록시도 이 값을 씀) |
| `WTS_HOST` | `127.0.0.1` | 바인딩 주소. 외부에 열지 마세요. |
| `WTS_DATA_DIR` | `~/.worktree-studio` | SQLite DB와 첨부 이미지 저장 위치 |
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
  db.ts         SQLite 스키마
web/src
  App.tsx, components/  사이드바, 대화, 프롬프트 입력, 새 세션, 설정 화면
```

## 알아 둘 점

- **auto 권한 모드**는 Claude Code 계정과 버전에 따라 쓸 수 없을 수 있습니다. 그런 경우 설정에서 `acceptEdits`로 바꾸세요.
- Claude는 시스템 프롬프트로 "세션 워크트리 밖은 수정하지 말 것, 커밋·푸시는 요청받을 때만"을 안내받습니다. 강제 제한은 아니므로 auto 모드에서 실행된 명령은 대화의 도구 카드로 확인하세요.
- macOS에서 OS 알림이 안 보이면 시스템 설정 › 알림에서 `terminal-notifier` 알림을 허용하세요.
- 도구가 비정상 종료되면 다음 실행 때 "작업 중"으로 남은 세션을 대기로 되돌립니다.
- 세션 닫기에서 "닫고 워크트리 삭제"는 커밋하지 않은 변경도 지웁니다. 확인 창을 거칩니다.
