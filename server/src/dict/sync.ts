import { normalizeIdent, normalizeType, resolve, standardName, termRef, typeMatches, type DictIndex, type TermRef } from './judge.js';
import { columnType, domainType, type ErdColumn, type ErdProject, type ErdTable } from './types.js';
import type { LbColumn, LbSchema, LbTable, Loc } from './liquibase.js';

/**
 * 소스(Liquibase 최종 스키마) × ERD × 용어사전 동기화 판정(순수 함수). 컬럼마다 규칙 R1~R5를 보고 할 일을 만든다.
 *   R1 ERD와 소스의 테이블·컬럼·타입이 같다. 다르면 건마다 기준(소스/ERD)을 고른다. 기본은 소스.
 *   R2 모든 컬럼은 등록된 용어를 쓴다. 없으면 단어 → 도메인 → 용어 순으로 등록하되, 논리명으로 이미 있는 용어를 먼저 본다.
 *   R3 논리명이 같은 용어가 있으면 그 표준 이름으로 소스·ERD 이름을 바꾼다.
 *   R4 ERD 안에서 같은 논리명은 한 물리명으로만 쓴다.
 *   R5 타입은 용어 도메인 타입과 같다(소스·ERD 둘 다).
 * R3~R5는 사전이 기준이라 고른 기준과 관계없이 양쪽을 고친다. 할 일은 기준마다 따로 들고, 화면에서 고른 쪽 것을 반영한다.
 */

export type SyncSide = 'source' | 'erd';
export type SyncIssue =
  | 'table_source_only' | 'table_erd_only'
  | 'source_only' | 'erd_only' | 'type_diff' | 'logical_diff'
  | 'variant' | 'same_logical' | 'overlap_blocked' | 'unregistered_term' | 'unknown_word'
  | 'domain_source' | 'domain_erd' | 'no_term_link' | 'logical_dup';

export type SyncAction =
  | { target: 'erd'; kind: 'add_table'; table: string; logical_name: string }
  | { target: 'erd'; kind: 'add_column'; table: string; table_id: string | null; physical_name: string; logical_name: string; data_type: string | null; is_primary_key: boolean; is_nullable: boolean; term_id: string | null }
  | { target: 'erd'; kind: 'rename_column'; column_id: string; before: string; after: string }
  | { target: 'erd'; kind: 'set_logical'; column_id: string; before: string; after: string }
  | { target: 'erd'; kind: 'set_type'; column_id: string; before: string | null; after: string }
  | { target: 'erd'; kind: 'link_term'; column_id: string; before: string | null; after: string; term_name: string }
  | { target: 'erd'; kind: 'delete_column'; column_id: string; physical_name: string }
  | { target: 'erd'; kind: 'delete_table'; table_id: string; physical_name: string }
  | { target: 'source'; kind: 'rename_column'; table: string; before: string; after: string }
  | { target: 'source'; kind: 'modify_type'; table: string; column: string; before: string | null; after: string }
  | { target: 'source'; kind: 'set_remarks'; table: string; column: string; before: string | null; after: string }
  | { target: 'source'; kind: 'add_column'; table: string; column: string; data_type: string | null; logical_name: string }
  | { target: 'source'; kind: 'drop_column'; table: string; column: string }
  | { target: 'source'; kind: 'add_table'; table: string; logical_name: string; columns: { name: string; type: string | null; logical_name: string }[] }
  | { target: 'source'; kind: 'drop_table'; table: string };

export type DictDraft =
  | { kind: 'word'; key: string; abbreviation: string; name: string; english_name: string; used_by: string[] }
  | { kind: 'domain'; key: string; name: string; data_type: string; used_by: string[] }
  | { kind: 'term'; key: string; logical_name: string; physical_name: string; physical_abbr_name: string; domain_name: string | null; words: string[]; needs: string[]; used_by: string[] };

export type SyncItem = {
  key: string; table: string; column: string | null;
  logical: string | null; logical_from: 'source' | 'erd' | 'term' | 'draft' | null;
  source: { name: string; type: string | null; remarks: string | null; change: Loc } | null;
  erd: { id: string; table_id: string; name: string; logical_name: string; type: string | null; term_id: string | null } | null;
  term: TermRef | null;
  /** 맞춘 뒤의 물리명·타입 */
  target_name: string | null; target_type: string | null;
  issues: SyncIssue[];
  /** R1이 걸려 기준을 골라야 하는 항목. null이면 고를 것이 없다(또는 기본 제안이 없음: erd_only) */
  default_side: SyncSide | null;
  needs_side: boolean;
  /** 할 일: common은 기준과 관계없이(사전 규칙 R3~R5), source·erd는 그 기준을 골랐을 때만. 사전 초안은 drafts 키로 */
  actions: { common: SyncAction[] } & Record<SyncSide, SyncAction[]>;
  drafts: string[];
};

