import { db } from './db.js';
import { baselineKey, type BaselineStatus, type BaselineView } from './dict/triage.js';
import type { Finding, Issue } from './dict/extract.js';

/**
 * 용어 검사 기준선. 지금 있는 위반을 (테이블, 컬럼, 위반 종류) 단위로 출현 수와 함께 찍어 두고,
 * 이후 검사마다 남음·해결·새로 생김·늘어남·줄어듦을 센다. 기준선이 있으면 기준선에 없는 키만 PR을 막는다.
 * 무시 목록과 같이 워크스페이스 단위다.
 *
 * 예전 표(dict_baseline)는 이름 단위였다. 처음 한 번 tbl '*'(아무 테이블)로 옮기고,
 * 다음에 기준선을 다시 찍을 때 실제 테이블 줄로 바꾼다(상태·메모는 이어받는다).
 */

const fresh = !db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dict_baseline2'`).get();
db.exec(`
CREATE TABLE IF NOT EXISTS dict_baseline2 (
  workspace_id INTEGER NOT NULL,
  tbl TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  issue TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo',
  note TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  PRIMARY KEY (workspace_id, tbl, name, issue)
);
`);
if (fresh && db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dict_baseline'`).get()) {
  db.exec(`INSERT OR IGNORE INTO dict_baseline2 (workspace_id, tbl, name, issue, count, status, note, first_seen, resolved_at)
    SELECT workspace_id, '*', name, issue, 0, status, note, first_seen, resolved_at FROM dict_baseline`);
}

type Row = { tbl: string; name: string; issue: Issue; count: number; status: BaselineStatus; note: string; first_seen: string; resolved_at: string | null };

const rowsOf = (ws: number) => db.prepare(`SELECT tbl, name, issue, count, status, note, first_seen, resolved_at FROM dict_baseline2 WHERE workspace_id = ?`).all(ws) as Row[];
const rowKey = (r: { tbl: string; name: string; issue: Issue }) => `${r.tbl}|${r.name}|${r.issue}`;
const starKey = (name: string, issue: Issue) => `*|${name}|${issue}`;

export const hasBaseline = (ws: number) => Boolean(db.prepare(`SELECT 1 FROM dict_baseline2 WHERE workspace_id = ? LIMIT 1`).get(ws));

/**
 * 지금 위반을 기준선에 더한다. 이미 있는 항목의 상태·메모는 그대로 두고 출현 수만 새로 적고, 다시 나온 것은 해결 표시를 지운다.
 * 옛 '*' 줄은 실제 테이블 줄로 옮긴다.
 */
export function snapshotBaseline(ws: number, findings: Finding[]): number {
  const rows = new Map(rowsOf(ws).map((r) => [rowKey(r), r]));
  const ins = db.prepare(`INSERT INTO dict_baseline2 (workspace_id, tbl, name, issue, count, status, note, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(workspace_id, tbl, name, issue) DO UPDATE SET count = excluded.count, resolved_at = NULL`);
  const dropStar = db.prepare(`DELETE FROM dict_baseline2 WHERE workspace_id = ? AND tbl = '*' AND name = ? AND issue = ?`);
  let n = 0;
  db.transaction(() => {
    const moved = new Set<string>();
    for (const f of findings) for (const i of f.issues) {
      const star = rows.get(starKey(f.name, i));
      ins.run(ws, f.table ?? '', f.name, i, f.occurrence_count, star?.status ?? 'todo', star?.note ?? '', star?.first_seen ?? null);
      if (star) moved.add(starKey(f.name, i));
      n++;
    }
    for (const k of moved) { const [, name, issue] = k.split('|'); dropStar.run(ws, name, issue); }
  })();
  return n;
}

export function clearBaseline(ws: number) {
  db.prepare(`DELETE FROM dict_baseline2 WHERE workspace_id = ?`).run(ws);
}

export function setBaselineStatus(ws: number, keys: { table?: string | null; name: string; issue: string }[], status: BaselineStatus, note: string) {
  const up = db.prepare(`UPDATE dict_baseline2 SET status = ?, note = ? WHERE workspace_id = ? AND tbl IN (?, '*') AND name = ? AND issue = ?`);
  db.transaction(() => { for (const k of keys) up.run(status, note, ws, k.table ?? '', k.name, k.issue); })();
}

