import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { git, refExists } from './git.js';
import { walk } from './mapperindex.js';
import { getSession, type SessionView } from './sessions.js';
import { dictionary, erdProject } from './erdvibe.js';
import { buildIndex, normalizeIdent, resolve, typeMatches, type DictIndex, type TermRef } from './dict/judge.js';
import { diffSchema, erdFindingsOf, findingKey, scanText, sourceKind, SCAN_EXTS, type CheckFilter, type DomainMiss, type IgnoreMatch, type SchemaDiff, type DictReport, type Finding, type Issue, type MixedGroup, type Occurrence, type Raw } from './dict/extract.js';
import type { ErdProject } from './dict/types.js';
import { globToRegExp, groupFindings, hotFiles } from './dict/triage.js';
import { compareBaseline, hasBaseline } from './dictbaseline.js';
import { finalSchemaRaws, repoSchema } from './schemasync.js';

export { findingLine, issueLabel, erdFindingsOf, type CheckFilter, type DictReport } from './dict/extract.js';

/**
 * 워크트리 소스에서 컬럼 이름을 뽑아 용어사전·ERD와 맞댄다. 판정·추출 규칙은 dict/(순수 함수)에 있고,
 * 여기서는 파일 읽기, 이번 변경의 추가 줄(git), 무시 목록(DB)을 붙인다.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS dict_ignores (
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, name)
);
CREATE TABLE IF NOT EXISTS dict_excludes (
  workspace_id INTEGER NOT NULL,
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, pattern)
);
`);

export function scanFile(abs: string, rel: string, tableNames: Set<string>): Raw[] {
  const ext = path.extname(abs).toLowerCase();
  if (!SCAN_EXTS.includes(ext)) return [];
  try {
    if (fs.statSync(abs).size > 2_000_000) return [];
    return scanText(fs.readFileSync(abs, 'utf8'), ext, rel, tableNames);
  } catch { return []; }
}

/** 기준 브랜치에서 갈라진 뒤 바뀐 파일과, 파일마다 추가된 줄 번호. 추적하지 않는 새 파일은 모든 줄이 추가. */
export async function addedLines(w: SessionView['repos'][number]): Promise<Map<string, Set<number> | 'all'>> {
  const out = new Map<string, Set<number> | 'all'>();
  const base = (await refExists(w.path, `refs/remotes/origin/${w.base_branch}`)) ? `origin/${w.base_branch}` : w.base_branch;
  const ref = await git(w.path, ['merge-base', base, 'HEAD']);
  const diff = await git(w.path, ['diff', '-U0', '--no-color', '--no-ext-diff', ref, '--', '*.xml', '*.sql', '*.java', '*.kt']);
  let file: string | null = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(6); if (file) out.set(file, new Set()); continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      const start = Number(h[1]); const n = h[2] === undefined ? 1 : Number(h[2]);
      const set = out.get(file) as Set<number>;
      for (let i = 0; i < n; i++) set.add(start + i);
    }
  }
  const untracked = await git(w.path, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const f of untracked.split('\0').filter(Boolean)) out.set(f, 'all');
  return out;
}

/**
 * 예외(무시) 목록. 컬럼 이름에 테이블·위반 종류를 좁혀 걸 수 있다(빈 값 = 전부).
 * 예전 표(dict_ignores, 이름만)는 처음 한 번 옮긴다.
 */
const freshIgnores = !db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dict_ignores2'`).get();
db.exec(`
CREATE TABLE IF NOT EXISTS dict_ignores2 (
  workspace_id INTEGER NOT NULL,
  tbl TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  issue TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, tbl, name, issue)
);
`);
if (freshIgnores) db.exec(`INSERT OR IGNORE INTO dict_ignores2 (workspace_id, name, reason, created_at) SELECT workspace_id, name, reason, created_at FROM dict_ignores`);

