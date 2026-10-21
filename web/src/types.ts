export type ProjectKind = 'be' | 'fe' | 'full' | 'unknown';

export type Project = {
  id: number;
  name: string;
  /** 앱 폴더. 모노레포의 하위 앱이면 저장소 안의 하위 폴더 */
  local_path: string;
  repo_root: string;
  subdir: string;
  kind: ProjectKind;
  start_cmd: string | null;
  check_cmd: string | null;
  health_path: string | null;
  port_env: string | null;
  api_env_key: string | null;
  login_path: string | null;
  /** 개발 서버 접속 주소 틀. 비우면 http://localhost:{port} */
  app_url: string | null;
  setup_cmd: string | null;
  commit_template: string | null;
  current_branch: string | null;
  origin: string | null;
  worktrees: number;
  missing: boolean;
};

export type Workspace = { id: number; name: string; jira_project: string | null; projects: { id: number; name: string; kind: ProjectKind; repo_root: string }[] };

/** 새 티켓을 만들 때 프로젝트가 필수로 요구하는 칸(스프린트 등) */
export type JiraRequiredField = {
  key: string;
  name: string;
  kind: 'sprint' | 'select' | 'multiselect' | 'text' | 'number';
  options: { id: string; name: string; hint?: string }[];
  default_id: string | null;
};

export type JiraIssue = {
  key: string; summary: string; status: string; status_category: string; type: string; assignee: string | null; url: string; updated: string;
};
export type JiraStatus = { connected: boolean; user: string | null; error: string | null; site: string | null };
export type JiraConfig = {
  logged_in: boolean; user: string | null;
  site: { id: string; url: string } | null; sites: { id: string; name: string; url: string }[];
};

export type Worktree = {
  id: number;
  /** 워크트리 폴더가 지워짐 */
  missing?: boolean;
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
  /** 이 세션에서 쓸 수 있는 계정(워크스페이스 계정과 공용 계정). 다른 세션과 같이 쓴다. */
  accounts: { id: number; login: string; note: string }[];
  worktrees: Worktree[];
  queue: QueuedPrompt[];
  queue_paused: boolean;
  /** 같은 워크트리에서 따로 연 대화. status·queue는 메인 대화의 것이다. */
  chats: Chat[];
  /** 메인이든 추가 대화든 하나라도 작업 중인지 */
  busy: boolean;
};

export type QueuedPrompt = { id: number; text: string; image_count: number; plan: boolean; created_at: string };

export type Chat = { id: number; title: string; status: 'idle' | 'running'; unread: number; created_at: string; queue: QueuedPrompt[]; queue_paused: boolean };

export type StoredMessage = { id: number; chat_id: number; kind: 'user' | 'sdk' | 'event'; payload: any; created_at: string };

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export type Settings = {
  permissionMode: PermissionMode;
  notify: { onComplete: boolean; onError: boolean; onServerFail: boolean; os: boolean; sound: boolean; skipWhenViewing: boolean; minSeconds: number; onPr: boolean; onCleanup: boolean };
  cleanup: { stopServersOnPr: boolean; autoCleanMerged: boolean; deleteRemoteBranch: boolean; pollMinutes: number; staleDays: number };
  /** 보조 작업마다 쓸 모델. 빈 값이면 Claude Code 기본 모델. */
  helperModels: Record<string, string>;
};

export type ServerEvent =
  | { type: 'session.updated'; sessionId: number }
  | { type: 'sessions.changed' }
  | { type: 'message'; sessionId: number; message: StoredMessage }
  | { type: 'server.updated'; sessionId: number }
  | { type: 'log'; sessionId: number; worktreeId: number; lines: LogLine[] }
  | { type: 'pr.updated'; sessionId: number }
  | { type: 'screens.updated'; sessionId: number }
  | { type: 'cleanup.changed' }
  | { type: 'approvals.updated'; sessionId: number }
  | { type: 'docs.updated'; sessionId: number }
  | { type: 'tasks.updated'; sessionId: number }
  | { type: 'tests.updated'; sessionId: number }
  | { type: 'test.result'; sessionId: number; ticket: string; caseId: number; title: string; status: TestCase['status']; summary: string; index: number; total: number };

export type TestCase = {
  id: number; session_id: number; title: string; role: string; start_path: string; steps: string[]; expected: string[];
  account_id: number | null; status: 'draft' | 'queued' | 'running' | 'pass' | 'fail' | 'blocked' | 'error';
  summary: string | null; results: { step: string; ok: boolean; note: string; shot: string | null }[];
  shots: { file: string; caption: string }[]; ran_at: string | null;
};
export type TestState = {
  cases: TestCase[]; fe_project: { id: number; name: string } | null; app_url: string | null; login_path: string | null;
  generating: boolean; running: boolean;
  /** 실행 중일 때 끝난 케이스 수 / 이번에 돌리는 케이스 수 */
  progress: { done: number; total: number } | null;
  roles: { role: string; account: { id: number; login: string; note: string } | null }[];
  /** 지금 실행하면 안 되는 이유. 비어 있어야 실행할 수 있다(역할 계정 확인은 케이스마다 따로 본다). */
  blockers: string[];
};

export type ChangeScope = 'base' | 'uncommitted';
export type ChangedFile = {
  path: string; old_path: string | null; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number | null; deletions: number | null; binary: boolean;
};
export type WorktreeChanges = {
  worktree_id: number; project_name: string; branch: string; base_branch: string; compare_ref: string; files: ChangedFile[]; error: string | null;
};

/** 서버를 띄우기 전에 이 세션 포트에 맞춰 바꾸자고 제안된 환경값 */
export type EnvSuggestion = { worktree_id: number; project_id: number; project_name: string; key: string; value: string; current: string | null; reason: string; found_in: string };

