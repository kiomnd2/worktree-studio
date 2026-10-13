export type ProjectKind = 'be' | 'fe' | 'full' | 'unknown';

export type Project = {
  id: number;
  name: string;
  local_path: string;
  kind: ProjectKind;
  start_cmd: string | null;
  check_cmd: string | null;
  health_path: string | null;
  port_env: string | null;
  api_env_key: string | null;
  baseline_url: string | null;
  login_path: string | null;
  setup_cmd: string | null;
  current_branch: string | null;
  origin: string | null;
  worktrees: number;
  missing: boolean;
};

export type Workspace = { id: number; name: string; projects: { id: number; name: string; kind: ProjectKind }[] };

export type Worktree = {
  id: number;
  project_id: number;
  project_name: string;
  project_kind: ProjectKind;
  path: string;
  branch: string;
  base_branch: string;
};

export type Session = {
  id: number;
  workspace_id: number;
  workspace_name: string;
  ticket: string;
  summary: string;
  status: 'idle' | 'running';
  claude_session_id: string | null;
  primary_worktree_id: number | null;
  unread: number;
  updated_at: string;
  account: { id: number; login: string } | null;
  worktrees: Worktree[];
};

export type StoredMessage = { id: number; kind: 'user' | 'sdk' | 'event'; payload: any; created_at: string };

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export type Settings = {
  permissionMode: PermissionMode;
  notify: { onComplete: boolean; onError: boolean; onServerFail: boolean; os: boolean; sound: boolean; skipWhenViewing: boolean; minSeconds: number; onPr: boolean; onCleanup: boolean };
  cleanup: { stopServersOnPr: boolean; autoCleanMerged: boolean; deleteRemoteBranch: boolean; pollMinutes: number; staleDays: number };
};

export type ServerEvent =
  | { type: 'session.updated'; sessionId: number }
  | { type: 'sessions.changed' }
  | { type: 'message'; sessionId: number; message: StoredMessage }
  | { type: 'server.updated'; sessionId: number }
  | { type: 'log'; sessionId: number; worktreeId: number; lines: LogLine[] }
  | { type: 'pr.updated'; sessionId: number }
  | { type: 'screens.updated'; sessionId: number }
  | { type: 'cleanup.changed' };

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';
export type PullRequest = { id: number; session_id: number; worktree_id: number; number: number; url: string; title: string; state: PrState; created_at: string };
export type PrDraft = {
  worktree_id: number; project_name: string; project_kind: ProjectKind; branch: string; base_branch: string;
  dirty_files: string[]; commits_ahead: number; has_changes: boolean; check_cmd: string | null; template_path: string | null;
  existing_pr: { number: number; url: string } | null; commit_message: string; title: string; body: string;
};
export type PrStep = { name: 'commit' | 'check' | 'push' | 'pr'; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; started_at: number | null; ended_at: number | null; detail: string | null; output: string | null };
export type PrJob = {
  session_id: number; status: 'running' | 'done' | 'failed'; started_at: number; ended_at: number | null; error: string | null; servers_stopped: boolean;
  repos: { worktree_id: number; project_name: string; pr_url: string | null; steps: PrStep[] }[];
};

export type Box = { x: number; y: number; w: number; h: number };
export type ScreenCheck = {
  id: number; session_id: number; route: string; reason: string; before_file: string | null; after_file: string | null; diff_file: string | null;
  diff_ratio: number | null; boxes: Box[]; status: 'pending' | 'capturing' | 'changed' | 'same' | 'failed' | 'accepted'; error: string | null; captured_at: string | null;
};
export type ScreenState = {
  checks: ScreenCheck[]; baseline_url: string | null; after_url: string | null; login_path: string | null; account: string | null;
  viewport: { width: number; height: number }; capturing: boolean; detecting: boolean; fe_project: { id: number; name: string } | null;
};

export type CleanupState = 'running' | 'protected' | 'ready' | 'waiting_merge' | 'active';
export type CleanupRow = {
  session_id: number; ticket: string; summary: string; workspace_name: string; closed: boolean; updated_at: string; idle_days: number;
  prs: { id: number; number: number; url: string; state: PrState }[]; servers: number;
  worktrees: { id: number; project_name: string; path: string; branch: string; exists: boolean; dirty: number; size_kb: number | null }[];
  account: string | null; screens_kb: number; state: CleanupState; reason: string;
};
export type StartupReport = { at: string; orphans_killed: number; pruned: { project: string; lines: string[] }[]; accounts_released: number; missing_worktrees: number };
export type CleanResult = { session_id: number; steps: { name: string; ok: boolean; detail: string }[]; error: string | null };

export type LogLine = { seq: number; t: number; stream: 'out' | 'err' | 'sys'; level: 'error' | 'warn' | 'info'; text: string };

export type ServerStatus = 'idle' | 'starting' | 'running' | 'unhealthy' | 'failed' | 'stopped';
export type ServerView = {
  worktree_id: number;
  project_id: number;
  project_name: string;
  project_kind: ProjectKind;
  status: ServerStatus;
  port: number | null;
  url: string | null;
  exit_code: number | null;
  started_at: number | null;
  can_start: boolean;
  start_cmd: string | null;
  cwd: string;
  health_path: string;
  setup_pending: string | null;
};

export type EnvSource = 'detected' | 'ai' | 'clone' | 'profile' | 'manual';
export type EnvVar = { key: string; value: string; required: boolean; secret: boolean; source: EnvSource; found_in: string | null; overridden?: boolean; reason?: string };
export type EnvProfile = { id: number; project_id: number; name: string; is_default: number };
export type ProjectEnvState = {
  projectId: number;
  project: string;
  kind: ProjectKind;
  worktreeId: number;
  path: string;
  profiles: EnvProfile[];
  selectedProfileId: number;
  vars: EnvVar[];
  auto: { key: string; value: string }[];
  missing: string[];
};

export type Account = { id: number; login: string; note: string; session_id: number | null; ticket: string | null };
export type MissingEnv = { projectId: number; project: string; keys: string[] };
