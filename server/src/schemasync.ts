import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { walk } from './mapperindex.js';
import { getSession, type SessionView } from './sessions.js';
import { addedLines, excludeMatcher } from './dictscan.js';
import { globToRegExp } from './dict/triage.js';
import { buildSchema, emptySchema, type ChangelogIO, type LbSchema } from './dict/liquibase.js';
import type { Raw } from './dict/extract.js';
import { compareRefs, jpaClasses, jpaRefs, mapperRefs, type JpaClass, type LocatedRef, type SchemaFinding, type SchemaFindingKind, type SourceRef } from './dict/srcrefs.js';

/**
 * 세션 워크트리의 Liquibase changelog를 순서대로 적용한 최종 스키마와, 매퍼·JPA가 그 스키마를 맞게 쓰는지.
 * 루트 changelog는 src/main/resources 아래 *changelog-master*. 없으면 그 앱의 .sql DDL을 경로 순서로 적용한다.
 * include의 classpath 절대경로(/liquibase-db/...)는 같은 저장소의 src/main/resources들에서 찾는다.
 * 저장소마다 changelog 파일 mtime으로 결과를 들고 있다.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS schema_ignores (
  workspace_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, key)
);
`);

export type AppSchema = {
  project_name: string;
  kind: 'liquibase' | 'ddl' | 'none';
  roots: string[];
  schema: LbSchema;
};

const isTest = (rel: string) => /(^|\/)src\/test\//.test(rel) || /(^|\/)(test|tests)\//.test(rel);

type Cached = { at: number; resDirs: string[]; roots: string[]; kind: AppSchema['kind']; mtimes: Map<string, number>; schema: LbSchema };
const cache = new Map<string, Cached>();
const RES_DIRS_MS = 60_000;

function resourceDirs(repo: string): string[] {
  const out: string[] = [];
  const go = (d: string, depth: number) => {
    if (depth > 10) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || ['node_modules', 'build', 'target', 'out', 'bin', 'dist', 'test'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (p.endsWith(`${path.sep}src${path.sep}main${path.sep}resources`)) out.push(p); else go(p, depth + 1);
    }
  };
  go(repo, 0);
  return out;
}

function changelogRoots(resDirs: string[]): string[] {
  const out: string[] = [];
  for (const r of resDirs) walk(r, (f) => { if (/changelog-master[^/]*\.(xml|sql)$/i.test(path.basename(f))) out.push(f); });
  return out.sort();
}

function ioFor(repo: string, resDirs: string[], mtimes: Map<string, number>): ChangelogIO {
  const exists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  return {
    read: (abs) => {
      try { const st = fs.statSync(abs); mtimes.set(abs, st.mtimeMs); return fs.readFileSync(abs, 'utf8'); } catch { mtimes.set(abs, -1); return null; }
    },
    resolve: (ref, from, relative) => {
      const r = ref.replace(/^classpath\*?:/, '');
      const local = path.resolve(path.dirname(from), r);
      if (relative) return exists(local) ? local : null;
      // 같은 앱의 resources 먼저, 다음은 저장소의 다른 resources, 마지막으로 changelog 기준 상대
      const own = resDirs.filter((d) => from.startsWith(d)).concat(resDirs.filter((d) => !from.startsWith(d)));
      for (const d of own) { const p = path.join(d, r.replace(/^\//, '')); if (exists(p)) return p; }
      if (exists(local)) return local;
      const fromRepo = path.join(repo, r.replace(/^\//, ''));
      return exists(fromRepo) ? fromRepo : null;
    },
    list: (ref, from, relative) => {
      const r = ref.replace(/^classpath\*?:/, '').replace(/^\//, '');
      const dirs = relative ? [path.resolve(path.dirname(from), r)] : resDirs.map((d) => path.join(d, r));
      const files: string[] = [];
      for (const d of dirs) { try { for (const f of fs.readdirSync(d).sort()) if (/\.(xml|sql)$/i.test(f)) files.push(path.join(d, f)); } catch { /* 없는 폴더 */ } }
      return files;
    },
    rel: (abs) => path.relative(repo, abs),
  };
}

function fresh(c: Cached): boolean {
  for (const [f, m] of c.mtimes) { let now = -1; try { now = fs.statSync(f).mtimeMs; } catch { /* 지워짐 */ } if (now !== m) return false; }
  return true;
}