export type IgnoreRule = { table: string; name: string; issue: string; reason: string; created_at: string };
export function ignoresOf(workspaceId: number): IgnoreRule[] {
  return db.prepare(`SELECT tbl AS "table", name, issue, reason, created_at FROM dict_ignores2 WHERE workspace_id = ? ORDER BY name, tbl, issue`).all(workspaceId) as IgnoreRule[];
}
/** reason이 null이면 지운다. table·issue를 비우면 그 이름 전부 */
export function setIgnore(workspaceId: number, name: string, reason: string | null, table = '', issue = '') {
  const n = normalizeIdent(name);
  const t = table.trim().toUpperCase();
  if (!n) throw new Error('컬럼 이름이 필요합니다.');
  if (reason === null) db.prepare(`DELETE FROM dict_ignores2 WHERE workspace_id = ? AND tbl = ? AND name = ? AND issue = ?`).run(workspaceId, t, n, issue);
  else db.prepare(`INSERT INTO dict_ignores2 (workspace_id, tbl, name, issue, reason) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, tbl, name, issue) DO UPDATE SET reason = excluded.reason`).run(workspaceId, t, n, issue, reason);
}
export function ignoreMatcher(workspaceId: number): IgnoreMatch {
  const rules = ignoresOf(workspaceId);
  const byName = new Map<string, IgnoreRule[]>();
  for (const r of rules) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  return (table, name, issue) => (byName.get(name) ?? []).some((r) =>
    (!r.table || r.table === (table ?? '').toUpperCase()) && (issue ? !r.issue || r.issue === issue : !r.issue));
}

