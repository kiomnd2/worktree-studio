import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'unknown',
  start_cmd TEXT,
  check_cmd TEXT,
  health_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workspace_projects (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, project_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  ticket TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  claude_session_id TEXT,
  primary_worktree_id INTEGER,
  unread INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS worktrees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS env_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS env_vars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES env_profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  secret INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  found_in TEXT,
  UNIQUE (profile_id, key)
);
CREATE TABLE IF NOT EXISTS session_env (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES env_profiles(id) ON DELETE SET NULL,
  overrides TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, project_id)
);
CREATE TABLE IF NOT EXISTS test_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS servers (
  worktree_id INTEGER PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
  port INTEGER NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// PR과 영향 화면 표. 아래 addColumn이 이 표들에 열을 더하므로 먼저 만든다(새로 설치할 때 표가 없어 실패하지 않게).
db.exec(`
CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worktree_id INTEGER NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  checked_at TEXT
);
CREATE TABLE IF NOT EXISTS screen_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  before_file TEXT,
  after_file TEXT,
  diff_file TEXT,
  diff_ratio REAL,
  boxes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  captured_at TEXT,
  UNIQUE (session_id, route)
);
`);

function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('projects', 'port_env', 'port_env TEXT');
addColumn('projects', 'api_env_key', 'api_env_key TEXT');
// baseline_url은 예전 화면 전후 비교의 기준 서버 주소(지금은 쓰지 않음). login_path는 미리보기 캡처 로그인용.
addColumn('projects', 'baseline_url', 'baseline_url TEXT');
addColumn('projects', 'login_path', 'login_path TEXT');
// 새 워크트리에서 처음 실행하기 전에 돌릴 의존성 설치 명령(uv sync, npm ci 등)과 설치를 마쳤는지
addColumn('projects', 'setup_cmd', 'setup_cmd TEXT');
addColumn('worktrees', 'setup_done', 'setup_done INTEGER NOT NULL DEFAULT 0');
// 한 세션에 계정 여러 개: 배정 순서를 기억하고, 화면마다 어느 계정으로 찍을지 고른다.
addColumn('test_accounts', 'assigned_at', 'assigned_at TEXT');
addColumn('screen_checks', 'account_id', 'account_id INTEGER REFERENCES test_accounts(id) ON DELETE SET NULL');
// Claude가 작업 중일 때 보낸 프롬프트를 순서대로 쌓아 둔다. 이미지는 보낼 때 이미 파일로 저장해 이름만 둔다.
db.exec(`
CREATE TABLE IF NOT EXISTS prompt_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
// 영향 화면: 직접 영향(보이는 게 바뀜)인지 간접(가능성)인지, 같은 화면 컴포넌트를 쓰는 다른 경로, 직접 추가했는지
addColumn('screen_checks', 'kind', `kind TEXT NOT NULL DEFAULT 'direct'`);
addColumn('screen_checks', 'also_routes', `also_routes TEXT NOT NULL DEFAULT '[]'`);
addColumn('screen_checks', 'manual', 'manual INTEGER NOT NULL DEFAULT 0');
db.prepare(`UPDATE screen_checks SET manual = 1 WHERE reason = '직접 추가' AND manual = 0`).run();
// 커밋 메시지 템플릿 파일 경로(저장소 기준 상대 경로나 절대 경로). 비우면 저장소에서 찾는다.
addColumn('projects', 'commit_template', 'commit_template TEXT');
// 테스트 계정은 워크스페이스마다 따로 쓴다(RE100 계정을 DRMS 세션에 배정하지 않게). 비어 있으면 모든 워크스페이스에서 쓰는 공용 계정.
addColumn('test_accounts', 'workspace_id', 'workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL');
{
  // 워크스페이스가 하나뿐일 때 만든 계정은 그 워크스페이스 것으로 옮긴다.
  const ws = db.prepare(`SELECT id FROM workspaces`).all() as { id: number }[];
  if (ws.length === 1) db.prepare(`UPDATE test_accounts SET workspace_id = ? WHERE workspace_id IS NULL`).run(ws[0].id);
}
// 워크스페이스마다 쓰는 Jira 프로젝트 키(예: KERE, DRMS). 세션을 만들 때 이 프로젝트에서 티켓을 고르거나 만든다.
addColumn('workspaces', 'jira_project', 'jira_project TEXT');
// 계획 모드로 실행할 프롬프트
addColumn('prompt_queue', 'plan', 'plan INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'stale_notified', 'stale_notified INTEGER NOT NULL DEFAULT 0');

// 한 세션 안의 추가 대화. 같은 워크트리에서 메인 대화와 따로 Claude를 돌린다(로그를 보다 생긴 작은 수정 등).
// 메인 대화는 chat_id 0이고 sessions 행의 상태를 쓴다.
db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  claude_session_id TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
addColumn('messages', 'chat_id', 'chat_id INTEGER NOT NULL DEFAULT 0');
addColumn('prompt_queue', 'chat_id', 'chat_id INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(session_id, chat_id, id)`);


// GitHub가 본 PR 머지 가능 여부(MERGEABLE, CONFLICTING, UNKNOWN). 충돌이면 화면에 표시한다.
addColumn('pull_requests', 'mergeable', 'mergeable TEXT');

// 저장소 하나에 FE·BE가 함께 있는 경우(모노레포): 프로젝트는 '앱' 하나이고 local_path는 그 앱 폴더다.
// repo_root는 git 저장소 루트, subdir는 루트에서 앱 폴더까지의 상대 경로(루트 앱이면 '').
// 같은 저장소의 앱들은 세션에서 워크트리 하나를 같이 쓴다.
addColumn('projects', 'repo_root', 'repo_root TEXT');
addColumn('projects', 'subdir', `subdir TEXT NOT NULL DEFAULT ''`);
db.prepare(`UPDATE projects SET repo_root = local_path WHERE repo_root IS NULL`).run();
// 닫은 세션이 아직 가리키는 프로젝트는 지우지 않고 숨긴다(산출물 보관함·리소스 정리가 그 정보를 쓴다).
addColumn('projects', 'deleted', 'deleted INTEGER NOT NULL DEFAULT 0');
addColumn('workspaces', 'deleted', 'deleted INTEGER NOT NULL DEFAULT 0');

// Claude 호출의 토큰·비용 기록(usage.ts). 보조 호출(PR 문안, 화면 테스트 등)은 대화 기록 파일을 남기지 않아 여기에만 남는다.
// 행 하나가 결과 메시지 하나다. 숫자 열은 그 결과에서 늘어난 몫이고 cumulative는 SDK가 준 누적값 그대로다.
// 세션이 정리돼도 기록은 남기려고 sessions에 외래 키를 걸지 않는다.
db.exec(`
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  session_id INTEGER,
  chat_id INTEGER,
  cwd TEXT,
  claude_session_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  models TEXT NOT NULL DEFAULT '{}',
  cumulative TEXT NOT NULL DEFAULT '{}',
  num_turns INTEGER,
  duration_ms INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0,
  carried INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_claude ON usage_log(claude_session_id, id);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_log(session_id, id);
`);

// 도구가 비정상 종료됐다면 실행 중으로 남은 세션을 되돌린다.
db.prepare(`UPDATE sessions SET status = 'idle' WHERE status = 'running'`).run();
db.prepare(`UPDATE chats SET status = 'idle' WHERE status = 'running'`).run();

export type ProjectRow = {
  id: number; name: string; local_path: string; kind: string;
  start_cmd: string | null; check_cmd: string | null; health_path: string | null; created_at: string;
  port_env: string | null; api_env_key: string | null; baseline_url: string | null; login_path: string | null; setup_cmd: string | null; commit_template: string | null;
  repo_root: string; subdir: string;
};
export type SessionRow = {
  id: number; workspace_id: number; ticket: string; summary: string; status: string;
  claude_session_id: string | null; primary_worktree_id: number | null; unread: number; closed: number;
  created_at: string; updated_at: string; stale_notified: number;
};
export type WorktreeRow = {
  id: number; session_id: number; project_id: number; path: string; branch: string; base_branch: string; setup_done: number;
};
export type ChatRow = {
  id: number; session_id: number; title: string; status: string; claude_session_id: string | null; unread: number; closed: number; created_at: string;
};
