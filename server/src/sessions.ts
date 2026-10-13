import fs from 'node:fs';
import path from 'node:path';
import { db, type SessionRow, type WorktreeRow } from './db.js';
import { getProject } from './projects.js';
import { addWorktree, fetchOrigin, removeWorktree } from './git.js';
import { broadcast } from './hub.js';

export type SessionView = SessionRow & {
  workspace_name: string;
  accounts: { id: number; login: string; note: string }[];
  worktrees: (WorktreeRow & { project_name: string; project_kind: string })[];
  /** 지금 작업이 끝나면 차례로 실행할 프롬프트 */
  queue: { id: number; text: string; image_count: number; created_at: string }[];
  /** 중단·오류로 대기열을 멈췄는지. 멈추면 사용자가 이어서 실행해야 다음 프롬프트가 돈다. */
  queue_paused: boolean;
};

export function listSessions(includeClosed = false): SessionView[] {
  const rows = db.prepare(`
    SELECT s.*, w.name AS workspace_name FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
    ${includeClosed ? '' : 'WHERE s.closed = 0'} ORDER BY s.updated_at DESC`).all() as (SessionRow & { workspace_name: string })[];
  return rows.map((r) => ({ ...r, accounts: accountsView(r.id), worktrees: worktreesOf(r.id), ...queueView(r.id) }));
}

export function getSession(id: number): SessionView | undefined {
  const r = db.prepare(`SELECT s.*, w.name AS workspace_name FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`)
    .get(id) as (SessionRow & { workspace_name: string }) | undefined;
  return r ? { ...r, accounts: accountsView(r.id), worktrees: worktreesOf(r.id), ...queueView(r.id) } : undefined;
}

export type QueuedPrompt = { id: number; session_id: number; text: string; images: string; created_at: string };
const pausedQueues = new Set<number>();

function queueView(sessionId: number) {
  const rows = db.prepare(`SELECT id, text, images, created_at FROM prompt_queue WHERE session_id = ? ORDER BY id`).all(sessionId) as QueuedPrompt[];
  return {
    queue: rows.map((r) => ({ id: r.id, text: r.text, image_count: (JSON.parse(r.images) as unknown[]).length, created_at: r.created_at })),
    queue_paused: rows.length > 0 && pausedQueues.has(sessionId),
  };
}

export function enqueuePrompt(sessionId: number, text: string, images: unknown[]): number {
  db.prepare(`INSERT INTO prompt_queue (session_id, text, images) VALUES (?, ?, ?)`).run(sessionId, text, JSON.stringify(images));
  broadcast({ type: 'session.updated', sessionId });
  return (db.prepare(`SELECT COUNT(*) AS n FROM prompt_queue WHERE session_id = ?`).get(sessionId) as { n: number }).n;
}

/** 대기열 맨 앞을 꺼낸다. */
export function shiftQueue(sessionId: number): QueuedPrompt | null {
  const row = db.prepare(`SELECT * FROM prompt_queue WHERE session_id = ? ORDER BY id LIMIT 1`).get(sessionId) as QueuedPrompt | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM prompt_queue WHERE id = ?`).run(row.id);
  broadcast({ type: 'session.updated', sessionId });
  return row;
}

export function queueLength(sessionId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM prompt_queue WHERE session_id = ?`).get(sessionId) as { n: number }).n;
}

export function removeQueued(sessionId: number, id: number) {
  db.prepare(`DELETE FROM prompt_queue WHERE id = ? AND session_id = ?`).run(id, sessionId);
  broadcast({ type: 'session.updated', sessionId });
}

export function setQueuePaused(sessionId: number, paused: boolean) {
  if (paused) pausedQueues.add(sessionId); else pausedQueues.delete(sessionId);
  broadcast({ type: 'session.updated', sessionId });
}
export const isQueuePaused = (sessionId: number) => pausedQueues.has(sessionId);

// 도구를 다시 켰을 때 남은 대기열이 저절로 돌지 않게 멈춰 둔다.
for (const r of db.prepare(`SELECT DISTINCT session_id FROM prompt_queue`).all() as { session_id: number }[]) pausedQueues.add(r.session_id);

function accountsView(sessionId: number) {
  return db.prepare(`SELECT id, login, note FROM test_accounts WHERE session_id = ? ORDER BY assigned_at, id`).all(sessionId) as SessionView['accounts'];
}

function worktreesOf(sessionId: number) {
  return db.prepare(`
    SELECT wt.*, p.name AS project_name, p.kind AS project_kind FROM worktrees wt
    JOIN projects p ON p.id = wt.project_id WHERE wt.session_id = ? ORDER BY wt.id`).all(sessionId) as SessionView['worktrees'];
}

export function setSession(id: number, patch: Partial<Pick<SessionRow, 'status' | 'claude_session_id' | 'unread' | 'closed'>>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) { broadcast({ type: 'session.updated', sessionId: id }); return; }
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  // 손댄 세션은 미활동 알림을 다시 받을 수 있게 한다.
  db.prepare(`UPDATE sessions SET ${sets}, updated_at = datetime('now'), stale_notified = 0 WHERE id = @id`).run({ ...patch, id });
  broadcast({ type: 'session.updated', sessionId: id });
}

function ticketSlug(ticket: string) {
  const digits = ticket.match(/\d+/g)?.join('-');
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
  try {
    for (const b of input.branches) {
      const project = getProject(b.projectId);
      if (!project) throw new Error(`프로젝트 ${b.projectId}가 없습니다.`);
      const branch = b.branch.trim();
      if (!branch) throw new Error(`${project.name}의 새 브랜치 이름을 넣어 주세요.`);
      await fetchOrigin(project.local_path).catch(() => { /* 오프라인이면 로컬 기준으로 진행 */ });
      const wtPath = freePath(path.join(path.dirname(project.local_path), `${project.name}-${ticketSlug(ticket)}`));
      await addWorktree(project.local_path, wtPath, branch, b.base);
      created.push({ repo: project.local_path, path: wtPath });
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
  if (s.status === 'running') throw new Error('작업 중인 세션은 닫을 수 없습니다. 먼저 중단하세요.');
  if (removeWorktrees) {
    for (const wt of s.worktrees) {
      const project = getProject(wt.project_id);
      if (project) await removeWorktree(project.local_path, wt.path).catch(() => {});
    }
  }
  setSession(id, { closed: 1 });
  broadcast({ type: 'sessions.changed' });
}

export function listMessages(sessionId: number) {
  const rows = db.prepare(`SELECT id, kind, payload, created_at FROM messages WHERE session_id = ? ORDER BY id`)
    .all(sessionId) as { id: number; kind: string; payload: string; created_at: string }[];
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function appendMessage(sessionId: number, kind: string, payload: unknown) {
  const info = db.prepare(`INSERT INTO messages (session_id, kind, payload) VALUES (?, ?, ?)`)
    .run(sessionId, kind, JSON.stringify(payload));
  const row = db.prepare(`SELECT id, kind, created_at FROM messages WHERE id = ?`).get(info.lastInsertRowid) as { id: number; kind: string; created_at: string };
  broadcast({ type: 'message', sessionId, message: { ...row, payload } });
}
