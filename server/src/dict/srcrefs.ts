import { blank, lineAt, SQL_WORDS, stripSql } from './extract.js';
import { typeMatches } from './judge.js';
import type { LbSchema, Loc } from './liquibase.js';

/**
 * 매퍼 SQL과 JPA 엔티티가 쓰는 테이블·컬럼을 뽑아 Liquibase 최종 스키마와 맞댄다(순수 함수).
 * 다른 스키마(스키마.테이블)·DB 링크(@)·WITH 이름·DUAL은 이 DB 스키마 밖으로 보고 뺀다.
 * 테이블을 모르는 컬럼(여러 테이블 문장의 별칭 없는 컬럼)은 문장의 테이블 중 하나에만 있으면 통과다.
 * 2차로 미룬 것: @Embedded·@AttributeOverride, @Query nativeQuery 문자열, Kotlin 엔티티.
 */

export type RefKind = 'mapper' | 'jpa';
export type SourceRef = {
  kind: RefKind; file: string; line: number; text: string;
  /** 테이블 참조면 column이 null */
  table: string | null; column: string | null;
  /** 테이블을 모르는 컬럼: 그 문장의 테이블들 */
  candidates?: string[];
  /** JPA columnDefinition */
  type?: string | null;
};
export type JpaClass = {
  name: string; file: string; line: number; role: 'entity' | 'mapped' | 'embeddable';
  table: string | null; parent: string | null;
  fields: { column: string; line: number; type: string | null; text: string }[];
};

const lineText = (lines: string[], n: number) => (lines[n - 1] ?? '').trim().slice(0, 200);

/** 여는 괄호가 아직 안 닫힌 가장 가까운 ( 앞의 단어 */
function enclosingCall(sql: string, at: number): string | null {
  let d = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = sql[i];
    if (c === ')') d++;
    else if (c === '(') { if (d === 0) return sql.slice(Math.max(0, i - 30), i).match(/(\w+)\s*$/)?.[1]?.toUpperCase() ?? ''; d--; }
  }
  return null;
}

/** Liquibase가 아니라 프레임워크가 만드는 테이블(Spring Batch·Quartz·Liquibase 자체·Spring Session) */
const FRAMEWORK = /^(BATCH_(JOB|STEP)_|QRTZ_|DATABASECHANGELOG|SPRING_SESSION|SHEDLOCK$|(ALL|USER|DBA)_(TAB_|COL_|CONS|IND|OBJECTS|TABLES|VIEWS|SEQUENCES|SOURCE|TRIGGERS|SYNONYMS|USERS|PROCEDURES|DEPENDENCIES)|V\$|GV\$)/;

