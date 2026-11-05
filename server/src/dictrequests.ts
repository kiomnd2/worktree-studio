import { db } from './db.js';
import { broadcast } from './hub.js';
import { getSession } from './sessions.js';
import { createDictEntry, createTerm, createWord, dictionary, erdApi, erdProject, updateDictEntry, type DictEntry, type DictKind, type ErdProject } from './erdvibe.js';
import { normalizeIdent, standardName } from './dict/judge.js';
import { ISSUES, type Issue } from './dict/extract.js';
import { checkSession, sessionErdId, setIgnore } from './dictscan.js';
import { hasBaseline, holdBaseline, snapshotBaseline } from './dictbaseline.js';

/**
 * Claude가 만든 초안: 사전에 없는 용어·단어 등록(dict_request_term), ERD 테이블·컬럼 추가·변경(erd_request_change),
 * 검사 예외·보류(dict_request_exception), 기준선 저장(dict_request_baseline), 용어·단어·도메인 추가·수정(dict_request_edit).
 * 사용자가 화면에서 고쳐 승인해야 erd-vibe(팀 공유)에 반영된다. Claude가 직접 쓰지는 못한다.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS dict_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
`);

export type TermPayload = { logical_name: string; physical_name: string; physical_abbr_name: string | null; domain_name: string | null; description: string };
export type WordPayload = { name: string; english_name: string; abbreviation: string | null; definition: string };
/** term은 용어 표준 이름(약어명). 있으면 승인할 때 용어 연결(term_dictionary_id)을 채운다. */
export type ColumnDraft = { physical_name: string; logical_name: string; data_type: string; is_primary_key?: boolean; is_nullable?: boolean; term?: string | null };
export type ErdPayload =
  | { action: 'add_table'; table: { physical_name: string; logical_name: string; description?: string; columns: ColumnDraft[] } }
  | { action: 'add_column'; table: string; column: ColumnDraft }
  | { action: 'update_column'; table: string; column: string; patch: Partial<ColumnDraft> }
  | { action: 'drop_column'; table: string; column: string };
/** ignore: 검사에서 뺀다. hold: 기준선 상태를 보류로(남은 일로는 세지만 위반·막힘 집계에서 빠진다). table·issue가 비면 전부 */
export type ExceptionPayload = { mode: 'ignore' | 'hold'; name: string; table: string; issue: Issue | ''; note: string };
export type BaselinePayload = { scope: 'all' };
export const EDIT_FIELDS: Record<DictKind, string[]> = {
  term: ['logical_name', 'physical_name', 'physical_abbr_name', 'domain_name', 'description'],
  word: ['name', 'english_name', 'abbreviation', 'definition'],
  domain: ['name', 'data_type_default', 'data_type_oracle', 'data_type_mysql', 'data_type_postgresql', 'description'],
};
const REQUIRED: Record<DictKind, string[]> = {
  term: ['logical_name', 'physical_name', 'description'], word: ['name', 'english_name', 'definition'], domain: ['name', 'data_type_default'],
};
const UPPER_FIELDS = new Set(['physical_name', 'physical_abbr_name', 'english_name', 'abbreviation']);
/** update는 id와 바꾸기 전 값(before)을 요청 때 찍어 둔다. values는 바꿀 칸만 */
export type DictEditPayload = { entity: DictKind; action: 'create' | 'update'; id: string | null; target: string; before: Record<string, string | null> | null; values: Record<string, string | null> };
export type RequestInput = { kind: 'term'; payload: TermPayload } | { kind: 'word'; payload: WordPayload } | { kind: 'erd'; payload: ErdPayload }
  | { kind: 'exception'; payload: ExceptionPayload } | { kind: 'baseline'; payload: BaselinePayload } | { kind: 'dict_edit'; payload: DictEditPayload };
export type DictRequest = {
  id: number; session_id: number; reason: string; source: 'claude' | 'user';
  status: 'pending' | 'done' | 'rejected' | 'failed'; error: string | null; created_at: string; resolved_at: string | null;
} & RequestInput;