/** 저장소 하나의 최종 스키마 */
export function repoSchema(repo: string, projectName: string, excluded: (projectName: string, rel: string) => boolean): AppSchema {
  let c = cache.get(repo);
  const resDirs = c && Date.now() - c.at < RES_DIRS_MS ? c.resDirs : resourceDirs(repo);
  const roots = changelogRoots(resDirs);
  if (c && fresh(c) && c.roots.join('\0') === roots.join('\0')) {
    return { project_name: projectName, kind: c.kind, roots: c.roots.map((r) => path.relative(repo, r)), schema: c.schema };
  }
  const mtimes = new Map<string, number>();
  const io = ioFor(repo, resDirs, mtimes);
  let kind: AppSchema['kind'] = 'liquibase';
  let schema: LbSchema;
  let used = roots;
  if (roots.length) schema = buildSchema(roots, io);
  else {
    // Liquibase가 없으면 .sql DDL을 경로 순서로(테스트·제외 경로는 빼고)
    const sql: string[] = [];
    walk(repo, (f) => { const rel = path.relative(repo, f); if (/\.sql$/i.test(f) && !isTest(rel) && !excluded(projectName, rel)) sql.push(f); });
    used = sql.sort();
    schema = used.length ? buildSchema(used, io) : emptySchema();
    kind = schema.tables.size ? 'ddl' : 'none';
    // 새 .sql이 생기는 것은 mtime으로 못 보니 이 경우는 짧게만 들고 있는다
    mtimes.set(path.join(repo, '.'), fs.statSync(repo).mtimeMs);
  }
  c = { at: Date.now(), resDirs, roots: used, kind, mtimes, schema };
  cache.set(repo, c);
  return { project_name: projectName, kind, roots: kind === 'liquibase' ? roots.map((r) => path.relative(repo, r)) : [], schema };
}

/** 여러 저장소의 스키마를 하나로(같은 DB로 본다. 앞 저장소가 이긴다) */
export function mergeSchemas(list: LbSchema[]): LbSchema {
  if (list.length === 1) return list[0];
  const s = emptySchema();
  for (const x of list) {
    for (const [k, v] of x.tables) if (!s.tables.has(k)) s.tables.set(k, v);
    for (const [k, v] of x.renamedColumns) if (!s.renamedColumns.has(k)) s.renamedColumns.set(k, v);
    for (const [k, v] of x.droppedColumns) if (!s.droppedColumns.has(k)) s.droppedColumns.set(k, v);
    for (const [k, v] of x.renamedTables) if (!s.renamedTables.has(k)) s.renamedTables.set(k, v);
    for (const [k, v] of x.droppedTables) if (!s.droppedTables.has(k)) s.droppedTables.set(k, v);
    s.unparsed.push(...x.unparsed); s.files.push(...x.files); s.changesets += x.changesets;
  }
  return s;
}

/**
 * 용어 검사·ERD 비교에 쓸 최종 스키마 컬럼. Liquibase 앱만(DDL만 있는 앱은 파일을 그대로 훑는다).
 * 위치는 컬럼을 만들었거나 마지막으로 바꾼 changeset 줄. changelog 파일 자체의 이름들은 빼야 하니 그 목록도 준다.
 */
export function finalSchemaRaws(app: AppSchema): { files: Set<string>; raws: Raw[] } | null {
  if (app.kind !== 'liquibase') return null;
  const raws: Raw[] = [];
  for (const t of app.schema.tables.values()) {
    if (t.view) continue;
    for (const c of t.columns.values()) raws.push({ name: c.name, file: c.changed.file, line: c.changed.line, kind: 'liquibase', table: t.name, type: c.type });
  }
  return { files: new Set(app.schema.files), raws };
}

export function sessionSchemas(s: SessionView): { apps: AppSchema[]; schema: LbSchema } {
  const excluded = excludeMatcher(s.workspace_id);
  const apps = s.repos.filter((r) => fs.existsSync(r.path)).map((r) => repoSchema(r.path, r.project_name, excluded));
  return { apps, schema: mergeSchemas(apps.map((a) => a.schema)) };
}

