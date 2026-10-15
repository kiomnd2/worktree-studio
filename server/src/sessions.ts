import fs from 'node:fs';
import path from 'node:path';
import { db, type ChatRow, type SessionRow, type WorktreeRow } from './db.js';
import { getProject } from './projects.js';
import { addWorktree, fetchOrigin, removeWorktree } from './git.js';
import { broadcast } from './hub.js';

export type QueueView = {
  /** 지금 작업이 끝나면 차례로 실행할 프롬프트 */
  queue: { id: number; text: string; image_count: number; plan: boolean; created_at: string }[];
  /** 중단·오류로 대기열을 멈췄는지. 멈추면 사용자가 이어서 실행해야 다음 프롬프트가 돈다. */
  queue_paused: boolean;
};

/** 메인 대화 말고 따로 연 대화. 같은 워크트리에서 돈다. */
export type ChatView = Pick<ChatRow, 'id' | 'title' | 'status' | 'unread' | 'created_at'> & QueueView;

export type SessionView = SessionRow & QueueView & {
  workspace_name: string;
  accounts: { id: number; login: string; note: string }[];
  /** 앱(프로젝트)마다 하나. 같은 저장소의 앱들은 path·branch가 같은 워크트리를 같이 쓰고, app_path는 그 안의 앱 폴더다. */
  worktrees: WorktreeView[];
  /** 저장소마다 하나(같은 path는 한 번). 커밋·PR·충돌·변경 파일처럼 git으로 하는 일은 이것으로 한다. */
  repos: RepoView[];
  /** 추가 대화. status·queue는 메인 대화(chat 0)의 것이다. */
  chats: ChatView[];
  /** 메인이든 추가 대화든 하나라도 작업 중인지 */
  busy: boolean;
};

export function listSessions(includeClosed = false): SessionView[] {
  const rows = db.prepare(`
    SELECT s.*, w.name AS workspace_name FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
    ${includeClosed ? '' : 'WHERE s.closed = 0'} ORDER BY s.updated_at DESC`).all() as (SessionRow & { workspace_name: string })[];
  return rows.map(view);
}

export function getSession(id: number): SessionView | undefined {
  const r = db.prepare(`SELECT s.*, w.name AS workspace_name FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`)
    .get(id) as (SessionRow & { workspace_name: string }) | undefined;
  return r ? view(r) : undefined;
}

function view(r: SessionRow & { workspace_name: string }): SessionView {
  const chats = chatsOf(r.id);
  const worktrees = worktreesOf(r.id);
  return {
    ...r, accounts: accountsView(r.id), worktrees, repos: reposOf(worktrees), ...queueView(r.id, 0), chats,
    busy: r.status === 'running' || chats.some((c) => c.status === 'running'),
  };
}

function chatsOf(sessionId: number): ChatView[] {
  const rows = db.prepare(`SELECT id, title, status, unread, created_at FROM chats WHERE session_id = ? AND closed = 0 ORDER BY id`).all(sessionId) as ChatRow[];
  return rows.map((c) => ({ id: c.id, title: c.title, status: c.status, unread: c.unread, created_at: c.created_at, ...queueView(sessionId, c.id) }));
}

export function getChat(sessionId: number, chatId: number): ChatRow | undefined {
  return db.prepare(`SELECT * FROM chats WHERE id = ? AND session_id = ?`).get(chatId, sessionId) as ChatRow | undefined;
}

/** 제목을 주지 않으면 첫 프롬프트의 첫 줄로 짓는다. */
export function createChat(sessionId: number, firstText: string, givenTitle?: string): ChatRow {
  const line = firstText.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE session_id = ?`).get(sessionId) as { n: number }).n;
  const title = givenTitle?.trim() || (line ? (line.length > 40 ? `${line.slice(0, 40)}…` : line) : `대화 ${n + 2}`);
  const id = Number(db.prepare(`INSERT INTO chats (session_id, title) VALUES (?, ?)`).run(sessionId, title).lastInsertRowid);
  broadcast({ type: 'session.updated', sessionId });
  return getChat(sessionId, id)!;
}

export function closeChat(sessionId: number, chatId: number) {
  db.prepare(`UPDATE chats SET closed = 1 WHERE id = ? AND session_id = ?`).run(chatId, sessionId);
  db.prepare(`DELETE FROM prompt_queue WHERE session_id = ? AND chat_id = ?`).run(sessionId, chatId);
  pausedQueues.delete(qkey(sessionId, chatId));
  broadcast({ type: 'session.updated', sessionId });
}

/** 대화의 상태를 바꾼다. chat 0은 메인 대화라 세션 행을 바꾼다. */
export function setChat(sessionId: number, chatId: number, patch: Partial<Pick<ChatRow, 'status' | 'claude_session_id' | 'unread'>>) {
  if (chatId === 0) { setSession(sessionId, patch); return; }
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length) db.prepare(`UPDATE chats SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: chatId });
  // 추가 대화에서 일해도 세션을 손댄 것으로 본다.
  db.prepare(`UPDATE sessions SET updated_at = datetime('now'), stale_notified = 0 WHERE id = ?`).run(sessionId);
  broadcast({ type: 'session.updated', sessionId });
}