/** 한 문장(주석·문자열·태그는 지운 것)의 테이블 참조와 별칭 */
function statementTables(sql: string) {
  const ctes = new Set<string>();
  for (const m of sql.matchAll(/(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)([A-Za-z_]\w*)\s*(?:\([^)]*\)\s*)?AS\s*\(/gi)) ctes.add(m[1].toUpperCase());
  const local: { table: string; index: number }[] = [];
  /** 별칭 → 테이블들(UNION 갈래마다 같은 별칭을 다른 테이블에 쓰기도 한다) */
  const aliases = new Map<string, Set<string>>();
  /** 스키마 밖 객체를 가리키는 별칭·이름 */
  const outside = new Set<string>();
  const take = (raw: string, alias: string | undefined, index: number) => {
    const name = raw.toUpperCase();
    const a = alias?.toUpperCase();
    const validAlias = a && !SQL_WORDS.has(a) && !/^(WHERE|SET|ON|USING|LEFT|RIGHT|INNER|OUTER|JOIN|GROUP|ORDER|CONNECT|START|UNION|MINUS|INTERSECT|FETCH|PIVOT|UNPIVOT|SAMPLE|PARTITION|VALUES|SELECT|WHEN|NATURAL|CROSS|FULL|LATERAL|OFFSET|LIMIT|RETURNING|LOG)$/.test(a);
    if (name.includes('.') || name.includes('@') || name === 'DUAL' || ctes.has(name) || name.startsWith('__') || FRAMEWORK.test(name)) {
      outside.add(name.split('.').pop()!.split('@')[0]);
      if (validAlias) outside.add(a!);
      return;
    }
    if (SQL_WORDS.has(name)) return;
    local.push({ table: name, index });
    if (validAlias) aliases.set(a!, (aliases.get(a!) ?? new Set()).add(name));
  };
  const re = /\b(FROM|JOIN|UPDATE|INTO|USING)\s+([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?(?:@[\w.]+)?)\b(?!\s*\.)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  for (const m of sql.matchAll(re)) {
    const kw = m[1].toUpperCase();
    const at = m.index ?? 0;
    // FROM TABLE(...)·JSON_TABLE(...) 같은 함수. INSERT INTO T (컬럼들)은 테이블이다.
    if (kw !== 'INTO' && !m[3] && /^\s*\(/.test(sql.slice(at + m[0].length))) continue;
    const before = sql.slice(Math.max(0, at - 30), at).toUpperCase();
    if (kw === 'FROM' && (/\bIS\s+(NOT\s+)?DISTINCT\s+$/.test(before) || ['EXTRACT', 'TRIM', 'SUBSTRING', 'OVERLAY', 'POSITION'].includes(enclosingCall(sql, at) ?? ''))) continue;
    if (kw === 'UPDATE' && /\b(FOR|THEN|KEY)\s+$/.test(before)) continue;
    take(m[2], m[3], at + m[0].indexOf(m[2], m[1].length));
  }
  // FROM A a, B b — 쉼표로 이어진 테이블(FROM 절 안에서만)
  for (const fm of sql.matchAll(/\bFROM\b(?!\s*\()([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bCONNECT\b|\bSTART\b|\bUNION\b|\bMINUS\b|\bFETCH\b|\bSELECT\b|\bJOIN\b|\bON\b|\bVALUES\b|\bINSERT\b|\bUPDATE\b|\bSET\b|[()]|$)/gi)) {
    const clause = fm[1];
    const base = (fm.index ?? 0) + 4;
    for (const m of clause.matchAll(/,\s*([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?(?:@[\w.]+)?)\b(?!\s*[(.])(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/g)) {
      take(m[1], m[2], base + (m.index ?? 0) + m[0].indexOf(m[1]));
    }
  }
  // ( 인라인 뷰 ) 별칭
  for (const m of sql.matchAll(/\)\s+(?:AS\s+)?([A-Za-z_]\w*)\b/gi)) {
    const a = m[1].toUpperCase();
    if (!SQL_WORDS.has(a) && !/^(WHERE|ON|USING|LEFT|RIGHT|INNER|OUTER|JOIN|GROUP|ORDER|UNION|MINUS|INTERSECT|FETCH|PIVOT|UNPIVOT|THEN|ELSE|END|WHEN|AND|OR|IS|NOT|IN|AS|OVER|WITHIN|KEEP|FILTER|CROSS|FULL|NATURAL|LATERAL|SELECT|FROM|SET|VALUES|CONNECT|START|OFFSET|LIMIT|ROWS|RETURNING|BETWEEN|LIKE|DESC|ASC|NULLS)$/.test(a) && !aliases.has(a)) outside.add(a);
  }
  return { local, aliases, outside, ctes };
}

/** SELECT 목록에서 만든 별칭(AS X, 식 뒤의 X) — 별칭 없는 컬럼 판정에서 뺀다 */
function selectAliases(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/\bAS\s+"?([A-Za-z_]\w*)"?/gi)) out.add(m[1].toUpperCase());
  for (const m of sql.matchAll(/(?:\)|[\w$#]\.[\w$#]+|\b[A-Za-z_][\w$#]*)\s+([A-Za-z_]\w*)\s*(?=,|\bFROM\b|\bINTO\b|\)|$)/gi)) {
    const a = m[1].toUpperCase();
    if (!SQL_WORDS.has(a)) out.add(a);
  }
  return out;
}

const COL_RE = /(?<![\w$#.])(?:([A-Za-z_][\w$#]*)\.)?([A-Za-z_][\w$#]*)\b(?!\s*[(.])/g;
const NOT_COL = /^(CONNECT_BY_ISLEAF|CONNECT_BY_ISCYCLE|CONNECT_BY_ROOT|NULLS|LAST|KEEP|DENSE_RANK|WITHIN|SIBLINGS|NOWAIT|SKIP|LOCKED|RETURNING|TO_CHAR|TO_DATE|NVL|SYS_GUID|SYS_CONTEXT|USERENV|SQLERRM|SQLCODE|ROW_NUMBER|LISTAGG|PIVOT|UNPIVOT|MINUS|INTERSECT|NATURAL|LATERAL|IGNORE|RESPECT|PRECEDING|FOLLOWING|UNBOUNDED|CURRENT|RANGE|SEARCH|BREADTH|DEPTH|CYCLE|MATERIALIZED|INLINE|PARALLEL|APPEND|USE_NL|INDEX_DESC|INDEX_ASC|LEADING|ORDERED|FIRST_ROWS|ALL_ROWS)$/;

/** MyBatis 매퍼 XML에서 문장별 테이블·컬럼 참조 */
export function mapperRefs(text: string, file: string): SourceRef[] {
  if (!/<mapper\s+namespace\s*=/.test(text)) return [];
  const lines = text.split('\n');
  const out: SourceRef[] = [];
  for (const m of text.matchAll(/<(select|insert|update|delete)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const bodyAt = (m.index ?? 0) + m[0].indexOf('>') + 1;
    const first = lineAt(text, bodyAt);
    // ${테이블} 같은 동적 이름은 같은 길이의 __이름__으로 바꿔 스키마 밖으로 본다
    // <include refid>도 같은 식으로(FROM <include .../> s 에서 s가 테이블로 잡히지 않게)
    const dyn = (d: string) => (d.length >= 6 ? ` __${'X'.repeat(d.length - 6)}__ ` : blank(d));
    let sql = stripSql(m[2].replace(/\$\{[^}\n]*\}/g, dyn).replace(/<include\b[^>]*?\/>/g, (d) => (d.includes('\n') ? blank(d) : dyn(d))), true);
    sql = sql.replace(/"[^"\n]*"(?:\s*\.\s*"[^"\n]*")+/g, blank);
    const { local, aliases, outside } = statementTables(sql);
    const at = (i: number) => first + lineAt(sql, i) - 1;
    const localNames = new Set(local.map((l) => l.table));
    for (const l of local) { const line = at(l.index); out.push({ kind: 'mapper', file, line, text: lineText(lines, line), table: l.table, column: null }); }
    if (!local.length) continue;
    // JSON_TABLE·XMLTABLE·TABLE()은 문장 안에서 컬럼을 만든다
    if (/\b(JSON_TABLE|XMLTABLE|TABLE)\s*\(/i.test(sql)) outside.add('*');
    const selAlias = selectAliases(sql);
    // INSERT INTO T (A, B) 의 컬럼 목록
    const insertCols = new Set<number>();
    for (const im of sql.matchAll(/\bINTO\s+([A-Za-z_][\w$#]*)\s*\(([^()]*)\)/gi)) {
      const t = im[1].toUpperCase();
      if (!localNames.has(t)) continue;
      const listAt = (im.index ?? 0) + im[0].indexOf('(') + 1;
      for (const cm of im[2].matchAll(/[A-Za-z_][\w$#]*/g)) {
        const i = listAt + (cm.index ?? 0);
        insertCols.add(i);
        const line = at(i);
        out.push({ kind: 'mapper', file, line, text: lineText(lines, line), table: t, column: cm[0].toUpperCase() });
      }
    }
    for (const cm of sql.matchAll(COL_RE)) {
      const i = (cm.index ?? 0) + (cm[1] ? cm[1].length + 1 : 0);
      if (insertCols.has(i)) continue;
      const qual = cm[1]?.toUpperCase();
      const name = cm[2].toUpperCase();
      if (SQL_WORDS.has(name) || NOT_COL.test(name) || name.startsWith('__') || name.length < 2 || name.includes('$$') || /^\d/.test(name)) continue;
      if (localNames.has(name) || aliases.has(name) || outside.has(name)) continue;
      const before = sql.slice(Math.max(0, i - 25), i).toUpperCase();
      if (/\bAS\s*"?$/.test(before) || /\b(CONSTRAINT|INDEX|SEQUENCE|TRIGGER|VIEW|PROCEDURE|FUNCTION|PACKAGE|SYNONYM|SCHEMA|INTO|FROM|JOIN|UPDATE|USING|TABLE)\s+$/.test(before)) continue;
      const line = at(i);
      if (qual) {
        if (outside.has(qual)) continue;
        const tables = aliases.get(qual) ?? (localNames.has(qual) ? new Set([qual]) : null);
        if (!tables) continue; // 인라인 뷰 별칭·패키지.함수 등
        const ts = [...tables];
        out.push({ kind: 'mapper', file, line, text: lineText(lines, line), table: ts.length === 1 ? ts[0] : null, column: name, candidates: ts.length === 1 ? undefined : ts });
      } else {
        if (!name.includes('_') || selAlias.has(name) || outside.size) continue;
        const cands = [...localNames];
        out.push({ kind: 'mapper', file, line, text: lineText(lines, line), table: cands.length === 1 ? cands[0] : null, column: name, candidates: cands.length === 1 ? undefined : cands });
      }
    }
  }
  return out;
}

/** Spring 기본 이름 규칙(CamelCaseToUnderscoresNamingStrategy) */
export function springName(s: string): string {
  let b = s.replace(/\./g, '_');
  for (let i = 1; i < b.length - 1; i++) {
    if (/[a-z]/.test(b[i - 1]) && /[A-Z]/.test(b[i]) && /[a-z]/.test(b[i + 1])) { b = `${b.slice(0, i)}_${b.slice(i)}`; i++; }
  }
  return b.toUpperCase();
}

const ann = (head: string, name: string) => head.match(new RegExp(`@${name}\\b(?:\\s*\\(([^]*?)\\))?(?=\\s*(@|$|\\w))`));
const attr = (args: string | undefined, key: string) => args?.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`))?.[1] ?? null;
const unquote = (s: string) => s.replace(/[`"\\]/g, '').trim().toUpperCase();

/** 클래스 본문을 최상위 멤버 단위(주석·문자열 지운 것)로 나눈다 */
function members(body: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  let d = 0; let p = 0; let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') p++; else if (c === ')') p--;
    else if (c === '{' && p === 0) { if (d === 0) { out.push({ text: body.slice(from, i), index: from }); } d++; }
    else if (c === '}' && p === 0) { d--; if (d === 0) from = i + 1; }
    else if (c === ';' && d === 0 && p === 0) { out.push({ text: body.slice(from, i), index: from }); from = i + 1; }
  }
  return out;
}

/** 어노테이션들과 나머지 선언으로 */
function splitAnnotations(text: string): { head: string; decl: string } {
  let i = 0; const t = text;
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t[i] !== '@') break;
    i++;
    while (i < t.length && /[\w.]/.test(t[i])) i++;
    let j = i; while (j < t.length && /\s/.test(t[j])) j++;
    if (t[j] === '(') {
      let d = 0;
      for (; j < t.length; j++) { if (t[j] === '(') d++; else if (t[j] === ')') { d--; if (d === 0) { j++; break; } } }
      i = j;
    }
  }
  return { head: t.slice(0, i), decl: t.slice(i).trim() };
}

/** Java 파일 하나에서 @Entity·@MappedSuperclass·@Embeddable 클래스 */
export function jpaClasses(text: string, file: string): JpaClass[] {
  if (!/@(Entity|MappedSuperclass|Embeddable)\b/.test(text)) return [];
  // 주석·문자열 안의 괄호·중괄호가 멤버 나누기를 흐리지 않게(문자열은 어노테이션 값이라 따옴표는 남기고 안만 지킨다)
  const code = text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => s.replace(/[(){};]/g, ' '));
  const lines = text.split('\n');
  const out: JpaClass[] = [];
  for (const m of code.matchAll(/((?:@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)+)(?:(?:public|protected|private|abstract|final|static)\s+)*class\s+(\w+)(?:\s*<[^>{]*>)?(?:\s+extends\s+([\w.]+))?[^{]*\{/g)) {
    // 어노테이션 값(columnDefinition의 괄호 등)은 원문에서 읽는다. code와 text는 위치가 같다.
    const head = text.slice(m.index ?? 0, (m.index ?? 0) + m[1].length);
    const role = /@Entity\b/.test(head) ? 'entity' : /@MappedSuperclass\b/.test(head) ? 'mapped' : /@Embeddable\b/.test(head) ? 'embeddable' : null;
    if (!role) continue;
    const start = (m.index ?? 0) + m[0].length;
    let d = 1; let end = start;
    for (let i = start; i < code.length && d > 0; i++) { if (code[i] === '{') d++; else if (code[i] === '}') d--; end = i; }
    const body = code.slice(start, end);
    const entityName = attr(ann(head, 'Entity')?.[1], 'name');
    const tableName = attr(ann(head, 'Table')?.[1], 'name');
    const cls: JpaClass = {
      name: m[2], file, line: lineAt(code, (m.index ?? 0) + m[0].indexOf('class ')), role,
      table: role === 'entity' ? (tableName ? unquote(tableName) : springName(entityName ?? m[2])) : null,
      parent: m[3]?.split('.').pop() ?? null, fields: [],
    };
    for (const mem of members(body)) {
      const { head: h, decl: full } = splitAnnotations(mem.text);
      const fh = text.slice(start + mem.index, start + mem.index + h.length);
      const decl = full.replace(/\s*=[\s\S]*$/, '');
      if (!decl || decl.includes('(') || /\b(static|transient|class|interface|enum|record)\b/.test(decl)) continue;
      if (/@(Transient|Formula|OneToMany|ManyToMany|Embedded|EmbeddedId|ElementCollection|AttributeOverrides?|AssociationOverrides?)\b/.test(fh)) continue;
      const one = /@(ManyToOne|OneToOne)\b/.test(fh);
      if (one && /\bmappedBy\s*=/.test(fh)) continue;
      const dm = decl.match(/([\w$<>?,.\s[\]]+?)\s+(\w+)\s*$/);
      if (!dm) continue;
      const jtype = dm[1].trim(); const fname = dm[2];
      if (!one && /^(java\.util\.)?(List|Set|Map|Collection|SortedSet|Iterable)\b/.test(jtype.replace(/^(final\s+|private\s+|protected\s+|public\s+)+/, ''))) continue;
      const colArgs = ann(fh, one ? 'JoinColumn' : 'Column')?.[1] ?? (one ? undefined : ann(fh, 'JoinColumn')?.[1]);
      const named = attr(colArgs, 'name');
      const column = named ? unquote(named) : one ? `${springName(fname)}_ID` : springName(fname);
      // 줄은 컬럼 이름이 적힌 어노테이션, 없으면 필드 선언
      const local = named ? mem.text.indexOf(named) : mem.text.lastIndexOf(fname);
      const line = lineAt(code, start + mem.index + Math.max(0, local));
      cls.fields.push({ column, line, type: attr(colArgs, 'columnDefinition'), text: lineText(lines, line) });
    }
    out.push(cls);
  }
  return out;
}

/** 엔티티마다 부모 @MappedSuperclass 필드를 합쳐 컬럼 참조로 */
export function jpaRefs(classes: JpaClass[]): SourceRef[] {
  const byName = new Map<string, JpaClass>();
  for (const c of classes) if (c.role !== 'entity') byName.set(c.name, c);
  const out: SourceRef[] = [];
  for (const c of classes) {
    if (c.role !== 'entity' || !c.table) continue;
    out.push({ kind: 'jpa', file: c.file, line: c.line, text: `@Table ${c.table}`, table: c.table, column: null });
    const seen = new Set<string>();
    for (let k: JpaClass | undefined = c, depth = 0; k && depth < 6; k = k.parent ? byName.get(k.parent) : undefined, depth++) {
      for (const f of k.fields) {
        if (seen.has(f.column)) continue;
        seen.add(f.column);
        out.push({ kind: 'jpa', file: k.file, line: f.line, text: f.text, table: c.table, column: f.column, type: f.type });
      }
    }
  }
  return out;
}

export type SchemaFindingKind = 'missing_table' | 'missing_column' | 'renamed_table' | 'renamed_column' | 'dropped_table' | 'dropped_column' | 'type_mismatch' | 'unused_table' | 'unused_column';
export type SchemaOccurrence = { project_name: string; file: string; line: number; kind: RefKind; text: string; added: boolean };
export type SchemaFinding = {
  key: string; kind: SchemaFindingKind; table: string | null; column: string | null;
  /** 옛 이름이면 지금 이름 */
  suggestion: string | null;
  /** rename·drop·만든 changeset 위치 */
  change: Loc | null;
  detail: string | null;
  occurrences: SchemaOccurrence[]; occurrence_count: number;
  added: boolean; blocking: boolean;
};
export const BLOCKING_KINDS: SchemaFindingKind[] = ['missing_table', 'missing_column', 'renamed_table', 'renamed_column', 'dropped_table', 'dropped_column'];

/** 무시 목록 키: TABLE 또는 TABLE.COLUMN */
export const schemaKey = (table: string | null, column: string | null) => (column ? `${table ?? '*'}.${column}` : table ?? '*');

export type LocatedRef = SourceRef & { project_name: string; added: boolean };

/**
 * 참조를 최종 스키마와 맞댄다. withUnused면 소스 어디서도 안 쓰는 테이블·컬럼도 낸다(전체 검사일 때만 의미가 있다).
 * 뷰는 컬럼을 모르니 테이블이 있는지만 본다.
 */
export function compareRefs(schema: LbSchema, refs: LocatedRef[], opts: { withUnused: boolean; ignored: Set<string> }): SchemaFinding[] {
  const found = new Map<string, SchemaFinding>();
  const add = (kind: SchemaFindingKind, table: string | null, column: string | null, r: LocatedRef | null, extra: Partial<SchemaFinding> = {}) => {
    const key = `${kind}:${schemaKey(table, column)}`;
    if (opts.ignored.has(schemaKey(table, column)) || (column && table && opts.ignored.has(table))) return;
    const f = found.get(key) ?? { key, kind, table, column, suggestion: null, change: null, detail: null, occurrences: [], occurrence_count: 0, added: false, blocking: false, ...extra };
    if (r) {
      f.occurrence_count++;
      if (f.occurrences.length < 20 || r.added) f.occurrences.push({ project_name: r.project_name, file: r.file, line: r.line, kind: r.kind, text: r.text, added: r.added });
      f.added ||= r.added;
    }
    found.set(key, f);
  };
  const renamedTable = (t: string) => schema.renamedTables.get(t);
  const usedTables = new Set<string>();
  const usedCols = new Set<string>();

  for (const r of refs) {
    if (r.column === null) {
      const t = r.table!;
      if (schema.tables.has(t)) { usedTables.add(t); continue; }
      const rn = renamedTable(t);
      if (rn) add('renamed_table', t, null, r, { suggestion: rn.to, change: rn.at });
      else if (schema.droppedTables.has(t)) add('dropped_table', t, null, r, { change: schema.droppedTables.get(t)! });
      else add('missing_table', t, null, r);
      continue;
    }
    const col = r.column;
    if (r.table) {
      // 테이블이 옛 이름이면 테이블 쪽에서 이미 알렸다. 지금 이름 기준으로 컬럼을 본다.
      const t = schema.tables.get(r.table) ?? (renamedTable(r.table) ? schema.tables.get(renamedTable(r.table)!.to) : undefined);
      if (!t || t.view) continue;
      usedCols.add(`${t.name}.${col}`);
      const c = t.columns.get(col);
      if (c) {
        if (r.type && c.type && !typeMatches(r.type, c.type) && !typeMatches(c.type, r.type)) {
          add('type_mismatch', t.name, col, r, { detail: `${r.type} ≠ ${c.type}`, change: c.changed });
        }
        continue;
      }
      const rn = schema.renamedColumns.get(`${t.name}.${col}`);
      if (rn) add('renamed_column', t.name, col, r, { suggestion: rn.to, change: rn.at });
      else if (schema.droppedColumns.has(`${t.name}.${col}`)) add('dropped_column', t.name, col, r, { change: schema.droppedColumns.get(`${t.name}.${col}`)! });
      else add('missing_column', t.name, col, r);
      continue;
    }
    // 테이블을 모르는 컬럼: 후보 테이블을 다 알아야 판정한다
    const cands = (r.candidates ?? []).map((n) => schema.tables.get(n) ?? (renamedTable(n) ? schema.tables.get(renamedTable(n)!.to) : undefined));
    if (!cands.length || cands.some((t) => !t || t.view)) continue;
    const hit = cands.filter((t) => t!.columns.has(col));
    for (const t of hit) usedCols.add(`${t!.name}.${col}`);
    if (hit.length) continue;
    const rn = cands.map((t) => schema.renamedColumns.get(`${t!.name}.${col}`)).find(Boolean);
    const names = cands.map((t) => t!.name);
    if (rn) add('renamed_column', rn.table, col, r, { suggestion: rn.to, change: rn.at });
    else {
      const dt = names.find((n) => schema.droppedColumns.has(`${n}.${col}`));
      if (dt) add('dropped_column', dt, col, r, { change: schema.droppedColumns.get(`${dt}.${col}`)! });
      else add('missing_column', null, col, r, { detail: `문장의 테이블 ${names.join(', ')} 어디에도 없음` });
    }
  }

  if (opts.withUnused) {
    for (const t of schema.tables.values()) {
      if (t.view) continue;
      if (!usedTables.has(t.name) && ![...t.columns.keys()].some((c) => usedCols.has(`${t.name}.${c}`))) {
        add('unused_table', t.name, null, null, { change: t.created, detail: `컬럼 ${t.columns.size}개` });
        continue;
      }
      for (const c of t.columns.values()) if (!usedCols.has(`${t.name}.${c.name}`)) add('unused_column', t.name, c.name, null, { change: c.created });
    }
  }

  const out = [...found.values()];
  for (const f of out) f.blocking = f.added && BLOCKING_KINDS.includes(f.kind);
  const order: SchemaFindingKind[] = ['renamed_column', 'renamed_table', 'dropped_column', 'dropped_table', 'missing_column', 'missing_table', 'type_mismatch', 'unused_table', 'unused_column'];
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || order.indexOf(a.kind) - order.indexOf(b.kind) || b.occurrence_count - a.occurrence_count || a.key.localeCompare(b.key));
}