export type SyncResult = {
  items: SyncItem[];
  drafts: DictDraft[];
  summary: { tables: number; columns: number; ok: number; todo: number; issues: Partial<Record<SyncIssue, number>>; logical_dups: number };
};

const squash = (s: string) => s.replace(/[\s_]+/g, '');
/** judge.buildIndex의 byLogical 키(공백만 뺀 것) */
const lkey = (s: string) => s.replace(/\s+/g, '');
/** 코멘트의 앞머리 이름만(설명이 붙은 "실적연도. NULL 이면 조건 없음", "상태 (DRAFT/DONE)", "ID: 시퀀스") */
const cleanRemarks = (r: string | null) => (r ? r.split(/\s*[.,:;\n(\[]|\s+[-–]\s+/)[0].trim() || null : null);
/** 백업·임시 테이블은 동기화 대상이 아니다 */
const SKIP_TABLE = /(_BAK|_BACKUP|_TMP|_TEMP|_OLD)(_\d+)?$/;
const sameType = (a: string | null, b: string | null) => !a || !b || typeMatches(a, b) || typeMatches(b, a);

/** 논리명 끝 단어와 타입으로 기존 도메인을 고른다. 없으면 도메인 등록 초안 이름·타입 */
function guessDomain(ix: DictIndex, lastWord: string | null, type: string | null): { name: string; create: boolean } | null {
  if (!type) return null;
  const doms = ix.dict.domains;
  const typed = (d: (typeof doms)[number]) => { const t = domainType(d, ix.dbms); return t ? typeMatches(type, t) && typeMatches(t, type) || normalizeType(t) === normalizeType(type) : false; };
  if (lastWord) {
    const family = doms.filter((d) => d.name === lastWord || d.name.startsWith(`${lastWord}_`));
    const hit = family.find(typed);
    if (hit) return { name: hit.name, create: false };
    if (family.length) {
      const len = normalizeType(type).match(/\(([^)]*)\)/)?.[1]?.replace(/,/g, '_');
      return { name: len ? `${lastWord}_${len}` : lastWord, create: true };
    }
  }
  const any = doms.find((d) => typed(d) && lastWord && d.name.includes(lastWord));
  if (any) return { name: any.name, create: false };
  return lastWord ? { name: lastWord, create: true } : null;
}

type Pair = { table: string; src: LbColumn | null; erd: ErdColumn | null; srcTable: LbTable | null; erdTable: ErdTable | null };

export function syncCheck(schema: LbSchema, erd: ErdProject, ix: DictIndex): SyncResult {
  const drafts = new Map<string, DictDraft>();
  const items: SyncItem[] = [];
  const draft = (d: DictDraft, by: string) => {
    const cur = drafts.get(d.key) ?? d;
    if (!cur.used_by.includes(by)) cur.used_by.push(by);
    drafts.set(d.key, cur);
    return d.key;
  };

  const erdTables = new Map(erd.tables.map((t) => [t.physical_name.trim().toUpperCase(), t]));
  const srcTables = new Map([...schema.tables].filter(([n, t]) => !t.view && !SKIP_TABLE.test(n)));
  const names = [...new Set([...srcTables.keys(), ...[...erdTables.keys()].filter((n) => !SKIP_TABLE.test(n))])].sort();

  // 테이블마다 컬럼 짝 맞추기(이름이 같으면 한 짝, 다르면 맞춘 뒤 이름이 같을 때 한 짝)
  const pairs: Pair[] = [];
  for (const tn of names) {
    const st = srcTables.get(tn) ?? null; const et = erdTables.get(tn) ?? null;
    if (st && !et) items.push(tableItem(tn, 'table_source_only', st, null));
    if (!st && et) { items.push(tableItem(tn, 'table_erd_only', null, et)); continue; }
    const ecols = new Map((et?.columns ?? []).map((c) => [normalizeIdent(c.physical_name), c]));
    const used = new Set<string>();
    const srcOnly: Pair[] = [];
    for (const c of st!.columns.values()) {
      const e = ecols.get(c.name) ?? null;
      if (e) used.add(c.name);
      const p = { table: tn, src: c, erd: e, srcTable: st, erdTable: et };
      (e || !et ? pairs : srcOnly).push(p);
    }
    const erdOnly = [...ecols].filter(([n]) => !used.has(n)).map(([, e]) => ({ table: tn, src: null, erd: e, srcTable: st, erdTable: et }) as Pair);
    // 소스에만·ERD에만 있는 것끼리 맞춘 뒤 이름이 같으면 합친다(APLY_YMD ↔ APLY_DT)
    const target = (p: Pair) => targetOf(ix, p.src?.name ?? normalizeIdent(p.erd!.physical_name), p.src ? cleanRemarks(p.src.remarks) : p.erd!.logical_name).name;
    const byTarget = new Map<string, Pair[]>();
    for (const p of erdOnly) byTarget.set(target(p), [...(byTarget.get(target(p)) ?? []), p]);
    for (const p of srcOnly) {
      const m = byTarget.get(target(p));
      if (m?.length === 1) { p.erd = m[0].erd; byTarget.delete(target(p)); }
      pairs.push(p);
    }
    for (const ps of byTarget.values()) pairs.push(...ps);
  }

  for (const p of pairs) items.push(columnItem(ix, p, draft));

  // R4: ERD 전체에서 같은 논리명 → 물리명 하나
  const byLogical = new Map<string, SyncItem[]>();
  for (const it of items) {
    if (!it.erd || it.issues.includes('overlap_blocked')) continue;
    // 용어로 맞추면 그 논리명이 된다
    const k = lkey(it.term?.logical_name ?? it.erd.logical_name);
    if (!k) continue;
    byLogical.set(k, [...(byLogical.get(k) ?? []), it]);
  }
  let logicalDups = 0;
  for (const [k, group] of byLogical) {
    const namesIn = new Map<string, number>();
    for (const it of group) { const n = it.target_name ?? it.erd!.name; namesIn.set(n, (namesIn.get(n) ?? 0) + 1); }
    if (namesIn.size < 2) continue;
    logicalDups++;
    const ts = ix.byLogical.get(k);
    const termStd = ts && new Set(ts.map(standardName)).size === 1 ? standardName(ts[0]) : null;
    const chosen = termStd ?? [...namesIn].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    for (const it of group) {
      const now = it.target_name ?? it.erd!.name;
      if (now === chosen) continue;
      if (!it.issues.includes('logical_dup')) it.issues.push('logical_dup');
      it.target_name = chosen;
      const acts: SyncAction[] = it.actions.common.filter((a) => a.kind !== 'rename_column');
      if (it.erd && normalizeIdent(it.erd.name) !== chosen) acts.push({ target: 'erd', kind: 'rename_column', column_id: it.erd.id, before: it.erd.name, after: chosen });
      if (it.source && it.source.name !== chosen) acts.push({ target: 'source', kind: 'rename_column', table: it.table, before: it.source.name, after: chosen });
      it.actions.common = acts;
      for (const a of it.actions.source) if (a.kind === 'add_column' && a.target === 'erd') a.physical_name = chosen;
    }
  }

  const issues: SyncResult['summary']['issues'] = {};
  let ok = 0;
  for (const it of items) {
    if (!it.issues.length) ok++;
    for (const i of it.issues) issues[i] = (issues[i] ?? 0) + 1;
  }
  return {
    items: items.sort((a, b) => a.table.localeCompare(b.table) || Number(a.column !== null) - Number(b.column !== null) || (a.column ?? '').localeCompare(b.column ?? '')),
    drafts: [...drafts.values()],
    summary: { tables: names.length, columns: pairs.length, ok, todo: items.length - ok, issues, logical_dups: logicalDups },
  };
}

function tableItem(table: string, issue: 'table_source_only' | 'table_erd_only', st: LbTable | null, et: ErdTable | null): SyncItem {
  const logical = st ? cleanRemarks(st.remarks) : et!.logical_name;
  const actions: SyncItem['actions'] = issue === 'table_source_only'
    ? { common: [], source: [{ target: 'erd', kind: 'add_table', table, logical_name: logical ?? table }], erd: [{ target: 'source', kind: 'drop_table', table }] }
    : {
      common: [],
      source: [{ target: 'erd', kind: 'delete_table', table_id: et!.id, physical_name: table }],
      erd: [{ target: 'source', kind: 'add_table', table, logical_name: logical ?? table, columns: et!.columns.map((c) => ({ name: c.physical_name.toUpperCase(), type: columnType(c), logical_name: c.logical_name })) }],
    };
  return {
    key: table, table, column: null, logical, logical_from: st ? 'source' : 'erd', source: null, erd: null, term: null,
    target_name: table, target_type: null, issues: [issue],
    default_side: issue === 'table_source_only' ? 'source' : null, needs_side: true, actions, drafts: [],
  };
}

/** 이름과 논리명으로 맞출 표준 이름과 용어 */
function targetOf(ix: DictIndex, name: string, logical: string | null): { name: string; term: TermRef | null; via: 'standard' | 'variant' | 'logical' | 'overlap' | 'none' } {
  const res = resolve(ix, name);
  if (res.term) return { name: res.term.standard, term: res.term, via: res.verdict === 'standard' ? 'standard' : 'variant' };
  if (logical) {
    const ts = ix.byLogical.get(lkey(logical));
    if (ts?.length) {
      if (new Set(ts.map(standardName)).size > 1) return { name, term: null, via: 'overlap' };
      return { name: standardName(ts[0]), term: termRef(ix, ts[0]), via: 'logical' };
    }
  }
  return { name, term: null, via: 'none' };
}

function columnItem(ix: DictIndex, p: Pair, draft: (d: DictDraft, by: string) => string): SyncItem {
  const { src, erd: e } = p;
  const name = src?.name ?? normalizeIdent(e!.physical_name);
  const key = `${p.table}.${name}`;
  const srcLogical = src ? cleanRemarks(src.remarks) : null;
  const erdLogical = e?.logical_name?.trim() || null;
  const issues: SyncIssue[] = [];
  const both: SyncAction[] = [];
  const bySide: Record<SyncSide, SyncAction[]> = { source: [], erd: [] };
  const draftKeys: string[] = [];
  const srcType = src?.type ?? null;
  const erdType = e ? columnType(e) : null;

  // 1. 논리명
  let logical = srcLogical ?? erdLogical;
  let logicalFrom: SyncItem['logical_from'] = srcLogical ? 'source' : erdLogical ? 'erd' : null;
  if (srcLogical && erdLogical && squash(srcLogical) !== squash(erdLogical)) issues.push('logical_diff');

  // 2~3. 용어
  const t = targetOf(ix, name, logical);
  // 소스 논리명으로 못 찾으면 ERD 논리명으로도 본다
  const t2 = t.via === 'none' && erdLogical && erdLogical !== logical ? targetOf(ix, name, erdLogical) : t;
  const term = t2.term;
  const targetName = t2.name;
  if (t2.via === 'variant') issues.push('variant');
  if (t2.via === 'logical') issues.push('same_logical');
  if (t2.via === 'overlap') issues.push('overlap_blocked');
  if (term) {
    logical = term.logical_name; if (!logicalFrom) logicalFrom = 'term';
    const i = issues.indexOf('logical_diff'); if (i >= 0) issues.splice(i, 1);
  }

  if (!term && t2.via !== 'overlap') {
    const res = resolve(ix, name);
    // 끝 토큰의 단어가 여럿이면 도메인이 있는 단어를 고른다(CD → 코드)
    const lastTok = res.tokens[res.tokens.length - 1]?.token;
    const cands = lastTok ? ix.wordsByToken.get(lastTok) ?? [] : [];
    const lastWord = cands.find((w) => ix.dict.domains.some((d) => d.name === w.name || d.name.startsWith(`${w.name}_`)))?.name ?? res.tokens[res.tokens.length - 1]?.word ?? null;
    const dom = guessDomain(ix, lastWord, srcType ?? erdType);
    const needs: string[] = [];
    if (res.verdict === 'unknown_word') {
      issues.push('unknown_word');
      for (const tok of res.missing) needs.push(draft({ kind: 'word', key: `word:${tok}`, abbreviation: tok, name: '', english_name: '', used_by: [] }, key));
    } else issues.push('unregistered_term');
    if (dom?.create) needs.push(draft({ kind: 'domain', key: `domain:${dom.name}`, name: dom.name, data_type: srcType ?? erdType!, used_by: [] }, key));
    const words = res.tokens.map((x) => x.word ?? x.token);
    const termKey = draft({
      kind: 'term', key: `term:${name}`, logical_name: logical ?? res.draft?.logical_name ?? words.join(''),
      physical_name: res.draft?.physical_name ?? name, physical_abbr_name: name, domain_name: dom?.name ?? null, words, needs, used_by: [],
    }, key);
    if (!logical) { logical = res.draft?.logical_name ?? null; logicalFrom = logical ? 'draft' : null; }
    draftKeys.push(...needs, termKey);
  }

  // 이름 맞추기(R3·비표준): 사전 기준이라 양쪽
  if (src && targetName !== src.name) both.push({ target: 'source', kind: 'rename_column', table: p.table, before: src.name, after: targetName });
  if (e && targetName !== normalizeIdent(e.physical_name)) both.push({ target: 'erd', kind: 'rename_column', column_id: e.id, before: e.physical_name, after: targetName });

  // 5. 도메인 타입(R5)
  const domType = term?.domain_type ?? null;
  if (domType && srcType && !typeMatches(srcType, domType)) { issues.push('domain_source'); both.push({ target: 'source', kind: 'modify_type', table: p.table, column: targetName, before: srcType, after: domType }); }
  if (domType && e && (!erdType || !typeMatches(erdType, domType))) { issues.push('domain_erd'); both.push({ target: 'erd', kind: 'set_type', column_id: e.id, before: erdType, after: domType }); }
  const targetType = domType ?? srcType ?? erdType;

  // 4. 있음·타입(R1)
  let needsSide = false;
  let defaultSide: SyncSide | null = 'source';
  if (src && !e) {
    issues.push('source_only'); needsSide = true;
    bySide.source.push({ target: 'erd', kind: 'add_column', table: p.table, table_id: p.erdTable?.id ?? null, physical_name: targetName, logical_name: logical ?? targetName, data_type: targetType, is_primary_key: src.pk, is_nullable: src.nullable ?? !src.pk, term_id: term?.id ?? null });
    bySide.erd.push({ target: 'source', kind: 'drop_column', table: p.table, column: src.name });
  } else if (!src && e) {
    issues.push('erd_only'); needsSide = true; defaultSide = null;
    bySide.source.push({ target: 'erd', kind: 'delete_column', column_id: e.id, physical_name: e.physical_name });
    bySide.erd.push({ target: 'source', kind: 'add_column', table: p.table, column: targetName, data_type: targetType, logical_name: logical ?? targetName });
  } else if (src && e && !domType && !sameType(srcType, erdType)) {
    issues.push('type_diff'); needsSide = true;
    if (srcType) bySide.source.push({ target: 'erd', kind: 'set_type', column_id: e.id, before: erdType, after: srcType });
    if (erdType) bySide.erd.push({ target: 'source', kind: 'modify_type', table: p.table, column: targetName, before: srcType, after: erdType });
  }

  // 논리명: ERD는 용어 논리명으로. 소스 코멘트는 설명(코드값·FK 등)이 붙어 있어 용어가 있으면 건드리지 않는다.
  if (term && e && squash(e.logical_name) !== squash(term.logical_name)) both.push({ target: 'erd', kind: 'set_logical', column_id: e.id, before: e.logical_name, after: term.logical_name });
  if (!term && issues.includes('logical_diff') && src && e) {
    bySide.source.push({ target: 'erd', kind: 'set_logical', column_id: e.id, before: e.logical_name, after: srcLogical! });
    bySide.erd.push({ target: 'source', kind: 'set_remarks', table: p.table, column: targetName, before: src.remarks, after: erdLogical! });
    needsSide = true;
  }

  // 6. 용어 연결
  if (term && e && e.term_dictionary_id !== term.id) { issues.push('no_term_link'); both.push({ target: 'erd', kind: 'link_term', column_id: e.id, before: e.term_dictionary_id, after: term.id, term_name: term.logical_name }); }

  return {
    key, table: p.table, column: name, logical, logical_from: logicalFrom,
    // 화면에는 파일 이름과 줄만(항목이 수천 개라 전체 경로는 무겁다)
    source: src ? { name: src.name, type: srcType, remarks: src.remarks, change: { ...src.changed, file: src.changed.file.split('/').pop()! } } : null,
    erd: e ? { id: e.id, table_id: e.table_id, name: e.physical_name, logical_name: e.logical_name, type: erdType, term_id: e.term_dictionary_id } : null,
    term, target_name: targetName, target_type: targetType, issues,
    default_side: needsSide ? defaultSide : null, needs_side: needsSide,
    actions: { common: both, source: bySide.source, erd: bySide.erd },
    drafts: draftKeys,
  };
}
