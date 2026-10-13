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
  notify: { onComplete: boolean; onError: boolean; onServerFail: boolean; os: boolean; sound: boolean; skipWhenViewing: boolean; minSeconds: number };
};

export type ServerEvent =
  | { type: 'session.updated'; sessionId: number }
  | { type: 'sessions.changed' }
  | { type: 'message'; sessionId: number; message: StoredMessage }
  | { type: 'server.updated'; sessionId: number }
  | { type: 'log'; sessionId: number; worktreeId: number; lines: LogLine[] };

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