export type TaskList = { title: string; tasks: { title: string; status: 'todo' | 'doing' | 'done' | 'skipped'; note: string }[]; updated_at: string };

export type Approval = {
  id: number; session_id: number; chat_id: number; reason: string; created_at: number;
  request:
    | { kind: 'env'; project_id: number; project_name: string; profile_name: string; vars: { key: string; value: string; reason: string; secret: boolean; current: string | null }[] }
    | { kind: 'plan'; plan: string; docs: { name: string; title: string; kind: DocKind }[] }
    | { kind: 'question'; questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }[] }
    | { kind: 'testdata'; case_id: number; case_title: string; need: string; plan: string; role: string };
};

/** 개발 산출물. plan: 계획서, screen: 화면설계서, test: 테스트 결과서 */
export type DocKind = 'plan' | 'screen' | 'test' | 'other';
export type DocMeta = { name: string; title: string; kind: DocKind; version: number; updated_at: string; path: string };
export type ArchiveEntry = {
  session_id: number; ticket: string; summary: string; workspace_name: string; closed: boolean; updated_at: string;
  branches: string[]; prs: { number: number; url: string; title: string; state: string }[]; docs: DocMeta[]; dir: string;
};

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';
export type PullRequest = { id: number; session_id: number; worktree_id: number; number: number; url: string; title: string; state: PrState; created_at: string; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null };

export type ConflictHunk = { line: number; ours: string; theirs: string };
export type WorktreeConflict = {
  worktree_id: number; project_name: string; branch: string; base_branch: string;
  pr: { number: number; url: string } | null;
  state: 'clean' | 'conflict' | 'merging' | 'error';
  behind: number; unpushed: number;
  files: { path: string; hunks: ConflictHunk[]; note: string | null }[];
  base_commits: { sha: string; subject: string; author: string }[];
  error: string | null;
};
export type ConflictProposal = {
  summary: string;
  files: { path: string; strategy: 'ours' | 'theirs' | 'both' | 'manual'; how: string; risk: string }[];
  checks: string[];
};
export type PrDraft = {
  worktree_id: number; project_name: string; project_kind: ProjectKind; branch: string; base_branch: string;
  dirty_files: string[]; commits_ahead: number; has_changes: boolean; check_cmd: string | null; template_path: string | null;
  commit_template: { path: string; from: string | null } | null;
  style_examples: { number: number; title: string; author: string; mine: boolean }[];
  existing_pr: { number: number; url: string; state: PrState; head_oid: string } | null;
  pr_mode: 'new' | 'update' | 'none'; pr_note: string | null; commit_message: string; title: string; body: string;
};
export type PrStep = { name: 'commit' | 'check' | 'push' | 'pr'; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'ignored'; started_at: number | null; ended_at: number | null; detail: string | null; output: string | null };
export type PrJob = {
  session_id: number; status: 'running' | 'done' | 'failed'; started_at: number; ended_at: number | null; error: string | null; servers_stopped: boolean; ignore_check_failures: boolean;
  repos: { worktree_id: number; project_name: string; pr_url: string | null; steps: PrStep[] }[];
};

export type ScreenCheck = {
  id: number; session_id: number; route: string; reason: string; checked: boolean;
  kind: 'direct' | 'indirect'; also_routes: string[]; manual: boolean;
};
export type ScreenState = { checks: ScreenCheck[]; preview_url: string | null; detecting: boolean; fe_project: { id: number; name: string } | null };

export type CleanupState = 'running' | 'protected' | 'ready' | 'waiting_merge' | 'active';
export type CleanupRow = {
  session_id: number; ticket: string; summary: string; workspace_name: string; closed: boolean; updated_at: string; idle_days: number;
  prs: { id: number; number: number; url: string; state: PrState }[]; servers: number;
  worktrees: { id: number; project_name: string; path: string; branch: string; exists: boolean; dirty: number; size_kb: number | null }[];
  screens_kb: number; state: CleanupState; reason: string;
};
export type UsageSum = { calls: number; input: number; output: number; cache_read: number; cache_write: number; cost_usd: number };
export type UsageReport = {
  days: number;
  totals: UsageSum & { errors: number };
  carried: number;
  by_purpose: (UsageSum & { purpose: string })[];
  by_model: (UsageSum & { model: string })[];
  by_day: (UsageSum & { day: string })[];
  by_session: (UsageSum & { session_id: number; ticket: string; summary: string; workspace_name: string; closed: boolean })[];
};
export type StartupReport = { at: string; orphans_killed: number; pruned: { project: string; lines: string[] }[]; missing_worktrees: number };
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
  failure: { kind: 'exit' | 'unhealthy'; at: number; exit_code: number | null; command: string; summary: string; excerpt: string } | null;
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

export type Account = {
  id: number; login: string; note: string;
  /** null이면 모든 워크스페이스에서 쓰는 공용 계정 */
  workspace_id: number | null; workspace_name: string | null;
};

/** 이 워크스페이스 세션에서 쓸 수 있는 계정인지: 그 워크스페이스 계정이나 공용 계정. 여러 세션이 같이 쓴다. */
export const usableIn = (a: Account, workspaceId: number) => a.workspace_id === null || a.workspace_id === workspaceId;
export type MissingEnv = { projectId: number; project: string; keys: string[] };

export type AnalyzeField = 'start_cmd' | 'setup_cmd' | 'check_cmd' | 'health_path' | 'port_env' | 'api_env_key' | 'app_url' | 'login_path';
/** 등록한 프로젝트를 Claude가 읽고 낸 실행 설정 제안 */
export type ProjectAnalysis = {
  suggestions: { field: AnalyzeField; value: string; current: string | null; reason: string }[];
  env_keys: { key: string; reason: string }[];
  notes: string[];
};
