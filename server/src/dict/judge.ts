import { domainType, type Dictionary, type Domain, type Term, type Word } from './types.js';

/**
 * 컬럼 이름(식별자)을 단어사전으로 풀어 용어사전과 맞대는 판정 엔진.
 * 표준 이름은 용어의 약어명(physical_abbr_name), 비어 있으면 물리명(physical_name)이다.
 *
 *   TR_DT     → 거래일자 용어의 표준 이름              → standard
 *   TR_DATE   → TR(거래) + DATE(일자) = 거래일자, 표기만 다름 → variant (TR_DT 제안)
 *   TR_CNCL_DT→ 단어는 모두 있지만 용어가 없음           → unregistered_term (등록 초안)
 *   TR_DD     → DD가 단어사전에 없음                    → unknown_word (비슷한 용어 제안)
 */

export type Verdict = 'standard' | 'variant' | 'unregistered_term' | 'unknown_word';
export type TermRef = { id: string; logical_name: string; standard: string; physical_name: string; domain_name: string | null; domain_type: string | null };
export type TermDraft = { logical_name: string; physical_name: string; physical_abbr_name: string; words: string[] };
export type Resolution = {
  name: string;
  verdict: Verdict;
  /** standard·variant일 때 맞는 용어 */
  term: TermRef | null;
  /** 토큰마다 풀린 단어(없으면 null) */
  tokens: { token: string; word: string | null }[];
  /** unknown_word: 단어사전에 없는 토큰 */
  missing: string[];
  /** unregistered_term: 등록 초안 */
  draft: TermDraft | null;
  /** unknown_word: 비슷한 등록 용어 */
  similar: TermRef[];
};

export type DictIndex = {
  dict: Dictionary;
  dbms: string;
  byStandard: Map<string, Term>;
  byAnyName: Map<string, Term>;
  byLogical: Map<string, Term[]>;
  wordsByToken: Map<string, Word[]>;
  domains: Map<string, Domain>;
  /** 같은 논리명에 표준 이름이 둘 이상인 용어(사전 자체의 중복) */
  duplicates: { logical_name: string; standards: string[] }[];
};

const up = (s: string) => s.trim().toUpperCase();
const squash = (s: string) => s.replace(/\s+/g, '');
export const standardName = (t: Term) => up(t.physical_abbr_name || t.physical_name);

/** camelCase·snake_case 모두 대문자 snake로. trDt → TR_DT, tr_dt → TR_DT */
export function normalizeIdent(name: string): string {
  const snake = /[a-z]/.test(name) && /[A-Z]/.test(name) && !name.includes('_')
    ? name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    : name;
  return snake.toUpperCase().replace(/_+/g, '_').replace(/^_|_$/g, '');
}

export function buildIndex(dict: Dictionary, dbms: string): DictIndex {
  const byStandard = new Map<string, Term>();
  const byAnyName = new Map<string, Term>();
  const byLogical = new Map<string, Term[]>();
  for (const t of dict.terms) {
    byStandard.set(standardName(t), t);
    byAnyName.set(up(t.physical_name), t);
    if (t.physical_abbr_name) byAnyName.set(up(t.physical_abbr_name), t);
    const k = squash(t.logical_name);
    byLogical.set(k, [...(byLogical.get(k) ?? []), t]);
  }
  const wordsByToken = new Map<string, Word[]>();
  const addToken = (tok: string, w: Word) => {
    const k = up(tok).replace(/[^A-Z0-9]/g, '');
    if (!k) return;
    const list = wordsByToken.get(k) ?? [];
    if (!list.includes(w)) list.push(w);
    wordsByToken.set(k, list);
  };
  for (const w of dict.words) {
    if (w.abbreviation) addToken(w.abbreviation, w);
    if (w.english_name) addToken(w.english_name, w);
  }
  const domains = new Map(dict.domains.map((d) => [d.name, d]));
  const duplicates = [...byLogical.entries()]
    .map(([, ts]) => ({ logical_name: ts[0].logical_name, standards: [...new Set(ts.map(standardName))] }))
    .filter((d) => d.standards.length > 1);
  return { dict, dbms, byStandard, byAnyName, byLogical, wordsByToken, domains, duplicates };
}

export function termRef(ix: DictIndex, t: Term): TermRef {
  const d = t.domain_name ? ix.domains.get(t.domain_name) : undefined;
  return { id: t.id, logical_name: t.logical_name, standard: standardName(t), physical_name: t.physical_name, domain_name: t.domain_name, domain_type: d ? domainType(d, ix.dbms) : null };
}