/** 검사에서 뺄 경로(glob). 앱 안의 상대 경로나 "앱이름/상대 경로"에 맞으면 뺀다. */
export function excludesOf(workspaceId: number): string[] {
  return (db.prepare(`SELECT pattern FROM dict_excludes WHERE workspace_id = ? ORDER BY pattern`).all(workspaceId) as { pattern: string }[]).map((r) => r.pattern);
}
export function setExcludes(workspaceId: number, patterns: string[]) {
  const clean = [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
  for (const p of clean) globToRegExp(p); // 잘못된 패턴이면 여기서 throw
  db.transaction(() => {
    db.prepare(`DELETE FROM dict_excludes WHERE workspace_id = ?`).run(workspaceId);
    const ins = db.prepare(`INSERT INTO dict_excludes (workspace_id, pattern) VALUES (?, ?)`);
    for (const p of clean) ins.run(workspaceId, p);
  })();
}
export function excludeMatcher(workspaceId: number): (projectName: string, rel: string) => boolean {
  const res = excludesOf(workspaceId).map(globToRegExp);
  if (!res.length) return () => false;
  return (projectName, rel) => {
    const r = rel.split(path.sep).join('/');
    return res.some((re) => re.test(r) || re.test(`${projectName}/${r}`));
  };
}

/** 세션이 쓰는 ERD = 세션 워크스페이스에 고른 ERD. */
export function sessionErdId(s: SessionView): string | null {
  return (db.prepare(`SELECT erd_project_id FROM workspaces WHERE id = ?`).get(s.workspace_id) as { erd_project_id: string | null } | undefined)?.erd_project_id ?? null;
}

/** 세션에 연결한 ERD와 사전 색인. ERD를 못 받아도 사전만으로 검사한다. */
export async function sessionIndex(s: SessionView): Promise<{ ix: DictIndex; erd: ErdProject | null; erdError: string | null }> {
  const dict = await dictionary();
  const erdId = sessionErdId(s);
  let erd: ErdProject | null = null;
  let erdError: string | null = null;
  if (erdId) { try { erd = await erdProject(erdId); } catch (err) { erdError = (err as Error).message; } }
  return { ix: buildIndex(dict, erd?.dbms_type ?? 'ORACLE'), erd, erdError };
}

export type CheckOptions = CheckFilter & { refresh?: boolean };

/** 판정에서 남길 이슈인지: 이름 단위 판정(variant 등)과 테이블 단위 판정(domain·ERD)을 모두 (테이블, 컬럼)에 건다 */
const REAL = (i: Issue) => i !== 'not_in_erd';

export async function checkSession(sessionId: number, scope: 'changed' | 'all', opts: CheckOptions = {}): Promise<DictReport> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  if (opts.refresh) await refreshSessionDictionary(s);
  const { ix, erd, erdError } = await sessionIndex(s);
  const ignored = ignoreMatcher(s.workspace_id);
  const excluded = excludeMatcher(s.workspace_id);
  const extra = (opts.exclude_paths ?? []).map((p) => p.trim()).filter(Boolean).map(globToRegExp);
  const excludedNow = (project: string, rel: string) => {
    if (excluded(project, rel)) return true;
    const r = rel.split(path.sep).join('/');
    return extra.some((re) => re.test(r) || re.test(`${project}/${r}`));
  };
  const tableRes = (opts.tables ?? []).map((p) => p.trim()).filter(Boolean).map((p) => globToRegExp(p.toUpperCase()));
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
  const issueFilter = opts.issues?.length ? new Set(opts.issues) : null;
  let excludedFiles = 0;
  const erdTables = new Map((erd?.tables ?? []).map((t) => [t.physical_name.toUpperCase(), new Set(t.columns.map((c) => c.physical_name.toUpperCase()))]));
  const erdColNames = new Set([...erdTables.values()].flatMap((c) => [...c]));
  const erdTableNames = new Set(erdTables.keys());

  // 위치를 먼저 다 모은 뒤 (테이블, 컬럼)으로 묶는다. 소스 DDL·Liquibase·JPA에 나온 테이블과 ERD 테이블만 테이블로 믿는다
  // (SQL 별칭을 못 푼 이름이나 서브쿼리 별칭이 테이블로 잡히지 않게).
  const all: { project: string; name: string; occ: Occurrence }[] = [];
  const knownTables = new Set(erdTables.keys());
  let scanned = 0;
  let skippedIgnored = 0;
  for (const w of s.repos.filter((r) => fs.existsSync(r.path))) {
    let added = new Map<string, Set<number> | 'all'>();
    try { added = await addedLines(w); } catch { /* 기준 브랜치가 없으면 추가 줄 판별 없이 */ }
    const files: string[] = [];
    if (scope === 'changed') {
      for (const f of added.keys()) if (fs.existsSync(path.join(w.path, f))) files.push(path.join(w.path, f));
    } else {
      walk(w.path, (f) => files.push(f));
    }
    // Liquibase 앱은 changelog를 다 훑지 않고 최종 스키마 컬럼을 쓴다(rename·drop된 옛 이름이 위반으로 남지 않게).
    const final = finalSchemaRaws(repoSchema(w.path, w.project_name, excluded));
    const texts = new Map<string, string[]>();
    const lineText = (rel: string, n: number) => {
      let t = texts.get(rel);
      if (!t) { try { t = fs.readFileSync(path.join(w.path, rel), 'utf8').split('\n'); } catch { t = []; } texts.set(rel, t); }
      return (t[n - 1] ?? '').trim().slice(0, 200);
    };
    const take = (rel: string, raws: Raw[]) => {
      const lines = added.get(rel);
      for (const r of raws) {
        const name = normalizeIdent(r.name);
        if (!name) continue;
        if (r.table && (r.kind === 'ddl' || r.kind === 'liquibase' || r.kind === 'jpa')) knownTables.add(r.table.toUpperCase());
        const isAdded = lines === 'all' || Boolean(lines?.has(r.line));
        all.push({ project: w.project_name, name, occ: { file: r.file, line: r.line, kind: r.kind, table: r.table?.toUpperCase() ?? null, type: r.type, text: lineText(r.file, r.line), added: isAdded } });
      }
    };
    for (const abs of files) {
      const rel = path.relative(w.path, abs);
      if (SCAN_EXTS.includes(path.extname(abs).toLowerCase()) && excludedNow(w.project_name, rel)) { excludedFiles++; continue; }
      if (final?.files.has(rel)) continue;
      const raws = scanFile(abs, rel, erdTableNames);
      if (!raws.length) continue;
      scanned++;
      take(rel, raws);
    }
    if (final) {
      const byFile = new Map<string, Raw[]>();
      for (const r of final.raws) {
        // 이번 변경 검사는 바뀐 changelog에서 만들거나 바꾼 컬럼만
        if ((scope === 'changed' && !added.has(r.file)) || excludedNow(w.project_name, r.file)) continue;
        byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
      }
      for (const [rel, raws] of byFile) { scanned++; take(rel, raws); }
    }
  }

  const byKey = new Map<string, { project: string; name: string; table: string | null; occ: Occurrence[] }>();
  for (const a of all) {
    if (a.occ.table && !knownTables.has(a.occ.table)) a.occ.table = null;
    if (kinds && !kinds.has(sourceKind(a.occ))) continue;
    if (tableRes.length && !(a.occ.table && tableRes.some((re) => re.test(a.occ.table!)))) continue;
    if (ignored(a.occ.table, a.name)) { skippedIgnored++; continue; }
    const key = findingKey(a.occ.table, a.name);
    const e = byKey.get(key) ?? { project: a.project, name: a.name, table: a.occ.table, occ: [] };
    e.occ.push(a.occ);
    byKey.set(key, e);
  }

  const findings: Finding[] = [];
  const byTerm = new Map<string, { term: TermRef; names: Map<string, number> }>();
  for (const [key, { project, name, table, occ }] of byKey) {
    const res = resolve(ix, name);
    let issues: Issue[] = [];
    if (res.verdict !== 'standard') issues.push(res.verdict);
    let domain: Finding['domain'] = null;
    const expected = res.term?.domain_type;
    if (expected) {
      // 소스에 타입이 적힌 곳(DDL·Liquibase·columnDefinition)만 본다. ERD 컬럼의 타입은 ERD 위반에서 따로 본다.
      const bad: DomainMiss[] = occ.filter((o) => o.type && !typeMatches(o.type, expected, ix.dbms))
        .map((o) => ({ table: o.table, file: o.file, line: o.line, type: o.type!, added: o.added }));
      if (bad.length) { issues.push('domain_mismatch'); domain = { expected, actual: [...new Set(bad.map((b) => b.type))], bad }; }
    }
    // 테이블을 알고 ERD에 그 테이블이 있으면 그 테이블의 컬럼으로, 아니면 ERD 전체 컬럼 이름으로 본다
    if (erd && !(table && erdTables.has(table) ? erdTables.get(table)!.has(name) : erdColNames.has(name))) issues.push('not_in_erd');
    if (res.term) {
      const g = byTerm.get(res.term.id) ?? { term: res.term, names: new Map() };
      g.names.set(name, (g.names.get(name) ?? 0) + occ.length);
      byTerm.set(res.term.id, g);
    }
    issues = issues.filter((i) => !ignored(table, name, i) && (!issueFilter || issueFilter.has(i)));
    if (!issues.length) continue;
    occ.sort((a, b) => Number(b.added) - Number(a.added));
    findings.push({
      key, name, table, project_name: project, resolution: res, issues, added: occ.some((o) => o.added),
      blocking: false, domain, baseline: null, occurrences: occ.slice(0, 500), occurrence_count: occ.length,
    });
  }

  const ws = s.workspace_id;
  const baseline = compareBaseline(ws, findings, scope);
  const withBaseline = hasBaseline(ws);
  let suppressed = 0;
  for (const f of findings) {
    // 기준선이 있으면 기준선에 없는 (테이블, 컬럼, 종류)가 있어야 막는다. 보류·허용은 집계에서 뺀다.
    const fresh = !withBaseline || f.baseline === 'new';
    f.blocking = f.added && f.issues.some(REAL) && fresh;
    if (f.baseline === 'hold' || f.baseline === 'accepted') suppressed++;
  }
  const rank = (f: Finding) => (f.blocking ? 0 : f.added ? 1 : 2) * 10 + (f.issues.includes('variant') ? 0 : f.issues.includes('unknown_word') ? 1 : f.issues.includes('unregistered_term') ? 2 : 3);
  findings.sort((a, b) => rank(a) - rank(b) || b.occurrence_count - a.occurrence_count || a.key.localeCompare(b.key));

  const mixed: MixedGroup[] = [...byTerm.values()].filter((g) => g.names.size > 1).map((g) => ({
    logical_name: g.term.logical_name, standard: g.term.standard,
    spellings: [...g.names.entries()].map(([n, count]) => ({ name: n, count, standard: n === g.term.standard })).sort((a, b) => b.count - a.count),
  }));

  const erdFindings = (erd ? erdFindingsOf(ix, erd, ignored) : [])
    .filter((e) => !tableRes.length || tableRes.some((re) => re.test(e.table.toUpperCase())))
    .filter((e) => !issueFilter || e.issues.some((i) => i === 'no_term_link' || issueFilter.has(i)));
  const filter: CheckFilter | null = tableRes.length || extra.length || kinds || issueFilter
    ? { tables: opts.tables, exclude_paths: opts.exclude_paths, kinds: opts.kinds, issues: opts.issues } : null;

  return {
    scope, generated_at: Date.now(), dbms: ix.dbms,
    erd_project: erd ? { id: erd.id, name: erd.name, dbms_type: erd.dbms_type } : null,
    scanned_files: scanned, findings, mixed, erd_findings: erdFindings,
    dictionary_duplicates: ix.duplicates, ignored: skippedIgnored, suppressed, filter,
    groups: groupFindings(findings), hot_files: hotFiles(findings),
    baseline, excluded_files: excludedFiles,
    error: erdError,
  };
}

