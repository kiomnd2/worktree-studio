/**
 * Liquibase changelog를 순서대로 적용해 최종 스키마를 만든다(파일 읽기는 부르는 쪽이 넘긴다).
 * 이미 적용된 changeset은 체크섬 때문에 고칠 수 없으므로, 소스·ERD·사전과 맞댈 기준은 "모든 changeset의 합"이 아니라
 * 마지막 상태다. rename·drop된 옛 이름은 따로 기록해 소스가 아직 옛 이름을 쓰는지 알려 줄 때 쓴다.
 *
 * 읽는 변경: createTable, addColumn, dropColumn, renameColumn, modifyDataType, dropTable, renameTable, createView,
 * setColumnRemarks, add/dropNotNullConstraint, sql·sqlFile(CREATE TABLE, ALTER TABLE ADD/MODIFY/DROP/RENAME, DROP TABLE, COMMENT ON, CREATE VIEW).
 * 인덱스·제약조건·시퀀스·데이터·프로시저는 스키마 모양과 상관없어 건너뛴다. 그 밖에 모르는 것은 unparsed로 남긴다.
 */

export type XmlNode = { tag: string; attrs: Record<string, string>; children: XmlNode[]; text: string; line: number };

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]);

/** 작은 XML 파서. 네임스페이스 접두어는 뗀다. 망가진 문서는 읽을 수 있는 데까지 읽는다. */
export function parseXml(text: string): XmlNode | null {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '', line: 1 };
  const stack: XmlNode[] = [root];
  let line = 1;
  let i = 0;
  const advance = (to: number) => { for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) line++; i = to; };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) { stack[stack.length - 1].text += decode(text.slice(i, lt)); advance(lt); }
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i); advance(e < 0 ? text.length : e + 3); continue; }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i);
      stack[stack.length - 1].text += text.slice(i + 9, e < 0 ? text.length : e);
      advance(e < 0 ? text.length : e + 3); continue;
    }
    if (text.startsWith('<?', i) || text.startsWith('<!', i)) { const e = text.indexOf('>', i); advance(e < 0 ? text.length : e + 1); continue; }
    // 속성 값 안의 >를 건너뛰며 태그 끝을 찾는다
    let j = i + 1; let q: string | null = null;
    for (; j < text.length; j++) { const c = text[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    const raw = text.slice(i + 1, j);
    const at = line;
    advance(Math.min(j + 1, text.length));
    if (raw.startsWith('/')) {
      const tag = raw.slice(1).trim().split(':').pop()!;
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; break; }
      continue;
    }
    const self = raw.endsWith('/');
    const body = self ? raw.slice(0, -1) : raw;
    const m = body.match(/^([\w:.-]+)/);
    if (!m) continue;
    const attrs: Record<string, string> = {};
    for (const a of body.slice(m[1].length).matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1].split(':').pop()!] = decode(a[3] ?? a[4] ?? '');
    const node: XmlNode = { tag: m[1].split(':').pop()!, attrs, children: [], text: '', line: at };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return root.children[0] ?? null;
}

export type Loc = { file: string; line: number; changeset: string };
export type LbColumn = { name: string; type: string | null; remarks: string | null; nullable: boolean | null; pk: boolean; created: Loc; changed: Loc };
export type LbTable = { name: string; remarks: string | null; view: boolean; columns: Map<string, LbColumn>; created: Loc };
export type LbSchema = {
  tables: Map<string, LbTable>;
  /** "TABLE.OLD" → 지금 이름(여러 번 바뀌었으면 마지막) */
  renamedColumns: Map<string, { table: string; to: string; at: Loc }>;
  droppedColumns: Map<string, Loc>;
  /** 옛 테이블 이름 → 지금 이름 */
  renamedTables: Map<string, { to: string; at: Loc }>;
  droppedTables: Map<string, Loc>;
  unparsed: { file: string; line: number; text: string }[];
  files: string[];
  changesets: number;
};

