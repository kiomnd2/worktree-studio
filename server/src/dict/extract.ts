import { normalizeIdent, resolve, typeMatches, type DictIndex, type Resolution, type Verdict } from './judge.js';
import { columnType, type ErdProject } from './types.js';
import type { BaselineView, FindingGroup, HotFile } from './triage.js';

/**
 * 소스 텍스트에서 컬럼 이름을 뽑는다(파일 읽기·git은 부르는 쪽이 한다).
 * 대상: MyBatis 매퍼 XML의 SQL과 resultMap column, .sql(DDL·DML), Liquibase XML의 <column name type>, JPA @Column/@JoinColumn.
 * SQL에서는 밑줄이 있는 이름과 별칭.컬럼만 컬럼으로 본다(예약어·함수·테이블·#{} 안·문자열·주석은 뺀다).
 */

export type OccurrenceKind = 'sql' | 'resultmap' | 'ddl' | 'liquibase' | 'jpa';
export type Occurrence = { file: string; line: number; kind: OccurrenceKind; table: string | null; type: string | null; text: string; added: boolean };
export type Issue = Exclude<Verdict, 'standard'> | 'domain_mismatch' | 'not_in_erd';
export type Finding = {
  name: string;
  project_name: string;
  resolution: Resolution;
  issues: Issue[];
  /** 이번 변경에서 추가된 줄에 나왔는지 */
  added: boolean;
  /** PR을 막는 위반인지(added이고 not_in_erd만 있는 게 아님) */
  blocking: boolean;
  domain: { expected: string; actual: string[] } | null;
  occurrences: Occurrence[];
  occurrence_count: number;
};
export type MixedGroup = { logical_name: string; standard: string; spellings: { name: string; count: number; standard: boolean }[] };
export type ErdFinding = { table: string; column: string; logical_name: string; type: string | null; resolution: Resolution; issues: (Issue | 'no_term_link')[] };
export type DictReport = {
  scope: 'changed' | 'all';
  generated_at: number;
  dbms: string;
  erd_project: { id: string; name: string; dbms_type: string } | null;
  scanned_files: number;
  findings: Finding[];
  mixed: MixedGroup[];
  erd_findings: ErdFinding[];
  dictionary_duplicates: { logical_name: string; standards: string[] }[];
  ignored: number;
  /** 원인별 묶음 */
  groups: FindingGroup[];
  hot_files: HotFile[];
  /** 기준선을 찍었으면 대조 결과 */
  baseline: BaselineView | null;
  /** 제외 경로에 걸려 건너뛴 파일 수 */
  excluded_files: number;
  error: string | null;
};

export const SQL_WORDS = new Set(`SELECT FROM WHERE AND OR NOT NULL IS IN AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS UNION ALL DISTINCT ORDER GROUP BY HAVING
INSERT INTO VALUES UPDATE SET DELETE MERGE USING MATCHED WHEN THEN ELSE END CASE EXISTS BETWEEN LIKE ESCAPE ASC DESC LIMIT OFFSET FETCH FIRST NEXT ROWS ROW ONLY
WITH RECURSIVE OVER PARTITION CREATE TABLE ALTER ADD DROP MODIFY COLUMN CONSTRAINT PRIMARY KEY FOREIGN REFERENCES UNIQUE INDEX CHECK DEFAULT COMMENT
SEQUENCE NEXTVAL CURRVAL DUAL SYSDATE SYSTIMESTAMP ROWNUM ROWID LEVEL CONNECT PRIOR START TRUE FALSE NOCACHE NOCYCLE INCREMENT MAXVALUE MINVALUE
VARCHAR VARCHAR2 NVARCHAR2 CHAR NCHAR NUMBER INTEGER INT BIGINT SMALLINT DECIMAL NUMERIC FLOAT DOUBLE DATE TIMESTAMP CLOB BLOB TEXT BOOLEAN BYTE
JDBCTYPE JAVATYPE TYPEHANDLER MODE IN_OUT CURRENT_DATE CURRENT_TIMESTAMP LOCALTIMESTAMP INTERVAL`.split(/\s+/));

