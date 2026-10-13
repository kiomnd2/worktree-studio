import type {
  Account, CleanResult, CleanupRow, EnvVar, LogLine, MissingEnv, PrDraft, PrJob, Project, ProjectEnvState, PullRequest,
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
  deleteWorkspace: (id: number) => request('DELETE', `/api/workspaces/${id}`),

  sessions: () => request<Session[]>('GET', '/api/sessions'),
  session: (id: number) => request<Session>('GET', `/api/sessions/${id}`),
  createSession: (body: {
    workspaceId: number; ticket: string; summary: string;
    branches: { projectId: number; base: string; branch: string }[]; firstPrompt?: string;
  }) => request<Session>('POST', '/api/sessions', body),
  messages: (id: number) => request<StoredMessage[]>('GET', `/api/sessions/${id}/messages`),
  prompt: (id: number, text: string, images: { mediaType: string; data: string; name?: string }[]) =>
    request('POST', `/api/sessions/${id}/prompt`, { text, images }),
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
  startServers: (id: number, worktreeIds?: number[], commands?: Record<number, string>) => request<ServerView[]>('POST', `/api/sessions/${id}/servers/start`, { worktreeIds, commands }),
  stopServers: (id: number, worktreeIds?: number[]) => request<ServerView[]>('POST', `/api/sessions/${id}/servers/stop`, { worktreeIds }),
  restartServers: (id: number, worktreeIds?: number[], commands?: Record<number, string>) => request<ServerView[]>('POST', `/api/sessions/${id}/servers/restart`, { worktreeIds, commands }),
  logs: (worktreeId: number) => request<LogLine[]>('GET', `/api/worktrees/${worktreeId}/logs`),

  accounts: () => request<{ accounts: Account[]; free: number }>('GET', '/api/accounts'),
  addAccount: (login: string, password: string, note: string) => request('POST', '/api/accounts', { login, password, note }),
  deleteAccount: (id: number) => request('DELETE', `/api/accounts/${id}`),
  accountPassword: (id: number) => request<{ password: string }>('GET', `/api/accounts/${id}/password`),
  assignAccount: (sessionId: number) => request('POST', `/api/sessions/${sessionId}/account/assign`),
  releaseAccount: (sessionId: number) => request('POST', `/api/sessions/${sessionId}/account/release`),
  githubStatus: () => request<{ installed: boolean; loggedIn: boolean; account: string | null }>('GET', '/api/github/status'),

  pr: (id: number) => request<{ job: PrJob | null; prs: PullRequest[] }>('GET', `/api/sessions/${id}/pr`),
  preparePr: (id: number) => request<{ drafts: PrDraft[]; ai_error: string | null }>('POST', `/api/sessions/${id}/pr/prepare`),
  createPr: (id: number, items: { worktree_id: number; title: string; body: string; commit_message: string }[]) => request<PrJob>('POST', `/api/sessions/${id}/pr`, { items }),
  closePr: (prId: number) => request('POST', `/api/prs/${prId}/close`),

  screens: (id: number) => request<ScreenState>('GET', `/api/sessions/${id}/screens`),
  detectScreens: (id: number) => request<{ found: number }>('POST', `/api/sessions/${id}/screens/detect`),
  addScreen: (id: number, route: string) => request('POST', `/api/sessions/${id}/screens`, { route }),
  captureScreens: (id: number, ids?: number[]) => request<{ warnings: string[] }>('POST', `/api/sessions/${id}/screens/capture`, { ids }),
  acceptScreen: (screenId: number, accepted: boolean) => request('PATCH', `/api/screens/${screenId}`, { accepted }),
  removeScreen: (screenId: number) => request('DELETE', `/api/screens/${screenId}`),
  askScreen: (screenId: number, note: string) => request('POST', `/api/screens/${screenId}/ask`, { note }),
  capturePreview: (id: number, url: string) => request<{ data: string; warning: string | null }>('POST', `/api/sessions/${id}/preview/capture`, { url }),

  cleanup: () => request<{ rows: CleanupRow[]; startup: StartupReport | null }>('GET', '/api/cleanup'),
  clean: (sessionIds: number[], deleteRemote: boolean, force: boolean) => request<CleanResult[]>('POST', '/api/cleanup', { sessionIds, deleteRemote, force }),
  refreshPrs: () => request<{ changed: number }>('POST', '/api/cleanup/refresh'),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (s: Settings) => request<Settings>('PUT', '/api/settings', s),
  testNotify: () => request('POST', '/api/notify/test'),
};