export type QueuedPrompt = { id: number; session_id: number; chat_id: number; text: string; images: string; plan: number; created_at: string };
const pausedQueues = new Set<string>();
const qkey = (sessionId: number, chatId: number) => `${sessionId}:${chatId}`;

function queueView(sessionId: number, chatId: number): QueueView {
  const rows = db.prepare(`SELECT id, text, images, plan, created_at FROM prompt_queue WHERE session_id = ? AND chat_id = ? ORDER BY id`).all(sessionId, chatId) as QueuedPrompt[];
  return {
    queue: rows.map((r) => ({ id: r.id, text: r.text, image_count: (JSON.parse(r.images) as unknown[]).length, plan: Boolean(r.plan), created_at: r.created_at })),
    queue_paused: rows.length > 0 && pausedQueues.has(qkey(sessionId, chatId)),
  };
}

export function enqueuePrompt(sessionId: number, chatId: number, text: string, images: unknown[], plan = false): number {
  db.prepare(`INSERT INTO prompt_queue (session_id, chat_id, text, images, plan) VALUES (?, ?, ?, ?, ?)`).run(sessionId, chatId, text, JSON.stringify(images), plan ? 1 : 0);
  broadcast({ type: 'session.updated', sessionId });
  return queueLength(sessionId, chatId);
}

/** 대기열 맨 앞을 꺼낸다. */
export function shiftQueue(sessionId: number, chatId: number): QueuedPrompt | null {
  const row = db.prepare(`SELECT * FROM prompt_queue WHERE session_id = ? AND chat_id = ? ORDER BY id LIMIT 1`).get(sessionId, chatId) as QueuedPrompt | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM prompt_queue WHERE id = ?`).run(row.id);
  broadcast({ type: 'session.updated', sessionId });
  return row;
}

export function queueLength(sessionId: number, chatId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM prompt_queue WHERE session_id = ? AND chat_id = ?`).get(sessionId, chatId) as { n: number }).n;
}

export function removeQueued(sessionId: number, id: number) {
  db.prepare(`DELETE FROM prompt_queue WHERE id = ? AND session_id = ?`).run(id, sessionId);
  broadcast({ type: 'session.updated', sessionId });
}

export function setQueuePaused(sessionId: number, chatId: number, paused: boolean) {
  if (paused) pausedQueues.add(qkey(sessionId, chatId)); else pausedQueues.delete(qkey(sessionId, chatId));
  broadcast({ type: 'session.updated', sessionId });
}
export const isQueuePaused = (sessionId: number, chatId: number) => pausedQueues.has(qkey(sessionId, chatId));

// 도구를 다시 켰을 때 남은 대기열이 저절로 돌지 않게 멈춰 둔다.
for (const r of db.prepare(`SELECT DISTINCT session_id, chat_id FROM prompt_queue`).all() as { session_id: number; chat_id: number }[]) pausedQueues.add(qkey(r.session_id, r.chat_id));

/** 세션이 쓸 수 있는 계정: 워크스페이스 계정과 공용 계정. 다른 세션과 같이 쓴다. */
function accountsView(sessionId: number) {
  return db.prepare(`SELECT a.id, a.login, a.note FROM test_accounts a JOIN sessions s ON s.id = ?
    WHERE a.workspace_id = s.workspace_id OR a.workspace_id IS NULL ORDER BY a.workspace_id IS NULL, a.login`).all(sessionId) as SessionView['accounts'];
}

