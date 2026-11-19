import dagre from '@dagrejs/dagre';
import { db } from './db.js';
import { decrypt, encrypt } from './secret.js';
import type { Dictionary, Domain, ErdColumn, ErdMemo, ErdProject, ErdRelationship, ErdTable, RelationshipType, Term, Word } from './dict/types.js';

export * from './dict/types.js';

/**
 * erd-vibe(팀이 같이 쓰는 ERD·단어/용어/도메인 사전 도구)의 데이터에 Supabase(PostgREST)로 직접 붙는다.
 * erd-vibe 서버는 SSO 뒤에 있어 도구가 부를 수 없으므로, erd-vibe가 쓰는 Supabase 프로젝트의 공개 키로 같은 테이블을 읽고 쓴다.
 * erd-vibe 백엔드 라우트(routes/*.js)가 하던 확인(필수값, 중복)과 기본값·시각 채우기를 여기서 똑같이 한다.
 * 데이터의 원본은 erd-vibe(Supabase) 하나다. studio는 읽은 것을 잠깐 메모리에 두고, 고치면 바로 쓰고 캐시를 비운다.
 * 사전은 erd-vibe 전체에 하나뿐이라(프로젝트 구분 없음) 한 번 받아 두고, ERD 프로젝트는 워크스페이스마다 연결한다(세션은 dictscan.sessionErdId로 고른다).
 */

export type ErdProjectSummary = { id: string; name: string; description: string | null; dbms_type: string; updated_at: string | null };
export type DictKind = 'word' | 'term' | 'domain';

/** base_url은 erd-vibe 화면 링크용. 데이터는 supabase_url·supabase_key로 읽고 쓴다. api_key는 예전 설정(쓰지 않음). */
type State = { base_url?: string; supabase_url?: string; supabase_key?: string; api_key?: string };
export const DEFAULT_URL = 'https://erd-vibe.dev.60hz.co';
const DICT_CACHE_MS = 60_000;
const ERD_CACHE_MS = 60_000;
/** Supabase PostgREST는 한 번에 1000행까지 돌려준다. */
const PAGE = 1000;

function load(): State {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'erd_vibe'`).get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as State) : {};
}
function save(next: State) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('erd_vibe', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
}

/** Supabase 주소와 키를 넣었으면 연동을 쓰는 것으로 본다(안 쓰는 사람에게 Claude 규칙·PR 단계를 붙이지 않게). */
export function erdConfigured(): boolean {
  const s = load();
  return Boolean(s.supabase_url && s.supabase_key);
}

const baseUrl = () => (load().base_url || DEFAULT_URL).replace(/\/+$/, '');

export function erdConfigView() {
  const s = load();
  return { base_url: baseUrl(), supabase_url: s.supabase_url ?? '', has_key: Boolean(s.supabase_key), configured: erdConfigured() };
}

const httpUrl = (v: string, label: string) => {
  const url = v.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) throw new Error(`${label}는 http:// 또는 https:// 로 시작해야 합니다.`);
  return url || undefined;
};

/** supabase_key: undefined면 그대로, ''면 지운다. */
export function saveErdConfig(patch: { base_url?: string; supabase_url?: string; supabase_key?: string }) {
  const s = load();
  if (patch.base_url !== undefined) s.base_url = httpUrl(patch.base_url, 'erd-vibe 주소');
  if (patch.supabase_url !== undefined) s.supabase_url = httpUrl(patch.supabase_url, 'Supabase 주소');
  if (patch.supabase_key !== undefined) s.supabase_key = patch.supabase_key.trim() ? encrypt(patch.supabase_key.trim()) : undefined;
  delete s.api_key;
  save(s);
  dict = null;
  erdCache.clear();
}

// ── Supabase(PostgREST) ─────────────────────────────

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Row = Record<string, unknown>;

const enc = encodeURIComponent;
/** PostgREST 필터 값. eq.<값> */
const eq = (v: string) => `eq.${enc(v)}`;
const now = () => new Date().toISOString();

