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

// 도구가 비정상 종료됐다면 실행 중으로 남은 세션을 되돌린다.
db.prepare(`UPDATE sessions SET status = 'idle' WHERE status = 'running'`).run();

export type ProjectRow = {
  id: number; name: string; local_path: string; kind: string;
  start_cmd: string | null; check_cmd: string | null; health_path: string | null; created_at: string;
  port_env: string | null; api_env_key: string | null;
};
export type SessionRow = {
  id: number; workspace_id: number; ticket: string; summary: string; status: string;
  claude_session_id: string | null; primary_worktree_id: number | null; unread: number; closed: number;
  created_at: string; updated_at: string;
};
export type WorktreeRow = {
  id: number; session_id: number; project_id: number; path: string; branch: string; base_branch: string;
};
