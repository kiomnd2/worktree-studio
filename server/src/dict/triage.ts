import { normalizeType } from './judge.js';
import type { Finding, Issue } from './extract.js';

/**
 * 위반을 원인별로 묶는다. 이름마다 하나씩 보면 수백 건이지만, 원인으로 묶으면
 * "DD 단어 하나 등록하면 30개 이름이 풀린다"처럼 한 번에 처리할 단위가 된다.
 * 위반 하나가 여러 묶음에 들 수 있다(미등록 토큰이 둘이거나 도메인도 틀린 경우).
 */

export type GroupKind = 'word' | 'domain' | 'variant' | 'term' | 'not_in_erd';
export type FindingGroup = {
  key: string;
  kind: GroupKind;
  issue: Issue;
  /** word: 토큰, domain: 기대 ← 실제, variant: 표준 이름, term·not_in_erd: 빈 값 */
  title: string;
  /** variant: 표준 용어 논리명 */
  detail: string | null;
  /** 위반 키(테이블.컬럼, 테이블을 모르면 컬럼). 출현이 많은 순 */
  names: string[];
  occurrence_count: number;
  added: boolean;
};
export type HotFile = { project_name: string; file: string; names: number; occurrences: number };

export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup & { counts: Map<string, number> }>();
  const add = (key: string, kind: GroupKind, issue: Issue, title: string, detail: string | null, f: Finding) => {
    const g = groups.get(key) ?? { key, kind, issue, title, detail, names: [], occurrence_count: 0, added: false, counts: new Map() };
    if (!g.counts.has(f.key)) { g.counts.set(f.key, f.occurrence_count); g.occurrence_count += f.occurrence_count; }
    g.added ||= f.added;
    groups.set(key, g);
  };
  for (const f of findings) {
    const r = f.resolution;
    for (const i of f.issues) {
      if (i === 'unknown_word') for (const t of r.missing) add(`word:${t}`, 'word', i, t, null, f);
      else if (i === 'variant' && r.term) add(`variant:${r.term.standard}`, 'variant', i, r.term.standard, r.term.logical_name, f);
      else if (i === 'unregistered_term') add('term', 'term', i, '', null, f);
      else if (i === 'domain_mismatch' && f.domain) {
        // 실제 타입이 여럿이면 첫 번째 기준으로 묶는다(대부분 하나다).
        const actual = normalizeType(f.domain.actual[0]);
        add(`domain:${normalizeType(f.domain.expected)}<-${actual}`, 'domain', i, `${f.domain.expected} ← ${f.domain.actual[0]}`, null, f);
      } else if (i === 'not_in_erd') add('not_in_erd', 'not_in_erd', i, '', null, f);
    }
  }
  return [...groups.values()]
    .map(({ counts, ...g }) => ({ ...g, names: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n) }))
    .sort((a, b) => b.names.length - a.names.length || b.occurrence_count - a.occurrence_count || a.key.localeCompare(b.key));
}

/** 위반이 많이 나온 파일. 상관없는 경로를 검사에서 뺄 때 고르기 쉽게 */
export function hotFiles(findings: Finding[], limit = 10): HotFile[] {
  const m = new Map<string, HotFile & { set: Set<string> }>();
  for (const f of findings) for (const o of f.occurrences) {
    const k = `${f.project_name}\0${o.file}`;
    const h = m.get(k) ?? { project_name: f.project_name, file: o.file, names: 0, occurrences: 0, set: new Set() };
    h.set.add(f.key); h.occurrences++;
    m.set(k, h);
  }
  return [...m.values()].map(({ set, ...h }) => ({ ...h, names: set.size }))
    .sort((a, b) => b.occurrences - a.occurrences).slice(0, limit);
}

export type BaselineStatus = 'todo' | 'hold' | 'accepted';
export type BaselineView = {
  created_at: string;
  total: number;
  resolved: number;
  remaining: number;
  todo: number;
  hold: number;
  accepted: number;
  /** 기준선에 없는 위반(테이블.컬럼|종류) 수 */
  new_count: number;
  /** 기준선에 있는데 출현 수가 늘어난·줄어든 키 수와, 늘어난·줄어든 출현 합 */
  increased: number;
  decreased: number;
  occ_added: number;
  occ_removed: number;
  /** 이번 검사 위반의 키(baselineKey) → 상태. 기준선에 없으면 빠져 있다 */
  status: Record<string, BaselineStatus>;
  notes: Record<string, string>;
};

/**
 * 기준선 한 줄의 키. (테이블, 컬럼, 위반 종류) 단위로 잡아, 도메인만 고쳐도 그만큼 해결로 센다.
 * 테이블을 모르는 위치는 빈 테이블, 옛 기준선(이름 단위)에서 옮긴 줄은 '*'(아무 테이블)다.
 */
export const baselineKey = (table: string | null, name: string, issue: Issue) => `${table ?? ''}|${name}|${issue}`;

/** 검사 제외 경로 패턴. `**`는 여러 폴더, `*`는 폴더 안의 이름 일부. 패턴에 /가 없으면 어느 폴더에서든 이름이 맞으면 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.trim().replace(/^\.?\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
    }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // 폴더 패턴(끝이 /)은 그 아래 전부
  if (p.endsWith('/')) re += '.*';
  return new RegExp(p.includes('/') ? `^${re}$` : `(^|/)${re}(/|$)`);
}