/** 기준선 항목을 보류로. table이 비면 모든 테이블, issue가 비면 모든 위반 종류. 바꾼 줄 수 */
export function holdBaseline(ws: number, table: string, name: string, issue: string, note: string): number {
  return db.prepare(`UPDATE dict_baseline2 SET status = 'hold', note = ? WHERE workspace_id = ? AND name = ?
    AND (? = '' OR tbl IN (?, '*')) AND (? = '' OR issue = ?)`).run(note, ws, name, table, table, issue, issue).changes;
}

/**
 * 검사 결과를 기준선과 맞대고, 위반마다 기준선 상태(finding.baseline)를 채운다.
 * 전체 검사(all)일 때만 해결 여부를 기록한다(이번 변경 검사에는 안 나온 위반이 많아 해결로 잘못 센다).
 */
export function compareBaseline(ws: number, findings: Finding[], scope: 'changed' | 'all'): BaselineView | null {
  const rows = rowsOf(ws);
  for (const f of findings) f.baseline = null;
  if (!rows.length) return null;
  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  const rowFor = (f: Finding, i: Issue) => byKey.get(rowKey({ tbl: f.table ?? '', name: f.name, issue: i })) ?? byKey.get(starKey(f.name, i));

  const seen = new Set<Row>();
  const status: Record<string, BaselineStatus> = {};
  const notes: Record<string, string> = {};
  let newCount = 0; let increased = 0; let decreased = 0; let occAdded = 0; let occRemoved = 0;
  // '*' 줄은 테이블 여러 곳의 출현을 합쳐 비교한다
  const starOcc = new Map<Row, number>();
  for (const f of findings) {
    const sts: (BaselineStatus | 'new')[] = [];
    for (const i of f.issues) {
      const r = rowFor(f, i);
      const k = baselineKey(f.table, f.name, i);
      if (!r) { newCount++; sts.push('new'); continue; }
      seen.add(r);
      status[k] = r.status;
      if (r.note) notes[k] = r.note;
      sts.push(r.status);
      if (r.tbl === '*') starOcc.set(r, (starOcc.get(r) ?? 0) + f.occurrence_count);
      else if (r.count && f.occurrence_count !== r.count) {
        if (f.occurrence_count > r.count) { increased++; occAdded += f.occurrence_count - r.count; } else { decreased++; occRemoved += r.count - f.occurrence_count; }
      }
    }
    f.baseline = sts.includes('new') ? 'new' : sts.includes('todo') ? 'todo' : sts.includes('hold') ? 'hold' : 'accepted';
  }
  for (const [r, occ] of starOcc) {
    if (!r.count || occ === r.count) continue;
    if (occ > r.count) { increased++; occAdded += occ - r.count; } else { decreased++; occRemoved += r.count - occ; }
  }

  if (scope === 'all') {
    const resolve = db.prepare(`UPDATE dict_baseline2 SET resolved_at = datetime('now') WHERE workspace_id = ? AND tbl = ? AND name = ? AND issue = ? AND resolved_at IS NULL`);
    const reopen = db.prepare(`UPDATE dict_baseline2 SET resolved_at = NULL WHERE workspace_id = ? AND tbl = ? AND name = ? AND issue = ?`);
    db.transaction(() => {
      for (const r of rows) {
        const on = seen.has(r);
        if (!on && !r.resolved_at) { resolve.run(ws, r.tbl, r.name, r.issue); r.resolved_at = 'now'; }
        else if (on && r.resolved_at) { reopen.run(ws, r.tbl, r.name, r.issue); r.resolved_at = null; }
      }
    })();
  }
  let resolved = 0; let todo = 0; let hold = 0; let accepted = 0;
  for (const r of rows) {
    if (r.resolved_at) { resolved++; continue; }
    if (r.status === 'hold') hold++; else if (r.status === 'accepted') accepted++; else todo++;
  }
  return {
    created_at: rows.reduce((a, r) => (r.first_seen < a ? r.first_seen : a), rows[0].first_seen),
    total: rows.length, resolved, remaining: rows.length - resolved, todo, hold, accepted, new_count: newCount,
    increased, decreased, occ_added: occAdded, occ_removed: occRemoved, status, notes,
  };
}