/** 세션 소스의 매퍼·JPA 참조. src/main이 있는 저장소는 그 아래만(문서·예제 폴더의 엔티티를 빼려고) */
export function sessionRefs(s: SessionView, added: Map<string, Map<string, Set<number> | 'all'>>): LocatedRef[] {
  const excluded = excludeMatcher(s.workspace_id);
  const out: LocatedRef[] = [];
  for (const w of s.repos.filter((r) => fs.existsSync(r.path))) {
    const files: string[] = [];
    walk(w.path, (f) => { if (/\.(xml|java)$/i.test(f)) files.push(f); });
    const hasMain = files.some((f) => path.relative(w.path, f).includes(`src${path.sep}main${path.sep}`));
    const lines = added.get(w.path);
    const refs: SourceRef[] = [];
    const classes: JpaClass[] = [];
    for (const abs of files) {
      const rel = path.relative(w.path, abs);
      if ((hasMain && !rel.includes(`src${path.sep}main${path.sep}`)) || isTest(rel) || excluded(w.project_name, rel)) continue;
      let text: string;
      try { if (fs.statSync(abs).size > 2_000_000) continue; text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (abs.endsWith('.xml')) refs.push(...mapperRefs(text, rel));
      else classes.push(...jpaClasses(text, rel));
    }
    refs.push(...jpaRefs(classes));
    for (const r of refs) {
      const l = lines?.get(r.file);
      out.push({ ...r, project_name: w.project_name, added: l === 'all' || Boolean(l?.has(r.line)) });
    }
  }
  return out;
}

export function schemaIgnoresOf(ws: number): { key: string; reason: string; created_at: string }[] {
  return db.prepare(`SELECT key, reason, created_at FROM schema_ignores WHERE workspace_id = ? ORDER BY key`).all(ws) as { key: string; reason: string; created_at: string }[];
}
export function setSchemaIgnore(ws: number, key: string, reason: string | null) {
  if (reason === null) db.prepare(`DELETE FROM schema_ignores WHERE workspace_id = ? AND key = ?`).run(ws, key);
  else db.prepare(`INSERT INTO schema_ignores (workspace_id, key, reason) VALUES (?, ?, ?) ON CONFLICT(workspace_id, key) DO UPDATE SET reason = excluded.reason`).run(ws, key, reason);
}

export type SchemaReport = {
  scope: 'changed' | 'all';
  generated_at: number;
  apps: { project_name: string; kind: AppSchema['kind']; roots: string[]; files: number; changesets: number; tables: number; columns: number; unparsed: number }[];
  unparsed: { project_name: string; file: string; line: number; text: string }[];
  findings: SchemaFinding[];
  counts: Partial<Record<SchemaFindingKind, number>>;
  refs: number;
  ignored: number;
};

export async function addedBySession(s: SessionView): Promise<Map<string, Map<string, Set<number> | 'all'>>> {
  const out = new Map<string, Map<string, Set<number> | 'all'>>();
  for (const w of s.repos.filter((r) => fs.existsSync(r.path))) {
    try { out.set(w.path, await addedLines(w)); } catch { out.set(w.path, new Map()); }
  }
  return out;
}

export type SchemaFilter = { tables?: string[]; exclude_paths?: string[] };

export async function schemaCheck(sessionId: number, scope: 'changed' | 'all', filter: SchemaFilter = {}): Promise<SchemaReport> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const { apps, schema } = sessionSchemas(s);
  const added = await addedBySession(s);
  let refs = sessionRefs(s, added);
  if (scope === 'changed') {
    refs = refs.filter((r) => {
      const repo = s.repos.find((w) => w.project_name === r.project_name);
      return repo ? added.get(repo.path)?.has(r.file) : false;
    });
  }
  const ignores = schemaIgnoresOf(s.workspace_id);
  const ignored = new Set(ignores.map((i) => i.key));
  // Liquibase·DDL이 하나도 없으면 비교할 기준이 없다
  const tableRes = (filter.tables ?? []).map((p) => p.trim()).filter(Boolean).map((p) => globToRegExp(p.toUpperCase()));
  const pathRes = (filter.exclude_paths ?? []).map((p) => p.trim()).filter(Boolean).map(globToRegExp);
  if (pathRes.length) refs = refs.filter((r) => !pathRes.some((re) => re.test(r.file) || re.test(`${r.project_name}/${r.file}`)));
  const findings = (schema.tables.size ? compareRefs(schema, refs, { withUnused: scope === 'all', ignored }) : [])
    .filter((f) => !tableRes.length || (f.table !== null && tableRes.some((re) => re.test(f.table!.toUpperCase()))));
  const counts: SchemaReport['counts'] = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return {
    scope, generated_at: Date.now(),
    apps: apps.map((a) => ({
      project_name: a.project_name, kind: a.kind, roots: a.roots, files: a.schema.files.length, changesets: a.schema.changesets,
      tables: a.schema.tables.size, columns: [...a.schema.tables.values()].reduce((n, t) => n + t.columns.size, 0), unparsed: a.schema.unparsed.length,
    })),
    unparsed: apps.flatMap((a) => a.schema.unparsed.slice(0, 100).map((u) => ({ project_name: a.project_name, ...u }))),
    findings, counts, refs: refs.length, ignored: ignores.length,
  };
}