export type WorktreeView = WorktreeRow & {
  project_name: string; project_kind: string;
  /** 저장소 루트에서 앱 폴더까지(루트 앱이면 '') */
  subdir: string;
  /** 앱 폴더(path + subdir). 서버를 띄우고 환경값을 찾는 곳 */
  app_path: string;
  /** 원본 저장소 폴더 이름(앱이 여럿인 저장소를 부를 때) */
  repo_name: string;
  /** 워크트리 폴더가 지워졌는지(세션은 열려 있는데 폴더가 없으면 서버·Claude가 동작하지 않는다) */
  missing: boolean;
};
export type RepoView = WorktreeView & {
  /** 이 워크트리를 같이 쓰는 앱들 */
  apps: { worktree_id: number; project_id: number; project_name: string; project_kind: string; subdir: string }[];
};

function worktreesOf(sessionId: number): WorktreeView[] {
  const rows = db.prepare(`
    SELECT wt.*, p.name AS project_name, p.kind AS project_kind, p.subdir AS subdir, COALESCE(p.repo_root, p.local_path) AS repo_root FROM worktrees wt
    JOIN projects p ON p.id = wt.project_id WHERE wt.session_id = ? ORDER BY wt.id`).all(sessionId) as (Omit<WorktreeView, 'app_path' | 'repo_name' | 'missing'> & { repo_root: string })[];
  return rows.map(({ repo_root, ...r }) => ({ ...r, subdir: r.subdir ?? '', app_path: r.subdir ? path.join(r.path, r.subdir) : r.path, repo_name: path.basename(repo_root), missing: !fs.existsSync(r.path) }));
}

/** 같은 워크트리(path)를 쓰는 앱을 묶는다. 앱이 여럿이면 이름은 저장소 폴더 이름으로 보여 준다. */
export function reposOf(worktrees: WorktreeView[]): RepoView[] {
  const out = new Map<string, RepoView>();
  for (const w of worktrees) {
    const app = { worktree_id: w.id, project_id: w.project_id, project_name: w.project_name, project_kind: w.project_kind, subdir: w.subdir };
    const cur = out.get(w.path);
    if (!cur) { out.set(w.path, { ...w, app_path: w.path, apps: [app] }); continue; }
    cur.apps.push(app);
    // 루트 앱이 있으면 그 앱을 대표로 둔다(PR·커밋 템플릿 설정을 그 프로젝트에서 읽는다).
    if (!w.subdir && cur.subdir) Object.assign(cur, { ...w, app_path: w.path, apps: cur.apps });
  }
  for (const r of out.values()) {
    if (r.apps.length > 1) r.project_name = r.repo_name;
  }
  return [...out.values()];
}

export function setSession(id: number, patch: Partial<Pick<SessionRow, 'status' | 'claude_session_id' | 'unread' | 'closed'>>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) { broadcast({ type: 'session.updated', sessionId: id }); return; }
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  // 손댄 세션은 미활동 알림을 다시 받을 수 있게 한다.
  db.prepare(`UPDATE sessions SET ${sets}, updated_at = datetime('now'), stale_notified = 0 WHERE id = @id`).run({ ...patch, id });
  broadcast({ type: 'session.updated', sessionId: id });
}

/** KERE-370 같은 Jira 이슈 키인지. 아니면 티켓 없이 작업 이름으로 만든 세션이다. */
export const isJiraKey = (ticket: string) => /^[A-Z][A-Z0-9]+-\d+$/.test(ticket.trim());

function ticketSlug(ticket: string) {
  const digits = isJiraKey(ticket) ? ticket.match(/\d+/g)?.join('-') : undefined;
  return (digits ?? ticket).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'work';
}

function freePath(base: string) {
  let p = base;
  for (let i = 2; fs.existsSync(p); i++) p = `${base}-${i}`;
  return p;
}

export type CreateSessionInput = {
  workspaceId: number;
  ticket: string;
  summary: string;
  branches: { projectId: number; base: string; branch: string }[];
};