/** 사전과 연결한 ERD를 erd-vibe에서 다시 받는다(erd-vibe 화면·REST로 바로 고친 것을 검사에 반영). */
export async function refreshSessionDictionary(s: SessionView): Promise<{ words: number; terms: number; domains: number; erd_tables: number | null }> {
  const d = await dictionary(true);
  const erdId = sessionErdId(s);
  const erd = erdId ? await erdProject(erdId, true).catch(() => null) : null;
  return { words: d.words.length, terms: d.terms.length, domains: d.domains.length, erd_tables: erd ? erd.tables.length : null };
}


/** 세션 워크트리 전체의 DDL·Liquibase를 연결한 ERD와 비교한다. */
export async function erdDiffSession(sessionId: number): Promise<{ erd: { id: string; name: string } | null; source_tables: number; diffs: SchemaDiff[] }> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const erdId = sessionErdId(s);
  if (!erdId) return { erd: null, source_tables: 0, diffs: [] };
  const erd = await erdProject(erdId);
  const raws: Raw[] = [];
  const excluded = excludeMatcher(s.workspace_id);
  for (const w of s.repos.filter((r) => fs.existsSync(r.path))) {
    const prefix = (rel: string) => (s.repos.length > 1 ? `${w.project_name}/${rel}` : rel);
    // Liquibase 앱은 최종 스키마로 비교한다(옛 이름이 "소스에만 있음"으로 나오지 않게)
    const final = finalSchemaRaws(repoSchema(w.path, w.project_name, excluded));
    if (final) { raws.push(...final.raws.map((r) => ({ ...r, file: prefix(r.file) }))); continue; }
    walk(w.path, (abs) => {
      const ext = path.extname(abs).toLowerCase();
      if (ext !== '.sql' && ext !== '.xml') return;
      raws.push(...scanFile(abs, prefix(path.relative(w.path, abs)), new Set()).filter((r) => r.kind === 'ddl' || r.kind === 'liquibase'));
    });
  }
  const tables = new Set(raws.filter((r) => r.table && r.type).map((r) => r.table!.toUpperCase()));
  return { erd: { id: erd.id, name: erd.name }, source_tables: tables.size, diffs: diffSchema(raws, erd) };
}
