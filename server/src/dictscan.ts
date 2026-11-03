import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { git, refExists } from './git.js';
import { walk } from './mapperindex.js';
import { getSession, type SessionView } from './sessions.js';
import { dictionary, erdProject } from './erdvibe.js';
import { buildIndex, normalizeIdent, resolve, typeMatches, type DictIndex, type TermRef } from './dict/judge.js';
import { diffSchema, erdFindingsOf, scanText, SCAN_EXTS, type SchemaDiff, type DictReport, type Finding, type Issue, type MixedGroup, type Occurrence, type Raw } from './dict/extract.js';
import type { ErdProject } from './dict/types.js';
import { globToRegExp, groupFindings, hotFiles } from './dict/triage.js';
import { compareBaseline } from './dictbaseline.js';
import { finalSchemaRaws, repoSchema } from './schemasync.js';

export { findingLine, issueLabel, erdFindingsOf, type DictReport } from './dict/extract.js';

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

export function ignoresOf(workspaceId: number): { name: string; reason: string; created_at: string }[] {
  return db.prepare(`SELECT name, reason, created_at FROM dict_ignores WHERE workspace_id = ? ORDER BY name`).all(workspaceId) as { name: string; reason: string; created_at: string }[];
}
export function setIgnore(workspaceId: number, name: string, reason: string | null) {
  const n = normalizeIdent(name);
  if (reason === null) db.prepare(`DELETE FROM dict_ignores WHERE workspace_id = ? AND name = ?`).run(workspaceId, n);
  else db.prepare(`INSERT INTO dict_ignores (workspace_id, name, reason) VALUES (?, ?, ?) ON CONFLICT(workspace_id, name) DO UPDATE SET reason = excluded.reason`).run(workspaceId, n, reason);
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

export async function checkSession(sessionId: number, scope: 'changed' | 'all'): Promise<DictReport> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const { ix, erd, erdError } = await sessionIndex(s);
  const ignored = new Set(ignoresOf(s.workspace_id).map((i) => i.name));
  const excluded = excludeMatcher(s.workspace_id);
  let excludedFiles = 0;
  const erdTables = new Set(erd?.tables.map((t) => t.physical_name.toUpperCase()) ?? []);
  const erdColNames = new Set((erd?.tables ?? []).flatMap((t) => t.columns.map((c) => c.physical_name.toUpperCase())));

  const byName = new Map<string, { project: string; occ: Occurrence[] }>();
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
        if (ignored.has(name)) { skippedIgnored++; continue; }
        const isAdded = lines === 'all' || Boolean(lines?.has(r.line));
        const entry = byName.get(name) ?? { project: w.project_name, occ: [] };
        entry.occ.push({ file: r.file, line: r.line, kind: r.kind, table: r.table, type: r.type, text: lineText(r.file, r.line), added: isAdded });
        byName.set(name, entry);
      }
    };
    for (const abs of files) {
      const rel = path.relative(w.path, abs);
      if (SCAN_EXTS.includes(path.extname(abs).toLowerCase()) && excluded(w.project_name, rel)) { excludedFiles++; continue; }
      if (final?.files.has(rel)) continue;
      const raws = scanFile(abs, rel, erdTables);
      if (!raws.length) continue;
      scanned++;
      take(rel, raws);
    }
    if (final) {
      const byFile = new Map<string, Raw[]>();
      for (const r of final.raws) {
        // 이번 변경 검사는 바뀐 changelog에서 만들거나 바꾼 컬럼만
        if ((scope === 'changed' && !added.has(r.file)) || excluded(w.project_name, r.file)) continue;
        byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
      }
      for (const [rel, raws] of byFile) { scanned++; take(rel, raws); }
    }
  }

  const findings: Finding[] = [];
  const byTerm = new Map<string, { term: TermRef; names: Map<string, number> }>();
  for (const [name, { project, occ }] of byName) {
    const res = resolve(ix, name);
    const issues: Issue[] = [];
    if (res.verdict !== 'standard') issues.push(res.verdict);
    let domain: Finding['domain'] = null;
    const expected = res.term?.domain_type;
    if (expected) {
      // 소스에 타입이 적힌 곳(DDL·Liquibase·columnDefinition)만 본다. ERD 컬럼의 타입은 ERD 위반에서 따로 본다.
      const bad = [...new Set(occ.map((o) => o.type).filter((t): t is string => Boolean(t)))]
        .filter((t) => !typeMatches(t, expected));
      if (bad.length) { issues.push('domain_mismatch'); domain = { expected, actual: bad }; }
    }
    if (erd && !erdColNames.has(name)) issues.push('not_in_erd');
    if (res.term) {
      const g = byTerm.get(res.term.id) ?? { term: res.term, names: new Map() };
      g.names.set(name, (g.names.get(name) ?? 0) + occ.length);
      byTerm.set(res.term.id, g);
    }
    if (!issues.length) continue;
    const isAdded = occ.some((o) => o.added);
    occ.sort((a, b) => Number(b.added) - Number(a.added));
    findings.push({
      name, project_name: project, resolution: res, issues, added: isAdded,
      blocking: isAdded && issues.some((i) => i !== 'not_in_erd'),
      domain, occurrences: occ.slice(0, 30), occurrence_count: occ.length,
    });
  }
  const rank = (f: Finding) => (f.blocking ? 0 : f.added ? 1 : 2) * 10 + (f.issues.includes('variant') ? 0 : f.issues.includes('unknown_word') ? 1 : f.issues.includes('unregistered_term') ? 2 : 3);
  findings.sort((a, b) => rank(a) - rank(b) || b.occurrence_count - a.occurrence_count || a.name.localeCompare(b.name));

  const mixed: MixedGroup[] = [...byTerm.values()].filter((g) => g.names.size > 1).map((g) => ({
    logical_name: g.term.logical_name, standard: g.term.standard,
    spellings: [...g.names.entries()].map(([n, count]) => ({ name: n, count, standard: n === g.term.standard })).sort((a, b) => b.count - a.count),
  }));

  const erdFindings = erd ? erdFindingsOf(ix, erd, ignored) : [];

  return {
    scope, generated_at: Date.now(), dbms: ix.dbms,
    erd_project: erd ? { id: erd.id, name: erd.name, dbms_type: erd.dbms_type } : null,
    scanned_files: scanned, findings, mixed, erd_findings: erdFindings,
    dictionary_duplicates: ix.duplicates, ignored: skippedIgnored,
    groups: groupFindings(findings), hot_files: hotFiles(findings),
    baseline: compareBaseline(s.workspace_id, findings, scope), excluded_files: excludedFiles,
    error: erdError,
  };
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