type Row = Omit<DictRequest, 'payload' | 'kind'> & { kind: RequestInput['kind']; payload: string };
const view = (r: Row) => ({ ...r, payload: JSON.parse(r.payload) }) as DictRequest;

/** 처리할 요청(대기·실패)은 전부, 처리 끝난 요청은 최근 200건만. 대기까지 잘라 버리면 일괄 승인이 화면에 보이는 것만 처리하고 개수가 그대로인 것처럼 보인다. */
export function listDictRequests(sessionId: number): DictRequest[] {
  const open = db.prepare(`SELECT * FROM dict_requests WHERE session_id = ? AND status IN ('pending', 'failed') ORDER BY id DESC`).all(sessionId) as Row[];
  const closed = db.prepare(`SELECT * FROM dict_requests WHERE session_id = ? AND status NOT IN ('pending', 'failed') ORDER BY id DESC LIMIT 200`).all(sessionId) as Row[];
  return [...open, ...closed].map(view);
}
export const pendingDictRequests = (sessionId: number) => listDictRequests(sessionId).filter((r) => r.status === 'pending');

function get(id: number): DictRequest {
  const r = db.prepare(`SELECT * FROM dict_requests WHERE id = ?`).get(id) as Row | undefined;
  if (!r) throw new Error('등록 요청이 없습니다.');
  return view(r);
}

/** 이미 사전에 있으면(같은 물리명·약어명·논리명·단어명) 만들지 않고 알려 준다. exceptId: 수정 중인 항목 자신 */
export async function duplicateOf(kind: 'term' | 'word', p: TermPayload | WordPayload, exceptId?: string): Promise<string | null> {
  const all = await dictionary();
  const d = { terms: all.terms.filter((x) => x.id !== exceptId), words: all.words.filter((x) => x.id !== exceptId) };
  const U = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
  if (kind === 'term') {
    const t = p as TermPayload;
    const hit = d.terms.find((x) => U(x.physical_name) === U(t.physical_name) || (t.physical_abbr_name && U(x.physical_abbr_name) === U(t.physical_abbr_name)) || x.logical_name.replace(/\s+/g, '') === t.logical_name.replace(/\s+/g, ''));
    return hit ? `이미 있는 용어입니다: ${hit.logical_name} (${hit.physical_abbr_name || hit.physical_name})` : null;
  }
  const w = p as WordPayload;
  const hit = d.words.find((x) => x.name === w.name.trim());
  return hit ? `이미 있는 단어입니다: ${hit.name} (${hit.abbreviation || hit.english_name})` : null;
}

export async function createDictRequest(sessionId: number, input: RequestInput, reason: string, source: 'claude' | 'user'): Promise<DictRequest> {
  if (input.kind === 'erd') validateErd(input.payload);
  else if (input.kind === 'exception') validateException(sessionId, input.payload);
  else if (input.kind === 'baseline') { /* 승인할 때 검사한다 */ }
  else if (input.kind === 'dict_edit') input = { kind: 'dict_edit', payload: await prepareEdit(input.payload) };
  else {
    const dup = await duplicateOf(input.kind, input.payload).catch(() => null);
    if (dup) throw new Error(dup);
  }
  const same = pendingDictRequests(sessionId).find((r) => r.kind === input.kind && JSON.stringify(r.payload) === JSON.stringify(input.payload));
  if (same) return same;
  const id = Number(db.prepare(`INSERT INTO dict_requests (session_id, kind, payload, reason, source) VALUES (?, ?, ?, ?, ?)`)
    .run(sessionId, input.kind, JSON.stringify(input.payload), reason, source).lastInsertRowid);
  broadcast({ type: 'dict.requests', sessionId });
  return get(id);
}

function finish(r: DictRequest, status: DictRequest['status'], error: string | null, payload?: unknown) {
  db.prepare(`UPDATE dict_requests SET status = ?, error = ?, resolved_at = datetime('now')${payload ? ', payload = ?' : ''} WHERE id = ?`)
    .run(...(payload ? [status, error, JSON.stringify(payload), r.id] : [status, error, r.id]));
  broadcast({ type: 'dict.requests', sessionId: r.session_id });
}

