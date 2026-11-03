import pg from 'pg';
import mysql from 'mysql2';
import oracledb from 'oracledb';
import mssql from 'mssql';
import { ENGINE, type DbConnection } from './dbconn.js';

/**
 * DB 연결로 질의 하나를 실행한다. 대화의 Claude가 데이터를 확인할 때 쓴다.
 * 읽기 질의는 롤백하는 트랜잭션(되는 엔진은 READ ONLY) 안에서 돌리고, 쓰기 질의는 사용자가 승인한 뒤에만 돌린다.
 */
export const MAX_ROWS = 200;
const TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_CELL = 300;

export type QueryResult = { columns: string[]; rows: unknown[][]; truncated: boolean; affected: number | null; ms: number };

const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMENT|CALL|EXEC|EXECUTE|DO|COPY|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|SET|RESET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|DECLARE|INTO|HANDLER|LOAD|PURGE|FLASHBACK|SHUTDOWN|KILL)\b/i;
const READ_START = /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES|TABLE)\b/i;

/** 문자열·따옴표 이름·주석을 지운 질의. 키워드를 볼 때만 쓴다. */
function stripped(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
}

/**
 * 읽기만 하는 질의인지 본다. 애매하면 쓰기로 본다(승인 카드를 거친다).
 * 끝의 세미콜론 하나는 허용하고, 문장이 여럿이면 쓰기로 본다.
 */
export function isReadOnly(sql: string): boolean {
  const s = stripped(sql).replace(/;\s*$/, '');
  if (!s || s.includes(';')) return false;
  if (!READ_START.test(s)) return false;
  // EXPLAIN ANALYZE는 실제로 실행하므로 뒤 문장만 본다. ANALYZE가 쓰기 단어라 먼저 뺀다.
  const body = s.replace(/^EXPLAIN\s+(\((?:[^)]*)\)\s*)?(ANALYZE\s+)?(VERBOSE\s+)?/i, '');
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(body)) return false;
  return !WRITE_WORDS.test(body.replace(/^(DESCRIBE|DESC)\b/i, ''));
}

export function engineSupported(c: DbConnection): boolean {
  return ENGINE[c.engine].sql;
}

const portOf = (c: DbConnection) => c.port ?? ENGINE[c.engine].port;
const hostOf = (c: DbConnection) => c.host || 'localhost';

/** 읽기는 readOnly: true. 결과는 MAX_ROWS행까지만 가져온다. */
export async function runQuery(c: DbConnection, sql: string, opts: { readOnly: boolean }): Promise<QueryResult> {
  const text = sql.trim().replace(/;\s*$/, '');
  const started = Date.now();
  let r: Omit<QueryResult, 'ms'>;
  switch (c.engine) {
    case 'postgres': r = await runPostgres(c, text, opts.readOnly); break;
    case 'mysql': case 'mariadb': r = await runMysql(c, text, opts.readOnly); break;
    case 'oracle': r = await runOracle(c, text, opts.readOnly); break;
    case 'mssql': r = await runMssql(c, text, opts.readOnly); break;
    default: throw new Error(`${c.engine}은(는) 아직 질의를 지원하지 않습니다. SQL DB(postgres, mysql, mariadb, oracle, mssql)만 됩니다.`);
  }
  return { ...r, ms: Date.now() - started };
}

function pgClient(c: DbConnection) {
  return new pg.Client({
    host: hostOf(c), port: portOf(c), database: c.database || undefined, user: c.username || undefined, password: c.password || undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS + 2000,
    // 날짜는 드라이버가 Date로 바꾸지 않고 DB가 보낸 글자 그대로 보여 준다.
    types: { getTypeParser: (oid: number, format?: string) => (format === 'binary' ? pg.types.getTypeParser(oid, 'binary') : [1082, 1114, 1184].includes(oid) ? (v: string) => v : pg.types.getTypeParser(oid, 'text')) } as never,
  });
}

