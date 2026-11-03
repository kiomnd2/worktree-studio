import { db } from './db.js';
import { baselineKey, type BaselineStatus, type BaselineView } from './dict/triage.js';
import type { Finding, Issue } from './dict/extract.js';

/**
 * 용어 검사 기준선. 지금 있는 위반을 (이름, 위반 종류) 단위로 찍어 두고,
 * 이후 전체 검사마다 남음·해결·새로 생김을 센다. PR 막힘 규칙과는 관계없는 정리용 표시다.
 * 무시 목록과 같이 워크스페이스 단위다.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS dict_baseline (
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  issue TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  note TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  PRIMARY KEY (workspace_id, name, issue)
);
`);

type Row = { name: string; issue: Issue; status: BaselineStatus; note: string; first_seen: string; resolved_at: string | null };

const rowsOf = (ws: number) => db.prepare(`SELECT name, issue, status, note, first_seen, resolved_at FROM dict_baseline WHERE workspace_id = ?`).all(ws) as Row[];

/** 지금 위반을 기준선에 더한다. 이미 있는 항목의 상태·메모는 그대로 두고, 다시 나온 것은 해결 표시를 지운다. */
export function snapshotBaseline(ws: number, findings: Finding[]): number {
  const ins = db.prepare(`INSERT INTO dict_baseline (workspace_id, name, issue) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, name, issue) DO UPDATE SET resolved_at = NULL`);
  let n = 0;
  db.transaction(() => {
    for (const f of findings) for (const i of f.issues) { ins.run(ws, f.name, i); n++; }
  })();
  return n;
}

export function clearBaseline(ws: number) {
  db.prepare(`DELETE FROM dict_baseline WHERE workspace_id = ?`).run(ws);
}

export function setBaselineStatus(ws: number, keys: { name: string; issue: string }[], status: BaselineStatus, note: string) {
  const up = db.prepare(`UPDATE dict_baseline SET status = ?, note = ? WHERE workspace_id = ? AND name = ? AND issue = ?`);
  db.transaction(() => { for (const k of keys) up.run(status, note, ws, k.name, k.issue); })();
}

/**
 * 검사 결과를 기준선과 맞댄다. 전체 검사(all)일 때만 해결 여부를 기록한다
 * (이번 변경 검사에는 안 나온 위반이 많아 해결로 잘못 센다).
 */
export function compareBaseline(ws: number, findings: Finding[], scope: 'changed' | 'all'): BaselineView | null {
  const rows = rowsOf(ws);
  if (!rows.length) return null;
  const current = new Set(findings.flatMap((f) => f.issues.map((i) => baselineKey(f.name, i))));
  if (scope === 'all') {
    const resolve = db.prepare(`UPDATE dict_baseline SET resolved_at = datetime('now') WHERE workspace_id = ? AND name = ? AND issue = ? AND resolved_at IS NULL`);
    const reopen = db.prepare(`UPDATE dict_baseline SET resolved_at = NULL WHERE workspace_id = ? AND name = ? AND issue = ?`);
    db.transaction(() => {
      for (const r of rows) {
        const seen = current.has(baselineKey(r.name, r.issue));
        if (!seen && !r.resolved_at) { resolve.run(ws, r.name, r.issue); r.resolved_at = 'now'; }
        else if (seen && r.resolved_at) { reopen.run(ws, r.name, r.issue); r.resolved_at = null; }
      }
    })();
  }
  const status: Record<string, BaselineStatus> = {};
  const notes: Record<string, string> = {};
  let resolved = 0; let todo = 0; let hold = 0; let accepted = 0;
  for (const r of rows) {
    if (r.resolved_at) { resolved++; continue; }
    const k = baselineKey(r.name, r.issue);
    status[k] = r.status;
    if (r.note) notes[k] = r.note;
    if (r.status === 'hold') hold++; else if (r.status === 'accepted') accepted++; else todo++;
  }
  const known = new Set(rows.map((r) => baselineKey(r.name, r.issue)));
  let newCount = 0;
  for (const k of current) if (!known.has(k)) newCount++;
  return {
    created_at: rows.reduce((a, r) => (r.first_seen < a ? r.first_seen : a), rows[0].first_seen),
    total: rows.length, resolved, remaining: rows.length - resolved, todo, hold, accepted, new_count: newCount, status, notes,
  };
}