/** 사용자가 (고친) 초안으로 승인 → erd-vibe·검사 설정에 반영. */
export async function approveDictRequest(id: number, payload: RequestInput['payload']): Promise<DictRequest> {
  const r = get(id);
  if (r.status !== 'pending' && r.status !== 'failed') throw new Error('이미 처리한 요청입니다.');
  try {
    if (r.kind === 'erd' || r.kind === 'exception' || r.kind === 'baseline' || r.kind === 'dict_edit') {
      if (r.kind === 'erd') await applyErd(r.session_id, payload as ErdPayload);
      else if (r.kind === 'exception') applyException(r.session_id, payload as ExceptionPayload);
      else if (r.kind === 'baseline') payload = { ...(payload as BaselinePayload), ...(await applyBaseline(r.session_id)) };
      else await applyEdit(payload as DictEditPayload);
      finish(r, 'done', null, payload);
      return get(id);
    }
    const dup = await duplicateOf(r.kind, payload as TermPayload | WordPayload);
    if (dup) throw new Error(dup);
    if (r.kind === 'term') {
      const t = payload as TermPayload;
      if (!t.logical_name.trim() || !t.physical_name.trim() || !t.description.trim()) throw new Error('논리명, 물리명, 설명은 꼭 넣어야 합니다.');
      await createTerm({ ...t, physical_name: t.physical_name.trim().toUpperCase(), physical_abbr_name: t.physical_abbr_name?.trim().toUpperCase() || null, domain_name: t.domain_name?.trim() || null });
    } else {
      const w = payload as WordPayload;
      if (!w.name.trim() || !w.english_name.trim() || !w.definition.trim()) throw new Error('단어, 영문명, 정의는 꼭 넣어야 합니다.');
      await createWord({ ...w, english_name: w.english_name.trim().toUpperCase(), abbreviation: w.abbreviation?.trim().toUpperCase() || null });
    }
    finish(r, 'done', null, payload);
  } catch (err) {
    finish(r, 'failed', (err as Error).message, payload);
  }
  return get(id);
}

export function rejectDictRequest(id: number) {
  const r = get(id);
  if (r.status === 'done') throw new Error('이미 등록한 요청입니다.');
  finish(r, 'rejected', null);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const workspaceOf = (sessionId: number) => {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  return s.workspace_id;
};

function validateException(sessionId: number, p: ExceptionPayload) {
  if (p.mode !== 'ignore' && p.mode !== 'hold') throw new Error('mode는 ignore 또는 hold입니다.');
  if (!normalizeIdent(p.name ?? '')) throw new Error('컬럼 이름이 필요합니다.');
  if (p.issue && !(ISSUES as readonly string[]).includes(p.issue)) throw new Error(`위반 종류는 ${ISSUES.join(', ')} 중 하나이거나 비워 둡니다.`);
  if (!p.note?.trim()) throw new Error('예외 사유(note)가 필요합니다.');
  if (p.mode === 'hold') {
    if (!hasBaseline(workspaceOf(sessionId))) throw new Error('보류는 기준선 항목에 거는 상태입니다. 기준선이 없으니 먼저 dict_request_baseline으로 기준선 저장을 요청하거나 mode "ignore"를 쓰세요.');
  }
}

function applyException(sessionId: number, p: ExceptionPayload) {
  validateException(sessionId, p);
  const ws = workspaceOf(sessionId);
  const name = normalizeIdent(p.name);
  const table = (p.table ?? '').trim().toUpperCase();
  if (p.mode === 'ignore') setIgnore(ws, name, p.note.trim(), table, p.issue);
  else if (!holdBaseline(ws, table, name, p.issue, p.note.trim())) throw new Error(`기준선에 ${table ? `${table}.` : ''}${name}${p.issue ? `(${p.issue})` : ''} 항목이 없습니다. 기준선을 다시 저장한 뒤 요청하세요.`);
  broadcast({ type: 'dict.updated' });
}

/** 전체 검사를 돌려 기준선에 더한다. 몇 건을 찍었는지 요청에 남긴다 */
async function applyBaseline(sessionId: number): Promise<{ findings: number; keys: number }> {
  const report = await checkSession(sessionId, 'all');
  const keys = snapshotBaseline(workspaceOf(sessionId), report.findings);
  broadcast({ type: 'dict.updated' });
  return { findings: report.findings.length, keys };
}

const cleanValues = (entity: DictKind, values: Record<string, string | null | undefined>) => {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!EDIT_FIELDS[entity].includes(k)) throw new Error(`${entity}에는 ${k} 칸이 없습니다. 고칠 수 있는 칸: ${EDIT_FIELDS[entity].join(', ')}`);
    const t = typeof v === 'string' ? v.trim() : null;
    out[k] = t ? (UPPER_FIELDS.has(k) ? t.toUpperCase() : t) : null;
  }
  return out;
};

