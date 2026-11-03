import { db } from './db.js';
import { getSession, type SessionView } from './sessions.js';
import { sessionIndex } from './dictscan.js';
import { createDictEntry, createTerm, createWord, dictionary, erdApi, erdProject, invalidateErd, type ColumnInput } from './erdvibe.js';
import { addedBySession, sessionRefs, sessionSchemas } from './schemasync.js';
import { standardName } from './dict/judge.js';
import { syncCheck, type DictDraft, type SyncAction, type SyncItem, type SyncResult, type SyncSide } from './dict/sync.js';
import { columnType, type ErdColumn } from './dict/types.js';

/**
 * 전체 동기화의 결정(건마다 기준·상태)과 반영. 판정은 dict/sync.ts.
 * 사전 등록·ERD 반영은 화면에서 미리보기를 보고 누른 것만 한다. ERD 반영은 이전 값을 sync_runs에 남겨 되돌릴 수 있다.
 * 소스 쪽 할 일은 반영하지 않고 Claude에게 넘길 목록(source-todo)으로만 만든다.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS sync_decisions (
  workspace_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  side TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, key)
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  erd_project_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary TEXT NOT NULL DEFAULT '',
  undo_json TEXT NOT NULL,
  undone_at TEXT
);
`);

export type SyncStatus = 'todo' | 'hold' | 'accepted';
type DecisionRow = { key: string; side: SyncSide | null; status: SyncStatus; note: string };

const decisionsOf = (ws: number) => new Map((db.prepare(`SELECT key, side, status, note FROM sync_decisions WHERE workspace_id = ?`).all(ws) as DecisionRow[]).map((r) => [r.key, r]));

export function setDecisions(ws: number, keys: string[], patch: { side?: SyncSide | null; status?: SyncStatus; note?: string }) {
  const up = db.prepare(`INSERT INTO sync_decisions (workspace_id, key, side, status, note) VALUES (@ws, @key, @side, @status, @note)
    ON CONFLICT(workspace_id, key) DO UPDATE SET
      side = CASE WHEN @hasSide THEN @side ELSE side END,
      status = CASE WHEN @hasStatus THEN @status ELSE status END,
      note = CASE WHEN @hasNote THEN @note ELSE note END,
      updated_at = datetime('now')`);
  db.transaction(() => {
    for (const key of keys) up.run({
      ws, key, side: patch.side ?? null, status: patch.status ?? 'todo', note: patch.note ?? '',
      hasSide: patch.side !== undefined ? 1 : 0, hasStatus: patch.status ? 1 : 0, hasNote: patch.note !== undefined ? 1 : 0,
    });
  })();
}

export type SyncView = SyncItem & { side: SyncSide | null; status: SyncStatus; note: string };
export type SyncRun = { id: number; created_at: string; summary: string; undone_at: string | null; count: number };
export type SyncReport = {
  generated_at: number;
  erd_project: { id: string; name: string } | null;
  apps: { project_name: string; kind: string; roots: string[]; tables: number }[];
  summary: SyncResult['summary'] & { by_target: Record<'dict' | 'erd' | 'source', number> };
  items: SyncView[];
  drafts: DictDraft[];
  runs: SyncRun[];
  error: string | null;
};

/** 공통 할 일 + 고른 기준의 할 일. 기준을 안 골랐고 기본도 없으면(ERD에만 있음) 공통만 */
export const actionsOf = (it: SyncView): SyncAction[] => [...it.actions.common, ...(it.side ? it.actions[it.side] : [])];

async function computeSync(s: SessionView): Promise<{ result: SyncResult | null; erd: { id: string; name: string } | null; apps: SyncReport['apps']; error: string | null }> {
  const { ix, erd, erdError } = await sessionIndex(s);
  const { apps, schema } = sessionSchemas(s);
  const appView = apps.map((a) => ({ project_name: a.project_name, kind: a.kind, roots: a.roots, tables: a.schema.tables.size }));
  if (!erd) return { result: null, erd: null, apps: appView, error: erdError ?? '워크스페이스에 ERD 프로젝트를 연결해야 동기화할 수 있습니다.' };
  if (!schema.tables.size) return { result: null, erd: { id: erd.id, name: erd.name }, apps: appView, error: '소스에서 Liquibase changelog나 .sql DDL을 찾지 못했습니다.' };
  return { result: syncCheck(schema, erd, ix), erd: { id: erd.id, name: erd.name }, apps: appView, error: null };
}

