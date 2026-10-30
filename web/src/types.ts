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
  /** 1이면 워크트리가 아니라 원본 클론 폴더에서 작업한다 */
  in_place?: number;
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

/** db_connection_id가 있으면 그 DB에만 질의하는 DB 대화 */
export type Chat = { id: number; title: string; status: 'idle' | 'running'; unread: number; created_at: string; queue: QueuedPrompt[]; queue_paused: boolean; db_connection_id: number | null };
/** DB 대화를 열 수 있는 세션 앱들의 DB 연결 */
export type SessionDb = { id: number; name: string; engine: DbEngine; project_name: string; target: string; enabled: boolean; queryable: boolean };

export type StoredMessage = { id: number; chat_id: number; kind: 'user' | 'sdk' | 'event'; payload: any; created_at: string };

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export type Settings = {
  permissionMode: PermissionMode;
  notify: { onComplete: boolean; onError: boolean; onServerFail: boolean; os: boolean; sound: boolean; skipWhenViewing: boolean; minSeconds: number; onPr: boolean; onCleanup: boolean };
  cleanup: { stopServersOnPr: boolean; autoCleanMerged: boolean; deleteRemoteBranch: boolean; pollMinutes: number; staleDays: number };
  /** 대화에 쓸 모델. 빈 값이면 Claude Code 기본 모델. */
  defaultModel: string;
  /** 보조 작업마다 쓸 모델. 빈 값이면 defaultModel. */
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
  | { type: 'queries'; sessionId: number; worktreeId: number }
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
/** template은 프로필에 저장될 값. 이 세션 주소가 {be_url}·{fe_url} 같은 포트 자리로 바뀐다. */
export type EnvSuggestion = { worktree_id: number; project_id: number; project_name: string; key: string; value: string; template: string; current: string | null; reason: string; found_in: string };

export type TaskList = { title: string; tasks: { title: string; status: 'todo' | 'doing' | 'done' | 'skipped'; note: string }[]; updated_at: string };

export type Approval = {
  id: number; session_id: number; chat_id: number; reason: string; created_at: number;
  request:
    | { kind: 'env'; project_id: number; project_name: string; profile_name: string; vars: { key: string; value: string; reason: string; secret: boolean; current: string | null }[] }
    | { kind: 'plan'; plan: string; docs: { name: string; title: string; kind: DocKind }[] }
    | { kind: 'question'; questions: { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }[] }
    | { kind: 'testdata'; case_id: number; case_title: string; need: string; plan: string; role: string }
    | { kind: 'dbwrite'; connection_id: number; connection_name: string; target: string; sql: string };
};

/** 개발 산출물. plan: 계획서, screen: 화면설계서, test: 테스트 결과서, report: 완료 보고서 */
export type DocKind = 'plan' | 'screen' | 'test' | 'report' | 'other';
export type DocMeta = { name: string; title: string; kind: DocKind; version: number; updated_at: string; path: string };
export type ArchiveEntry = {
  session_id: number; ticket: string; summary: string; workspace_name: string; closed: boolean; updated_at: string;
  branches: string[]; projects: string[]; prs: { number: number; url: string; title: string; state: string }[]; docs: DocMeta[]; dir: string;
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

/** sql: 쿼리 감시가 SQL 로그로 읽은 줄 */
export type LogLine = { seq: number; t: number; stream: 'out' | 'err' | 'sys'; level: 'error' | 'warn' | 'info'; text: string; sql?: true };

// 쿼리 감시(서버 로그에서 센 쿼리 모양별 집계)
export type QueryWarning = 'n+1' | 'large' | 'slow' | 'cache' | 'select-star' | 'like-prefix' | 'fn-column' | 'no-where' | 'big-offset';
export type QuerySort = 'calls' | 'rows' | 'time' | 'recent';
export type QueryStat = {
  key: string; shape: string; mapper: string | null; calls: number;
  rows_avg: number | null; rows_max: number | null; ms_avg: number | null; ms_max: number | null;
  warnings: QueryWarning[]; muted: boolean; first_at: number; last_at: number; has_example: boolean;
};
export type QueryDetail = QueryStat & {
  example: { sql: string; params: { value: string | null; type: string | null }[]; filled: string; at: number } | null;
  /** 로그에 찍힌 로거 이름 그대로(줄였을 수 있음) */
  logger: string | null;
  /** 매퍼 XML 위치와 그 매퍼 메서드를 부르는 곳(워크트리 기준 상대 경로) */
  location: { full_id: string; short_id: string; file: string; line: number; callers: { file: string; line: number; text: string }[]; candidates: number } | null;
};
export type QueryList = {
  rows: QueryStat[];
  /** 서버를 띄울 때 넣은 SQL 로그 환경값. 띄운 적 없으면 null */
  sql_log: { enabled: boolean; packages: string[]; keys: string[]; kept: string[]; hibernate: boolean } | null;
  /** from_env: DB 설정에 연결이 없어 서버 환경값에서 짐작한 연결(id 음수) */
  connections: { id: number; name: string; engine: string; enabled: boolean; from_env: boolean; target: string }[];
};
export type ExplainResult = {
  engine: string; connection: string; connection_id: number; sql: string; plan: string; notes: string[]; ms: number;
  tables: { name: string; rows: number | null; indexes: { name: string; unique: boolean; columns: string; used: boolean }[] }[];
};

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
  /** DB 설정이 넣는 값. 프로필 값보다 우선한다. 비밀값은 가려져 온다. */
  db: { key: string; value: string; connection: string }[];
  missing: string[];
};

export type DbEngine = 'postgres' | 'mysql' | 'mariadb' | 'oracle' | 'mssql' | 'mongodb' | 'redis';
export type DbConnection = {
  id: number; project_id: number; name: string; engine: DbEngine;
  host: string; port: number | null; database: string; username: string; password: string;
  /** 환경변수 이름 → 틀({jdbc_url}, {url}, {host}, {port}, {database}, {username}, {password}) */
  env_map: Record<string, string>; enabled: boolean; note: string;
};
export type DbConnectionInput = Omit<DbConnection, 'id' | 'project_id'>;
export type DockerStack = { file: string; services: string[] };
export type DockerState = 'ok' | 'no-cli' | 'daemon-down';
export type DbCandidate = { from: string; engine: DbEngine; host: string; port: number; database: string; username: string; password: string; stack: DockerStack | null };
/** 프로젝트 로컬 실행 환경: 클론에서 복사할 파일, 서버 앞에 띄울 도커, DB 연결 */
export type LocalSetup = {
  copy_files: { auto: boolean; files: string[]; detected: string[] };
  stacks: DockerStack[];
  compose: { file: string; services: { name: string; image: string | null; infra: DbEngine | 'other' | null; ports: { host: number; container: number }[] }[] }[];
  candidates: DbCandidate[];
  needs: DbEngine[];
  docker: DockerState;
  connections: DbConnection[];
  studio_engines: DbEngine[];
};
/** 서버 실행 창의 실행 전 준비 */
export type StartPrep = {
  items: {
    worktree_id: number; project_id: number; project_name: string;
    docker: DockerStack[]; copies: string[]; db: { name: string; engine: string; target: string }[]; db_missing: DbEngine[];
  }[];
  docker: DockerState | null;
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
