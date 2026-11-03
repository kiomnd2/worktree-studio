/**
 * CREATE TABLE·COMMENT ON·ALTER TABLE ... FOREIGN KEY DDL을 테이블·컬럼·관계로 푼다.
 * erd-vibe 프론트의 utils/ddlParser.js 규칙을 그대로 옮겼다(같은 DDL을 넣으면 erd-vibe와 같은 결과가 나와야 팀 데이터가 섞이지 않는다).
 * 다른 점: 관계 방향을 erd-vibe DDL 생성기·캔버스와 같게 from = 참조되는 쪽(PK), to = FK를 가진 쪽으로 돌려 준다.
 * 이 폴더(dict/)는 studio의 DB·세션을 쓰지 않는 순수 함수만 둔다(나중에 CLI·CI가 그대로 쓰게).
 */

export type ParsedColumn = {
  logical_name: string; physical_name: string; data_type: string;
  is_nullable: boolean; is_primary_key: boolean; is_unique: boolean; is_auto_increment?: boolean;
  description: string; order_index: number;
};
export type ParsedTable = { logical_name: string; physical_name: string; description?: string; columns: ParsedColumn[] };
export type ParsedRelationship = {
  constraint_name: string; from_table_name: string; from_column_name: string; to_table_name: string; to_column_name: string;
  relationship_type: 'one_to_one' | 'one_to_many' | 'many_to_many';
};
export type ParsedDdl = { tables: ParsedTable[]; relationships: ParsedRelationship[] };

export const PARSE_DBMS = ['oracle', 'mysql', 'mariadb', 'postgresql'] as const;

function removeComments(ddl: string): string {
  return ddl.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n/g, '\n').trim();
}

/** 괄호 안의 쉼표는 두고 바깥 쉼표로만 나눈다. */
function splitByComma(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** 여는 괄호 위치부터 짝이 맞는 닫는 괄호 위치. 없으면 -1 */
function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function parseOracleDataType(typeStr: string): string {
  const up = typeStr.toUpperCase().trim();
  const varchar = up.match(/(VARCHAR2?)\((\d+)(?:\s+(?:BYTE|CHAR))?\)/);
  if (varchar) return `VARCHAR(${varchar[2]})`;
  const num = up.match(/NUMBER\(([^,)]+)(?:,(\d+))?\)/);
  if (num) {
    const precision = num[1].trim();
    if (precision === '*' && num[2] === '0') return 'NUMBER';
    return num[2] ? `NUMBER(${precision},${num[2]})` : `NUMBER(${precision})`;
  }
  const ts = up.match(/TIMESTAMP\((\d+)\)/);
  if (ts) return `TIMESTAMP(${ts[1]})`;
  if (/^(NUMBER|DATE|TIMESTAMP|CLOB|BLOB|CHAR)$/.test(up)) return up;
  return typeStr;
}

function parseMySQLDataType(typeStr: string): string {
  const low = typeStr.toLowerCase().trim();
  const varchar = low.match(/varchar\((\d+)\)/);
  if (varchar) return `VARCHAR(${varchar[1]})`;
  const int = low.match(/(int|bigint|smallint|tinyint)\((\d+)\)/);
  if (int) return `${int[1].toUpperCase()}(${int[2]})`;
  const dec = low.match(/decimal\((\d+)(?:,(\d+))?\)/);
  if (dec) return dec[2] ? `DECIMAL(${dec[1]},${dec[2]})` : `DECIMAL(${dec[1]})`;
  if (/^(int|bigint|smallint|tinyint|decimal|text|datetime|timestamp|date|float|double)$/.test(low)) return low.toUpperCase();
  return typeStr;
}