export async function syncReport(sessionId: number): Promise<SyncReport> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const { result, erd, apps, error } = await computeSync(s);
  const dec = decisionsOf(s.workspace_id);
  const items: SyncView[] = (result?.items ?? []).map((it) => {
    const d = dec.get(it.key);
    return { ...it, side: d?.side ?? it.default_side, status: d?.status ?? 'todo', note: d?.note ?? '' };
  });
  const byTarget = { dict: 0, erd: 0, source: 0 };
  for (const it of items) {
    if (it.status !== 'todo') continue;
    for (const a of actionsOf(it)) byTarget[a.target]++;
  }
  byTarget.dict = result?.drafts.length ?? 0;
  return {
    generated_at: Date.now(), erd_project: erd, apps,
    summary: { ...(result?.summary ?? { tables: 0, columns: 0, ok: 0, todo: 0, issues: {}, logical_dups: 0 }), by_target: byTarget },
    items, drafts: result?.drafts ?? [], runs: runsOf(s.workspace_id), error,
  };
}

function runsOf(ws: number): SyncRun[] {
  return (db.prepare(`SELECT id, created_at, summary, undone_at, undo_json FROM sync_runs WHERE workspace_id = ? ORDER BY id DESC LIMIT 10`).all(ws) as (Omit<SyncRun, 'count'> & { undo_json: string })[])
    .map(({ undo_json, ...r }) => ({ ...r, count: (JSON.parse(undo_json) as unknown[]).length }));
}

// ───────────── ① 사전 등록 ─────────────

export type DraftInput =
  | { kind: 'word'; key: string; name: string; english_name: string; abbreviation: string; definition?: string }
  | { kind: 'domain'; key: string; name: string; data_type: string; description?: string }
  | { kind: 'term'; key: string; logical_name: string; physical_name: string; physical_abbr_name: string; domain_name: string | null; description?: string };
export type DraftResult = { key: string; ok: boolean; skipped?: string; error?: string };

/** 단어 → 도메인 → 용어 순서로 등록. 용어는 등록 직전에 같은 논리명·이름이 생겼는지 다시 본다. */
export async function applyDrafts(drafts: DraftInput[]): Promise<DraftResult[]> {
  const out: DraftResult[] = [];
  const dict = await dictionary(true);
  const order = { word: 0, domain: 1, term: 2 } as const;
  const squash = (v: string) => v.replace(/\s+/g, '');
  for (const d of [...drafts].sort((a, b) => order[a.kind] - order[b.kind])) {
    try {
      if (d.kind === 'word') {
        if (!d.name.trim() || !d.english_name.trim()) { out.push({ key: d.key, ok: false, error: '단어 이름과 영문명이 필요합니다.' }); continue; }
        if (dict.words.some((w) => w.name === d.name.trim() && (w.abbreviation ?? '').toUpperCase() === d.abbreviation.toUpperCase())) { out.push({ key: d.key, ok: true, skipped: '이미 있음' }); continue; }
        await createWord({ name: d.name.trim(), english_name: d.english_name.trim().toUpperCase(), abbreviation: d.abbreviation.trim().toUpperCase() || null, definition: d.definition ?? '' });
      } else if (d.kind === 'domain') {
        if (dict.domains.some((x) => x.name === d.name.trim())) { out.push({ key: d.key, ok: true, skipped: '이미 있음' }); continue; }
        const t = d.data_type.trim().toUpperCase();
        await createDictEntry('domain', { name: d.name.trim(), description: d.description ?? '', data_type_default: t, data_type_oracle: t });
      } else {
        const same = dict.terms.find((t) => squash(t.logical_name) === squash(d.logical_name));
        if (same) { out.push({ key: d.key, ok: false, skipped: `같은 논리명의 용어가 이미 있음: ${standardName(same)}` }); continue; }
        const name = d.physical_abbr_name.trim().toUpperCase();
        const clash = dict.terms.find((t) => standardName(t) === name);
        if (clash) { out.push({ key: d.key, ok: false, skipped: `같은 이름의 용어가 이미 있음: ${clash.logical_name}` }); continue; }
        await createTerm({ logical_name: d.logical_name.trim(), physical_name: d.physical_name.trim().toUpperCase(), physical_abbr_name: name, domain_name: d.domain_name, description: d.description ?? '' });
      }
      out.push({ key: d.key, ok: true });
    } catch (err) {
      out.push({ key: d.key, ok: false, error: (err as Error).message });
    }
  }
  return out;
}

