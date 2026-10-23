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

async function runPostgres(c: DbConnection, sql: string, readOnly: boolean): Promise<Omit<QueryResult, 'ms'>> {
  const client = new pg.Client({
    host: hostOf(c), port: portOf(c), database: c.database || undefined, user: c.username || undefined, password: c.password || undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS + 2000,
    // 날짜는 드라이버가 Date로 바꾸지 않고 DB가 보낸 글자 그대로 보여 준다.
    types: { getTypeParser: (oid: number, format?: string) => (format === 'binary' ? pg.types.getTypeParser(oid, 'binary') : [1082, 1114, 1184].includes(oid) ? (v: string) => v : pg.types.getTypeParser(oid, 'text')) } as never,
  });
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

async function runMysql(c: DbConnection, sql: string, readOnly: boolean): Promise<Omit<QueryResult, 'ms'>> {
  const conn = mysql.createConnection({
    host: hostOf(c), port: portOf(c), database: c.database || undefined, user: c.username || undefined, password: c.password || undefined,
    connectTimeout: CONNECT_TIMEOUT_MS, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, rowsAsArray: true,
  });
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

async function runOracle(c: DbConnection, sql: string, readOnly: boolean): Promise<Omit<QueryResult, 'ms'>> {
  const conn = await oracledb.getConnection({
    user: c.username, password: c.password, connectString: `${hostOf(c)}:${portOf(c)}/${c.database}`, connectTimeout: CONNECT_TIMEOUT_MS / 1000,
  }).catch((err: Error) => {
    // Thin 모드는 Oracle 12.1부터 붙는다. 11g는 Instant Client(Thick 모드)가 있어야 해서 아직 지원하지 않는다.
    if (err.message.startsWith('NJS-138')) throw new Error('Oracle 11g 이하에는 아직 질의할 수 없습니다(Oracle 12.1 이상만 지원).');
    throw err;
  });
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

async function runMssql(c: DbConnection, sql: string, readOnly: boolean): Promise<Omit<QueryResult, 'ms'>> {
  const pool = new mssql.ConnectionPool({
    server: hostOf(c), port: portOf(c), database: c.database || undefined, user: c.username, password: c.password,
    connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: TIMEOUT_MS, pool: { max: 1 },
    options: { encrypt: false, trustServerCertificate: true, useUTC: false },
  });
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