/** COMMENT ON TABLE/COLUMN 구문. key는 fold로 맞춘 이름 */
function commentsOf(ddl: string, fold: (s: string) => string) {
  const tables: Record<string, string> = {};
  const columns: Record<string, Record<string, string>> = {};
  for (const m of ddl.matchAll(/COMMENT\s+ON\s+TABLE\s+(?:(\w+)\.)?(\w+)\s+IS\s+'([^']+)'/gi)) tables[fold(m[2])] = m[3];
  for (const m of ddl.matchAll(/COMMENT\s+ON\s+COLUMN\s+(?:(\w+)\.)?(\w+)\.(\w+)\s+IS\s+'([^']+)'/gi)) {
    (columns[fold(m[2])] ??= {})[fold(m[3])] = m[4];
  }
  return { tables, columns };
}

function parseOracleDDL(ddl: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const cleaned = removeComments(ddl);
  const comments = commentsOf(cleaned, (s) => s.toUpperCase());
  for (const statement of cleaned.split(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i).filter((s) => s.trim())) {
    const nameMatch = statement.match(/^(?:"(\w+)"\s*\.\s*)?("?)(\w+)\2\s*\(/i);
    if (!nameMatch) continue;
    const tableName = nameMatch[3].toUpperCase();
    const open = statement.indexOf('(');
    const close = closingParen(statement, open);
    if (close === -1) continue;
    const columnsText = statement.substring(open + 1, close);
    if (!columnsText.trim()) continue;
    const pkFromConstraint = new Set<string>();
    const pk = columnsText.match(/CONSTRAINT\s+[^,]+PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    if (pk) for (const c of pk[1].split(',')) pkFromConstraint.add(c.trim().replace(/^"(.+)"$/, '$1').toUpperCase());
    const colComments = comments.columns[tableName] ?? {};
    const columns: ParsedColumn[] = [];
    for (const line of splitByComma(columnsText)) {
      if (/^(PRIMARY\s+KEY|CONSTRAINT|FOREIGN\s+KEY|UNIQUE|CHECK)/i.test(line)) continue;
      const m = line.match(/^("?)(\w+)\1\s+(\w+(?:\([^)]+\))?)\s*(.*)/i);
      if (!m) continue;
      const name = m[2].toUpperCase();
      const rest = m[4];
      const identity = /GENERATED\s+(?:BY\s+DEFAULT|ALWAYS)\s+AS\s+IDENTITY/i.test(rest);
      const logical = colComments[name] || name;
      columns.push({
        logical_name: logical, physical_name: name, data_type: parseOracleDataType(m[3]),
        is_nullable: !identity && !/NOT\s+NULL/i.test(rest),
        is_primary_key: /PRIMARY\s+KEY/i.test(rest) || identity || pkFromConstraint.has(name),
        is_unique: /\bUNIQUE\b/i.test(rest), is_auto_increment: identity,
        description: logical, order_index: columns.length,
      });
    }
    tables.push({ logical_name: comments.tables[tableName] || tableName, physical_name: tableName, columns });
  }
  return tables;
}

function parseMySQLDDL(ddl: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const cleaned = removeComments(ddl);
  for (const statement of cleaned.split(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i).filter((s) => s.trim())) {
    const nameMatch = statement.match(/^`?(\w+)`?\s*\(/i);
    if (!nameMatch) continue;
    const tableName = nameMatch[1];
    const open = statement.indexOf('(');
    const close = closingParen(statement, open);
    if (close === -1) continue;
    const columnsText = statement.substring(open + 1, close);
    const tableComment = statement.substring(close).match(/^\)\s*[\s\S]*?COMMENT\s*=?\s*'([^']+)'/i)?.[1] ?? tableName;
    if (!columnsText.trim()) continue;
    const columns: ParsedColumn[] = [];
    for (const line of splitByComma(columnsText)) {
      if (/^(PRIMARY\s+KEY|CONSTRAINT|FOREIGN\s+KEY|UNIQUE\s+KEY|UNIQUE\s+INDEX|KEY\s+|INDEX\s+)/i.test(line)) continue;
      const m = line.match(/^`?(\w+)`?\s+([^\s]+(?:\s*\([^)]+\))?)(.*)/i);
      if (!m) continue;
      const rest = m[3];
      const logical = rest.match(/COMMENT\s+'([^']+)'/i)?.[1] ?? m[1];
      columns.push({
        logical_name: logical, physical_name: m[1], data_type: parseMySQLDataType(m[2]),
        is_nullable: !/NOT\s+NULL/i.test(rest),
        is_primary_key: /PRIMARY\s+KEY/i.test(rest) || /AUTO_INCREMENT/i.test(rest),
        is_unique: /UNIQUE/i.test(rest), description: logical, order_index: columns.length,
      });
    }
    tables.push({ logical_name: tableComment, physical_name: tableName, description: tableComment, columns });
  }
  return tables;
}

const PG_TYPES = [
  /^(timestamp\s+with\s+time\s+zone)/i, /^(timestamp\s+without\s+time\s+zone)/i, /^(character\s+varying(?:\([^)]+\))?(\[\])?)/i,
  /^(numeric\([^)]+\))/, /^(decimal\([^)]+\))/, /^(varchar\([^)]+\))/, /^(varchar\b)/i, /^(uuid\b)/i,
  /^(serial|bigserial|smallserial)\b/i, /^(boolean|bool)\b/i, /^(text\b)/i, /^(json|jsonb)\b/i, /^(integer|int|bigint|smallint)\b/i,
  /^(\w+(?:\([^)]+\))?)/,
];