async function rest<T>(method: Method, table: string, query: string, opts: { body?: unknown; single?: boolean } = {}): Promise<T> {
  const s = load();
  const key = decrypt(s.supabase_key ?? null);
  if (!s.supabase_url || !key) throw new Error('erd-vibe 연동이 설정되지 않았습니다. 설정 › erd-vibe 용어사전에 Supabase 주소와 키를 넣으세요.');
  const headers: Record<string, string> = {
    apikey: key,
    Accept: opts.single ? 'application/vnd.pgrst.object+json' : 'application/json',
    // 새 형식 키(sb_publishable_…)는 JWT가 아니라 apikey 헤더로만 보낸다. 예전 anon 키(JWT)는 Authorization에도 넣는다.
    ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }),
    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(method !== 'GET' ? { Prefer: 'return=representation' } : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${s.supabase_url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
      method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === 'TimeoutError' ? 'Supabase가 30초 안에 답하지 않았습니다.' : `Supabase에 연결하지 못했습니다: ${e.message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* HTML 등 */ }
  if (!res.ok) {
    const e = (json ?? {}) as { message?: string; code?: string; details?: string; hint?: string };
    if (res.status === 401 || res.status === 403) throw new Error(`Supabase가 거부했습니다(${res.status}). 설정의 Supabase 주소와 키를 확인하세요.${e.message ? ` (${e.message})` : ''}`);
    if (e.code === '23505') throw new Error(`이미 있는 값입니다: ${e.details ?? e.message ?? ''}`);
    throw new Error(`Supabase 요청이 실패했습니다(${res.status}): ${e.message ?? text.slice(0, 200)}${e.details ? ` · ${e.details}` : ''}`);
  }
  return json as T;
}

/** 1000행 제한을 넘는 표를 끝까지 읽는다. order에는 겹치지 않게 id를 뒤에 붙인다. */
async function restAll<T>(table: string, select: string, order: string, filter = ''): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await rest<T[]>('GET', table, `select=${enc(select)}${filter ? `&${filter}` : ''}&order=${order},id.asc&limit=${PAGE}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const insertOne = async <T>(table: string, row: Row) => (await rest<T[]>('POST', table, '', { body: row }))[0];
const updateOne = async <T>(table: string, id: string, patch: Row) => {
  const rows = await rest<T[]>('PATCH', table, `id=${eq(id)}`, { body: patch });
  if (!rows.length) throw new Error(`${table}에서 ${id}를 찾지 못했습니다.`);
  return rows[0];
};
const deleteOne = (table: string, id: string) => rest<unknown>('DELETE', table, `id=${eq(id)}`);
const exists = async (table: string, filter: string) => (await rest<Row[]>('GET', table, `select=id&${filter}&limit=1`)).length > 0;

function required(body: Row, fields: string[], label: Record<string, string>) {
  const missing = fields.filter((f) => typeof body[f] !== 'string' || !(body[f] as string).trim());
  if (missing.length) throw new Error(`${missing.map((f) => label[f] ?? f).join(', ')}이(가) 필요합니다.`);
}

// ── 사전 ─────────────────────────────────────────────

let dict: Dictionary | null = null;
let loading: Promise<Dictionary> | null = null;

/** 단어·용어·도메인 사전 전체. 1분 동안 메모리에 두고, force면 다시 받는다. 용어에는 erd-vibe처럼 domain_info를 붙인다. */
export async function dictionary(force = false): Promise<Dictionary> {
  if (!force && dict && Date.now() - dict.loaded_at < DICT_CACHE_MS) return dict;
  if (loading) return loading;
  loading = (async () => {
    const [words, terms, domains] = await Promise.all([
      restAll<Word>('word_dictionary', '*', 'name.asc'),
      restAll<Term>('term_dictionary', '*', 'logical_name.asc'),
      restAll<Domain>('domain_dictionary', '*', 'name.asc'),
    ]);
    const byName = new Map(domains.map((d) => [d.name, d]));
    const withInfo = terms.map((t) => {
      const d = t.domain_name ? byName.get(t.domain_name) : undefined;
      if (!t.domain_name) return { ...t, domain_info: null };
      if (!d) return t;
      const r = d as unknown as Row;
      return { ...t, domain_info: { name: r.name, data_type_default: r.data_type_default, data_type_oracle: r.data_type_oracle, data_type_mysql: r.data_type_mysql, data_type_postgresql: r.data_type_postgresql, description: r.description } };
    }) as Term[];
    dict = { words, terms: withInfo, domains, loaded_at: Date.now() };
    return dict;
  })().finally(() => { loading = null; });
  return loading;
}

export const invalidateDictionary = () => { dict = null; };

/** 연결 확인. 사전 건수까지 받아 본다. */
export async function erdStatus(): Promise<{ ok: boolean; error: string | null; counts: { words: number; terms: number; domains: number } | null; loaded_at: number | null }> {
  try {
    const d = await dictionary(true);
    return { ok: true, error: null, counts: { words: d.words.length, terms: d.terms.length, domains: d.domains.length }, loaded_at: d.loaded_at };
  } catch (err) {
    return { ok: false, error: (err as Error).message, counts: null, loaded_at: null };
  }
}

const DICT_TABLE: Record<DictKind, string> = { word: 'word_dictionary', term: 'term_dictionary', domain: 'domain_dictionary' };
const DICT_LIST: Record<DictKind, 'words' | 'terms' | 'domains'> = { word: 'words', term: 'terms', domain: 'domains' };
export type DictEntry = Word | Term | Domain;

const DICT_LABEL: Record<string, string> = {
  name: '이름', english_name: '영문명', definition: '정의', logical_name: '논리명', physical_name: '물리명', description: '설명', data_type_default: '기본 타입',
};
const DOMAIN_FIELDS = ['name', 'data_type_default', 'data_type_oracle', 'data_type_mysql', 'data_type_postgresql', 'description'] as const;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** erd-vibe의 사전 POST와 같다: 필수값 확인, 같은 이름(단어·도메인)·물리명(용어)이 있으면 거절, 빈 선택값은 null. */
function dictInsertRow(kind: DictKind, b: Row): { row: Row; dupFilter: string; dupMessage: string } {
  if (kind === 'word') {
    required(b, ['name', 'english_name', 'definition'], DICT_LABEL);
    return {
      row: { name: b.name, english_name: b.english_name, abbreviation: str(b.abbreviation) || null, definition: b.definition },
      dupFilter: `name=${eq(String(b.name))}`, dupMessage: '이미 존재하는 단어명입니다',
    };
  }
  if (kind === 'term') {
    required(b, ['logical_name', 'physical_name', 'description'], DICT_LABEL);
    return {
      row: { logical_name: b.logical_name, physical_name: b.physical_name, physical_abbr_name: str(b.physical_abbr_name) || null, domain_name: str(b.domain_name) || null, description: b.description },
      dupFilter: `physical_name=${eq(String(b.physical_name))}`, dupMessage: '이미 존재하는 물리명입니다',
    };
  }
  required(b, ['name', 'data_type_default', 'description'], DICT_LABEL);
  const row: Row = { name: b.name, data_type_default: b.data_type_default, description: b.description };
  for (const k of ['data_type_oracle', 'data_type_mysql', 'data_type_postgresql'] as const) if (str(b[k])) row[k] = b[k];
  return { row, dupFilter: `name=${eq(String(b.name))}`, dupMessage: '동일한 도메인명이 이미 존재합니다' };
}

/** erd-vibe의 사전 PUT과 같다: 단어·용어는 보낸 칸을 그대로(빈 약어·도메인·약어명은 null), 도메인은 정해진 칸만. */
function dictUpdatePatch(kind: DictKind, b: Row): Row {
  if (kind === 'domain') return Object.fromEntries(DOMAIN_FIELDS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
  const p: Row = { ...b };
  delete p.id; delete p.created_at; delete p.updated_at; delete p.domain_info;
  for (const k of ['name', 'english_name', 'definition', 'logical_name', 'physical_name', 'description']) {
    if (p[k] !== undefined && (typeof p[k] !== 'string' || !(p[k] as string).trim())) throw new Error(`${DICT_LABEL[k] ?? k}은(는) 비울 수 없습니다.`);
  }
  for (const k of kind === 'word' ? ['abbreviation'] : ['domain_name', 'physical_abbr_name']) if (p[k] === '') p[k] = null;
  return p;
}

/** 사전 항목 추가·수정·삭제. 반영한 뒤 캐시도 같게 고쳐 둔다(다음 검사에 바로 쓰이게). */
export async function createDictEntry(kind: DictKind, body: Record<string, unknown>): Promise<DictEntry> {
  const { row, dupFilter, dupMessage } = dictInsertRow(kind, body);
  if (await exists(DICT_TABLE[kind], dupFilter)) throw new Error(dupMessage);
  const created = await insertOne<DictEntry>(DICT_TABLE[kind], row);
  if (dict) (dict[DICT_LIST[kind]] as DictEntry[]).push(created);
  return created;
}
export async function updateDictEntry(kind: DictKind, id: string, body: Record<string, unknown>): Promise<DictEntry> {
  const updated = await updateOne<DictEntry>(DICT_TABLE[kind], id, dictUpdatePatch(kind, body));
  if (dict) {
    const list = dict[DICT_LIST[kind]] as DictEntry[];
    const i = list.findIndex((e) => e.id === id);
    if (i >= 0) list[i] = { ...list[i], ...updated };
  }
  return updated;
}
export async function deleteDictEntries(kind: DictKind, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await rest('DELETE', DICT_TABLE[kind], `id=in.(${ids.map(enc).join(',')})`);
  if (dict) {
    const gone = new Set(ids);
    (dict as Record<string, unknown>)[DICT_LIST[kind]] = (dict[DICT_LIST[kind]] as DictEntry[]).filter((e) => !gone.has(e.id));
  }
}

export const createTerm = (t: { logical_name: string; physical_name: string; physical_abbr_name: string | null; domain_name: string | null; description: string }) =>
  createDictEntry('term', t) as Promise<Term>;
export const createWord = (w: { name: string; english_name: string; abbreviation: string | null; definition: string }) =>
  createDictEntry('word', w) as Promise<Word>;

// ── ERD ─────────────────────────────────────────────

const summary = (r: Row): ErdProjectSummary => ({
  id: String(r.id), name: String(r.name ?? ''), description: (r.description as string | null) ?? null, dbms_type: (r.dbms_type as string) || 'ORACLE', updated_at: (r.updated_at as string | null) ?? null,
});

export async function listErdProjects(): Promise<ErdProjectSummary[]> {
  return (await restAll<Row>('erd_projects', '*', 'name.asc')).map(summary);
}

export async function createErdProject(p: { name: string; description?: string; author?: string }): Promise<ErdProjectSummary> {
  if (!p.name?.trim()) throw new Error('프로젝트 이름이 필요합니다.');
  const t = now();
  return summary(await insertOne<Row>('erd_projects', { name: p.name, description: p.description ?? null, author: p.author ?? null, canvas_data: {}, created_at: t, updated_at: t }));
}

const erdCache = new Map<string, { at: number; project: ErdProject }>();

type RawTable = Partial<ErdTable> & { id: string; columns?: Partial<ErdColumn>[]; relationships_from?: ErdRelationship[]; relationships_to?: ErdRelationship[] };

function normalizeProject(p: Omit<Partial<ErdProject>, "tables"> & { id: string; tables?: RawTable[]; memos?: ErdMemo[] }): ErdProject {
  const rels = new Map<string, ErdRelationship>();
  const tables = ((p.tables ?? []) as RawTable[]).map((t): ErdTable => {
    for (const r of [...(t.relationships_from ?? []), ...(t.relationships_to ?? [])]) rels.set(r.id, { ...r, description: r.description ?? null });
    return {
      id: t.id, logical_name: t.logical_name ?? '', physical_name: t.physical_name ?? '', description: t.description ?? null,
      position_x: Number(t.position_x ?? 0), position_y: Number(t.position_y ?? 0), header_color: t.header_color ?? null,
      default_has_pk_auto_increment: t.default_has_pk_auto_increment ?? null, updated_at: t.updated_at ?? null,
      columns: (t.columns ?? []).map((c): ErdColumn => ({
        id: c.id!, table_id: t.id, logical_name: c.logical_name ?? '', physical_name: c.physical_name ?? '',
        data_type: c.data_type ?? null, data_length: c.data_length ?? null,
        is_primary_key: Boolean(c.is_primary_key), is_nullable: c.is_nullable !== false, is_unique: Boolean(c.is_unique),
        default_value: c.default_value ?? null, description: c.description ?? null, order_index: c.order_index ?? 0,
        term_dictionary_id: c.term_dictionary_id ?? null,
      })).sort((a, b) => a.order_index - b.order_index),
    };
  });
  return {
    id: p.id, name: p.name ?? '', description: p.description ?? null, dbms_type: p.dbms_type || 'ORACLE', updated_at: p.updated_at ?? null,
    tables, relationships: [...rels.values()], memos: p.memos ?? [],
  };
}

/** erd-vibe GET /api/erd/:id 과 같은 묶음 조회. 관계는 양쪽 테이블에 한 번씩 나와 normalizeProject가 하나로 합친다. */
const PROJECT_SELECT = '*,tables:erd_tables(*,columns:erd_columns(*),relationships_from:erd_relationships!from_table_id(*),relationships_to:erd_relationships!to_table_id(*)),memos:erd_memos(*)';

export async function erdProject(id: string, force = false): Promise<ErdProject> {
  const hit = erdCache.get(id);
  if (!force && hit && Date.now() - hit.at < ERD_CACHE_MS) return hit.project;
  let raw: Parameters<typeof normalizeProject>[0];
  try {
    raw = await rest('GET', 'erd_projects', `select=${enc(PROJECT_SELECT)}&id=${eq(id)}`, { single: true });
  } catch (err) {
    throw new Error(`erd-vibe ERD 프로젝트 ${id}를 읽지 못했습니다: ${(err as Error).message}`);
  }
  const project = normalizeProject(raw);
  erdCache.set(id, { at: Date.now(), project });
  return project;
}

/** 이미 받아 둔 ERD(동기 호출용, tool_context). 없으면 null */
export const cachedErdProject = (id: string): ErdProject | null => erdCache.get(id)?.project ?? null;
export const invalidateErd = (id: string) => { erdCache.delete(id); };

export type HistoryEntity = 'table' | 'column' | 'relationship' | 'memo';
export type HistoryAction = 'create' | 'update' | 'delete' | 'move';

/** erd-vibe 변경 이력(erd_history)에 남긴다. 이력이 안 남아도 편집은 된 것이라 실패는 삼킨다. */
async function history(projectId: string, entity: HistoryEntity, entityId: string, action: HistoryAction, oldData: object | null, newData: object | null, description: string) {
  try {
    await insertOne('erd_history', {
      erd_project_id: projectId, entity_type: entity, entity_id: String(entityId), action,
      old_data: oldData ?? null, new_data: newData ?? null, description: `[studio] ${description}`, user_id: null, created_at: now(),
    });
  } catch (err) {
    console.warn('erd-vibe 이력 저장 실패:', (err as Error).message);
  }
}

export type TableInput = { logical_name: string; physical_name: string; description?: string; position_x?: number; position_y?: number; header_color?: string };
export type ColumnInput = {
  logical_name: string; physical_name: string; data_type: string; is_primary_key?: boolean; is_nullable?: boolean; is_unique?: boolean;
  default_value?: string; description?: string; order_index?: number; term_dictionary_id?: string | null;
};
export type RelationshipInput = { from_table_id: string; from_column_id: string; to_table_id: string; to_column_id: string; relationship_type: RelationshipType; description?: string };

/** 편집 한 번: Supabase에 쓰고 → 이력 → ERD 캐시 비움. 부르는 쪽이 최신 ERD를 다시 받는다. */
async function edit<T>(projectId: string, run: () => Promise<T>, log: (r: T) => [HistoryEntity, string, HistoryAction, object | null, object | null, string]): Promise<T> {
  try {
    const r = await run();
    const [entity, id, action, oldData, newData, desc] = log(r);
    await history(projectId, entity, id, action, oldData, newData, desc);
    return r;
  } finally {
    invalidateErd(projectId);
  }
}

const findTable = (p: ErdProject | null, id: string) => p?.tables.find((t) => t.id === id) ?? null;
const findColumn = (p: ErdProject | null, id: string) => p?.tables.flatMap((t) => t.columns).find((c) => c.id === id) ?? null;

const RELATIONSHIP_TYPES: RelationshipType[] = ['one_to_one', 'one_to_many', 'many_to_many'];

// erd-vibe POST /api/tables 와 같은 기본값.
async function insertTable(projectId: string, t: TableInput): Promise<ErdTable> {
  required(t as unknown as Row, ['logical_name', 'physical_name'], DICT_LABEL);
  const ts = now();
  return insertOne<ErdTable>('erd_tables', {
    erd_project_id: projectId, logical_name: t.logical_name, physical_name: t.physical_name, description: t.description ?? null,
    position_x: t.position_x ?? 0, position_y: t.position_y ?? 0, header_color: t.header_color ?? '#2563eb', default_has_pk_auto_increment: true,
    created_at: ts, updated_at: ts,
  });
}

// erd-vibe POST /api/columns 와 같은 기본값.
async function insertColumn(tableId: string, c: ColumnInput): Promise<ErdColumn> {
  required(c as unknown as Row, ['logical_name', 'physical_name', 'data_type'], { ...DICT_LABEL, data_type: '타입' });
  const ts = now();
  return insertOne<ErdColumn>('erd_columns', {
    table_id: tableId, logical_name: c.logical_name, physical_name: c.physical_name, data_type: c.data_type,
    is_primary_key: c.is_primary_key ?? false, is_nullable: c.is_nullable ?? true, is_unique: c.is_unique ?? false,
    default_value: c.default_value ?? null, description: c.description ?? null, order_index: c.order_index ?? 0,
    term_dictionary_id: c.term_dictionary_id || null, created_at: ts, updated_at: ts,
  });
}

// erd-vibe POST /api/relationships 와 같다: 같은 네 칸의 관계가 있으면 거절.
async function insertRelationship(projectId: string, r: RelationshipInput): Promise<ErdRelationship> {
  if (!RELATIONSHIP_TYPES.includes(r.relationship_type)) throw new Error(`관계 종류는 ${RELATIONSHIP_TYPES.join(', ')} 중 하나여야 합니다.`);
  const dup = `from_table_id=${eq(r.from_table_id)}&to_table_id=${eq(r.to_table_id)}&from_column_id=${eq(r.from_column_id)}&to_column_id=${eq(r.to_column_id)}`;
  if (await exists('erd_relationships', dup)) throw new Error('이미 존재하는 관계입니다');
  const ts = now();
  return insertOne<ErdRelationship>('erd_relationships', {
    erd_project_id: projectId, from_table_id: r.from_table_id, to_table_id: r.to_table_id, from_column_id: r.from_column_id, to_column_id: r.to_column_id,
    relationship_type: r.relationship_type, description: r.description ?? null, created_at: ts, updated_at: ts,
  });
}

/** erd-vibe POST /api/tables/auto-layout 과 같은 dagre 배치. 설명 앞 [그룹] 태그로 묶어 그룹마다 배치하고 격자로 놓는다. */
async function autoLayout(projectId: string): Promise<{ moved: number }> {
  type T = { id: string; description: string | null; columns: { logical_name: string | null; physical_name: string | null; data_type: string | null }[] };
  const tables = await rest<T[]>('GET', 'erd_tables', `select=${enc('id,description,columns:erd_columns(logical_name,physical_name,data_type)')}&erd_project_id=${eq(projectId)}&order=physical_name.asc`);
  if (!tables.length) return { moved: 0 };
  const projectRels = await restAll<{ from_table_id: string; to_table_id: string }>('erd_relationships', 'id,from_table_id,to_table_id', 'from_table_id.asc', `erd_project_id=${eq(projectId)}`);
  const len = (s: string | null) => (s ?? '').length;
  const size = (t: T) => {
    const h = 40 + (t.columns.length || 3) * 28 + 40;
    if (!t.columns.length) return { w: 450, h };
    const ml = Math.max(...t.columns.map((c) => len(c.logical_name))), mp = Math.max(...t.columns.map((c) => len(c.physical_name))), md = Math.max(...t.columns.map((c) => len(c.data_type)));
    const w = 20 + Math.max(80, ml * 11 + 20) + Math.max(80, mp * 9 + 20) + Math.max(60, md * 8 + 20) + 24 + 4 + 80;
    return { w: Math.min(1200, Math.max(400, w)), h };
  };
  const groupOf = (t: T) => /^\[([^\]]+)\]/.exec(t.description ?? '')?.[1] ?? '__ungrouped__';
  const layoutGroup = (list: T[], offX: number, offY: number) => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 200, ranksep: 180, marginx: 50, marginy: 50 });
    g.setDefaultEdgeLabel(() => ({}));
    const sizes = new Map(list.map((t) => [t.id, size(t)]));
    for (const t of list) g.setNode(t.id, { width: sizes.get(t.id)!.w, height: sizes.get(t.id)!.h });
    const ids = new Set(list.map((t) => t.id));
    for (const r of projectRels) if (ids.has(r.from_table_id) && ids.has(r.to_table_id)) g.setEdge(r.from_table_id, r.to_table_id);
    dagre.layout(g);
    const pos = list.map((t) => { const n = g.node(t.id); const s = sizes.get(t.id)!; return { id: t.id, x: Math.round(n.x - s.w / 2) + offX, y: Math.round(n.y - s.h / 2) + offY, w: s.w, h: s.h }; });
    const width = Math.max(...pos.map((p) => p.x + p.w)) - offX, height = Math.max(...pos.map((p) => p.y + p.h)) - offY;
    return { pos, width, height };
  };
  const groups = new Map<string, T[]>();
  for (const t of tables) { const k = groupOf(t); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(t); }
  let positions: { id: string; x: number; y: number }[] = [];
  const tagged = [...groups.keys()].filter((k) => k !== '__ungrouped__');
  if (tagged.length) {
    const order = [...tagged, ...(groups.has('__ungrouped__') ? ['__ungrouped__'] : [])];
    const cols = order.length <= 4 ? 2 : 3;
    const dry = order.map((k) => layoutGroup(groups.get(k)!, 0, 0));
    let y = 100;
    for (let row = 0; row * cols < order.length; row++) {
      let x = 100, rowH = 0;
      for (let c = 0; c < cols; c++) {
        const i = row * cols + c;
        if (i >= order.length) break;
        positions.push(...layoutGroup(groups.get(order[i])!, x, y).pos);
        x += dry[i].width + 200; rowH = Math.max(rowH, dry[i].height);
      }
      y += rowH + 200;
    }
  } else {
    positions = layoutGroup(tables, 100, 100).pos;
  }
  const ts = now();
  await Promise.all(positions.map((p) => rest('PATCH', 'erd_tables', `id=${eq(p.id)}`, { body: { position_x: p.x, position_y: p.y, updated_at: ts } })));
  return { moved: positions.length };
}