export const lineAt = (text: string, index: number) => { let n = 1; for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++; return n; };

/** 같은 길이로 지워서(줄 번호가 그대로 남게) 주석·문자열·#{}·XML 태그를 없앤다. */
export function blank(s: string) { return s.replace(/[^\n]/g, ' '); }
export function stripSql(text: string, xml: boolean): string {
  let t = text;
  if (xml) {
    t = t.replace(/<!--[\s\S]*?-->/g, blank).replace(/<!\[CDATA\[|\]\]>/g, blank).replace(/<[^>]*>/g, blank)
      .replace(/&lt;|&gt;|&amp;|&quot;|&apos;/g, blank);
  }
  return t.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank).replace(/'(?:[^']|'')*'/g, blank)
    .replace(/[#$]\{[^}]*\}/g, blank);
}

/** SQL 본문의 테이블 이름과 별칭 */
export function sqlTables(sql: string): { tables: Set<string>; aliases: Map<string, string> } {
  const tables = new Set<string>();
  const aliases = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|TABLE|MERGE\s+INTO|USING)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi)) {
    const t = m[1].toUpperCase().split('.').pop()!;
    tables.add(t);
    if (m[2] && !SQL_WORDS.has(m[2].toUpperCase())) aliases.set(m[2].toUpperCase(), t);
  }
  // FROM A a, B b 처럼 쉼표로 이어진 테이블
  for (const m of sql.matchAll(/,\s*([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s+([A-Za-z_]\w*)\s*(?=,|\bWHERE\b|$)/gim)) {
    if (SQL_WORDS.has(m[2].toUpperCase())) continue;
    const t = m[1].toUpperCase().split('.').pop()!;
    if (/_/.test(t)) { tables.add(t); aliases.set(m[2].toUpperCase(), t); }
  }
  return { tables, aliases };
}

export type Raw = Omit<Occurrence, 'added' | 'text'> & { name: string };

/** SQL 텍스트(주석·문자열은 이미 지운 것)에서 컬럼 이름 후보 */
function sqlColumns(sql: string, offsetLine: number, file: string, skip: Set<string>): Raw[] {
  const out: Raw[] = [];
  const { tables, aliases } = sqlTables(sql);
  // "스키마"."시퀀스" 같은 따옴표 친 객체 이름("S"."ISEQ$$_1".nextval)은 컬럼이 아니다.
  sql = sql.replace(/"[^"\n]*"(?:\s*\.\s*"[^"\n]*")+/g, blank);
  for (const m of sql.matchAll(/(?<![\w$.])(?:([A-Za-z_]\w*)\.)?([A-Za-z_][\w$]*)\b(?!\s*\()(?!\s*\.)/g)) {
    const qual = m[1]?.toUpperCase();
    const name = m[2];
    const U = name.toUpperCase();
    if (SQL_WORDS.has(U) || tables.has(U) || skip.has(U) || /^\d/.test(name)) continue;
    if (!qual && !name.includes('_')) continue;
    if (qual && !aliases.has(qual) && !tables.has(qual)) continue; // 스키마.함수 등
    if (U.length < 2 || U.includes('$$')) continue;
    const before = sql.slice(Math.max(0, (m.index ?? 0) - 20), m.index).toUpperCase();
    if (/\bAS\s*$/.test(before)) continue; // SELECT ... AS 별칭
    // 제약조건·인덱스·시퀀스 등 컬럼이 아닌 객체 이름
    if (/\b(CONSTRAINT|INDEX|SEQUENCE|TRIGGER|VIEW|PROCEDURE|FUNCTION|PACKAGE|SYNONYM|SCHEMA)\s+$/.test(before)) continue;
    out.push({ name, file, line: offsetLine + lineAt(sql, m.index ?? 0) - 1, kind: 'sql', table: qual ? (aliases.get(qual) ?? qual) : (tables.size === 1 ? [...tables][0] : null), type: null });
  }
  return out;
}

/** CREATE TABLE ( ... ) 본문 구간 */
function createBodies(sql: string): { table: string; start: number; end: number }[] {
  const out: { table: string; start: number; end: number }[] = [];
  for (const m of sql.matchAll(/\bCREATE\s+TABLE\s+([\w$."]+)\s*\(/gi)) {
    let depth = 1; let i = (m.index ?? 0) + m[0].length; const start = i;
    while (i < sql.length && depth > 0) { if (sql[i] === '(') depth++; else if (sql[i] === ')') depth--; i++; }
    out.push({ table: m[1].replace(/"/g, '').toUpperCase().split('.').pop()!, start, end: i - 1 });
  }
  return out;
}

/** CREATE TABLE 정의와 ALTER TABLE ADD의 컬럼·타입 */
function ddlColumns(sql: string, file: string): Raw[] {
  const out: Raw[] = [];
  for (const { table, start, end } of createBodies(sql)) {
    const body = sql.slice(start, end);
    let d = 0; let from = 0;
    const defs: { text: string; at: number }[] = [];
    for (let j = 0; j <= body.length; j++) {
      const c = body[j];
      if (c === '(') d++; else if (c === ')') d--;
      if ((c === ',' && d === 0) || j === body.length) { defs.push({ text: body.slice(from, j), at: start + from }); from = j + 1; }
    }
    for (const def of defs) {
      const dm = def.text.match(/^\s*"?([A-Za-z_][\w$]*)"?\s+([A-Za-z][\w]*(?:\s*\([^)]*\))?)/);
      if (!dm || /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|KEY|INDEX)$/i.test(dm[1])) continue;
      const lead = def.text.length - def.text.trimStart().length;
      out.push({ name: dm[1], file, line: lineAt(sql, def.at + lead), kind: 'ddl', table, type: dm[2] });
    }
  }
  for (const m of sql.matchAll(/\bALTER\s+TABLE\s+([\w$."]+)\s+(?:ADD|MODIFY)\s*\(?\s*"?([A-Za-z_][\w$]*)"?\s+([A-Za-z][\w]*(?:\s*\([^)]*\))?)/gi)) {
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|COLUMN)$/i.test(m[2])) continue;
    out.push({ name: m[2], file, line: lineAt(sql, m.index ?? 0), kind: 'ddl', table: m[1].replace(/"/g, '').toUpperCase().split('.').pop()!, type: m[3] });
  }
  for (const m of sql.matchAll(/\bCOMMENT\s+ON\s+COLUMN\s+(?:[\w$"]+\.)?([\w$"]+)\.([\w$"]+)/gi)) {
    out.push({ name: m[2].replace(/"/g, ''), file, line: lineAt(sql, m.index ?? 0), kind: 'ddl', table: m[1].replace(/"/g, '').toUpperCase(), type: null });
  }
  return out;
}

export const SCAN_EXTS = ['.xml', '.sql', '.java', '.kt'];

/** 파일 하나의 내용에서 컬럼 이름이 나온 곳. ext는 '.xml'처럼 점을 붙인 소문자 */
export function scanText(text: string, ext: string, rel: string, tableNames: Set<string>): Raw[] {
  if (!SCAN_EXTS.includes(ext)) return [];
  const out: Raw[] = [];
  if (ext === '.java' || ext === '.kt') {
    for (const m of text.matchAll(/@(?:Column|JoinColumn)\s*\(([^)]*)\)/g)) {
      const name = m[1].match(/\bname\s*=\s*"([^"]+)"/)?.[1];
      if (!name) continue;
      const type = m[1].match(/\bcolumnDefinition\s*=\s*"([^"]+)"/)?.[1] ?? null;
      out.push({ name, file: rel, line: lineAt(text, m.index ?? 0), kind: 'jpa', table: null, type });
    }
    return out;
  }
  if (ext === '.sql') {
    const sql = stripSql(text, false);
    const ddl = ddlColumns(sql, rel);
    const ddlAt = new Set(ddl.map((d) => `${d.line}:${d.name.toUpperCase()}`));
    // CREATE TABLE 본문은 ddlColumns가 컬럼 정의로 봤으니 SQL로 다시 훑지 않는다(DEFAULT·CHECK 안의 이름이 컬럼으로 잡힌다).
    let rest = sql;
    for (const b of createBodies(sql)) rest = rest.slice(0, b.start) + blank(rest.slice(b.start, b.end)) + rest.slice(b.end);
    return [...ddl, ...sqlColumns(rest, 1, rel, tableNames).filter((c) => !ddlAt.has(`${c.line}:${c.name.toUpperCase()}`))];
  }
  if (/<mapper\s+namespace\s*=/.test(text)) {
    for (const m of text.matchAll(/<(?:result|id|idArg|arg)\b[^>]*?\bcolumn\s*=\s*"([\w$]+)"/g)) {
      out.push({ name: m[1], file: rel, line: lineAt(text, m.index ?? 0), kind: 'resultmap', table: null, type: null });
    }
    for (const m of text.matchAll(/<(select|insert|update|delete|sql)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const bodyAt = (m.index ?? 0) + m[0].indexOf('>') + 1;
      const body = stripSql(m[2], true);
      out.push(...sqlColumns(body, lineAt(text, bodyAt), rel, tableNames));
    }
    return out;
  }
  if (/databaseChangeLog/.test(text)) {
    for (const m of text.matchAll(/<column\b([^>]*)>/g)) {
      const attrs = m[1];
      const name = attrs.match(/\bname\s*=\s*"([^"]+)"/)?.[1];
      if (!name) continue;
      const before = text.slice(0, m.index);
      const table = [...before.matchAll(/\btableName\s*=\s*"([^"]+)"/g)].pop()?.[1]?.toUpperCase() ?? null;
      out.push({ name, file: rel, line: lineAt(text, m.index ?? 0), kind: 'liquibase', table, type: attrs.match(/\btype\s*=\s*"([^"]+)"/)?.[1] ?? null });
    }
    for (const m of text.matchAll(/<sql\b[^>]*>([\s\S]*?)<\/sql>/g)) {
      const sql = stripSql(m[1], true);
      const at = lineAt(text, (m.index ?? 0) + m[0].indexOf('>') + 1);
      out.push(...ddlColumns(sql, rel).map((c) => ({ ...c, line: c.line + at - 1 })));
    }
  }
  return out;
}


/** ERD 컬럼을 같은 규칙으로 판정하고, 용어에 연결하지 않은 컬럼도 표시한다. */
export function erdFindingsOf(ix: DictIndex, erd: ErdProject, ignored: Set<string>): ErdFinding[] {
  const out: ErdFinding[] = [];
  for (const t of erd.tables) for (const c of t.columns) {
    const res = resolve(ix, c.physical_name);
    const issues: ErdFinding['issues'] = [];
    if (res.verdict !== 'standard') issues.push(res.verdict);
    if (!c.term_dictionary_id) issues.push('no_term_link');
    const type = columnType(c);
    if (type && res.term?.domain_type && !typeMatches(type, res.term.domain_type)) issues.push('domain_mismatch');
    if (issues.length && !ignored.has(normalizeIdent(c.physical_name))) {
      out.push({ table: t.physical_name, column: c.physical_name, logical_name: c.logical_name, type, resolution: res, issues });
    }
  }
  return out;
}

const ISSUE_LABEL: Record<Issue | 'no_term_link', string> = {
  variant: '비표준 표기', unregistered_term: '미등록 용어', unknown_word: '미등록 단어',
  domain_mismatch: '도메인 불일치', not_in_erd: 'ERD에 없음', no_term_link: '용어 연결 없음',
};
export const issueLabel = (i: Issue | 'no_term_link') => ISSUE_LABEL[i];

/** Claude·PR 출력용 한 줄 요약 */
export function findingLine(f: Finding): string {
  const r = f.resolution;
  const hint = r.term && r.verdict === 'variant' ? ` → 표준 ${r.term.standard} (${r.term.logical_name})`
    : r.draft ? ` → 사전에 없는 용어 "${r.draft.logical_name}" (등록 초안 ${r.draft.physical_abbr_name})`
    : r.missing.length ? ` → 단어사전에 없는 토큰 ${r.missing.join(', ')}${r.similar.length ? `, 비슷한 용어 ${r.similar.map((t) => `${t.standard}(${t.logical_name})`).join(', ')}` : ''}`
    : '';
  const dom = f.domain ? ` · 도메인 ${f.domain.expected}인데 ${f.domain.actual.join(', ')}` : '';
  const o = f.occurrences[0];
  return `- ${f.name} [${f.issues.map(issueLabel).join(', ')}]${hint}${dom} · ${f.project_name}/${o.file}:${o.line}${f.occurrence_count > 1 ? ` 외 ${f.occurrence_count - 1}곳` : ''}`;
}

export type SchemaDiffKind = 'source_only_table' | 'erd_only_table' | 'source_only_column' | 'erd_only_column' | 'type_mismatch';
export type SchemaDiff = {
  kind: SchemaDiffKind; table: string; column: string | null;
  erd_type: string | null; source_type: string | null;
  /** 소스에서 처음 나온 곳 */
  file: string | null; line: number | null;
  /** source_only_table일 때 그 테이블의 컬럼(이름·타입) */
  columns?: { name: string; type: string | null }[];
};

/**
 * 소스 DDL·Liquibase에서 모은 테이블·컬럼·타입을 ERD와 맞댄다. 타입이 적힌 정의(CREATE TABLE·ALTER ADD/MODIFY·Liquibase column type)만 쓴다.
 * 이름은 대문자로, 스키마 접두어는 떼고 비교한다. 소스에 DDL이 하나도 없으면 비교하지 않는다(모든 테이블이 "ERD에만"으로 나오지 않게).
 */
export function diffSchema(raws: Raw[], erd: ErdProject): SchemaDiff[] {
  const src = new Map<string, { cols: Map<string, { type: string | null; file: string; line: number }>; file: string; line: number }>();
  for (const r of raws) {
    if (!r.table || !r.type || (r.kind !== 'ddl' && r.kind !== 'liquibase')) continue;
    const t = r.table.toUpperCase();
    const entry = src.get(t) ?? { cols: new Map(), file: r.file, line: r.line };
    // ALTER MODIFY가 뒤에 오면 그 타입이 최신이다.
    entry.cols.set(r.name.toUpperCase(), { type: r.type, file: r.file, line: r.line });
    src.set(t, entry);
  }
  if (!src.size) return [];
  const out: SchemaDiff[] = [];
  const erdTables = new Map(erd.tables.map((t) => [t.physical_name.toUpperCase(), t]));
  for (const [name, s] of src) {
    const et = erdTables.get(name);
    if (!et) {
      out.push({ kind: 'source_only_table', table: name, column: null, erd_type: null, source_type: null, file: s.file, line: s.line, columns: [...s.cols].map(([n, c]) => ({ name: n, type: c.type })) });
      continue;
    }
    const ecols = new Map(et.columns.map((c) => [c.physical_name.toUpperCase(), c]));
    for (const [cn, c] of s.cols) {
      const ec = ecols.get(cn);
      if (!ec) { out.push({ kind: 'source_only_column', table: name, column: cn, erd_type: null, source_type: c.type, file: c.file, line: c.line }); continue; }
      const et2 = columnType(ec);
      if (et2 && c.type && !typeMatches(c.type, et2) && !typeMatches(et2, c.type)) {
        out.push({ kind: 'type_mismatch', table: name, column: cn, erd_type: et2, source_type: c.type, file: c.file, line: c.line });
      }
    }
    for (const ec of et.columns) {
      if (!s.cols.has(ec.physical_name.toUpperCase())) out.push({ kind: 'erd_only_column', table: name, column: ec.physical_name, erd_type: columnType(ec), source_type: null, file: null, line: null });
    }
  }
  for (const [name] of erdTables) if (!src.has(name)) out.push({ kind: 'erd_only_table', table: name, column: null, erd_type: null, source_type: null, file: null, line: null });
  const order: SchemaDiffKind[] = ['source_only_table', 'type_mismatch', 'source_only_column', 'erd_only_column', 'erd_only_table'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.table.localeCompare(b.table));
}