function parsePostgreSQLDDL(ddl: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const cleaned = removeComments(ddl);
  const comments = commentsOf(cleaned, (s) => s.toLowerCase());
  for (const tm of cleaned.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)/gi)) {
    const tableName = tm[2];
    let p = tm.index! + tm[0].length;
    while (p < cleaned.length && cleaned[p] !== '(' && /\s/.test(cleaned[p])) p++;
    if (cleaned[p] !== '(') continue;
    const close = closingParen(cleaned, p);
    if (close === -1) continue;
    const body = cleaned.substring(p + 1, close).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const lower = tableName.toLowerCase();
    const columns: ParsedColumn[] = [];
    for (const line of splitByComma(body)) {
      if (!line || /^(PRIMARY\s+KEY|CONSTRAINT|FOREIGN\s+KEY|UNIQUE|CHECK)/i.test(line)) continue;
      const nm = line.match(/^(\w+)\s+/);
      if (!nm) continue;
      const name = nm[1];
      const rest = line.substring(name.length).trim();
      const refAt = /REFERENCES\s+(?:(\w+)\.)?(\w+)\s*\((\w+)\)/i.test(rest) ? rest.indexOf('REFERENCES') : -1;
      const before = refAt >= 0 ? rest.substring(0, refAt).trim() : rest;
      const refPart = refAt >= 0 ? rest.substring(refAt) : '';
      let type = '';
      let constraints = '';
      for (const re of PG_TYPES) {
        const m = before.match(re);
        if (m) { type = m[0].trim(); constraints = `${before.substring(m[0].length).trim()} ${refPart}`; break; }
      }
      if (!type) {
        const parts = before.split(/\s+/);
        if (!parts[0]) continue;
        type = parts[0];
        constraints = `${parts.slice(1).join(' ')} ${refPart}`;
      }
      const logical = comments.columns[lower]?.[name.toLowerCase()] || name;
      columns.push({
        logical_name: logical, physical_name: name, data_type: type,
        is_nullable: !/NOT\s+NULL/i.test(constraints),
        is_primary_key: /PRIMARY\s+KEY/i.test(constraints) || /^(serial|bigserial|smallserial)$/i.test(type),
        is_unique: /\bUNIQUE\b/i.test(constraints), description: logical, order_index: columns.length,
      });
    }
    const tableComment = comments.tables[lower] || tableName;
    tables.push({ logical_name: tableComment, physical_name: tableName, description: tableComment, columns });
  }
  return tables;
}

