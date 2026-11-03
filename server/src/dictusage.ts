import fs from 'node:fs';
import path from 'node:path';
import { walk } from './mapperindex.js';
import { normalizeIdent, standardName, termRef, type TermRef } from './dict/judge.js';
import { excludeMatcher, scanFile, sessionIndex } from './dictscan.js';
import type { SessionView } from './sessions.js';
import type { Word } from './dict/types.js';

/**
 * 사전 항목이 실제로 쓰이는지. 소스는 세션 워크트리 전체에서 컬럼 이름이 나온 횟수(제외 경로는 빼고, 무시 목록은 상관없이),
 * ERD는 용어에 연결된 컬럼과 같은 이름 컬럼을 센다. 소스를 다 훑는 데 시간이 들어 세션마다 결과를 들고 있다.
 */

type SourceCount = { count: number; files: Set<string> };
const cache = new Map<number, { at: number; names: Map<string, SourceCount> }>();

function sourceNames(s: SessionView): Map<string, SourceCount> {
  const excluded = excludeMatcher(s.workspace_id);
  const names = new Map<string, SourceCount>();
  for (const w of s.repos.filter((r) => fs.existsSync(r.path))) {
    walk(w.path, (abs) => {
      const rel = path.relative(w.path, abs);
      if (excluded(w.project_name, rel)) return;
      for (const r of scanFile(abs, rel, new Set())) {
        const n = normalizeIdent(r.name);
        if (!n) continue;
        const c = names.get(n) ?? { count: 0, files: new Set() };
        c.count++; c.files.add(`${w.project_name}/${rel}`);
        names.set(n, c);
      }
    });
  }
  return names;
}

export function forgetUsage(sessionId?: number) {
  if (sessionId === undefined) cache.clear(); else cache.delete(sessionId);
}

export type TermUsage = { source: number; files: number; erd_link: number; erd_name: number };
export type OverlapTerm = TermRef & { physical_abbr_name: string | null; description: string; usage: TermUsage };
export type DictUsage = {
  scanned_at: number;
  erd_project: { id: string; name: string } | null;
  terms: Record<string, TermUsage>;
  /** 논리명이 같은 용어 묶음 */
  term_overlaps: { logical_name: string; terms: OverlapTerm[] }[];
  /** 약어가 같은 단어 묶음과, 그 약어 토큰이 들어간 소스 이름 */
  word_overlaps: { abbreviation: string; words: Word[]; source: number; examples: { name: string; count: number }[] }[];
};

export async function dictUsage(s: SessionView, refresh = false): Promise<DictUsage> {
  if (refresh) cache.delete(s.id);
  let hit = cache.get(s.id);
  if (!hit) { hit = { at: Date.now(), names: sourceNames(s) }; cache.set(s.id, hit); }
  const { ix, erd } = await sessionIndex(s);
  const names = hit.names;

  const erdLink = new Map<string, number>();
  const erdName = new Map<string, number>();
  for (const c of erd?.tables.flatMap((t) => t.columns) ?? []) {
    if (c.term_dictionary_id) erdLink.set(c.term_dictionary_id, (erdLink.get(c.term_dictionary_id) ?? 0) + 1);
    const n = normalizeIdent(c.physical_name);
    erdName.set(n, (erdName.get(n) ?? 0) + 1);
  }

  const terms: Record<string, TermUsage> = {};
  for (const t of ix.dict.terms) {
    const keys = [...new Set([standardName(t), t.physical_name.trim().toUpperCase()])];
    const files = new Set<string>();
    let source = 0; let byName = 0;
    for (const k of keys) {
      const c = names.get(k);
      if (c) { source += c.count; c.files.forEach((f) => files.add(f)); }
      byName += erdName.get(k) ?? 0;
    }
    terms[t.id] = { source, files: files.size, erd_link: erdLink.get(t.id) ?? 0, erd_name: byName };
  }

  const squash = (v: string) => v.replace(/\s+/g, '');
  const term_overlaps = [...ix.byLogical.values()]
    .filter((ts) => new Set(ts.map(standardName)).size > 1)
    .map((ts) => ({
      logical_name: ts[0].logical_name,
      terms: ts.map((t) => ({ ...termRef(ix, t), physical_abbr_name: t.physical_abbr_name, description: t.description, usage: terms[t.id] }))
        .sort((a, b) => used(b.usage) - used(a.usage)),
    }))
    .sort((a, b) => squash(a.logical_name).localeCompare(squash(b.logical_name)));

  // 토큰 → 그 토큰이 들어간 소스 이름
  const byToken = new Map<string, { name: string; count: number }[]>();
  for (const [n, c] of names) for (const tok of new Set(n.split('_'))) {
    const list = byToken.get(tok) ?? [];
    list.push({ name: n, count: c.count });
    byToken.set(tok, list);
  }
  const word_overlaps = [...ix.wordsByToken.entries()]
    .filter(([tok, ws]) => ws.length > 1 && ws.some((w) => (w.abbreviation ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === tok))
    .map(([tok, ws]) => {
      const ex = (byToken.get(tok) ?? []).sort((a, b) => b.count - a.count);
      return { abbreviation: tok, words: ws, source: ex.reduce((a, e) => a + e.count, 0), examples: ex.slice(0, 8) };
    })
    .sort((a, b) => a.abbreviation.localeCompare(b.abbreviation));

  return { scanned_at: hit.at, erd_project: erd ? { id: erd.id, name: erd.name } : null, terms, term_overlaps, word_overlaps };
}

export const used = (u: TermUsage | undefined) => (u ? u.source + u.erd_link * 100 + u.erd_name * 10 : 0);
