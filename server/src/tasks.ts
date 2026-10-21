import { db } from './db.js';
import { broadcast } from './hub.js';

/**
 * 계획에서 나온 작업 목록. 계획을 승인한 뒤에도 사라지지 않게 세션마다 하나를 남기고,
 * Claude가 작업하면서 상태를 바꾼다. 새 계획을 세우면 목록을 통째로 바꾼다.
 */
export type TaskStatus = 'todo' | 'doing' | 'done' | 'skipped';
export type Task = { title: string; status: TaskStatus; note: string };
export type TaskList = { title: string; tasks: Task[]; updated_at: string };

db.exec(`
CREATE TABLE IF NOT EXISTS session_tasks (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  tasks TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function getTasks(sessionId: number): TaskList | null {
  const row = db.prepare(`SELECT title, tasks, updated_at FROM session_tasks WHERE session_id = ?`).get(sessionId) as { title: string; tasks: string; updated_at: string } | undefined;
  return row ? { title: row.title, tasks: JSON.parse(row.tasks) as Task[], updated_at: row.updated_at } : null;
}

export function setTasks(sessionId: number, title: string, tasks: { title: string; status: TaskStatus; note?: string }[]): TaskList {
  const clean = tasks.map((t) => ({ title: t.title.trim(), status: t.status, note: t.note?.trim() ?? '' })).filter((t) => t.title);
  db.prepare(`INSERT INTO session_tasks (session_id, title, tasks, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, tasks = excluded.tasks, updated_at = excluded.updated_at`)
    .run(sessionId, title.trim(), JSON.stringify(clean));
  broadcast({ type: 'tasks.updated', sessionId });
  return getTasks(sessionId)!;
}

/** 계획을 승인하면 바로 진행 중인 항목이 보이게, 하는 중인 항목이 없을 때 첫 할 일을 하는 중으로 바꾼다. */
export function startFirstTask(sessionId: number) {
  const l = getTasks(sessionId);
  if (!l || l.tasks.some((t) => t.status === 'doing')) return;
  const i = l.tasks.findIndex((t) => t.status === 'todo');
  if (i < 0) return;
  setTasks(sessionId, l.title, l.tasks.map((t, j) => (j === i ? { ...t, status: 'doing' as const } : t)));
}

export function clearTasks(sessionId: number) {
  db.prepare(`DELETE FROM session_tasks WHERE session_id = ?`).run(sessionId);
  broadcast({ type: 'tasks.updated', sessionId });
}

const MARK: Record<TaskStatus, string> = { todo: '[ ]', doing: '[~]', done: '[x]', skipped: '[-]' };
/** Claude에게 매 메시지마다 보여 줄 목록. */
export function tasksForContext(sessionId: number): string | null {
  const l = getTasks(sessionId);
  if (!l || l.tasks.length === 0) return null;
  return [`작업 목록${l.title ? ` "${l.title}"` : ''} (mcp__studio__set_tasks로 상태를 바꾼다):`, ...l.tasks.map((t, i) => `${i + 1}. ${MARK[t.status]} ${t.title}${t.note ? ` — ${t.note}` : ''}`)].join('\n');
}