export const emptySchema = (): LbSchema => ({
  tables: new Map(), renamedColumns: new Map(), droppedColumns: new Map(), renamedTables: new Map(), droppedTables: new Map(),
  unparsed: [], files: [], changesets: 0,
});

const U = (s: string | undefined | null) => (s ?? '').replace(/["`\[\]]/g, '').trim().toUpperCase().split('.').pop()!;
const bool = (s: string | undefined) => (s === undefined ? null : s.toLowerCase() === 'true');

/** 스키마 모델을 바꾸는 작은 명령들. XML·SQL 둘 다 이것으로 옮겨 적용한다. */
export class Model {
  constructor(readonly s: LbSchema) {}
  table(name: string) { return this.s.tables.get(U(name)) ?? null; }
  createTable(name: string, remarks: string | null, at: Loc, view = false) {
    const n = U(name);
    this.s.tables.set(n, { name: n, remarks, view, columns: new Map(), created: at });
    this.s.droppedTables.delete(n);
  }
  addColumn(table: string, c: { name: string; type: string | null; remarks?: string | null; nullable?: boolean | null; pk?: boolean }, at: Loc) {
    const t = this.table(table);
    if (!t) return false;
    const n = U(c.name);
    t.columns.set(n, { name: n, type: c.type?.trim() || null, remarks: c.remarks ?? null, nullable: c.nullable ?? null, pk: Boolean(c.pk), created: at, changed: at });
    this.s.droppedColumns.delete(`${t.name}.${n}`);
    this.s.renamedColumns.delete(`${t.name}.${n}`);
    return true;
  }
  dropColumn(table: string, col: string, at: Loc) {
    const t = this.table(table);
    if (!t) return false;
    const n = U(col);
    t.columns.delete(n);
    this.s.droppedColumns.set(`${t.name}.${n}`, at);
    return true;
  }
  renameColumn(table: string, from: string, to: string, at: Loc, type?: string | null) {
    const t = this.table(table);
    if (!t) return false;
    const f = U(from); const n = U(to);
    const c = t.columns.get(f);
    if (!c) return false;
    t.columns.delete(f);
    t.columns.set(n, { ...c, name: n, type: type?.trim() || c.type, changed: at });
    // 앞서 이 이름으로 바뀌었던 옛 이름들도 새 이름을 가리키게
    for (const r of this.s.renamedColumns.values()) if (r.table === t.name && r.to === f) { r.to = n; r.at = at; }
    this.s.renamedColumns.set(`${t.name}.${f}`, { table: t.name, to: n, at });
    this.s.renamedColumns.delete(`${t.name}.${n}`);
    this.s.droppedColumns.delete(`${t.name}.${n}`);
    return true;
  }
  modifyColumn(table: string, col: string, patch: { type?: string | null; nullable?: boolean | null; remarks?: string | null }, at: Loc) {
    const c = this.table(table)?.columns.get(U(col));
    if (!c) return false;
    if (patch.type) c.type = patch.type.trim();
    if (patch.nullable !== undefined && patch.nullable !== null) c.nullable = patch.nullable;
    if (patch.remarks !== undefined) c.remarks = patch.remarks;
    c.changed = at;
    return true;
  }
  dropTable(name: string, at: Loc) {
    const n = U(name);
    if (!this.s.tables.delete(n)) return false;
    this.s.droppedTables.set(n, at);
    return true;
  }
  renameTable(from: string, to: string, at: Loc) {
    const f = U(from); const n = U(to);
    const t = this.s.tables.get(f);
    if (!t) return false;
    this.s.tables.delete(f);
    t.name = n;
    this.s.tables.set(n, t);
    for (const r of this.s.renamedTables.values()) if (r.to === f) { r.to = n; r.at = at; }
    this.s.renamedTables.set(f, { to: n, at });
    this.s.renamedTables.delete(n);
    // 옛 테이블 이름으로 기록된 컬럼 이력도 새 이름으로
    for (const map of [this.s.renamedColumns, this.s.droppedColumns] as Map<string, unknown>[]) {
      for (const [k, v] of [...map]) if (k.startsWith(`${f}.`)) { map.delete(k); map.set(`${n}.${k.slice(f.length + 1)}`, v); }
    }
    for (const r of this.s.renamedColumns.values()) if (r.table === f) r.table = n;
    return true;
  }
}

const PLSQL = /^(CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE)\b|BEGIN\b|DECLARE\b)/i;

/**
 * SQL 문자열을 문장으로 나눈다(작은따옴표 안의 ;는 그대로, / 한 줄도 끝으로 본다). 줄 번호는 offset부터.
 * PL/SQL 블록(CREATE PACKAGE·BEGIN 등)은 / 줄까지 한 문장이다. delimiter가 '/'면 ;로는 나누지 않는다.
 */
export function splitSql(sql: string, offset: number, delimiter: ';' | '/' = ';'): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let cur = ''; let line = offset; let start = offset; let q = false;
  const push = () => { if (cur.trim()) out.push({ text: cur.trim(), line: start }); cur = ''; };
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (!q && c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = (e < 0 ? sql.length : e) - 1; continue; }
    if (!q && c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2); const end = e < 0 ? sql.length : e + 2;
      for (let k = i; k < end; k++) if (sql[k] === '\n') line++;
      i = end - 1; continue;
    }
    if (c === "'") q = !q;
    if (!q && c === ';' && delimiter === ';' && !PLSQL.test(cur.trim())) { push(); continue; }
    if (c === '\n') {
      line++;
      const e = sql.indexOf('\n', i + 1);
      if (!q && /^\s*\/\s*$/.test(sql.slice(i + 1, e < 0 ? sql.length : e))) { push(); i = (e < 0 ? sql.length : e) - 1; continue; }
    }
    if (!cur.trim() && !/\s/.test(c)) start = line;
    cur += c;
  }
  push();
  return out;
}

