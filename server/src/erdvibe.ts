import { db } from './db.js';
import { decrypt, encrypt } from './secret.js';
import type { Dictionary, Domain, ErdColumn, ErdMemo, ErdProject, ErdRelationship, ErdTable, RelationshipType, Term, Word } from './dict/types.js';

export * from './dict/types.js';

/**
 * erd-vibe(팀이 같이 쓰는 ERD·단어/용어/도메인 사전 도구)의 REST 클라이언트.
 * 데이터의 원본은 erd-vibe 하나다. studio는 읽은 것을 잠깐 메모리에 두고, 고치면 바로 erd-vibe에 쓰고 캐시를 비운다.
 * 사전은 erd-vibe 전체에 하나뿐이라(프로젝트 구분 없음) 한 번 받아 두고, ERD 프로젝트는 워크스페이스마다 연결한다(세션은 dictscan.sessionErdId로 고른다).
 * 인증은 API 키를 Authorization: Bearer로 보낸다. erd-vibe가 인증을 끈 경우(로컬)엔 키 없이도 된다.
 */

export type ErdProjectSummary = { id: string; name: string; description: string | null; dbms_type: string; updated_at: string | null };
export type DictKind = 'word' | 'term' | 'domain';

type State = { base_url?: string; api_key?: string };
export const DEFAULT_URL = 'https://vibe-erd.60hz.cc';
const DICT_CACHE_MS = 60_000;
const ERD_CACHE_MS = 60_000;

function load(): State {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'erd_vibe'`).get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as State) : {};
}
function save(next: State) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('erd_vibe', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
}

/** 설정에서 주소나 키를 넣었으면 연동을 쓰는 것으로 본다(안 쓰는 사람에게 Claude 규칙·PR 단계를 붙이지 않게). */
export function erdConfigured(): boolean {
  const s = load();
  return Boolean(s.base_url || s.api_key);
}

const baseUrl = () => (load().base_url || DEFAULT_URL).replace(/\/+$/, '');

export function erdConfigView() {
  const s = load();
  return { base_url: baseUrl(), has_key: Boolean(s.api_key), configured: erdConfigured() };
}

/** api_key: undefined면 그대로, ''면 지운다. */
export function saveErdConfig(patch: { base_url?: string; api_key?: string }) {
  const s = load();
  if (patch.base_url !== undefined) {
    const url = patch.base_url.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//.test(url)) throw new Error('주소는 http:// 또는 https:// 로 시작해야 합니다.');
    s.base_url = url || undefined;
  }
  if (patch.api_key !== undefined) s.api_key = patch.api_key.trim() ? encrypt(patch.api_key.trim()) : undefined;
  save(s);
  dict = null;
  erdCache.clear();
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const key = decrypt(load().api_key ?? null);
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/api${path}`, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === 'TimeoutError' ? 'erd-vibe가 30초 안에 답하지 않았습니다.' : `erd-vibe에 연결하지 못했습니다: ${e.message}`);
  }
  const text = await res.text();
  let json: { success?: boolean; data?: unknown; error?: string; message?: string; errors?: { msg: string }[] } | null = null;
  try { json = JSON.parse(text); } catch { /* HTML 등 */ }
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    throw new Error(`erd-vibe 인증에 실패했습니다(${res.status}). 설정의 API 키를 확인하세요.`);
  }
  if (res.status === 403) throw new Error('erd-vibe가 거부했습니다(403). 이 키에 쓰기 권한이 없거나 키가 맞지 않습니다.');
  if (!res.ok || !json || json.success === false) {
    const msg = json?.error ?? json?.message ?? json?.errors?.map((e) => e.msg).join(', ') ?? text.slice(0, 200);
    throw new Error(`erd-vibe 요청이 실패했습니다(${res.status}): ${msg}`);
  }
  return json.data as T;
}

const enc = encodeURIComponent;

// ── 사전 ─────────────────────────────────────────────

let dict: Dictionary | null = null;
let loading: Promise<Dictionary> | null = null;

