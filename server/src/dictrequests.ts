import { db } from './db.js';
import { broadcast } from './hub.js';
import { getSession } from './sessions.js';
import { createTerm, createWord, dictionary, erdApi, erdProject, type ErdProject } from './erdvibe.js';
import { standardName } from './dict/judge.js';
import { sessionErdId } from './dictscan.js';

/**
 * Claude가 만든 초안: 사전에 없는 용어·단어 등록(dict_request_term), ERD 테이블·컬럼 추가·변경(erd_request_change).
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
export type RequestInput = { kind: 'term'; payload: TermPayload } | { kind: 'word'; payload: WordPayload } | { kind: 'erd'; payload: ErdPayload };
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

/** 사용자가 (고친) 초안으로 승인 → erd-vibe에 등록. */
export async function approveDictRequest(id: number, payload: TermPayload | WordPayload | ErdPayload): Promise<DictRequest> {
  const r = get(id);
  if (r.status !== 'pending' && r.status !== 'failed') throw new Error('이미 처리한 요청입니다.');
  try {
    if (r.kind === 'erd') {
      await applyErd(r.session_id, payload as ErdPayload);
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

/** 요청 한 줄 요약(tool_context·목록용) */
export function requestLabel(r: RequestInput): string {
  if (r.kind === 'term') return `용어 ${r.payload.logical_name}(${r.payload.physical_abbr_name ?? r.payload.physical_name})`;
  if (r.kind === 'word') return `단어 ${r.payload.name}`;
  const p = r.payload;
  if (p.action === 'add_table') return `ERD 테이블 추가 ${p.table.physical_name}`;
  if (p.action === 'add_column') return `ERD 컬럼 추가 ${p.table}.${p.column.physical_name}`;
  if (p.action === 'update_column') return `ERD 컬럼 변경 ${p.table}.${p.column}`;
  return `ERD 컬럼 삭제 ${p.table}.${p.column}`;
}