/** 토큰마다 후보 단어를 곱해 나온 조합(너무 많아지지 않게 64개까지) */
function combos(cands: Word[][]): Word[][] {
  let out: Word[][] = [[]];
  for (const c of cands) {
    const next: Word[][] = [];
    for (const prefix of out) for (const w of c) { if (next.length < 64) next.push([...prefix, w]); }
    out = next;
  }
  return out;
}

const cache = new WeakMap<DictIndex, Map<string, Resolution>>();

export function resolve(ix: DictIndex, raw: string): Resolution {
  const name = normalizeIdent(raw);
  let memo = cache.get(ix);
  if (!memo) { memo = new Map(); cache.set(ix, memo); }
  const hit = memo.get(name);
  if (hit) return hit;
  const r = resolveFresh(ix, name);
  memo.set(name, r);
  return r;
}

function resolveFresh(ix: DictIndex, name: string): Resolution {
  const toks = name.split('_').filter(Boolean);
  const cands = toks.map((t) => ix.wordsByToken.get(t) ?? []);
  const tokens = toks.map((t, i) => ({ token: t, word: cands[i][0]?.name ?? null }));
  const base: Resolution = { name, verdict: 'standard', term: null, tokens, missing: [], draft: null, similar: [] };

  const std = ix.byStandard.get(name);
  if (std) return { ...base, term: termRef(ix, std) };
  const other = ix.byAnyName.get(name);
  if (other) return { ...base, verdict: 'variant', term: termRef(ix, other) };

  const missing = toks.filter((_, i) => !cands[i].length);
  if (missing.length) {
    return { ...base, verdict: 'unknown_word', missing, similar: similarTerms(ix, toks, cands) };
  }
  const all = combos(cands);
  for (const ws of all) {
    const ts = ix.byLogical.get(ws.map((w) => squash(w.name)).join(''));
    if (ts?.length) {
      return { ...base, verdict: 'variant', term: termRef(ix, ts[0]), tokens: toks.map((t, i) => ({ token: t, word: ws[i].name })) };
    }
  }
  const ws = all[0];
  return {
    ...base,
    verdict: 'unregistered_term',
    draft: {
      logical_name: ws.map((w) => w.name).join(''),
      words: ws.map((w) => w.name),
      physical_name: ws.map((w) => up(w.english_name).replace(/\s+/g, '_')).join('_'),
      physical_abbr_name: ws.map((w) => up(w.abbreviation || w.english_name).replace(/\s+/g, '_')).join('_'),
    },
  };
}

/** 단어사전에 없는 토큰이 있을 때: 아는 토큰의 단어를 같은 자리에 가진 용어를 겹치는 수로 골라 3개까지. */
function similarTerms(ix: DictIndex, toks: string[], cands: Word[][]): TermRef[] {
  const known = new Set(cands.flat().map((w) => squash(w.name)));
  if (!known.size) return [];
  const scored: { t: Term; score: number }[] = [];
  for (const t of ix.dict.terms) {
    const parts = standardName(t).split('_');
    if (Math.abs(parts.length - toks.length) > 1) continue;
    const logical = squash(t.logical_name);
    let score = 0;
    for (const k of known) if (logical.includes(k)) score += 2;
    parts.forEach((p, i) => { if (toks[i] === p) score += 1; });
    if (score >= 2) scored.push({ t, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map((s) => termRef(ix, s.t));
}

/**
 * VARCHAR2(10 BYTE) → VARCHAR(10), NUMBER ( 10, 2 ) → NUMBER(10,2).
 * VARCHAR2와 VARCHAR는 같게 본다(erd-vibe DDL 가져오기가 Oracle VARCHAR2를 VARCHAR로 저장한다).
 */
export function normalizeType(t: string): string {
  return up(t).replace(/\s+(BYTE|CHAR)\s*\)/g, ')').replace(/\s+/g, '').replace(/^VARCHAR2\b/, 'VARCHAR');
}

/** 실제 타입이 용어 도메인 타입과 같은지. 도메인에 길이가 없으면(DATE) 이름만 본다. */
export function typeMatches(actual: string, expected: string): boolean {
  const a = normalizeType(actual);
  const e = normalizeType(expected);
  if (a === e) return true;
  // 길이를 안 적은 CHAR는 CHAR(1)
  if ((a === 'CHAR' && e === 'CHAR(1)') || (e === 'CHAR' && a === 'CHAR(1)')) return true;
  if (!e.includes('(')) return a.split('(')[0] === e;
  return false;
}
