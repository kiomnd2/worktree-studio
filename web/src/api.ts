import type {
  EnvSuggestion,
  TaskList,
  Account, Approval, ChangeScope, ArchiveEntry, DocMeta, JiraConfig, JiraIssue, JiraRequiredField, JiraStatus, TestState, WorktreeChanges, CleanResult, CleanupRow, EnvVar, LogLine, MissingEnv, PrDraft, PrJob, Project, ProjectEnvState, PullRequest,
  ScreenState, ServerView, Session, Settings, StartupReport, StoredMessage, Workspace,
} from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown>) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `요청 실패 (${res.status})`, res.status, data as Record<string, unknown>);
  return data as T;
}

export function missingFrom(e: unknown): MissingEnv[] | null {
  return e instanceof ApiError && e.status === 409 && Array.isArray(e.data.missing) ? (e.data.missing as MissingEnv[]) : null;
}

export const api = {
  projects: () => request<Project[]>('GET', '/api/projects'),
  addProject: (path: string) => request<Project>('POST', '/api/projects', { path }),
  updateProject: (id: number, patch: Partial<Project>) => request<Project>('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id: number) => request('DELETE', `/api/projects/${id}`),
  branches: (id: number) => request<string[]>('GET', `/api/projects/${id}/branches`),

  workspaces: () => request<Workspace[]>('GET', '/api/workspaces'),
  createWorkspace: (name: string, projectIds: number[]) => request<{ id: number }>('POST', '/api/workspaces', { name, projectIds }),
  updateWorkspace: (id: number, patch: { jira_project?: string | null }) => request('PATCH', `/api/workspaces/${id}`, patch),
  jiraConfig: () => request<JiraConfig>('GET', '/api/jira/config'),
  jiraLoginUrl: (origin: string) => request<{ url: string }>('POST', '/api/jira/oauth/start', { origin }),
  jiraChooseSite: (cloudId: string) => request<JiraStatus>('POST', '/api/jira/site', { cloud_id: cloudId }),
  jiraLogout: () => request('POST', '/api/jira/logout'),
  jiraStatus: () => request<JiraStatus>('GET', '/api/jira/status'),
  jiraIssues: (workspaceId: number, q: string) => request<JiraIssue[]>('GET', `/api/jira/issues?${new URLSearchParams({ workspace: String(workspaceId), q })}`),
  jiraIssueTypes: (workspaceId: number) => request<{ id: string; name: string }[]>('GET', `/api/jira/issuetypes?workspace=${workspaceId}`),
  draftJiraIssue: (workspaceId: number, prompt: string) =>
    request<{ title: string; issuetype_id: string; description: string; examples: string[]; examples_mine: boolean }>('POST', '/api/jira/draft', { workspace: workspaceId, prompt }),
  jiraRequiredFields: (workspaceId: number, issuetypeId: string) =>
    request<JiraRequiredField[]>('GET', `/api/jira/fields?${new URLSearchParams({ workspace: String(workspaceId), issuetype: issuetypeId })}`),
  createJiraIssue: (workspaceId: number, body: { summary: string; description: string; issuetype_id: string; fields: Record<string, string> }) =>
    request<JiraIssue>('POST', '/api/jira/issues', { workspace: workspaceId, ...body }),
  deleteWorkspace: (id: number) => request('DELETE', `/api/workspaces/${id}`),

  sessions: () => request<Session[]>('GET', '/api/sessions'),
  session: (id: number) => request<Session>('GET', `/api/sessions/${id}`),
  createSession: (body: {
    workspaceId: number; ticket: string; summary: string;
    branches: { projectId: number; base: string; branch: string }[]; firstPrompt?: string; firstPromptPlan?: boolean;
  }) => request<Session>('POST', '/api/sessions', body),
  messages: (id: number) => request<StoredMessage[]>('GET', `/api/sessions/${id}/messages`),
  prompt: (id: number, text: string, images: { mediaType: string; data: string; name?: string }[], plan = false) =>
    request<{ queued: boolean; position: number }>('POST', `/api/sessions/${id}/prompt`, { text, images, plan }),
  docs: (id: number) => request<DocMeta[]>('GET', `/api/sessions/${id}/docs`),
  archive: () => request<ArchiveEntry[]>('GET', '/api/artifacts'),
  revealArchive: (sessionId?: number) => request('POST', '/api/artifacts/reveal', { session: sessionId }),
  deleteDoc: (id: number, name: string) => request('DELETE', `/api/sessions/${id}/docs/${encodeURIComponent(name)}`),
  changes: (id: number, scope: ChangeScope) => request<WorktreeChanges[]>('GET', `/api/sessions/${id}/changes?scope=${scope}`),
  diff: (id: number, worktreeId: number, path: string, scope: ChangeScope, full: boolean, ignoreWhitespace: boolean) =>
    request<{ patch: string; binary: boolean }>('GET', `/api/sessions/${id}/diff?${new URLSearchParams({ worktree: String(worktreeId), path, scope, full: full ? '1' : '0', ws: ignoreWhitespace ? '1' : '0' })}`),
  tests: (id: number) => request<TestState>('GET', `/api/sessions/${id}/tests`),
  generateTests: (id: number) => request<{ count: number }>('POST', `/api/sessions/${id}/tests/generate`),
  saveTest: (id: number, c: { id?: number; title: string; role: string; start_path: string; steps: string[]; expected: string[] }) => request('POST', `/api/sessions/${id}/tests/cases`, c),
  deleteTest: (id: number, caseId: number) => request('DELETE', `/api/sessions/${id}/tests/cases/${caseId}`),
  confirmTestAccount: (id: number, role: string, accountId: number) => request('POST', `/api/sessions/${id}/tests/accounts`, { role, account_id: accountId }),
  runTests: (id: number, ids?: number[]) => request('POST', `/api/sessions/${id}/tests/run`, { ids }),
  stopTests: (id: number) => request('POST', `/api/sessions/${id}/tests/stop`),
  tasks: (id: number) => request<TaskList | null>('GET', `/api/sessions/${id}/tasks`),
  clearTasks: (id: number) => request('DELETE', `/api/sessions/${id}/tasks`),
  approvals: (id: number) => request<Approval[]>('GET', `/api/sessions/${id}/approvals`),
  decideApproval: (approvalId: number, body: { approve: false; feedback?: string } | { approve: true; answers?: Record<string, string>; plan?: string; vars?: { key: string; value: string }[]; target?: 'session' | 'profile'; account_id?: number }) =>
    request('POST', `/api/approvals/${approvalId}`, body),
  removeQueued: (id: number, queueId: number) => request('DELETE', `/api/sessions/${id}/queue/${queueId}`),
  resumeQueue: (id: number) => request('POST', `/api/sessions/${id}/queue/resume`),
  stop: (id: number) => request('POST', `/api/sessions/${id}/stop`),
  markRead: (id: number) => request('POST', `/api/sessions/${id}/read`),
  closeSession: (id: number, removeWorktrees: boolean) => request('POST', `/api/sessions/${id}/close`, { removeWorktrees }),

  env: (id: number) => request<ProjectEnvState[]>('GET', `/api/sessions/${id}/env`),
  saveEnv: (id: number, body: { projectId: number; mode: 'profile' | 'new' | 'session'; newName?: string; vars: EnvVar[] }) =>
    request<ProjectEnvState[]>('PUT', `/api/sessions/${id}/env`, body),
  selectProfile: (id: number, projectId: number, profileId: number) => request<ProjectEnvState[]>('POST', `/api/sessions/${id}/env/select`, { projectId, profileId }),
  analyzeEnv: (id: number, projectId: number, ai: boolean, known: string[]) => request<EnvVar[]>('POST', `/api/sessions/${id}/env/analyze`, { projectId, ai, known }),
  deleteProfile: (profileId: number) => request('DELETE', `/api/env-profiles/${profileId}`),

  servers: (id: number) => request<ServerView[]>('GET', `/api/sessions/${id}/servers`),
  startServers: (id: number, worktreeIds?: number[], commands?: Record<number, string>, ports?: Record<number, number>) => request<ServerView[]>('POST', `/api/sessions/${id}/servers/start`, { worktreeIds, commands, ports }),
  planPorts: (id: number, worktreeIds?: number[], restart = false) => request<{ ports: Record<number, number> }>('POST', `/api/sessions/${id}/servers/plan`, { worktreeIds, restart }),
  suggestServerEnv: (id: number, ports: Record<number, number>) => request<{ suggestions: EnvSuggestion[]; note: string }>('POST', `/api/sessions/${id}/servers/suggest-env`, { ports }),
  applySessionEnv: (id: number, items: { project_id: number; key: string; value: string }[]) => request('POST', `/api/sessions/${id}/env/apply`, { items }),
  stopServers: (id: number, worktreeIds?: number[]) => request<ServerView[]>('POST', `/api/sessions/${id}/servers/stop`, { worktreeIds }),
  restartServers: (id: number, worktreeIds?: number[], commands?: Record<number, string>, ports?: Record<number, number>) => request<ServerView[]>('POST', `/api/sessions/${id}/servers/restart`, { worktreeIds, commands, ports }),
  dismissFailure: (id: number, worktreeId: number) => request<ServerView[]>('POST', `/api/sessions/${id}/servers/${worktreeId}/dismiss`),
  logs: (worktreeId: number) => request<LogLine[]>('GET', `/api/worktrees/${worktreeId}/logs`),

  accounts: () => request<{ accounts: Account[] }>('GET', '/api/accounts'),
  addAccount: (login: string, password: string, note: string, workspaceId: number | null) => request('POST', '/api/accounts', { login, password, note, workspace_id: workspaceId }),
  updateAccount: (id: number, patch: { note?: string; workspace_id?: number | null }) => request('PATCH', `/api/accounts/${id}`, patch),
  deleteAccount: (id: number) => request('DELETE', `/api/accounts/${id}`),
  accountPassword: (id: number) => request<{ password: string }>('GET', `/api/accounts/${id}/password`),
  githubStatus: () => request<{ installed: boolean; loggedIn: boolean; account: string | null }>('GET', '/api/github/status'),

  pr: (id: number) => request<{ job: PrJob | null; prs: PullRequest[] }>('GET', `/api/sessions/${id}/pr`),
  preparePr: (id: number) => request<{ drafts: PrDraft[]; ai_error: string | null }>('POST', `/api/sessions/${id}/pr/prepare`),
  createPr: (id: number, items: { worktree_id: number; title: string; body: string; commit_message: string }[], ignoreCheckFailures: boolean) =>
    request<PrJob>('POST', `/api/sessions/${id}/pr`, { items, ignore_check_failures: ignoreCheckFailures }),
  continuePr: (id: number) => request<PrJob>('POST', `/api/sessions/${id}/pr/continue`),
  closePr: (prId: number) => request('POST', `/api/prs/${prId}/close`),

  screens: (id: number) => request<ScreenState>('GET', `/api/sessions/${id}/screens`),
  detectScreens: (id: number) => request<{ found: number }>('POST', `/api/sessions/${id}/screens/detect`),
  addScreen: (id: number, route: string) => request('POST', `/api/sessions/${id}/screens`, { route }),
  checkScreen: (screenId: number, checked: boolean) => request('PATCH', `/api/screens/${screenId}`, { checked }),
  removeScreen: (screenId: number) => request('DELETE', `/api/screens/${screenId}`),
  capturePreview: (id: number, url: string) => request<{ data: string; warning: string | null }>('POST', `/api/sessions/${id}/preview/capture`, { url }),

  cleanup: () => request<{ rows: CleanupRow[]; startup: StartupReport | null }>('GET', '/api/cleanup'),
  clean: (sessionIds: number[], deleteRemote: boolean, force: boolean) => request<CleanResult[]>('POST', '/api/cleanup', { sessionIds, deleteRemote, force }),
  refreshPrs: () => request<{ changed: number }>('POST', '/api/cleanup/refresh'),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (s: Settings) => request<Settings>('PUT', '/api/settings', s),
  testNotify: () => request('POST', '/api/notify/test'),
};

/** 문서 HTML 주소. 서버가 스크립트를 막은 채로 돌려준다. */
export const docUrl = (sessionId: number, name: string, version?: number) =>
  `/api/sessions/${sessionId}/docs/${encodeURIComponent(name)}${version ? `?v=${version}` : ''}`;