type SyncColumn = { physical_name?: string; logical_name?: string; data_type?: string; is_primary_key?: boolean; is_nullable?: boolean; is_unique?: boolean; default_value?: string; description?: string; term_dictionary_id?: string | null };
type SyncTable = { physical_name?: string; logical_name?: string; description?: string; header_color?: string; columns?: SyncColumn[] };

/**
 * erd-vibe POST /api/tables/sync 와 같은 이름 맞추기(지우지는 않는다). DDL 가져오기에 쓴다.
 * 테이블은 물리명·논리명·설명이 같은 기존 테이블에 맞추고, 없으면 기존 테이블 아래 4열 격자로 새로 놓는다.
 * 컬럼은 물리명·논리명이 같은 기존 컬럼에 맞춰 바뀐 칸만 고치고, 없으면 입력 순서를 order_index로 새로 넣는다.
 * erd-vibe와 다른 점: 없는 group_name 칸은 쓰지 않고, 입력에 term_dictionary_id가 있으면 용어 연결도 채운다. 쓰기 오류는 삼키지 않는다.
 */
async function syncTables(projectId: string, input: SyncTable[]) {
  if (!input.length) throw new Error('테이블 배열이 필요합니다.');
  const ts = now();
  type ExCol = ErdColumn & Row;
  type Ex = ErdTable & { columns: ExCol[] };
  const existing = await rest<Ex[]>('GET', 'erd_tables', `select=${enc('*,columns:erd_columns(*)')}&erd_project_id=${eq(projectId)}`);
  const occupied = existing.map((t) => ({ y: Number(t.position_y ?? 0), h: 40 + ((t.columns?.length || 3) * 28) + 40 }));
  let nextX = 100, nextY = existing.length ? Math.max(100, ...occupied.map((o) => o.y + o.h + 60)) : 100, colIdx = 0;
  const toCreate: { in: SyncTable; x: number; y: number }[] = [];
  const toUpdate: { id: string; patch: Row; in: SyncTable }[] = [];
  const idByName = new Map<string, string>();
  const created = new Set<string>(), updated = new Set<string>();
  for (const t of input) {
    const m = existing.find((e) => (t.physical_name && e.physical_name === t.physical_name) || (t.logical_name && e.logical_name === t.logical_name) || (t.description && e.description === t.description));
    if (m) {
      const patch: Row = {};
      if (t.logical_name && t.logical_name !== m.logical_name) patch.logical_name = t.logical_name;
      if (t.physical_name && t.physical_name !== m.physical_name) patch.physical_name = t.physical_name;
      if (t.description !== undefined && t.description !== m.description) patch.description = t.description;
      if (t.header_color && t.header_color !== m.header_color) patch.header_color = t.header_color;
      if (Object.keys(patch).length) { toUpdate.push({ id: m.id, patch, in: t }); updated.add(t.physical_name ?? ''); }
      idByName.set(t.physical_name ?? '', m.id);
    } else {
      const th = 40 + Math.max(t.columns?.length ?? 0, 3) * 28 + 40;
      toCreate.push({ in: t, x: nextX, y: nextY });
      colIdx++;
      if (colIdx >= 4) { colIdx = 0; nextX = 100; nextY = nextY + th + 60; } else nextX = 100 + colIdx * 350;
      created.add(t.physical_name ?? '');
    }
  }
  if (toCreate.length) {
    const rows = await rest<ErdTable[]>('POST', 'erd_tables', '', {
      body: toCreate.map((c) => ({
        erd_project_id: projectId, logical_name: c.in.logical_name, physical_name: c.in.physical_name, description: c.in.description || '',
        position_x: c.x, position_y: c.y, header_color: c.in.header_color || '#2563eb', created_at: ts, updated_at: ts,
      })),
    });
    for (const r of rows) idByName.set(r.physical_name, r.id);
  }
  await Promise.all(toUpdate.map((u) => updateOne('erd_tables', u.id, { ...u.patch, updated_at: ts })));

  const newCols: Row[] = [];
  const colUpdates: { id: string; patch: Row }[] = [];
  const result: { physical_name: string; action: 'created' | 'updated' | 'unchanged'; columns: { created: string[]; updated: string[]; unchanged: string[] } }[] = [];
  for (const t of input) {
    const tableId = idByName.get(t.physical_name ?? '');
    const ex = existing.find((e) => e.physical_name === t.physical_name || e.logical_name === t.logical_name);
    const exCols = ex?.columns ?? [];
    const r = { physical_name: t.physical_name ?? '', action: created.has(t.physical_name ?? '') ? 'created' as const : updated.has(t.physical_name ?? '') ? 'updated' as const : 'unchanged' as const, columns: { created: [] as string[], updated: [] as string[], unchanged: [] as string[] } };
    (t.columns ?? []).forEach((c, i) => {
      const m = exCols.find((e) => (c.physical_name && e.physical_name === c.physical_name) || (c.logical_name && e.logical_name === c.logical_name));
      if (m) {
        const patch: Row = {};
        for (const k of ['logical_name', 'physical_name', 'data_type'] as const) if (c[k] && c[k] !== m[k]) patch[k] = c[k];
        for (const k of ['is_primary_key', 'is_nullable', 'is_unique', 'default_value', 'description'] as const) if (c[k] !== undefined && c[k] !== m[k]) patch[k] = c[k];
        if (c.term_dictionary_id && c.term_dictionary_id !== m.term_dictionary_id) patch.term_dictionary_id = c.term_dictionary_id;
        if (Object.keys(patch).length) { colUpdates.push({ id: m.id, patch: { ...patch, updated_at: ts } }); r.columns.updated.push(c.physical_name ?? ''); }
        else r.columns.unchanged.push(c.physical_name ?? '');
      } else if (tableId) {
        newCols.push({
          table_id: tableId, logical_name: c.logical_name, physical_name: c.physical_name, data_type: c.data_type,
          is_primary_key: c.is_primary_key || false, is_nullable: c.is_nullable !== undefined ? c.is_nullable : true, is_unique: c.is_unique || false,
          default_value: c.default_value || '', description: c.description || '', order_index: i, term_dictionary_id: c.term_dictionary_id || null,
          created_at: ts, updated_at: ts,
        });
        r.columns.created.push(c.physical_name ?? '');
      }
    });
    result.push(r);
  }
  if (newCols.length) await rest('POST', 'erd_columns', '', { body: newCols });
  await Promise.all(colUpdates.map((u) => updateOne('erd_columns', u.id, u.patch)));
  return {
    data: result,
    summary: {
      tables: { created: toCreate.length, updated: toUpdate.length, unchanged: input.length - toCreate.length - toUpdate.length },
      columns: { created: newCols.length, updated: colUpdates.length, unchanged: result.reduce((n, r) => n + r.columns.unchanged.length, 0) },
    },
  };
}