async function runPostgres(c: DbConnection, sql: string, readOnly: boolean): Promise<Omit<QueryResult, 'ms'>> {
  const client = pgClient(c);
  await client.connect();
  try {
    if (!readOnly) {
      const res = await client.query({ text: sql, rowMode: 'array' });
      return fromPg(Array.isArray(res) ? res[res.length - 1] : res);
    }
    await client.query('BEGIN READ ONLY');
    try {
      // SELECT 계열은 커서로 필요한 행만 가져온다.
      if (/^(SELECT|WITH|VALUES|TABLE)\b/i.test(stripped(sql))) {
        await client.query(`DECLARE studio_q NO SCROLL CURSOR FOR ${sql}`);
        return fromPg(await client.query({ text: `FETCH ${MAX_ROWS + 1} FROM studio_q`, rowMode: 'array' }));
      }
      return fromPg(await client.query({ text: sql, rowMode: 'array' }));
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

function fromPg(res: pg.QueryResult<unknown[]>): Omit<QueryResult, 'ms'> {
  const rows = res.rows ?? [];
  return {
    columns: (res.fields ?? []).map((f) => f.name),
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
    affected: res.fields?.length ? null : res.rowCount,
  };
}

function mysqlConn(c: DbConnection) {
  return mysql.createConnection({
    host: hostOf(c), port: portOf(c), database: c.database || undefined, user: c.username || undefined, password: c.password || undefined,
    connectTimeout: CONNECT_TIMEOUT_MS, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, rowsAsArray: true,
  });
}

async function runMysql(c: DbConnection, sql: string, readOnly: boolean): Promise<Omit<QueryResult, 'ms'>> {
  const conn = mysqlConn(c);
  const q = (s: string) => new Promise<void>((resolve, reject) => conn.query(s, (err) => (err ? reject(err) : resolve())));
  // MAX_ROWS를 넘으면 연결을 끊어 나머지를 받지 않는다. 끊긴 연결의 트랜잭션은 DB가 되돌린다.
  let cut = false;
  try {
    if (readOnly) await q('START TRANSACTION READ ONLY');
    return await new Promise<Omit<QueryResult, 'ms'>>((resolve, reject) => {
      const rows: unknown[][] = [];
      let columns: string[] = [];
      let affected: number | null = null;
      const query = conn.query({ sql, timeout: TIMEOUT_MS, rowsAsArray: true });
      query.on('fields', (fields: unknown) => { columns = ((fields as { name: string }[] | undefined) ?? []).map((f) => f.name); });
      query.on('result', (row) => {
        if (!Array.isArray(row)) { affected = (row as { affectedRows?: number }).affectedRows ?? null; return; }
        if (rows.length < MAX_ROWS) { rows.push(row); return; }
        if (cut) return;
        cut = true;
        conn.destroy();
        resolve({ columns, rows, truncated: true, affected: null });
      });
      query.on('error', (err) => { if (!cut) reject(err); });
      query.on('end', () => { if (!cut) resolve({ columns, rows, truncated: false, affected: columns.length ? null : affected }); });
    });
  } finally {
    if (!cut) {
      if (readOnly) await q('ROLLBACK').catch(() => {});
      await new Promise<void>((resolve) => conn.end(() => resolve())).catch(() => {});
    }
    conn.destroy();
  }
}

const AS_STRING: unknown[] = [oracledb.DB_TYPE_CLOB, oracledb.DB_TYPE_NCLOB];

/**
 * database 칸은 서비스 이름으로 먼저 붙고, 리스너가 서비스를 모르면(ORA-12514) SID로 다시 붙는다.
 * jdbc:oracle:thin:@host:port:SID 꼴 설정은 SID라서 서비스 이름으로는 안 붙는다.
 */
async function oracleConn(c: DbConnection) {
  const open = (connectString: string) => oracledb.getConnection({ user: c.username, password: c.password, connectString, connectTimeout: CONNECT_TIMEOUT_MS / 1000 });
  try {
    try {
      return await open(`${hostOf(c)}:${portOf(c)}/${c.database}`);
    } catch (err) {
      if (!c.database || !/ORA-12514|NJS-518|NJS-519/.test((err as Error).message)) throw err;
      return await open(`(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${hostOf(c)})(PORT=${portOf(c)}))(CONNECT_DATA=(SID=${c.database})))`);
    }
  } catch (err) {
    // Thin 모드는 Oracle 12.1부터 붙는다. 11g는 Instant Client(Thick 모드)가 있어야 해서 아직 지원하지 않는다.
    if ((err as Error).message.startsWith('NJS-138')) throw new Error('Oracle 11g 이하에는 아직 질의할 수 없습니다(Oracle 12.1 이상만 지원).');
    throw err;
  }
}

async function runOracle(c: DbConnection, sql: string, readOnly: boolean): Promise<Omit<QueryResult, 'ms'>> {
  const conn = await oracleConn(c);
  try {
    conn.callTimeout = TIMEOUT_MS;
    if (readOnly) await conn.execute('SET TRANSACTION READ ONLY');
    const res = await conn.execute<unknown[]>(sql, [], {
      outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: MAX_ROWS + 1, autoCommit: !readOnly,
      // 긴 글은 글자로 받는다. 날짜는 Date로 받아 cell()이 로컬 시각으로 적는다.
      fetchTypeHandler: (meta) => (AS_STRING.includes(meta.dbType) ? { type: oracledb.STRING } : undefined),
    });
    const rows = res.rows ?? [];
    return {
      columns: (res.metaData ?? []).map((m) => m.name),
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
      affected: res.metaData ? null : res.rowsAffected ?? null,
    };
  } finally {
    if (readOnly) await conn.rollback().catch(() => {});
    await conn.close().catch(() => {});
  }
}

/** 연결 하나짜리 풀. SET SHOWPLAN처럼 연결에 남는 설정을 이어 쓰려면 max 1이어야 한다. */
function mssqlPool(c: DbConnection) {
  return new mssql.ConnectionPool({
    server: hostOf(c), port: portOf(c), database: c.database || undefined, user: c.username, password: c.password,
    connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: TIMEOUT_MS, pool: { max: 1 },
    options: { encrypt: false, trustServerCertificate: true, useUTC: false },
  });
}

async function runMssql(c: DbConnection, sql: string, readOnly: boolean): Promise<Omit<QueryResult, 'ms'>> {
  const pool = mssqlPool(c);
  await pool.connect();
  // SQL Server에는 읽기 전용 트랜잭션이 없어 트랜잭션 안에서 돌리고 롤백한다.
  const tx = readOnly ? new mssql.Transaction(pool) : null;
  try {
    if (tx) await tx.begin();
    return await new Promise<Omit<QueryResult, 'ms'>>((resolve, reject) => {
      const req = tx ? new mssql.Request(tx) : pool.request();
      req.stream = true;
      let columns: string[] = [];
      const rows: unknown[][] = [];
      let truncated = false;
      req.on('recordset', (cols: Record<string, { index: number; name: string }>) => {
        // 결과가 여럿이면 마지막 것을 보여 준다.
        columns = Object.values(cols).sort((a, b) => a.index - b.index).map((x) => x.name);
        rows.length = 0;
      });
      req.on('row', (row: Record<string, unknown>) => {
        if (rows.length < MAX_ROWS) { rows.push(columns.map((k) => row[k])); return; }
        if (truncated) return;
        truncated = true;
        req.cancel();
        resolve({ columns, rows, truncated, affected: null });
      });
      req.on('error', (err: Error) => { if (!truncated) reject(err); });
      req.on('done', (r: { rowsAffected?: number[] }) => {
        resolve({ columns, rows, truncated, affected: columns.length ? null : (r.rowsAffected ?? []).reduce((a, b) => a + b, 0) });
      });
      req.query(sql);
    });
  } finally {
    if (tx) await tx.rollback().catch(() => {});
    await pool.close().catch(() => {});
  }
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  // Oracle·SQL Server 날짜는 드라이버가 로컬 시각으로 만든 Date라 로컬 시각 그대로 적는다.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().replace('T', ' ').replace(/(\.000)?Z$/, '');
  if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const one = s.replace(/\r?\n/g, '\\n').replace(/\t/g, ' ');
  return one.length > MAX_CELL ? `${one.slice(0, MAX_CELL)}…(${one.length}자)` : one;
}

/** Claude에게 돌려줄 글. 표는 탭으로 나눈다(마크다운 표보다 짧다). */
export function formatResult(r: QueryResult): string {
  if (!r.columns.length) return `실행했습니다. 영향받은 행 ${r.affected ?? 0}개 (${r.ms}ms)`;
  const head = `${r.rows.length}행${r.truncated ? ` (처음 ${MAX_ROWS}행만, 더 있음. 필요하면 조건이나 LIMIT로 좁히세요)` : ''} · ${r.ms}ms`;
  return [head, r.columns.join('\t'), ...r.rows.map((row) => row.map(cell).join('\t'))].join('\n');
}

export function describeConnection(c: DbConnection): string {
  return `${c.engine} ${hostOf(c)}:${portOf(c)}${c.database ? `/${c.database}` : ''}${c.username ? ` (${c.username})` : ''}`;
}

// ---- 실행 계획(쿼리 감시) ----

export type ExplainIndex = { name: string; unique: boolean; columns: string; used: boolean };
export type ExplainTable = { name: string; rows: number | null; indexes: ExplainIndex[] };
export type ExplainResult = { engine: string; connection: string; sql: string; plan: string; tables: ExplainTable[]; notes: string[]; ms: number };

const MAX_TABLES = 10;

/**
 * 실행 계획과 관련 테이블의 인덱스·행 수를 본다. 읽기 SELECT만 받고, 한 연결·한 트랜잭션에서 돌린 뒤 롤백한다.
 * analyze는 PostgreSQL에서만 쓴다(EXPLAIN ANALYZE는 질의를 실제로 돌린다. 읽기 전용 트랜잭션이라 데이터는 바뀌지 않는다).
 */
export async function explainQuery(c: DbConnection, sql: string, opts: { analyze?: boolean } = {}): Promise<ExplainResult> {
  const text = sql.trim().replace(/;\s*$/, '');
  if (!isReadOnly(text) || !/^(SELECT|WITH)\b/i.test(stripped(text))) throw new Error('실행 계획은 읽기 SELECT만 볼 수 있습니다.');
  const started = Date.now();
  let r: Pick<ExplainResult, 'plan' | 'tables' | 'notes'>;
  switch (c.engine) {
    case 'oracle': r = await explainOracle(c, text); break;
    case 'postgres': r = await explainPostgres(c, text, Boolean(opts.analyze)); break;
    case 'mysql': case 'mariadb': r = await explainMysql(c, text); break;
    case 'mssql': r = await explainMssql(c, text); break;
    default: throw new Error(`${c.engine}은(는) 실행 계획을 지원하지 않습니다.`);
  }
  return { engine: c.engine, connection: `${c.name} (${describeConnection(c)})`, sql: text, ...r, ms: Date.now() - started };
}

/** FROM·JOIN 뒤의 테이블 이름. WITH로 만든 이름과 서브쿼리는 뺀다. */
export function tablesOf(sql: string): string[] {
  const s = stripped(sql);
  const ctes = new Set([...s.matchAll(/(?:\bWITH|,)\s*([A-Za-z_][\w$]*)\s+AS\s*\(/gi)].map((m) => m[1].toUpperCase()));
  const names: string[] = [];
  const add = (n: string) => { const u = n.replace(/["`[\]]/g, ''); if (u && !ctes.has(u.toUpperCase()) && !/^(SELECT|DUAL|LATERAL|TABLE)$/i.test(u) && !names.some((x) => x.toUpperCase() === u.toUpperCase())) names.push(u); };
  for (const m of s.matchAll(/\bJOIN\s+([A-Za-z_][\w$.]*)/gi)) add(m[1]);
  // FROM a x, b y 처럼 쉼표로 나열한 테이블도 본다.
  for (const m of s.matchAll(/\bFROM\s+([^()]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bHAVING\b|\b(?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS)?\s*JOIN\b|\bUNION\b|\bFETCH\b|\bLIMIT\b|\bOFFSET\b|\)|$)/gi)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+/)[0]; if (/^[A-Za-z_][\w$.]*$/.test(n)) add(n); }
  }
  return names.slice(0, MAX_TABLES);
}

/** 표 결과를 줄 맞춘 글로 바꾼다(MySQL EXPLAIN처럼 표로 오는 계획). */
function textTable(columns: string[], rows: unknown[][]): string {
  const cells = [columns, ...rows.map((r) => r.map((v) => (v === null || v === undefined ? 'NULL' : String(v))))];
  const w = columns.map((_, i) => Math.min(60, Math.max(...cells.map((r) => (r[i] ?? '').length))));
  return cells.map((r) => r.map((v, i) => (v ?? '').slice(0, 60).padEnd(w[i])).join(' | ').trimEnd()).join('\n');
}

/** Oracle은 ? 대신 :1, :2 자리를 받는다. 값 없이도 EXPLAIN PLAN은 된다(바인드 값을 엿보지 않은 계획). */
function oracleBinds(sql: string): string {
  let i = 0;
  return sql.replace(/'(?:[^']|'')*'|\?/g, (m) => (m === '?' ? `:${++i}` : m));
}

async function explainOracle(c: DbConnection, sql: string): Promise<Pick<ExplainResult, 'plan' | 'tables' | 'notes'>> {
  const conn = await oracleConn(c);
  // PLAN_TABLE에 쓰므로 읽기 전용 트랜잭션으로 못 돌린다. 끝나면 롤백해 아무것도 남기지 않는다.
  const id = `studio_${Date.now().toString(36)}`;
  const arr = { outFormat: oracledb.OUT_FORMAT_ARRAY };
  try {
    conn.callTimeout = TIMEOUT_MS;
    try {
      await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${oracleBinds(sql)}`, [], { autoCommit: false });
    } catch (err) {
      const m = (err as Error).message;
      if (/ORA-02402|ORA-00942|ORA-01031/.test(m)) throw new Error(`${m}\nPLAN_TABLE이 없거나 권한이 없습니다. DBA에게 PLAN_TABLE 사용 권한(또는 ?/rdbms/admin/utlxplan.sql로 PLAN_TABLE 생성)을 요청하세요.`);
      throw err;
    }
    const plan = await conn.execute<[string]>(`SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL'))`, { id }, arr);
    const objs = await conn.execute<[string | null, string, string | null]>(
      `SELECT DISTINCT object_owner, object_name, object_type FROM plan_table WHERE statement_id = :id AND object_name IS NOT NULL`, { id }, arr);
    const used = new Set<string>();
    const tables: { owner: string | null; name: string }[] = [];
    const addTable = (owner: string | null, name: string) => { if (!tables.some((t) => t.name === name && t.owner === owner)) tables.push({ owner, name }); };
    for (const [owner, name, type] of objs.rows ?? []) {
      if (type?.startsWith('INDEX')) {
        used.add(name);
        const t = await conn.execute<[string, string]>(`SELECT table_owner, table_name FROM all_indexes WHERE index_name = :n AND (:o IS NULL OR owner = :o)`, { n: name, o: owner }, arr);
        for (const [to, tn] of t.rows ?? []) addTable(to, tn);
      } else if (type?.startsWith('TABLE') || type?.startsWith('MAT_VIEW')) {
        addTable(owner, name);
      }
    }
    const out: ExplainTable[] = [];
    for (const t of tables.slice(0, MAX_TABLES)) {
      const rows = await conn.execute<[number | null]>(`SELECT num_rows FROM all_tables WHERE table_name = :t AND (:o IS NULL OR owner = :o)`, { t: t.name, o: t.owner }, arr);
      const idx = await conn.execute<[string, string, string]>(
        `SELECT i.index_name, i.uniqueness, LISTAGG(c.column_name, ', ') WITHIN GROUP (ORDER BY c.column_position)
           FROM all_indexes i JOIN all_ind_columns c ON c.index_owner = i.owner AND c.index_name = i.index_name
          WHERE i.table_name = :t AND (:o IS NULL OR i.table_owner = :o)
          GROUP BY i.index_name, i.uniqueness ORDER BY i.index_name`, { t: t.name, o: t.owner }, arr);
      out.push({
        name: t.owner ? `${t.owner}.${t.name}` : t.name,
        rows: rows.rows?.[0]?.[0] ?? null,
        indexes: (idx.rows ?? []).map(([name, uq, cols]) => ({ name, unique: uq === 'UNIQUE', columns: cols, used: used.has(name) })),
      });
    }
    return {
      plan: (plan.rows ?? []).map((r) => r[0]).join('\n'),
      tables: out,
      notes: [
        '값을 리터럴로 넣은 계획이라, 앱이 바인드 변수로 실행할 때의 계획과 다를 수 있습니다.',
        '행 수(NUM_ROWS)는 마지막 통계 수집 때 값입니다.',
      ],
    };
  } finally {
    await conn.rollback().catch(() => {});
    await conn.close().catch(() => {});
  }
}

async function explainPostgres(c: DbConnection, sql: string, analyze: boolean): Promise<Pick<ExplainResult, 'plan' | 'tables' | 'notes'>> {
  const client = pgClient(c);
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    try {
      const res = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${analyze ? '(ANALYZE, BUFFERS) ' : ''}${sql}`);
      const plan = res.rows.map((r) => r['QUERY PLAN']).join('\n');
      const tables: ExplainTable[] = [];
      for (const name of tablesOf(sql)) {
        const rel = await client.query<{ rows: string | null }>(`SELECT reltuples::bigint AS rows FROM pg_class WHERE oid = to_regclass($1)`, [name]);
        if (!rel.rows.length) continue;
        const idx = await client.query<{ name: string; unique: boolean; def: string }>(
          `SELECT ic.relname AS name, ix.indisunique AS unique, pg_get_indexdef(ix.indexrelid) AS def
             FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid WHERE ix.indrelid = to_regclass($1) ORDER BY ic.relname`, [name]);
        const rows = rel.rows[0].rows === null ? null : Number(rel.rows[0].rows);
        tables.push({
          name,
          rows: rows !== null && rows >= 0 ? rows : null,
          indexes: idx.rows.map((i) => ({ name: i.name, unique: i.unique, columns: i.def.match(/\((.*)\)/)?.[1] ?? i.def, used: plan.includes(i.name) })),
        });
      }
      return {
        plan, tables,
        notes: [
          analyze ? 'EXPLAIN ANALYZE로 질의를 실제로 돌렸습니다(읽기 전용 트랜잭션, 롤백).' : '값을 리터럴로 넣은 계획이라, 앱이 바인드 변수로 실행할 때의 계획과 다를 수 있습니다.',
          '행 수(reltuples)는 통계 추정값입니다.',
        ],
      };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function explainMysql(c: DbConnection, sql: string): Promise<Pick<ExplainResult, 'plan' | 'tables' | 'notes'>> {
  const conn = mysqlConn(c).promise();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    try {
      const [rows, fields] = await conn.query({ sql: `EXPLAIN ${sql}`, rowsAsArray: true, timeout: TIMEOUT_MS });
      const plan = textTable((fields ?? []).map((f) => f.name), rows as unknown as unknown[][]);
      const tables: ExplainTable[] = [];
      for (const name of tablesOf(sql)) {
        const [schema, table] = name.includes('.') ? name.split('.', 2) : [null, name];
        const [t] = await conn.query({ sql: `SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`, values: [schema, table], rowsAsArray: true });
        const found = t as unknown as unknown[][];
        if (!found.length) continue;
        const [idx] = await conn.query({
          sql: `SELECT INDEX_NAME, MIN(NON_UNIQUE), GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ')
                  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? GROUP BY INDEX_NAME ORDER BY INDEX_NAME`,
          values: [schema, table], rowsAsArray: true,
        });
        tables.push({
          name,
          rows: found[0][0] === null ? null : Number(found[0][0]),
          indexes: (idx as unknown as [string, string | number, string][]).map(([n, nu, cols]) => ({ name: n, unique: Number(nu) === 0, columns: cols, used: plan.includes(n) })),
        });
      }
      return { plan, tables, notes: ['값을 리터럴로 넣은 계획입니다.', '행 수(TABLE_ROWS)는 InnoDB 추정값입니다.'] };
    } finally {
      await conn.query('ROLLBACK').catch(() => {});
    }
  } finally {
    await conn.end().catch(() => {});
  }
}

async function explainMssql(c: DbConnection, sql: string): Promise<Pick<ExplainResult, 'plan' | 'tables' | 'notes'>> {
  const pool = mssqlPool(c);
  await pool.connect();
  try {
    // SHOWPLAN을 켜면 질의는 실행되지 않고 계획만 돌아온다. SET은 혼자 한 배치여야 한다.
    await pool.request().batch('SET SHOWPLAN_TEXT ON');
    let plan: string;
    try {
      const res = await pool.request().query(sql);
      const sets = (res.recordsets as unknown as Record<string, unknown>[][]) ?? [];
      plan = sets.flatMap((rs) => rs.map((r) => String(r.StmtText ?? ''))).filter(Boolean).join('\n');
    } finally {
      await pool.request().batch('SET SHOWPLAN_TEXT OFF').catch(() => {});
    }
    const tables: ExplainTable[] = [];
    for (const name of tablesOf(sql)) {
      const rows = await pool.request().input('t', name).query<{ rows: number | null }>(
        `SELECT SUM(p.rows) AS rows FROM sys.partitions p WHERE p.object_id = OBJECT_ID(@t) AND p.index_id IN (0, 1)`);
      if (rows.recordset[0]?.rows === null || rows.recordset[0]?.rows === undefined) continue;
      const idx = await pool.request().input('t', name).query<{ name: string; is_unique: boolean; cols: string }>(
        `SELECT i.name, i.is_unique, STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS cols
           FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE i.object_id = OBJECT_ID(@t) AND i.name IS NOT NULL GROUP BY i.name, i.is_unique ORDER BY i.name`);
      tables.push({
        name, rows: Number(rows.recordset[0].rows),
        indexes: idx.recordset.map((i) => ({ name: i.name, unique: Boolean(i.is_unique), columns: i.cols, used: plan.includes(`[${i.name}]`) })),
      });
    }
    return { plan, tables, notes: ['SHOWPLAN_TEXT로 받은 예상 계획입니다(질의는 실행하지 않았습니다).'] };
  } finally {
    await pool.close().catch(() => {});
  }
}

/** Claude에게 돌려줄 실행 계획 글 */
export function formatExplain(r: ExplainResult): string {
  return [
    `${r.engine} · ${r.connection} · ${r.ms}ms`,
    'SQL:', r.sql,
    '실행 계획:', r.plan || '(비어 있음)',
    ...r.tables.flatMap((t) => [
      `테이블 ${t.name}: 행 ${t.rows ?? '알 수 없음'}`,
      ...(t.indexes.length ? t.indexes.map((i) => `  - ${i.name}${i.unique ? ' (UNIQUE)' : ''}: ${i.columns}${i.used ? ' · 계획에서 씀' : ''}`) : ['  - 인덱스 없음']),
    ]),
    ...r.notes.map((n) => `참고: ${n}`),
  ].join('\n');
}
