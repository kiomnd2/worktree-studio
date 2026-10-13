export type ProjectKind = 'be' | 'fe' | 'full' | 'unknown';

export type Project = {
  id: number;
  name: string;
  local_path: string;
  kind: ProjectKind;
  start_cmd: string | null;
  check_cmd: string | null;
  health_path: string | null;
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
  worktrees: Worktree[];
};

export type StoredMessage = { id: number; kind: 'user' | 'sdk' | 'event'; payload: any; created_at: string };

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export type Settings = {
  permissionMode: PermissionMode;
  notify: { onComplete: boolean; onError: boolean; os: boolean; sound: boolean; skipWhenViewing: boolean; minSeconds: number };
};

export type ServerEvent =
  | { type: 'session.updated'; sessionId: number }
  | { type: 'sessions.changed' }
  | { type: 'message'; sessionId: number; message: StoredMessage };