const listOf = (d: Awaited<ReturnType<typeof dictionary>>, entity: DictKind): DictEntry[] => (entity === 'term' ? d.terms : entity === 'word' ? d.words : d.domains);
const pick = (entity: DictKind, e: DictEntry) => Object.fromEntries(EDIT_FIELDS[entity].map((k) => [k, ((e as unknown as Record<string, string | null>)[k] ?? null)]));

/** 수정 대상 찾기: id, 또는 용어는 표준 이름·물리명·논리명, 단어는 단어·약어, 도메인은 이름 */
async function findEntry(entity: DictKind, idOrName: string): Promise<DictEntry> {
  const d = await dictionary();
  const q = idOrName.trim();
  const Q = q.toUpperCase();
  const list = listOf(d, entity);
  const hit = list.find((e) => e.id === q) ?? list.find((e) => {
    if (entity === 'term') { const t = e as typeof d.terms[number]; return standardName(t) === Q || t.physical_name.toUpperCase() === Q || t.logical_name.replace(/\s+/g, '') === q.replace(/\s+/g, ''); }
    if (entity === 'word') { const w = e as typeof d.words[number]; return w.name === q || (w.abbreviation ?? '').toUpperCase() === Q; }
    return (e as typeof d.domains[number]).name === q;
  });
  if (!hit) throw new Error(`사전에 ${entity} "${idOrName}"이(가) 없습니다. dict_lookup으로 이름을 확인하세요.`);
  return hit;
}

async function checkEditDuplicate(p: DictEditPayload, body: Record<string, string | null>) {
  if (p.entity === 'domain') {
    const d = await dictionary();
    const hit = d.domains.find((x) => x.id !== p.id && x.name === body.name);
    if (hit) throw new Error(`이미 있는 도메인입니다: ${hit.name}`);
    return;
  }
  const dup = await duplicateOf(p.entity, body as never, p.id ?? undefined);
  if (dup) throw new Error(dup);
}

async function editBody(p: DictEditPayload): Promise<Record<string, string | null>> {
  const values = cleanValues(p.entity, p.values);
  const base = p.action === 'update' ? pick(p.entity, await findEntry(p.entity, p.id ?? p.target)) : {};
  const body = { ...base, ...values };
  for (const k of REQUIRED[p.entity]) if (!body[k]) throw new Error(`${k}은(는) 꼭 넣어야 합니다.`);
  if (p.entity === 'domain' || p.entity === 'term') {
    if (p.entity === 'term' && body.domain_name) {
      const d = await dictionary();
      if (!d.domains.some((x) => x.name === body.domain_name)) throw new Error(`도메인사전에 "${body.domain_name}" 도메인이 없습니다.`);
    }
  }
  return body;
}

