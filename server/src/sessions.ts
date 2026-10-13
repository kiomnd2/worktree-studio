import fs from 'node:fs';
import path from 'node:path';
import { db, type SessionRow, type WorktreeRow } from './db.js';
import { getProject } from './projects.js';
import { addWorktree, fetchOrigin, removeWorktree } from './git.js';
import { broadcast } from './hub.js';

export type SessionView = SessionRow & {
  workspace_name: string;
  account: { id: number; login: string } | null;
  worktrees: (WorktreeRow & { project_name: string; project_kind: string })[];
};

export function listSessions(includeClosed = false): SessionView[] {
  const rows = db.prepare(`
    SELECT s.*, w.name AS workspace_name FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
    ${includeClosed ? '' : 'WHERE s.closed = 0'} ORDER BY s.updated_at DESC`).all() as (SessionRow & { workspace_name: string })[];
  return rows.map((r) => ({ ...r, account: accountView(r.id), worktrees: worktreesOf(r.id) }));
}

export function getSession(id: number): SessionView | undefined {
  const r = db.prepare(`SELECT s.*, w.name AS workspace_name FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`)
    .get(id) as (SessionRow & { workspace_name: string }) | undefined;
  return r ? { ...r, account: accountView(r.id), worktrees: worktreesOf(r.id) } : undefined;
}

function accountView(sessionId: number) {
  return (db.prepare(`SELECT id, login FROM test_accounts WHERE session_id = ?`).get(sessionId) as { id: number; login: string } | undefined) ?? null;
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