const TYPE = String.raw`[A-Za-z][\w]*(?:\s+(?:PRECISION|VARYING))?(?:\s*\([^)]*\))?`;
const IDENT = String.raw`"?[A-Za-z_][\w$#]*"?`;
const QIDENT = String.raw`(?:${IDENT}\.)?${IDENT}`;

/** 괄호 안을 최상위 쉼표로 나눈다 */
function splitTop(body: string): string[] {
  const out: string[] = []; let d = 0; let from = 0; let q = false;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === "'") q = !q;
    if (q) continue;
    if (c === '(') d++; else if (c === ')') d--;
    if ((c === ',' && d === 0) || i === body.length) { out.push(body.slice(from, i)); from = i + 1; }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}
const NOT_COLUMN = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|KEY|INDEX|SUPPLEMENTAL|PERIOD)\b/i;
const NOT_TYPE = /^(NOT|NULL|DEFAULT|CONSTRAINT|PRIMARY|UNIQUE|REFERENCES|CHECK|GENERATED|ENABLE|DISABLE)\b/i;
function columnDef(def: string): { name: string; type: string | null; nullable: boolean | null; pk: boolean } | null {
  const m = def.match(new RegExp(`^(${IDENT})(?:\\s+(${TYPE}))?`, 'i'));
  if (!m || NOT_COLUMN.test(m[1])) return null;
  let type: string | null = m[2] ?? null;
  if (type && NOT_TYPE.test(type)) type = null;
  return { name: m[1], type, nullable: /\bNOT\s+NULL\b/i.test(def) ? false : /\bNULL\b/i.test(def) ? true : null, pk: /\bPRIMARY\s+KEY\b/i.test(def) };
}