/** 단어·용어·도메인 사전 전체. 1분 동안 메모리에 두고, force면 다시 받는다. */
export async function dictionary(force = false): Promise<Dictionary> {
  if (!force && dict && Date.now() - dict.loaded_at < DICT_CACHE_MS) return dict;
  if (loading) return loading;
  loading = (async () => {
    const [words, terms, domains] = await Promise.all([
      call<Word[]>('GET', '/word-dictionary?limit=100000'),
      call<Term[]>('GET', '/term-dictionary?limit=100000'),
      call<Domain[]>('GET', '/domain-dictionary?limit=100000'),
    ]);
    dict = { words, terms, domains, loaded_at: Date.now() };
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

const DICT_PATH: Record<DictKind, string> = { word: '/word-dictionary', term: '/term-dictionary', domain: '/domain-dictionary' };
const DICT_LIST: Record<DictKind, 'words' | 'terms' | 'domains'> = { word: 'words', term: 'terms', domain: 'domains' };
export type DictEntry = Word | Term | Domain;

/** 사전 항목 추가·수정·삭제. 반영한 뒤 캐시도 같게 고쳐 둔다(다음 검사에 바로 쓰이게). */
export async function createDictEntry(kind: DictKind, body: Record<string, unknown>): Promise<DictEntry> {
  const created = await call<DictEntry>('POST', DICT_PATH[kind], body);
  if (dict) (dict[DICT_LIST[kind]] as DictEntry[]).push(created);
  return created;
}
export async function updateDictEntry(kind: DictKind, id: string, body: Record<string, unknown>): Promise<DictEntry> {
  const updated = await call<DictEntry>('PUT', `${DICT_PATH[kind]}/${enc(id)}`, body);
  if (dict) {
    const list = dict[DICT_LIST[kind]] as DictEntry[];
    const i = list.findIndex((e) => e.id === id);
    if (i >= 0) list[i] = { ...list[i], ...updated };
  }
  return updated;
}
export async function deleteDictEntries(kind: DictKind, ids: string[]): Promise<void> {
  if (ids.length === 1) await call('DELETE', `${DICT_PATH[kind]}/${enc(ids[0])}`);
  else await call('DELETE', DICT_PATH[kind], { ids });
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

export async function listErdProjects(): Promise<ErdProjectSummary[]> {
  const rows = await call<(ErdProjectSummary & { dbms_type?: string })[]>('GET', '/erd');
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description ?? null, dbms_type: r.dbms_type || 'ORACLE', updated_at: r.updated_at ?? null }));
}

export async function createErdProject(p: { name: string; description?: string; author?: string }): Promise<ErdProjectSummary> {
  const r = await call<ErdProjectSummary & { dbms_type?: string }>('POST', '/erd', p);
  return { id: r.id, name: r.name, description: r.description ?? null, dbms_type: r.dbms_type || 'ORACLE', updated_at: r.updated_at ?? null };
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

export async function erdProject(id: string, force = false): Promise<ErdProject> {
  const hit = erdCache.get(id);
  if (!force && hit && Date.now() - hit.at < ERD_CACHE_MS) return hit.project;
  const project = normalizeProject(await call('GET', `/erd/${enc(id)}`));
  erdCache.set(id, { at: Date.now(), project });
  return project;
}

/** 이미 받아 둔 ERD(동기 호출용, tool_context). 없으면 null */
export const cachedErdProject = (id: string): ErdProject | null => erdCache.get(id)?.project ?? null;
export const invalidateErd = (id: string) => { erdCache.delete(id); };

export type HistoryEntity = 'table' | 'column' | 'relationship' | 'memo';
export type HistoryAction = 'create' | 'update' | 'delete' | 'move';

/** erd-vibe 변경 이력에 남긴다. 이력이 안 남아도 편집은 된 것이라 실패는 삼킨다. */
async function history(projectId: string, entity: HistoryEntity, entityId: string, action: HistoryAction, oldData: object | null, newData: object | null, description: string) {
  try {
    await call('POST', '/history', { erd_project_id: projectId, entity_type: entity, entity_id: entityId, action, old_data: oldData, new_data: newData, description: `[studio] ${description}` });
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

/** 편집 한 번: erd-vibe에 쓰고 → 이력 → ERD 캐시 비움. 부르는 쪽이 최신 ERD를 다시 받는다. */
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

export const erdApi = {
  createTable: (projectId: string, t: TableInput) => edit(projectId,
    () => call<ErdTable>('POST', '/tables', { erd_project_id: projectId, ...t }),
    (r) => ['table', r.id, 'create', null, t, `테이블 ${t.physical_name} 추가`]),
  updateTable: (projectId: string, id: string, patch: Partial<TableInput>) => {
    const before = findTable(cachedErdProject(projectId), id);
    return edit(projectId, () => call<ErdTable>('PUT', `/tables/${enc(id)}`, patch),
      () => ['table', id, 'update', before ? { physical_name: before.physical_name, logical_name: before.logical_name } : null, patch, `테이블 ${patch.physical_name ?? before?.physical_name ?? id} 수정`]);
  },
  deleteTable: (projectId: string, id: string) => {
    const before = findTable(cachedErdProject(projectId), id);
    return edit(projectId, () => call('DELETE', `/tables/${enc(id)}`),
      () => ['table', id, 'delete', before ? { physical_name: before.physical_name, logical_name: before.logical_name } : null, null, `테이블 ${before?.physical_name ?? id} 삭제`]);
  },
  /** 끌어서 옮긴 위치 여러 개. 이력은 한 번에 하나씩 move로 남긴다. */
  moveTables: async (projectId: string, moves: { id: string; x: number; y: number }[]) => {
    try {
      await Promise.all(moves.map((m) => call('PUT', `/tables/${enc(m.id)}`, { position_x: Math.round(m.x), position_y: Math.round(m.y) })));
    } finally { invalidateErd(projectId); }
  },
  autoLayout: (projectId: string) => edit(projectId, () => call('POST', '/tables/auto-layout', { erd_project_id: projectId }),
    () => ['table', projectId, 'move', null, null, '자동 정렬']),
  createColumn: (projectId: string, tableId: string, c: ColumnInput) => edit(projectId,
    () => call<ErdColumn>('POST', '/columns', { table_id: tableId, ...c, term_dictionary_id: c.term_dictionary_id || undefined }),
    (r) => ['column', r.id, 'create', null, c, `컬럼 ${c.physical_name} 추가`]),
  updateColumn: (projectId: string, id: string, patch: Partial<ColumnInput>) => {
    const before = findColumn(cachedErdProject(projectId), id);
    return edit(projectId, () => call<ErdColumn>('PUT', `/columns/${enc(id)}`, patch),
      () => ['column', id, 'update', before ? { physical_name: before.physical_name, data_type: before.data_type } : null, patch, `컬럼 ${patch.physical_name ?? before?.physical_name ?? id} 수정`]);
  },
  deleteColumn: (projectId: string, id: string) => {
    const before = findColumn(cachedErdProject(projectId), id);
    return edit(projectId, () => call('DELETE', `/columns/${enc(id)}`),
      () => ['column', id, 'delete', before ? { physical_name: before.physical_name } : null, null, `컬럼 ${before?.physical_name ?? id} 삭제`]);
  },
  reorderColumns: async (projectId: string, order: { id: string; order_index: number }[]) => {
    try { await call('PUT', '/columns/reorder', { columns: order }); } finally { invalidateErd(projectId); }
  },
  createRelationship: (projectId: string, r: RelationshipInput) => edit(projectId,
    () => call<ErdRelationship>('POST', '/relationships', { erd_project_id: projectId, ...r }),
    (x) => ['relationship', x.id, 'create', null, r, '관계 추가']),
  updateRelationship: (projectId: string, id: string, patch: { relationship_type?: RelationshipType; description?: string }) => edit(projectId,
    () => call<ErdRelationship>('PUT', `/relationships/${enc(id)}`, patch),
    () => ['relationship', id, 'update', null, patch, '관계 수정']),
  deleteRelationship: (projectId: string, id: string) => edit(projectId, () => call('DELETE', `/relationships/${enc(id)}`),
    () => ['relationship', id, 'delete', null, null, '관계 삭제']),
  /** 이름으로 맞춰 테이블·컬럼을 추가·갱신한다(지우지는 않는다). DDL 가져오기에 쓴다. */
  syncTables: (projectId: string, tables: unknown[]) => edit(projectId,
    () => call<unknown>('POST', '/tables/sync', { erd_project_id: projectId, tables }),
    () => ['table', projectId, 'update', null, { tables: tables.length }, `DDL 가져오기 (${tables.length}개 테이블)`]),
};

export const erdWebUrl = () => baseUrl();