/** 요청 때: 대상을 찾아 id와 바꾸기 전 값을 찍고, 바꿀 값을 검사한다 */
async function prepareEdit(p: DictEditPayload): Promise<DictEditPayload> {
  if (!['term', 'word', 'domain'].includes(p.entity)) throw new Error('entity는 term, word, domain 중 하나입니다.');
  if (p.action !== 'create' && p.action !== 'update') throw new Error('action은 create 또는 update입니다.');
  const values = cleanValues(p.entity, p.values);
  if (!Object.keys(values).length) throw new Error('바꿀 값(values)이 없습니다.');
  let next: DictEditPayload = { ...p, values, id: null, before: null };
  if (p.action === 'update') {
    const e = await findEntry(p.entity, p.id || p.target);
    const before = pick(p.entity, e);
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => (before[k] ?? null) !== v));
    if (!Object.keys(changed).length) throw new Error('지금 사전 값과 같습니다. 바꿀 것이 없습니다.');
    next = { ...next, id: e.id, before, values: changed, target: p.target || e.id };
  }
  await checkEditDuplicate(next, await editBody(next));
  return next;
}

async function applyEdit(p: DictEditPayload) {
  const body = await editBody(p);
  await checkEditDuplicate(p, body);
  // 사전 화면의 저장과 같게: 도메인은 빈 DBMS 칸을 보내지 않는다
  const sent = p.entity === 'domain' || p.action === 'create' ? Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)) : body;
  if (p.action === 'create') await createDictEntry(p.entity, sent);
  else await updateDictEntry(p.entity, p.id!, sent);
  broadcast({ type: 'dict.updated' });
}

function validateColumn(c: ColumnDraft, where: string) {
  if (!c || !IDENT.test(c.physical_name ?? '')) throw new Error(`${where}: 컬럼 물리명은 영문·숫자·밑줄이어야 합니다.`);
  if (!c.logical_name?.trim()) throw new Error(`${where}: 컬럼 논리명이 필요합니다.`);
  if (!c.data_type?.trim()) throw new Error(`${where}: 컬럼 타입이 필요합니다.`);
}

function validateErd(p: ErdPayload) {
  if (p.action === 'add_table') {
    if (!IDENT.test(p.table?.physical_name ?? '') || !p.table.logical_name?.trim()) throw new Error('테이블 물리명(영문·숫자·밑줄)과 논리명이 필요합니다.');
    if (!p.table.columns?.length) throw new Error('컬럼이 하나 이상 있어야 합니다.');
    p.table.columns.forEach((c, i) => validateColumn(c, `${i + 1}번째 컬럼`));
  } else if (p.action === 'add_column') {
    if (!p.table) throw new Error('테이블 이름이 필요합니다.');
    validateColumn(p.column, '컬럼');
  } else if (p.action === 'update_column' || p.action === 'drop_column') {
    if (!p.table || !p.column) throw new Error('테이블과 컬럼 이름이 필요합니다.');
  } else throw new Error('알 수 없는 ERD 변경입니다.');
}

const U = (s: string) => s.trim().toUpperCase();

async function termIdOf(term: string | null | undefined): Promise<string | null> {
  if (!term) return null;
  const d = await dictionary();
  return d.terms.find((t) => standardName(t) === U(term) || U(t.physical_name) === U(term))?.id ?? null;
}

async function columnBody(c: ColumnDraft, order: number) {
  return {
    physical_name: U(c.physical_name), logical_name: c.logical_name.trim(), data_type: c.data_type.trim(),
    is_primary_key: Boolean(c.is_primary_key), is_nullable: c.is_nullable ?? !c.is_primary_key, order_index: order,
    term_dictionary_id: await termIdOf(c.term),
  };
}

function tableOf(erd: ErdProject, name: string) {
  const t = erd.tables.find((x) => U(x.physical_name) === U(name));
  if (!t) throw new Error(`ERD에 테이블 ${name}이(가) 없습니다.`);
  return t;
}