/** 워크스페이스의 각 프로젝트에 워크트리를 만들고 세션을 연다. 하나라도 실패하면 만든 것을 되돌린다. */
export async function createSession(input: CreateSessionInput): Promise<SessionView> {
  const ticket = input.ticket.trim();
  if (!ticket) throw new Error('티켓 번호를 넣어 주세요.');
  if (input.branches.length === 0) throw new Error('워크트리를 만들 프로젝트가 없습니다.');

  const created: { repo: string; path: string }[] = [];
  const planned: { projectId: number; path: string; branch: string; base: string }[] = [];
  // 같은 저장소의 앱(모노레포의 FE·BE)은 워크트리 하나를 같이 쓴다. 브랜치는 그 저장소에서 처음 나온 앱의 것을 쓴다.
  const byRepo = new Map<string, { path: string; branch: string; base: string }>();
  try {
    for (const b of input.branches) {
      const project = getProject(b.projectId);
      if (!project) throw new Error(`프로젝트 ${b.projectId}가 없습니다.`);
      const repo = project.repo_root || project.local_path;
      const shared = byRepo.get(repo);
      if (shared) { planned.push({ projectId: b.projectId, ...shared }); continue; }
      const branch = b.branch.trim();
      if (!branch) throw new Error(`${project.name}의 새 브랜치 이름을 넣어 주세요.`);
      await fetchOrigin(repo).catch(() => { /* 오프라인이면 로컬 기준으로 진행 */ });
      const wtPath = freePath(path.join(path.dirname(repo), `${path.basename(repo)}-${ticketSlug(ticket)}`));
      await addWorktree(repo, wtPath, branch, b.base);
      created.push({ repo, path: wtPath });
      byRepo.set(repo, { path: wtPath, branch, base: b.base });
      planned.push({ projectId: b.projectId, path: wtPath, branch, base: b.base });
    }
  } catch (err) {
    for (const c of created.reverse()) await removeWorktree(c.repo, c.path).catch(() => {});
    throw err;
  }

  const id = db.transaction(() => {
    const sid = Number(db.prepare(`INSERT INTO sessions (workspace_id, ticket, summary) VALUES (?, ?, ?)`)
      .run(input.workspaceId, ticket, input.summary.trim()).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO worktrees (session_id, project_id, path, branch, base_branch) VALUES (?, ?, ?, ?, ?)`);
    let first: number | null = null;
    for (const p of planned) {
      const wid = Number(ins.run(sid, p.projectId, p.path, p.branch, p.base).lastInsertRowid);
      first ??= wid;
    }
    db.prepare(`UPDATE sessions SET primary_worktree_id = ? WHERE id = ?`).run(first, sid);
    return sid;
  })();

  broadcast({ type: 'sessions.changed' });
  return getSession(id)!;
}

/** 세션을 닫는다. removeWorktrees가 true면 워크트리 폴더도 지운다 (Phase 3에서 정리 화면으로 확장). */
export async function closeSession(id: number, removeWorktrees: boolean) {
  const s = getSession(id);
  if (!s) throw new Error('세션이 없습니다.');
  if (s.busy) throw new Error('작업 중인 세션은 닫을 수 없습니다. 먼저 중단하세요.');
  if (removeWorktrees) {
    for (const wt of s.repos) {
      const project = getProject(wt.project_id);
      if (project) await removeWorktree(project.repo_root || project.local_path, wt.path).catch(() => {});
    }
  }
  setSession(id, { closed: 1 });
  broadcast({ type: 'sessions.changed' });
}

/** 대화의 메시지. chatId를 빼면 세션의 모든 대화(PR 설명처럼 한 일을 모을 때) */
export function listMessages(sessionId: number, chatId?: number) {
  const rows = (chatId === undefined
    ? db.prepare(`SELECT id, chat_id, kind, payload, created_at FROM messages WHERE session_id = ? ORDER BY id`).all(sessionId)
    : db.prepare(`SELECT id, chat_id, kind, payload, created_at FROM messages WHERE session_id = ? AND chat_id = ? ORDER BY id`).all(sessionId, chatId)
  ) as { id: number; chat_id: number; kind: string; payload: string; created_at: string }[];
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function appendMessage(sessionId: number, kind: string, payload: unknown, chatId = 0) {
  const info = db.prepare(`INSERT INTO messages (session_id, chat_id, kind, payload) VALUES (?, ?, ?, ?)`)
    .run(sessionId, chatId, kind, JSON.stringify(payload));
  const row = db.prepare(`SELECT id, chat_id, kind, created_at FROM messages WHERE id = ?`).get(info.lastInsertRowid) as { id: number; chat_id: number; kind: string; created_at: string };
  broadcast({ type: 'message', sessionId, message: { ...row, payload } });
}