// ───────────── ② ERD 반영 ─────────────

type Undo =
  | { op: 'update'; column_id: string; patch: Partial<ColumnInput> }
  | { op: 'delete_column'; column_id: string }
  | { op: 'delete_table'; table_id: string }
  | { op: 'create_column'; table_id: string; column: ColumnInput }
  | { op: 'create_table'; table: { physical_name: string; logical_name: string }; columns: ColumnInput[] };

export type ErdApplyResult = { run_id: number | null; applied: number; failed: { key: string; action: string; error: string }[]; skipped: number };

const MAX_ACTIONS = 500;
const asInput = (c: ErdColumn): ColumnInput => ({
  logical_name: c.logical_name, physical_name: c.physical_name, data_type: columnType(c) ?? 'VARCHAR2(100)',
  is_primary_key: c.is_primary_key, is_nullable: c.is_nullable, is_unique: c.is_unique, default_value: c.default_value ?? undefined,
  description: c.description ?? undefined, order_index: c.order_index, term_dictionary_id: c.term_dictionary_id,
});

/** 고른 항목의 ERD 할 일을 지금 판정으로 다시 만들어 반영한다(화면의 판정이 오래됐어도 지금 상태 기준). */
/** kinds를 주면 그 종류의 할 일만(삭제는 화면에서 따로 골라야 반영) */
export async function applyErd(sessionId: number, keys: string[], kinds?: string[]): Promise<ErdApplyResult> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const report = await syncReport(sessionId);
  if (!report.erd_project) throw new Error(report.error ?? 'ERD가 없습니다.');
  const pid = report.erd_project.id;
  const want = new Set(keys);
  const erd = await erdProject(pid, true);
  const colById = new Map(erd.tables.flatMap((t) => t.columns).map((c) => [c.id, c]));
  const tableByName = new Map(erd.tables.map((t) => [t.physical_name.toUpperCase(), t.id]));

  // 컬럼마다 바꿀 값을 하나로 모은다(이름·논리명·타입·용어를 한 번에)
  const patches = new Map<string, { key: string; patch: Partial<ColumnInput>; before: Partial<ColumnInput> }>();
  const creates: { key: string; a: Extract<SyncAction, { target: 'erd' }> }[] = [];
  let skipped = 0; let count = 0;
  for (const it of report.items) {
    if (!want.has(it.key) || it.status !== 'todo') continue;
    for (const a of actionsOf(it)) {
      if (a.target !== 'erd' || (kinds && !kinds.includes(a.kind))) continue;
      if (count >= MAX_ACTIONS) { skipped++; continue; }
      count++;
      if (a.kind === 'rename_column' || a.kind === 'set_logical' || a.kind === 'set_type' || a.kind === 'link_term') {
        const c = colById.get(a.column_id);
        if (!c) { skipped++; continue; }
        const p = patches.get(a.column_id) ?? { key: it.key, patch: {}, before: {} };
        if (a.kind === 'rename_column') { p.patch.physical_name = a.after; p.before.physical_name = c.physical_name; }
        if (a.kind === 'set_logical') { p.patch.logical_name = a.after; p.before.logical_name = c.logical_name; }
        if (a.kind === 'set_type') { p.patch.data_type = a.after; p.before.data_type = columnType(c) ?? undefined; }
        if (a.kind === 'link_term') { p.patch.term_dictionary_id = a.after; p.before.term_dictionary_id = c.term_dictionary_id; }
        patches.set(a.column_id, p);
      } else creates.push({ key: it.key, a });
    }
  }

  const undo: Undo[] = [];
  const failed: ErdApplyResult['failed'] = [];
  let applied = 0;
  const run = async (key: string, label: string, f: () => Promise<void>) => {
    try { await f(); applied++; } catch (err) { failed.push({ key, action: label, error: (err as Error).message }); }
  };

  // 테이블 추가 → 컬럼 추가 → 수정 → 삭제 순서
  for (const { key, a } of creates) if (a.kind === 'add_table') {
    await run(key, `테이블 ${a.table} 추가`, async () => {
      const t = await erdApi.createTable(pid, { physical_name: a.table, logical_name: a.logical_name });
      tableByName.set(a.table, t.id);
      undo.push({ op: 'delete_table', table_id: t.id });
    });
  }
  for (const { key, a } of creates) if (a.kind === 'add_column') {
    const tableId = a.table_id ?? tableByName.get(a.table);
    if (!tableId) { failed.push({ key, action: `컬럼 ${a.physical_name} 추가`, error: `ERD에 테이블 ${a.table}이 없습니다(테이블 추가를 같이 고르세요).` }); continue; }
    await run(key, `컬럼 ${a.table}.${a.physical_name} 추가`, async () => {
      const c = await erdApi.createColumn(pid, tableId, {
        physical_name: a.physical_name, logical_name: a.logical_name, data_type: a.data_type ?? 'VARCHAR2(100)',
        is_primary_key: a.is_primary_key, is_nullable: a.is_nullable, term_dictionary_id: a.term_id,
      });
      undo.push({ op: 'delete_column', column_id: c.id });
    });
  }
  for (const [id, p] of patches) {
    await run(p.key, `컬럼 ${colById.get(id)?.physical_name ?? id} 수정`, async () => {
      await erdApi.updateColumn(pid, id, p.patch);
      undo.push({ op: 'update', column_id: id, patch: p.before });
    });
  }
  for (const { key, a } of creates) {
    if (a.kind === 'delete_column') {
      const c = colById.get(a.column_id);
      if (!c) continue;
      await run(key, `컬럼 ${a.physical_name} 삭제`, async () => {
        await erdApi.deleteColumn(pid, a.column_id);
        undo.push({ op: 'create_column', table_id: c.table_id, column: asInput(c) });
      });
    } else if (a.kind === 'delete_table') {
      const t = erd.tables.find((x) => x.id === a.table_id);
      if (!t) continue;
      await run(key, `테이블 ${a.physical_name} 삭제`, async () => {
        await erdApi.deleteTable(pid, a.table_id);
        undo.push({ op: 'create_table', table: { physical_name: t.physical_name, logical_name: t.logical_name }, columns: t.columns.map(asInput) });
      });
    }
  }
  invalidateErd(pid);
  let runId: number | null = null;
  if (undo.length) {
    const r = db.prepare(`INSERT INTO sync_runs (workspace_id, erd_project_id, summary, undo_json) VALUES (?, ?, ?, ?)`)
      .run(s.workspace_id, pid, `ERD ${applied}건 반영${failed.length ? `, ${failed.length}건 실패` : ''}`, JSON.stringify(undo));
    runId = Number(r.lastInsertRowid);
  }
  return { run_id: runId, applied, failed, skipped };
}