export const erdApi = {
  createTable: (projectId: string, t: TableInput) => edit(projectId,
    () => insertTable(projectId, t),
    (r) => ['table', r.id, 'create', null, t, `테이블 ${t.physical_name} 추가`]),
  updateTable: (projectId: string, id: string, patch: Partial<TableInput>) => {
    const before = findTable(cachedErdProject(projectId), id);
    return edit(projectId, () => updateOne<ErdTable>('erd_tables', id, { ...patch, updated_at: now() }),
      () => ['table', id, 'update', before ? { physical_name: before.physical_name, logical_name: before.logical_name } : null, patch, `테이블 ${patch.physical_name ?? before?.physical_name ?? id} 수정`]);
  },
  deleteTable: (projectId: string, id: string) => {
    const before = findTable(cachedErdProject(projectId), id);
    return edit(projectId, () => deleteOne('erd_tables', id),
      () => ['table', id, 'delete', before ? { physical_name: before.physical_name, logical_name: before.logical_name } : null, null, `테이블 ${before?.physical_name ?? id} 삭제`]);
  },
  /** 끌어서 옮긴 위치 여러 개. */
  moveTables: async (projectId: string, moves: { id: string; x: number; y: number }[]) => {
    const ts = now();
    try {
      await Promise.all(moves.map((m) => updateOne('erd_tables', m.id, { position_x: Math.round(m.x), position_y: Math.round(m.y), updated_at: ts })));
    } finally { invalidateErd(projectId); }
  },
  autoLayout: (projectId: string) => edit(projectId, () => autoLayout(projectId),
    () => ['table', projectId, 'move', null, null, '자동 정렬']),
  createColumn: (projectId: string, tableId: string, c: ColumnInput) => edit(projectId,
    () => insertColumn(tableId, c),
    (r) => ['column', r.id, 'create', null, c, `컬럼 ${c.physical_name} 추가`]),
  updateColumn: (projectId: string, id: string, patch: Partial<ColumnInput>) => {
    const before = findColumn(cachedErdProject(projectId), id);
    return edit(projectId, () => updateOne<ErdColumn>('erd_columns', id, { ...patch, updated_at: now() }),
      () => ['column', id, 'update', before ? { physical_name: before.physical_name, data_type: before.data_type } : null, patch, `컬럼 ${patch.physical_name ?? before?.physical_name ?? id} 수정`]);
  },
  deleteColumn: (projectId: string, id: string) => {
    const before = findColumn(cachedErdProject(projectId), id);
    return edit(projectId, () => deleteOne('erd_columns', id),
      () => ['column', id, 'delete', before ? { physical_name: before.physical_name } : null, null, `컬럼 ${before?.physical_name ?? id} 삭제`]);
  },
  reorderColumns: async (projectId: string, order: { id: string; order_index: number }[]) => {
    const ts = now();
    try { await Promise.all(order.map((o) => updateOne('erd_columns', o.id, { order_index: o.order_index, updated_at: ts }))); } finally { invalidateErd(projectId); }
  },
  createRelationship: (projectId: string, r: RelationshipInput) => edit(projectId,
    () => insertRelationship(projectId, r),
    (x) => ['relationship', x.id, 'create', null, r, '관계 추가']),
  updateRelationship: (projectId: string, id: string, patch: { relationship_type?: RelationshipType; description?: string }) => {
    if (patch.relationship_type && !RELATIONSHIP_TYPES.includes(patch.relationship_type)) throw new Error(`관계 종류는 ${RELATIONSHIP_TYPES.join(', ')} 중 하나여야 합니다.`);
    return edit(projectId, () => updateOne<ErdRelationship>('erd_relationships', id, { ...patch, updated_at: now() }),
      () => ['relationship', id, 'update', null, patch, '관계 수정']);
  },
  deleteRelationship: (projectId: string, id: string) => edit(projectId, () => deleteOne('erd_relationships', id),
    () => ['relationship', id, 'delete', null, null, '관계 삭제']),
  /** 이름으로 맞춰 테이블·컬럼을 추가·갱신한다(지우지는 않는다). DDL 가져오기에 쓴다. */
  syncTables: (projectId: string, tables: unknown[]) => edit(projectId,
    () => syncTables(projectId, tables as SyncTable[]),
    () => ['table', projectId, 'update', null, { tables: tables.length }, `DDL 가져오기 (${tables.length}개 테이블)`]),
};

export const erdWebUrl = () => baseUrl();
