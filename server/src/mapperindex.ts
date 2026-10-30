import fs from 'node:fs';
import path from 'node:path';

/**
 * 워크트리의 MyBatis 매퍼 XML 색인. 로그의 로거 이름은 logback이 줄여 찍어(i.s.d.d.r.m.R.selectList)
 * 매퍼 클래스를 알 수 없으므로, 줄인 이름을 XML의 namespace.id와 맞대어 원래 매퍼와 파일 위치를 찾는다.
 */

export type MapperStatement = { namespace: string; id: string; file: string; line: number; tables: string[] };
export type MapperCaller = { file: string; line: number; text: string };
export type MapperLocation = { full_id: string; short_id: string; file: string; line: number; callers: MapperCaller[]; candidates: number };

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'target', 'out', 'bin', '.gradle', '.idea', 'dist']);
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; statements: MapperStatement[]; sources: string[] }>();

function walk(dir: string, visit: (file: string) => void) {
  let files = 0;
  const go = (d: string, depth: number) => {
    if (depth > 16 || files > 30000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) go(path.join(d, e.name), depth + 1); continue; }
      files++;
      visit(path.join(d, e.name));
    }
  };
  go(dir, 0);
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** 문장 본문에서 FROM·JOIN 뒤 테이블 이름(대문자). 모양과 맞대어 같은 이름의 문장 중 하나를 고를 때 쓴다. */
export function tableNames(sql: string): string[] {
  return [...new Set([...sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi)].map((m) => m[1].toUpperCase().split('.').pop()!))];
}

function index(dir: string) {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const statements: MapperStatement[] = [];
  const sources: string[] = [];
  walk(dir, (file) => {
    if (file.endsWith('.java') || file.endsWith('.kt')) { sources.push(file); return; }
    if (!file.endsWith('.xml')) return;
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const ns = text.match(/<mapper\s+namespace\s*=\s*"([\w.$]+)"/);
    if (!ns) return;
    for (const m of text.matchAll(/<(select|insert|update|delete)\b[^>]*?\bid\s*=\s*"([\w$]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
      statements.push({ namespace: ns[1], id: m[2], file: path.relative(dir, file), line: lineAt(text, m.index ?? 0), tables: tableNames(m[3]) });
    }
  });
  const entry = { at: Date.now(), statements, sources };
  cache.set(dir, entry);
  return entry;
}

/** 줄인 로거 이름의 각 마디가 원래 이름 마디의 앞부분인지(logback 줄임: io → i, RecMapper → R) */
function matchesAbbrev(abbrev: string, full: string): boolean {
  const a = abbrev.split('.');
  const f = full.split('.');
  if (a.length !== f.length) return false;
  return a.every((seg, i) => (i === a.length - 1 ? seg === f[i] : f[i].startsWith(seg)));
}

/** 로거 이름(줄였을 수 있음)과 SQL로 매퍼 문장을 찾는다. 같은 이름이 여럿이면 SQL의 테이블과 많이 겹치는 것을 고른다. */
function findStatement(dir: string, logger: string, sql: string): { best: MapperStatement; count: number } | null {
  const { statements } = index(dir);
  const id = logger.split('.').pop()!;
  let found = statements.filter((s) => s.id === id && matchesAbbrev(logger, `${s.namespace}.${s.id}`));
  // 로거가 패키지 없이 짧게(R.selectList) 남은 경우: 마지막 두 마디만 맞춘다.
  if (!found.length) found = statements.filter((s) => s.id === id && matchesAbbrev(logger.split('.').slice(-2).join('.'), `${s.namespace.split('.').pop()}.${s.id}`));
  if (!found.length) return null;
  const want = new Set(tableNames(sql));
  const score = (s: MapperStatement) => s.tables.filter((t) => want.has(t)).length;
  return { best: [...found].sort((a, b) => score(b) - score(a))[0], count: found.length };
}

/** 매퍼 문장 위치와, 그 매퍼 메서드를 부르는 소스 위치(인터페이스 이름이 나오는 파일에서 .메서드( 를 찾는다). */
export function locateMapper(dir: string, logger: string, sql: string): MapperLocation | null {
  const hit = findStatement(dir, logger, sql);
  if (!hit) return null;
  const { best } = hit;
  const iface = best.namespace.split('.').pop()!;
  const callers: MapperCaller[] = [];
  const call = new RegExp(`\\.${best.id}\\s*\\(`);
  for (const file of index(dir).sources) {
    if (callers.length >= 10) break;
    if (path.basename(file).startsWith(`${iface}.`)) continue;
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes(iface) || !call.test(text)) continue;
    text.split('\n').forEach((l, i) => { if (callers.length < 10 && call.test(l)) callers.push({ file: path.relative(dir, file), line: i + 1, text: l.trim().slice(0, 200) }); });
  }
  return { full_id: `${best.namespace}.${best.id}`, short_id: `${iface}.${best.id}`, file: best.file, line: best.line, callers, candidates: hit.count };
}

/** 목록에 보여 줄 매퍼 이름만 빠르게(호출 위치는 찾지 않는다). */
export function shortMapperId(dir: string, logger: string, sql: string): string | null {
  const hit = findStatement(dir, logger, sql);
  return hit ? `${hit.best.namespace.split('.').pop()}.${hit.best.id}` : null;
}