/** 승인한 ERD 변경을 연결한 ERD에 반영한다. 순서대로 쓰다 실패하면 거기서 멈추고 오류를 남긴다. */
async function applyErd(sessionId: number, p: ErdPayload) {
  validateErd(p);
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const erdId = sessionErdId(s);
  if (!erdId) throw new Error('이 워크스페이스에 연결한 ERD가 없습니다.');
  const erd = await erdProject(erdId, true);
  if (p.action === 'add_table') {
    if (erd.tables.some((t) => U(t.physical_name) === U(p.table.physical_name))) throw new Error(`ERD에 이미 ${p.table.physical_name} 테이블이 있습니다.`);
    const right = Math.max(0, ...erd.tables.map((t) => t.position_x)) + 350;
    const created = await erdApi.createTable(erdId, { physical_name: U(p.table.physical_name), logical_name: p.table.logical_name.trim(), description: p.table.description, position_x: erd.tables.length ? right : 100, position_y: 100 });
    for (const [i, c] of p.table.columns.entries()) await erdApi.createColumn(erdId, created.id, await columnBody(c, i));
  } else if (p.action === 'add_column') {
    const t = tableOf(erd, p.table);
    if (t.columns.some((c) => U(c.physical_name) === U(p.column.physical_name))) throw new Error(`${t.physical_name}에 이미 ${p.column.physical_name} 컬럼이 있습니다.`);
    await erdApi.createColumn(erdId, t.id, await columnBody(p.column, t.columns.length));
  } else {
    const t = tableOf(erd, p.table);
    const col = t.columns.find((c) => U(c.physical_name) === U(p.column));
    if (!col) throw new Error(`${t.physical_name}에 ${p.column} 컬럼이 없습니다.`);
    if (p.action === 'drop_column') await erdApi.deleteColumn(erdId, col.id);
    else {
      const patch: Record<string, unknown> = {};
      if (p.patch.physical_name) patch.physical_name = U(p.patch.physical_name);
      if (p.patch.logical_name) patch.logical_name = p.patch.logical_name.trim();
      if (p.patch.data_type) patch.data_type = p.patch.data_type.trim();
      if (p.patch.is_nullable !== undefined) patch.is_nullable = p.patch.is_nullable;
      if (p.patch.is_primary_key !== undefined) patch.is_primary_key = p.patch.is_primary_key;
      if (p.patch.term) {
        const termId = await termIdOf(p.patch.term);
        if (!termId) throw new Error(`용어사전에 ${p.patch.term} 용어가 없습니다. 먼저 용어를 등록하세요.`);
        patch.term_dictionary_id = termId;
      }
      await erdApi.updateColumn(erdId, col.id, patch);
    }
  }
}

const ENTITY_LABEL: Record<DictKind, string> = { term: '용어', word: '단어', domain: '도메인' };

/** 요청 한 줄 요약(tool_context·목록용) */
export function requestLabel(r: RequestInput): string {
  if (r.kind === 'exception') return `${r.payload.mode === 'hold' ? '보류' : '예외'} ${r.payload.table ? `${r.payload.table}.` : ''}${r.payload.name}${r.payload.issue ? `(${r.payload.issue})` : ''}`;
  if (r.kind === 'baseline') return '기준선 저장';
  if (r.kind === 'dict_edit') return `${ENTITY_LABEL[r.payload.entity]} ${r.payload.action === 'create' ? '추가' : '수정'} ${r.payload.target || r.payload.values.name || r.payload.values.logical_name || ''}`;
  if (r.kind === 'term') return `용어 ${r.payload.logical_name}(${r.payload.physical_abbr_name ?? r.payload.physical_name})`;
  if (r.kind === 'word') return `단어 ${r.payload.name}`;
  const p = r.payload;
  if (p.action === 'add_table') return `ERD 테이블 추가 ${p.table.physical_name}`;
  if (p.action === 'add_column') return `ERD 컬럼 추가 ${p.table}.${p.column.physical_name}`;
  if (p.action === 'update_column') return `ERD 컬럼 변경 ${p.table}.${p.column}`;
  return `ERD 컬럼 삭제 ${p.table}.${p.column}`;
}