const SQL_SKIP = /^(CREATE\s+(UNIQUE\s+|BITMAP\s+)?INDEX|DROP\s+INDEX|CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(FUNCTION|PROCEDURE|PACKAGE|TRIGGER|TYPE|SYNONYM|PUBLIC\s+SYNONYM)|CREATE\s+SEQUENCE|DROP\s+SEQUENCE|ALTER\s+SEQUENCE|DROP\s+(FUNCTION|PROCEDURE|PACKAGE|TRIGGER|SYNONYM|PUBLIC\s+SYNONYM|VIEW|MATERIALIZED)|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|BEGIN|DECLARE|CALL|EXEC|COMMIT|ROLLBACK|ANALYZE|TRUNCATE|SELECT|WITH|COMMENT\s+ON\s+(TABLE|MATERIALIZED|VIEW)|ALTER\s+(INDEX|TRIGGER|SESSION|PACKAGE|PROCEDURE|FUNCTION|VIEW|SYSTEM)|END|PURGE|SET\s)/i;

/** SQL 한 문장을 모델에 적용. 스키마와 상관없는 문장이면 true, 못 읽으면 false */
export function applySql(model: Model, stmt: string, at: Loc): boolean {
  const s = stmt.replace(/\s+/g, ' ').trim();
  let m: RegExpMatchArray | null;
  if (SQL_SKIP.test(s)) return true;
  if ((m = s.match(new RegExp(`^CREATE\\s+(?:GLOBAL\\s+TEMPORARY\\s+)?TABLE\\s+(${QIDENT})\\s*\\(`, 'i')))) {
    const open = s.indexOf('(');
    let d = 0; let end = s.length;
    for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
    model.createTable(m[1], null, at);
    for (const def of splitTop(s.slice(open + 1, end))) { const c = columnDef(def); if (c) model.addColumn(m[1], c, at); }
    return true;
  }
  if ((m = s.match(new RegExp(`^CREATE\\s+TABLE\\s+(${QIDENT})\\s+AS\\s+SELECT\\s+(.*?)\\s+FROM\\s+(${QIDENT})(?:\\s+(?!WHERE|JOIN|LEFT|INNER|GROUP|ORDER)(\\w+))?`, 'i')))) {
    // 백업용 CTAS. 고른 컬럼을 원본 테이블에서 가져온다(별칭.컬럼 AS 이름도)
    model.createTable(m[1], null, at);
    const src = model.table(m[3]);
    const items = m[2].trim() === '*' ? [...(src?.columns.keys() ?? [])] : splitTop(m[2]);
    for (const it of items) {
      const parts = it.trim().split(/\s+(?:AS\s+)?/i);
      const from = U(parts[0]); const name = U(parts[parts.length - 1]);
      if (!/^[A-Z_][\w$#]*$/.test(name)) continue;
      const c = src?.columns.get(from);
      model.addColumn(m[1], { name, type: c?.type ?? null, remarks: c?.remarks ?? null }, at);
    }
    return true;
  }
  if ((m = s.match(new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FORCE\\s+|NOFORCE\\s+)?(?:EDITIONABLE\\s+)?(?:MATERIALIZED\\s+)?VIEW\\s+(${QIDENT})`, 'i')))) { model.createTable(m[1], null, at, true); return true; }
  if ((m = s.match(new RegExp(`^DROP\\s+TABLE\\s+(${QIDENT})`, 'i')))) { model.dropTable(m[1], at); return true; }
  if ((m = s.match(new RegExp(`^COMMENT\\s+ON\\s+COLUMN\\s+(?:${IDENT}\\.)?(${IDENT})\\.(${IDENT})\\s+IS\\s+'((?:[^']|'')*)'`, 'i')))) {
    model.modifyColumn(m[1], m[2], { remarks: m[3].replace(/''/g, "'") }, at);
    return true;
  }
  if ((m = s.match(new RegExp(`^RENAME\\s+(${IDENT})\\s+TO\\s+(${IDENT})$`, 'i')))) { model.renameTable(m[1], m[2], at); return true; }
  const alt = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(${QIDENT})\\s+(.*)$`, 'i'));
  if (!alt) return false;
  const t = alt[1]; const rest = alt[2];
  if ((m = rest.match(new RegExp(`^RENAME\\s+COLUMN\\s+(${IDENT})\\s+TO\\s+(${IDENT})`, 'i')))) { model.renameColumn(t, m[1], m[2], at); return true; }
  if (/^RENAME\s+(CONSTRAINT|INDEX)\b/i.test(rest)) return true;
  if ((m = rest.match(new RegExp(`^RENAME\\s+TO\\s+(${QIDENT})`, 'i')))) { model.renameTable(t, m[1], at); return true; }
  if (/^(DROP|ADD|MODIFY|ENABLE|DISABLE)\s+(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|PARTITION|SUPPLEMENTAL|INDEX)\b/i.test(rest) || /^(ADD\s+)?\(?\s*CONSTRAINT\b/i.test(rest)) return true;
  if ((m = rest.match(new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(SET|DROP)\\s+NOT\\s+NULL`, 'i')))) { model.modifyColumn(t, m[1], { nullable: m[2].toUpperCase() === 'DROP' }, at); return true; }
  if ((m = rest.match(new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+(${TYPE})`, 'i')))) { model.modifyColumn(t, m[1], { type: m[2] }, at); return true; }
  if (/^ALTER\s+(?:COLUMN\s+)?\S+\s+(SET|DROP)\s+DEFAULT\b/i.test(rest)) return true;
  if ((m = rest.match(/^DROP\s*\(([^)]*)\)/i))) { for (const c of m[1].split(',')) model.dropColumn(t, c, at); return true; }
  if ((m = rest.match(/^DROP\s+(?:COLUMN\s+)?("?[A-Za-z_][\w$#]*"?)/i))) { model.dropColumn(t, m[1], at); return true; }
  if ((m = rest.match(/^(ADD|MODIFY)\s*(?:COLUMN\s+)?([\s\S]*)$/i))) {
    const add = m[1].toUpperCase() === 'ADD';
    let body = m[2].trim();
    if (body.startsWith('(')) {
      let d = 0; let end = body.length;
      for (let i = 0; i < body.length; i++) { if (body[i] === '(') d++; else if (body[i] === ')') { d--; if (d === 0) { end = i; break; } } }
      body = body.slice(1, end);
    }
    let ok = true;
    for (const def of splitTop(body)) {
      if (NOT_COLUMN.test(def)) continue;
      const c = columnDef(def);
      if (!c) { ok = false; continue; }
      if (add) { if (!model.addColumn(t, c, at)) ok = false; }
      else if (!model.modifyColumn(t, c.name, { type: c.type, nullable: c.nullable }, at)) ok = false;
    }
    return ok;
  }
  return /^(PARALLEL|NOPARALLEL|LOGGING|NOLOGGING|MOVE|SHRINK|ENABLE|DISABLE|CACHE|NOCACHE|ROW)\b/i.test(rest);
}

export type ChangelogIO = {
  /** 파일 내용(없으면 null) */
  read: (abs: string) => string | null;
  /** include file 경로를 절대 경로로 */
  resolve: (ref: string, fromAbs: string, relative: boolean) => string | null;
  /** includeAll path 아래 changelog 파일들(이름순) */
  list: (ref: string, fromAbs: string, relative: boolean) => string[];
  /** 화면에 보일 상대 경로 */
  rel: (abs: string) => string;
};

const SKIP_CHANGES = new Set(['comment', 'preConditions', 'rollback', 'validCheckSum', 'createIndex', 'dropIndex', 'addForeignKeyConstraint', 'dropForeignKeyConstraint',
  'addPrimaryKey', 'dropPrimaryKey', 'addUniqueConstraint', 'dropUniqueConstraint', 'createSequence', 'dropSequence', 'alterSequence', 'renameSequence', 'loadData', 'loadUpdateData',
  'insert', 'update', 'delete', 'addDefaultValue', 'dropDefaultValue', 'createProcedure', 'dropProcedure', 'tagDatabase', 'output', 'stop', 'empty', 'executeCommand',
  'customChange', 'addAutoIncrement', 'addLookupTable', 'setTableRemarks', 'dropView', 'renameView', 'createSynonym', 'dropSynonym', 'modifySql', 'createFunction',
  'createTrigger', 'createPackage', 'createPackageBody', 'dropAllForeignKeyConstraints', 'addCheckConstraint', 'dropCheckConstraint', 'enableCheckConstraint', 'disableCheckConstraint']);

/** test 컨텍스트에서만 도는 changeset인지 */
function testOnly(ctx: string | undefined): boolean {
  if (!ctx) return false;
  const parts = ctx.split(/,|\bor\b/i).map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^test\b/.test(p));
}

/** 전제조건을 지금 모델로 평가. 모르는 조건은 참으로 본다. */
function precondition(model: Model, n: XmlNode): boolean {
  const kids = n.children;
  switch (n.tag) {
    case 'preConditions': case 'and': return kids.every((k) => precondition(model, k));
    case 'or': return kids.length === 0 || kids.some((k) => precondition(model, k));
    case 'not': return !kids.every((k) => precondition(model, k));
    case 'tableExists': return Boolean(model.table(n.attrs.tableName));
    case 'viewExists': return Boolean(model.table(n.attrs.viewName));
    case 'columnExists': return Boolean(model.table(n.attrs.tableName)?.columns.has(U(n.attrs.columnName)));
    default: return true;
  }
}

function columnsOf(n: XmlNode) {
  return n.children.filter((c) => c.tag === 'column' && c.attrs.name).map((c) => {
    const cons = c.children.find((x) => x.tag === 'constraints');
    return {
      name: c.attrs.name, type: c.attrs.type ?? null, remarks: c.attrs.remarks ?? null,
      nullable: bool(cons?.attrs.nullable), pk: cons?.attrs.primaryKey === 'true', line: c.line,
    };
  });
}

function applyChange(model: Model, n: XmlNode, at: Loc, io: ChangelogIO, fromAbs: string): void {
  const a = n.attrs;
  const here = { ...at, line: n.line };
  const miss = (why: string) => model.s.unparsed.push({ file: at.file, line: n.line, text: `<${n.tag}${a.tableName ? ` tableName="${a.tableName}"` : ''}> ${why}` });
  const sql = (text: string, file: string, line: number) => {
    const parts = a.splitStatements === 'false' ? [{ text: text.trim(), line }] : splitSql(text, line, a.endDelimiter?.trim() === '/' ? '/' : ';');
    for (const st of parts) if (!applySql(model, st.text, { file, line: st.line, changeset: at.changeset })) model.s.unparsed.push({ file, line: st.line, text: st.text.slice(0, 200) });
  };
  switch (n.tag) {
    case 'createTable':
      model.createTable(a.tableName, a.remarks ?? null, here);
      for (const c of columnsOf(n)) model.addColumn(a.tableName, c, { ...here, line: c.line });
      return;
    case 'addColumn':
      for (const c of columnsOf(n)) if (!model.addColumn(a.tableName, c, { ...here, line: c.line })) miss('테이블 없음');
      return;
    case 'dropColumn': {
      const cols = a.columnName ? [a.columnName] : columnsOf(n).map((c) => c.name);
      for (const c of cols) model.dropColumn(a.tableName, c, here);
      return;
    }
    case 'renameColumn':
      if (!model.renameColumn(a.tableName, a.oldColumnName, a.newColumnName, here, a.columnDataType)) miss(`${a.oldColumnName} 없음`);
      return;
    case 'modifyDataType':
      if (!model.modifyColumn(a.tableName, a.columnName, { type: a.newDataType }, here)) miss(`${a.columnName} 없음`);
      return;
    case 'addNotNullConstraint': model.modifyColumn(a.tableName, a.columnName, { nullable: false, type: a.columnDataType }, here); return;
    case 'dropNotNullConstraint': model.modifyColumn(a.tableName, a.columnName, { nullable: true }, here); return;
    case 'setColumnRemarks': model.modifyColumn(a.tableName, a.columnName, { remarks: a.remarks ?? null }, here); return;
    case 'dropTable': model.dropTable(a.tableName, here); return;
    case 'renameTable': model.renameTable(a.oldTableName, a.newTableName, here); return;
    case 'createView': model.createTable(a.viewName, null, here, true); return;
    case 'sql': sql(n.text, at.file, n.line); return;
    case 'sqlFile': {
      const abs = io.resolve(a.path, fromAbs, a.relativeToChangelogFile === 'true');
      const text = abs ? io.read(abs) : null;
      if (text === null) { miss(`${a.path} 못 읽음`); return; }
      sql(text, io.rel(abs!), 1);
      return;
    }
    default:
      if (!SKIP_CHANGES.has(n.tag)) miss('모르는 변경');
  }
}

/** formatted SQL changelog(--liquibase formatted sql) */
function applyFormattedSql(model: Model, text: string, file: string) {
  const blocks: { id: string; skip: boolean; sql: string; line: number }[] = [];
  let cur: (typeof blocks)[number] | null = null;
  text.split('\n').forEach((l, i) => {
    const cs = l.match(/^--\s*changeset\s+(\S+)(.*)$/i);
    if (cs) { cur = { id: cs[1], skip: testOnly(cs[2].match(/context:(\S+)/i)?.[1]), sql: '', line: i + 2 }; blocks.push(cur); return; }
    if (cur) cur.sql += /^--\s*(rollback|precondition|comment)/i.test(l) ? '\n' : `${l}\n`;
  });
  for (const b of blocks) {
    model.s.changesets++;
    if (b.skip) continue;
    for (const st of splitSql(b.sql, b.line)) if (!applySql(model, st.text, { file, line: st.line, changeset: b.id })) model.s.unparsed.push({ file, line: st.line, text: st.text.slice(0, 200) });
  }
}

/** 루트 changelog들을 순서대로 따라가며 최종 스키마를 만든다. */
export function buildSchema(roots: string[], io: ChangelogIO): LbSchema {
  const s = emptySchema();
  const model = new Model(s);
  const seen = new Set<string>();
  const visit = (abs: string) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const text = io.read(abs);
    if (text === null) return;
    const file = io.rel(abs);
    s.files.push(file);
    if (/\.sql$/i.test(abs)) {
      if (/--\s*liquibase\s+formatted\s+sql/i.test(text)) applyFormattedSql(model, text, file);
      else for (const st of splitSql(text, 1)) if (!applySql(model, st.text, { file, line: st.line, changeset: '(sql)' })) s.unparsed.push({ file, line: st.line, text: st.text.slice(0, 200) });
      return;
    }
    const root = parseXml(text);
    if (!root || root.tag !== 'databaseChangeLog') return;
    for (const n of root.children) {
      if (n.tag === 'include') {
        const target = io.resolve(n.attrs.file, abs, n.attrs.relativeToChangelogFile === 'true');
        if (target) visit(target); else s.unparsed.push({ file, line: n.line, text: `include ${n.attrs.file} 못 찾음` });
      } else if (n.tag === 'includeAll') {
        for (const f of io.list(n.attrs.path, abs, n.attrs.relativeToChangelogFile === 'true')) visit(f);
      } else if (n.tag === 'changeSet') {
        s.changesets++;
        if (testOnly(n.attrs.context ?? n.attrs.contextFilter ?? n.attrs.contexts)) continue;
        const pre = n.children.find((c) => c.tag === 'preConditions');
        if (pre && !precondition(model, pre)) continue;
        const at: Loc = { file, line: n.line, changeset: n.attrs.id ?? '' };
        for (const c of n.children) applyChange(model, c, at, io, abs);
      }
    }
  };
  for (const r of roots) visit(r);
  return s;
}
