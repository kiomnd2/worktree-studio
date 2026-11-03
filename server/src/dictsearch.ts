import { domainType, type Domain, type Word } from './erdvibe.js';
import { resolve, termRef, type Resolution, type TermRef } from './dict/judge.js';
import { sessionIndex } from './dictscan.js';
import type { SessionView } from './sessions.js';

/**
 * 사전 통합 검색(화면과 Claude의 dict_lookup). 받아 둔 사전에서 찾으므로 erd-vibe를 매번 부르지 않는다.
 * 검색어가 영문 식별자면(TR_DATE, trDt) 판정도 같이 돌려 표준 이름을 알려 준다.
 */

export type DictSearchResult = {
  dbms: string;
  query: string;
  resolution: Resolution | null;
  terms: (TermRef & { description: string; physical_abbr_name: string | null })[];
  words: Word[];
  domains: (Domain & { type_for_dbms: string | null })[];
  total: { terms: number; words: number; domains: number };
  /** 연결한 ERD에서 용어별로 연결된 컬럼 수(사전 관리에서 지울 때 알려 주려고) */
  erd_usage: Record<string, number>;
  /** 도메인별로 그 도메인을 쓰는 용어 수 */
  domain_usage: Record<string, number>;
};

export async function searchDictionary(s: SessionView, raw: string, limit = 50): Promise<DictSearchResult> {
  const { ix, erd } = await sessionIndex(s);
  const erd_usage: Record<string, number> = {};
  for (const c of erd?.tables.flatMap((t) => t.columns) ?? []) if (c.term_dictionary_id) erd_usage[c.term_dictionary_id] = (erd_usage[c.term_dictionary_id] ?? 0) + 1;
  const domain_usage: Record<string, number> = {};
  for (const t of ix.dict.terms) if (t.domain_name) domain_usage[t.domain_name] = (domain_usage[t.domain_name] ?? 0) + 1;
  const q = raw.trim();
  const qs = q.replace(/\s+/g, '').toUpperCase();
  const has = (...v: (string | null | undefined)[]) => !qs || v.some((x) => (x ?? '').replace(/\s+/g, '').toUpperCase().includes(qs));
  // 정확히 같은 것을 먼저
  const exact = (...v: (string | null | undefined)[]) => v.some((x) => (x ?? '').replace(/\s+/g, '').toUpperCase() === qs);
  const order = <T>(list: T[], keys: (x: T) => (string | null | undefined)[]) =>
    [...list].sort((a, b) => Number(exact(...keys(b))) - Number(exact(...keys(a))));

  const resolution = /^[A-Za-z][A-Za-z0-9_]*$/.test(q) ? resolve(ix, q) : null;
  // 판정으로 찾은 용어(TR_DATE → 거래일자)는 이름이 안 겹쳐도 맨 앞에
  const resolved = resolution?.term ? ix.dict.terms.find((t) => t.id === resolution.term!.id) : undefined;
  const terms = [
    ...(resolved ? [resolved] : []),
    ...order(ix.dict.terms.filter((t) => t !== resolved && has(t.logical_name, t.physical_name, t.physical_abbr_name, t.domain_name)), (t) => [t.logical_name, t.physical_name, t.physical_abbr_name]),
  ];
  const words = order(ix.dict.words.filter((w) => has(w.name, w.english_name, w.abbreviation)), (w) => [w.name, w.english_name, w.abbreviation]);
  const domains = order(ix.dict.domains.filter((d) => has(d.name, d.description)), (d) => [d.name]);
  return {
    dbms: ix.dbms,
    query: q,
    resolution,
    terms: terms.slice(0, limit).map((t) => ({ ...termRef(ix, t), description: t.description, physical_abbr_name: t.physical_abbr_name })),
    words: words.slice(0, limit),
    domains: domains.slice(0, 500).map((d) => ({ ...d, type_for_dbms: domainType(d, ix.dbms) })),
    total: { terms: terms.length, words: words.length, domains: domains.length },
    erd_usage, domain_usage,
  };
}