const splitIdentifiers = (text: string) => text.split(',').map((s) => s.trim().replace(/^["`](.+)["`]$/, '$1')).filter(Boolean);

/** FK를 가진 쪽(holder)과 참조되는 쪽(ref)을 받아 erd-vibe 방향(from = ref)으로 만든다. */
function rel(name: string, holderTable: string, holderCol: string, refTable: string, refCol: string): ParsedRelationship {
  return { constraint_name: name, from_table_name: refTable, from_column_name: refCol, to_table_name: holderTable, to_column_name: holderCol, relationship_type: 'one_to_many' };
}

function createTableForeignKeys(ddl: string, norm: (s: string) => string): ParsedRelationship[] {
  const out: ParsedRelationship[] = [];
  for (const tm of ddl.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?(\w+)["`]?\s*\.\s*)?["`]?(\w+)["`]?\s*\(/gi)) {
    const table = norm(tm[2]);
    const open = tm.index! + tm[0].length - 1;
    const close = closingParen(ddl, open);
    if (close === -1) continue;
    for (const line of splitByComma(ddl.substring(open + 1, close))) {
      const t = line.match(/^(?:CONSTRAINT\s+["`]?(\w+)["`]?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:["`]?(\w+)["`]?\s*\.\s*)?["`]?(\w+)["`]?\s*\(([^)]+)\)/i);
      if (t) {
        const from = splitIdentifiers(t[2]).map(norm);
        const to = splitIdentifiers(t[5]).map(norm);
        for (let i = 0; i < Math.min(from.length, to.length); i++) out.push(rel(t[1] || `FK_${table}_${from[i]}`, table, from[i], norm(t[4]), to[i]));
        continue;
      }
      if (/^(CONSTRAINT|FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|KEY\s|INDEX\s)/i.test(line)) continue;
      const inline = line.match(/^["`]?(\w+)["`]?\s+.*?\bREFERENCES\s+(?:["`]?(\w+)["`]?\s*\.\s*)?["`]?(\w+)["`]?\s*\(([^)]+)\)/i);
      if (inline) {
        const to = splitIdentifiers(inline[4]).map(norm);
        if (to.length) out.push(rel(`FK_${table}_${norm(inline[1])}`, table, norm(inline[1]), norm(inline[3]), to[0]));
      }
    }
  }
  return out;
}

function alterTableForeignKeys(ddl: string, norm: (s: string) => string): ParsedRelationship[] {
  const out: ParsedRelationship[] = [];
  const re = /ALTER\s+TABLE\s+(?:["`]?(\w+)["`]?\s*\.\s*)?["`]?(\w+)["`]?\s+ADD\s+CONSTRAINT\s+["`]?(\w+)["`]?\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:["`]?(\w+)["`]?\s*\.\s*)?["`]?(\w+)["`]?\s*\(([^)]+)\)/gi;
  for (const m of ddl.matchAll(re)) {
    const from = splitIdentifiers(m[4]).map(norm);
    const to = splitIdentifiers(m[7]).map(norm);
    for (let i = 0; i < Math.min(from.length, to.length); i++) out.push(rel(m[3], norm(m[2]), from[i], norm(m[6]), to[i]));
  }
  return out;
}

export function parseDDL(ddl: string, dbms = 'oracle'): ParsedDdl {
  const type = dbms.toLowerCase();
  const tables = type === 'oracle' ? parseOracleDDL(ddl)
    : type === 'mysql' || type === 'mariadb' ? parseMySQLDDL(ddl)
    : type === 'postgresql' ? parsePostgreSQLDDL(ddl)
    : null;
  if (!tables) throw new Error(`DDL 가져오기는 Oracle·MySQL·MariaDB·PostgreSQL만 됩니다(받은 값: ${dbms}).`);
  const cleaned = removeComments(ddl);
  const norm = type === 'oracle' ? (s: string) => s.toUpperCase() : (s: string) => s;
  const seen = new Set<string>();
  const relationships = [...createTableForeignKeys(cleaned, norm), ...alterTableForeignKeys(cleaned, norm)].filter((r) => {
    const key = [r.from_table_name, r.from_column_name, r.to_table_name, r.to_column_name].join('|').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { tables, relationships };
}