/** ERD 반영 한 번을 거꾸로 되돌린다 */
export async function undoRun(sessionId: number, runId: number): Promise<{ undone: number; failed: string[] }> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const row = db.prepare(`SELECT erd_project_id, undo_json, undone_at FROM sync_runs WHERE id = ? AND workspace_id = ?`).get(runId, s.workspace_id) as { erd_project_id: string; undo_json: string; undone_at: string | null } | undefined;
  if (!row) throw new Error('반영 기록이 없습니다.');
  if (row.undone_at) throw new Error('이미 되돌렸습니다.');
  const pid = row.erd_project_id;
  const ops = (JSON.parse(row.undo_json) as Undo[]).reverse();
  let undone = 0; const failed: string[] = [];
  for (const u of ops) {
    try {
      if (u.op === 'update') await erdApi.updateColumn(pid, u.column_id, u.patch);
      else if (u.op === 'delete_column') await erdApi.deleteColumn(pid, u.column_id);
      else if (u.op === 'delete_table') await erdApi.deleteTable(pid, u.table_id);
      else if (u.op === 'create_column') await erdApi.createColumn(pid, u.table_id, u.column);
      else {
        const t = await erdApi.createTable(pid, u.table);
        for (const c of u.columns) await erdApi.createColumn(pid, t.id, c);
      }
      undone++;
    } catch (err) { failed.push((err as Error).message); }
  }
  db.prepare(`UPDATE sync_runs SET undone_at = datetime('now') WHERE id = ?`).run(runId);
  invalidateErd(pid);
  return { undone, failed };
}

// ───────────── ③ 소스 할 일 ─────────────

