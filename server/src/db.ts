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
addColumn('sessions', 'stale_notified', 'stale_notified INTEGER NOT NULL DEFAULT 0');

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

// 도구가 비정상 종료됐다면 실행 중으로 남은 세션을 되돌린다.
db.prepare(`UPDATE sessions SET status = 'idle' WHERE status = 'running'`).run();

export type ProjectRow = {
  id: number; name: string; local_path: string; kind: string;
  start_cmd: string | null; check_cmd: string | null; health_path: string | null; created_at: string;
  port_env: string | null; api_env_key: string | null; baseline_url: string | null; login_path: string | null; setup_cmd: string | null; commit_template: string | null;
};
export type SessionRow = {
  id: number; workspace_id: number; ticket: string; summary: string; status: string;
  claude_session_id: string | null; primary_worktree_id: number | null; unread: number; closed: number;
  created_at: string; updated_at: string; stale_notified: number;
};
export type WorktreeRow = {
  id: number; session_id: number; project_id: number; path: string; branch: string; base_branch: string; setup_done: number;
};