export type SourceTodo = {
  key: string; table: string; column: string | null; logical: string | null; term: string | null;
  actions: Extract<SyncAction, { target: 'source' }>[];
  /** 옛 이름을 쓰는 매퍼·JPA 위치(rename·drop일 때) */
  usages: { project_name: string; file: string; line: number; text: string }[];
};

export async function sourceTodo(sessionId: number, keys?: string[]): Promise<{ todos: SourceTodo[]; roots: string[]; text: string }> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const report = await syncReport(sessionId);
  const want = keys?.length ? new Set(keys) : null;
  const refs = sessionRefs(s, await addedBySession(s));
  const todos: SourceTodo[] = [];
  for (const it of report.items) {
    if ((want && !want.has(it.key)) || it.status !== 'todo') continue;
    const acts = actionsOf(it).filter((a): a is Extract<SyncAction, { target: 'source' }> => a.target === 'source');
    if (!acts.length) continue;
    const olds = new Set(acts.flatMap((a) => (a.kind === 'rename_column' ? [a.before] : a.kind === 'drop_column' ? [a.column] : [])));
    const usages = olds.size ? refs.filter((r) => r.column && olds.has(r.column) && (r.table === it.table || r.candidates?.includes(it.table)))
      .slice(0, 30).map((r) => ({ project_name: r.project_name, file: r.file, line: r.line, text: r.text })) : [];
    todos.push({ key: it.key, table: it.table, column: it.column, logical: it.logical, term: it.term ? `${it.term.logical_name}(${it.term.standard}, ${it.term.domain_name ?? '-'})` : null, actions: acts, usages });
  }
  const roots = report.apps.flatMap((a) => a.roots.map((r) => `${a.project_name}/${r}`));
  return { todos, roots, text: sourceTodoText(todos, roots) };
}

const actionText = (a: Extract<SyncAction, { target: 'source' }>): string => {
  switch (a.kind) {
    case 'rename_column': return `renameColumn ${a.table}.${a.before} → ${a.after}`;
    case 'modify_type': return `modifyDataType ${a.table}.${a.column}: ${a.before ?? '?'} → ${a.after}`;
    case 'set_remarks': return `코멘트 ${a.table}.${a.column}: "${a.after}"`;
    case 'add_column': return `addColumn ${a.table}.${a.column} ${a.data_type ?? ''} (${a.logical_name})`;
    case 'drop_column': return `dropColumn ${a.table}.${a.column}`;
    case 'add_table': return `createTable ${a.table} (${a.logical_name}): ${a.columns.map((c) => `${c.name} ${c.type ?? ''}`).join(', ')}`;
    case 'drop_table': return `dropTable ${a.table}`;
  }
};

export function sourceTodoText(todos: SourceTodo[], roots: string[]): string {
  if (!todos.length) return '소스 쪽 할 일이 없습니다.';
  const lines = [
    '용어사전·ERD와 맞추기 위한 소스 변경 목록입니다. 아래 규칙을 지켜 고쳐 주세요.',
    '- 이미 적용된 changeset은 고치지 않습니다(체크섬). 새 changeset 파일을 만들고 master changelog에 include를 더합니다.',
    roots.length ? `- master changelog: ${roots.join(', ')}` : '- Liquibase가 없으면 DDL 파일을 고칩니다.',
    '- 이름을 바꾸면 그 컬럼을 쓰는 매퍼 XML·JPA 엔티티(@Column name)·DTO도 같이 고칩니다. 아래 "쓰는 곳"을 보세요.',
    '- 기존 changeset 형식(preConditions onFail=MARK_RAN, COMMENT ON COLUMN)을 따릅니다.',
    '- 다 고친 뒤 schema_check 도구로 없는 컬럼·옛 이름 사용이 남았는지 확인합니다.',
    '',
  ];
  for (const t of todos) {
    lines.push(`## ${t.key}${t.logical ? ` (${t.logical})` : ''}${t.term ? ` — 용어 ${t.term}` : ''}`);
    for (const a of t.actions) lines.push(`- ${actionText(a)}`);
    if (t.usages.length) {
      lines.push('  쓰는 곳:');
      for (const u of t.usages.slice(0, 10)) lines.push(`  - ${u.project_name}/${u.file}:${u.line}  ${u.text}`);
      if (t.usages.length > 10) lines.push(`  - … ${t.usages.length - 10}곳 더`);
    }
  }
  return lines.join('\n');
}
