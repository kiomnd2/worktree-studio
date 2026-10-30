import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { broadcast } from './hub.js';
import { type MapperLocation, locateMapper, shortMapperId } from './mapperindex.js';

/**
 * 서버 로그에서 SQL을 알아보고 쿼리 모양별로 센다(쿼리 감시).
 * MyBatis(==>  Preparing:), Hibernate(Hibernate:, org.hibernate.SQL), p6spy(…|took|statement|…), log4jdbc(jdbc.sqltiming) 로그를 읽는다.
 * log4jdbc는 MyBatis와 함께 찍히면 같은 스레드의 MyBatis 쿼리에 실행 시간만 붙인다.
 * 줄이 들어올 때마다 추출·집계하고, 집계는 5초마다 SQLite에 쓴다. 파라미터가 들어간 예시 SQL은 메모리에만 둔다.
 */

export type QueryWarning = 'n+1' | 'large' | 'slow' | 'cache' | 'select-star' | 'like-prefix' | 'fn-column' | 'no-where' | 'big-offset';

export const WARNING_LABEL: Record<QueryWarning, string> = {
  'n+1': 'N+1 의심',
  large: '대량 결과',
  slow: '느림',
  cache: '캐시 후보',
  'select-star': 'SELECT *',
  'like-prefix': '앞 % LIKE',
  'fn-column': '컬럼에 함수',
  'no-where': 'WHERE 없음',
  'big-offset': '큰 OFFSET',
};

// 기준값. 처음엔 상수로 두고 쓰면서 맞춘다.
const NPLUS1_WINDOW_MS = 2000;
const NPLUS1_CALLS = 10;
const LARGE_ROWS = 1000;
const SLOW_MS = 500;
const BIG_OFFSET = 1000;
const CACHE_TOP = 5;
const MAX_SHAPES = 500;
const SAVE_EVERY_MS = 5000;
const EMIT_EVERY_MS = 1000;
/** 여러 줄 SQL(Hibernate format_sql 등)은 다음 로그 머리가 오거나 잠시 줄이 없으면 끝난 것으로 본다. */
const MULTILINE_IDLE_MS = 300;

db.exec(`
CREATE TABLE IF NOT EXISTS query_stats (
  worktree_id INTEGER NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  shape TEXT NOT NULL,
  mapper TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_max INTEGER,
  rows_n INTEGER NOT NULL DEFAULT 0,
  ms_total INTEGER NOT NULL DEFAULT 0,
  ms_max INTEGER,
  ms_n INTEGER NOT NULL DEFAULT 0,
  last_rows INTEGER,
  same_rows INTEGER NOT NULL DEFAULT 1,
  warnings TEXT NOT NULL DEFAULT '[]',
  muted INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, key)
);
`);
// 로그에 찍힌 로거 이름 그대로(logback이 줄인 i.s.d.d.r.m.R.selectList). 매퍼 XML과 맞대어 원래 매퍼를 찾는다.
if (!(db.prepare(`PRAGMA table_info(query_stats)`).all() as { name: string }[]).some((c) => c.name === 'logger')) db.exec(`ALTER TABLE query_stats ADD COLUMN logger TEXT`);

type Example = { sql: string; params: Param[]; filled: string; at: number };
export type Param = { value: string | null; type: string | null };

type Stat = {
  key: string; shape: string; mapper: string | null; logger: string | null;
  /** 매퍼 XML에서 찾은 매퍼 이름(RecDashboardMapper.selectList). undefined면 아직 안 찾음, null이면 못 찾음 */
  resolved?: string | null;
  calls: number; rowsTotal: number; rowsMax: number | null; rowsN: number;
  msTotal: number; msMax: number | null; msN: number;
  lastRows: number | null; sameRows: boolean;
  warnings: Set<QueryWarning>; muted: boolean;
  firstAt: number; lastAt: number;
  example: Example | null;
};

/** MyBatis는 Preparing, Parameters, Total이 따로 찍힌다. 스레드(없으면 로거)별로 이어 붙인다. */
type Pending = { sql: string; mapper: string | null; logger?: string | null; thread: string | null; params: Param[]; at: number; ms?: number | null };
/** skip: 계속 줄만 SQL 줄로 표시하고 버린다(log4jdbc sqlonly·resultset 표 등) */
type Multi = { kind: 'hibernate' | 'p6spy' | 'log4jdbc' | 'skip'; lines: string[]; mapper: string | null; thread: string | null; ms: number | null; at: number; timer: NodeJS.Timeout | null };

type Tracker = {
  worktreeId: number;
  sessionId: number;
  stats: Map<string, Stat>;
  pending: Map<string, Pending>;
  multi: Multi | null;
  /** N+1: (스레드, 모양)별 최근 호출 시각과 파라미터 */
  recent: Map<string, { t: number; p: string }[]>;
  /** 스레드별 마지막으로 센 MyBatis 쿼리. log4jdbc 시간이 Total 뒤에 오면 여기에 붙인다. */
  lastByThread: Map<string, { stat: Stat; at: number; timed: boolean }>;
  dirty: Set<string>;
  removed: Set<string>;
  emitTimer: NodeJS.Timeout | null;
};

const trackers = new Map<number, Tracker>();
/** 서버를 띄울 때 넣은 SQL 로그 환경값. 쿼리 탭이 비어 있을 때 보여 준다. */
export type SqlLogInfo = { enabled: boolean; packages: string[]; keys: string[]; kept: string[]; hibernate: boolean };
const sqlLogInfo = new Map<number, SqlLogInfo>();

export function setSqlLogInfo(worktreeId: number, info: SqlLogInfo) { sqlLogInfo.set(worktreeId, info); }

type Row = {
  worktree_id: number; key: string; shape: string; mapper: string | null; logger: string | null; calls: number; rows_total: number; rows_max: number | null; rows_n: number;
  ms_total: number; ms_max: number | null; ms_n: number; last_rows: number | null; same_rows: number; warnings: string; muted: number; first_at: number; last_at: number;
};

function tracker(worktreeId: number, sessionId?: number): Tracker {
  let t = trackers.get(worktreeId);
  if (!t) {
    t = { worktreeId, sessionId: sessionId ?? sessionOf(worktreeId), stats: new Map(), pending: new Map(), multi: null, recent: new Map(), lastByThread: new Map(), dirty: new Set(), removed: new Set(), emitTimer: null };
    // 도구를 다시 켜도 남도록 저장해 둔 집계를 읽는다. 예시 SQL은 없다.
    for (const r of db.prepare(`SELECT * FROM query_stats WHERE worktree_id = ?`).all(worktreeId) as Row[]) {
      t.stats.set(r.key, {
        key: r.key, shape: r.shape, mapper: r.mapper, logger: r.logger, calls: r.calls, rowsTotal: r.rows_total, rowsMax: r.rows_max, rowsN: r.rows_n,
        msTotal: r.ms_total, msMax: r.ms_max, msN: r.ms_n, lastRows: r.last_rows, sameRows: Boolean(r.same_rows),
        warnings: new Set(JSON.parse(r.warnings) as QueryWarning[]), muted: Boolean(r.muted), firstAt: r.first_at, lastAt: r.last_at, example: null,
      });
    }
    trackers.set(worktreeId, t);
  }
  if (sessionId) t.sessionId = sessionId;
  return t;
}

function sessionOf(worktreeId: number): number {
  return (db.prepare(`SELECT session_id FROM worktrees WHERE id = ?`).get(worktreeId) as { session_id: number } | undefined)?.session_id ?? 0;
}

// ---- 추출 ----

/** 로그 머리(시각으로 시작). 여러 줄 SQL이 끝났는지 보는 데 쓴다. */
const LOG_HEAD = /^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}[.,]\d{3}|\[\d{4}-\d{2}-\d{2}|(TRACE|DEBUG|INFO|WARN|ERROR)\b|Hibernate:)/;
const MYBATIS = /(==>|<==)\s+(Preparing|Parameters|Total|Updates):\s?(.*)$/;
const P6SPY = /\|\s*(?:took\s*)?(\d+)\s*(?:ms)?\s*\|\s*(statement|batch)\s*\|(.*)$/i;
const HIBERNATE_LOGGER = /\borg\.hibernate\.SQL\s*:\s?(.*)$|\bo\.h\.SQL\s*:\s?(.*)$/;
const HIBERNATE_STDOUT = /^\s*Hibernate:\s?(.*)$/;
const LOG4JDBC = /\bjdbc\.(sqltiming|sqlonly|audit|resultset|resultsettable|connection)\s*:\s?(.*)$/;
const LOG4JDBC_MS = /\{executed in (\d+) ?msec\}/;
const HIBERNATE_BIND = /binding parameter \[?\(?(\d+)[^\]]*?\]?\s*(?:as \[(\w+)\])?\s*(?:-|<-)\s*\[(.*)\]\s*$/;

/** 로그 머리에서 스레드 이름과 로거 이름(매퍼 id). Spring Boot 3은 [앱] [스레드] 두 칸이라 마지막 칸을 쓴다. */
function headOf(prefix: string): { thread: string | null; logger: string | null } {
  const brackets = [...prefix.matchAll(/\[\s*([^\]]+?)\s*\]/g)].map((m) => m[1]);
  const thread = brackets.length ? brackets[brackets.length - 1] : null;
  const after = prefix.slice(prefix.lastIndexOf(']') + 1).replace(/\s*:\s*$/, '').trim();
  const logger = after.split(/\s+/).pop() || null;
  return { thread, logger };
}

/** c.k.r.m.MemberMapper.selectList → MemberMapper.selectList */
function mapperId(logger: string | null): string | null {
  if (!logger || !/\./.test(logger)) return null;
  const parts = logger.split('.');
  return parts.slice(-2).join('.');
}

/** MyBatis 파라미터: "abc(String), 1(Integer), null" */
export function parseMybatisParams(s: string): Param[] {
  const out: Param[] = [];
  let rest = s.trim();
  while (rest) {
    if (/^null(, |$)/.test(rest)) { out.push({ value: null, type: null }); rest = rest.slice(rest.startsWith('null, ') ? 6 : 4); continue; }
    const m = rest.match(/^([\s\S]*?)\(([A-Za-z][\w.$]*)\)(?:, |$)/);
    if (!m) { out.push({ value: rest, type: null }); break; }
    out.push({ value: m[1], type: m[2] });
    rest = rest.slice(m[0].length);
  }
  return out;
}

const NUMERIC_TYPES = /^(Integer|Long|Short|Byte|BigDecimal|BigInteger|Double|Float|int|long|short|double|float|INTEGER|BIGINT|NUMERIC|DECIMAL|SMALLINT|DOUBLE|FLOAT|REAL)$/;

function literal(p: Param): string {
  if (p.value === null) return 'NULL';
  if ((p.type && NUMERIC_TYPES.test(p.type)) || (!p.type && /^-?\d+(\.\d+)?$/.test(p.value))) return p.value;
  if (p.type === 'Boolean' || p.type === 'BOOLEAN') return p.value === 'true' ? '1' : '0';
  return `'${p.value.replace(/'/g, "''")}'`;
}

/** ? 자리에 파라미터 값을 리터럴로 넣는다. 문자열 안의 ?는 건드리지 않는다. 값이 모자라면 ?를 남긴다. */
export function bindParams(sql: string, params: Param[]): string {
  let i = 0;
  return sql.replace(/'(?:[^']|'')*'|\?/g, (m) => (m === '?' && i < params.length ? literal(params[i++]) : m));
}

/**
 * 로그 한 줄을 본다. SQL 로그 줄이면 true(로그 탭의 SQL 줄 숨기기와 실패 요약에서 뺄 때 쓴다).
 * 비밀값은 이미 가려진 줄이다.
 */
export function feedQueryLog(worktreeId: number, sessionId: number, text: string, t: number): boolean {
  const tr = trackers.get(worktreeId);
  // 여러 줄 SQL을 모으는 중이면 로그 머리가 올 때까지 잇는다.
  if (tr?.multi) {
    if (!LOG_HEAD.test(text) && !MYBATIS.test(text)) {
      tr.multi.lines.push(text);
      armMulti(tr);
      return true;
    }
    finishMulti(tr);
  }
  // 글자 검사로 먼저 걸러 정규식 비용을 줄인다.
  if (!(text.includes('==>') || text.includes('<==') || text.includes('jdbc.') || text.includes('ibernate') || text.includes('o.h.SQL') || text.includes('binding parameter') || /statement|batch/i.test(text))) return false;

  const mb = text.match(MYBATIS);
  if (mb) {
    const t2 = tracker(worktreeId, sessionId);
    const prefix = text.slice(0, mb.index);
    const { thread, logger } = headOf(prefix);
    const pk = thread ?? logger ?? 'main';
    const [, , what, rest] = mb;
    if (what === 'Preparing') {
      // 앞 쿼리가 Total 없이 끝났으면(INSERT 등 Updates를 못 본 경우) 행 수 없이 센다.
      const prev = t2.pending.get(pk);
      if (prev) record(t2, prev, null, null);
      t2.pending.set(pk, { sql: rest.trim(), mapper: mapperId(logger), logger, thread, params: [], at: t });
    } else if (what === 'Parameters') {
      const p = t2.pending.get(pk);
      if (p) p.params = parseMybatisParams(rest);
    } else {
      const p = t2.pending.get(pk);
      if (p) {
        t2.pending.delete(pk);
        const n = Number.parseInt(rest.trim(), 10);
        const st = record(t2, p, Number.isFinite(n) ? n : null, p.ms ?? null);
        if (st && p.thread) t2.lastByThread.set(p.thread, { stat: st, at: t, timed: p.ms !== undefined && p.ms !== null });
      }
    }
    return true;
  }

  const lj = text.match(LOG4JDBC);
  if (lj) {
    const t2 = tracker(worktreeId, sessionId);
    const { thread } = headOf(text.slice(0, lj.index));
    // sqltiming만 SQL과 시간을 읽는다. 나머지(sqlonly, resultsettable 등)는 이어지는 줄까지 SQL 줄로 표시만 한다.
    t2.multi = { kind: lj[1] === 'sqltiming' ? 'log4jdbc' : 'skip', lines: [lj[2]], mapper: null, thread, ms: null, at: t, timer: null };
    if (LOG4JDBC_MS.test(lj[2])) finishMulti(t2);
    else armMulti(t2);
    return true;
  }

  const hb = text.match(HIBERNATE_STDOUT) ?? text.match(HIBERNATE_LOGGER);
  if (hb) {
    const t2 = tracker(worktreeId, sessionId);
    const body = (hb[1] ?? hb[2] ?? '').trim();
    // Hibernate 로그에는 매퍼 id가 없다(로거가 org.hibernate.SQL).
    const { thread } = HIBERNATE_STDOUT.test(text) ? { thread: null } : headOf(text.slice(0, hb.index));
    t2.multi = { kind: 'hibernate', lines: body ? [body] : [], mapper: null, thread, ms: null, at: t, timer: null };
    armMulti(t2);
    return true;
  }

  const bind = text.match(HIBERNATE_BIND);
  if (bind && tr) {
    // 바로 앞 Hibernate SQL의 예시에 값을 채운다. 집계는 이미 됐다.
    const last = lastHibernate.get(worktreeId);
    if (last?.example) {
      const idx = Number(bind[1]) - 1;
      last.example.params[idx] = { value: bind[3], type: bind[2] ?? null };
      last.example.filled = bindParams(last.example.sql, last.example.params);
    }
    return true;
  }

  const p6 = text.match(P6SPY);
  if (p6) {
    const t2 = tracker(worktreeId, sessionId);
    const ms = Number(p6[1]);
    const fields = p6[3].split('|').map((f) => f.trim());
    // connection·url 칸 뒤에 prepared SQL과 값이 들어간 SQL이 온다. 값이 들어간 마지막 칸을 쓴다.
    const sql = [...fields].reverse().find((f) => /^(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\b/i.test(f));
    const { thread } = headOf(text.slice(0, p6.index));
    if (sql) {
      const prepared = fields.find((f) => /^(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\b/i.test(f) && f.includes('?'));
      record(t2, { sql: prepared ?? sql, mapper: null, thread, params: [], at: t }, null, Number.isFinite(ms) ? ms : null, prepared ? sql : undefined);
    } else {
      t2.multi = { kind: 'p6spy', lines: [], mapper: null, thread, ms: Number.isFinite(ms) ? ms : null, at: t, timer: null };
      armMulti(t2);
    }
    return true;
  }
  return false;
}

const lastHibernate = new Map<number, Stat>();

function armMulti(t: Tracker) {
  if (!t.multi) return;
  if (t.multi.timer) clearTimeout(t.multi.timer);
  t.multi.timer = setTimeout(() => finishMulti(t), MULTILINE_IDLE_MS);
}

function finishMulti(t: Tracker) {
  const m = t.multi;
  if (!m) return;
  t.multi = null;
  if (m.timer) clearTimeout(m.timer);
  const lines = m.lines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  if (m.kind === 'skip') return;
  if (m.kind === 'log4jdbc') {
    const joined = lines.join('\n');
    const ms = Number(joined.match(LOG4JDBC_MS)?.[1] ?? NaN);
    const sql = joined.replace(LOG4JDBC_MS, '').replace(/^\s*\d+\.\s*/, '').trim();
    const time = Number.isFinite(ms) ? ms : null;
    // 같은 스레드의 MyBatis 쿼리가 있으면 시간만 붙인다(같은 쿼리를 두 번 세지 않는다).
    const p = m.thread ? t.pending.get(m.thread) : undefined;
    if (p) { p.ms = time; return; }
    const last = m.thread ? t.lastByThread.get(m.thread) : undefined;
    if (last && m.at - last.at < 2000) {
      if (!last.timed && time !== null) { addTime(last.stat, time); last.timed = true; t.dirty.add(last.stat.key); scheduleEmit(t); }
      return;
    }
    record(t, { sql, mapper: null, thread: m.thread, params: [], at: m.at }, null, time, sql);
    return;
  }
  if (m.kind === 'hibernate') {
    const s = record(t, { sql: lines.join(' '), mapper: m.mapper, thread: m.thread, params: [], at: m.at }, null, m.ms);
    if (s) lastHibernate.set(t.worktreeId, s);
  } else {
    // p6spy 여러 줄: prepared SQL 다음 줄에 값이 들어간 SQL이 오는 경우가 많다. 끝의 세미콜론은 뺀다.
    const stmts = lines.join('\n').split(/;\s*\n|\n(?=\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\b)/i).map((s) => s.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const prepared = stmts.find((s) => s.includes('?')) ?? stmts[0];
    const filled = stmts.find((s) => s !== prepared);
    record(t, { sql: prepared, mapper: null, thread: m.thread, params: [], at: m.at }, null, m.ms, filled);
  }
}

// ---- 모양 묶기 ----

/** 값만 다른 쿼리를 하나로 센다. 리터럴·바인드 자리는 ?, IN 목록은 IN (…), 공백·대소문자 정리. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/(?<![\w$.:])-?\d+(?:\.\d+)?(?![\w$])/g, '?')
    .replace(/(?<![\w:]):[A-Za-z_]\w*|:\d+|\$\d+/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/g, 'IN (…)')
    .replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)(?:\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))+/g, '(…)')
    .replace(/\s*;\s*$/, '');
}

const shapeKey = (shape: string) => crypto.createHash('sha1').update(shape).digest('hex').slice(0, 16);

/** SQL 모양만 보고 붙이는 경고. 모양이 처음 생길 때 정한다. */
function shapeWarnings(sql: string, shape: string): QueryWarning[] {
  const out: QueryWarning[] = [];
  if (/\bSELECT\s+(DISTINCT\s+)?(\w+\.)?\*/.test(shape)) out.push('select-star');
  if (/\bLIKE\s+(?:'%|CONCAT\s*\(\s*'%'|'%'\s*\|\|)/i.test(sql)) out.push('like-prefix');
  const where = shape.split(/\bWHERE\b/).slice(1).join(' WHERE ');
  if (where && /\b(TO_CHAR|TO_DATE|UPPER|LOWER|TRUNC|SUBSTR|SUBSTRING|NVL|COALESCE|IFNULL|ISNULL|DATE_FORMAT|CAST|REPLACE|TRIM)\s*\(\s*[A-Z_][A-Z0-9_.]*\s*(?:,[^()]*)?\)\s*(=|<>|!=|<=|>=|<|>|LIKE\b|BETWEEN\b|IN\b)/.test(where)) out.push('fn-column');
  const verb = shape.match(/^\s*(\w+)/)?.[1];
  if ((verb === 'UPDATE' || verb === 'DELETE') && !/\bWHERE\b/.test(shape)) out.push('no-where');
  if ((verb === 'SELECT' || verb === 'WITH') && /\bFROM\b/.test(shape) && !/\bWHERE\b|\bLIMIT\b|\bFETCH\s+(FIRST|NEXT)\b|\bROWNUM\b|\bTOP\b|\bGROUP BY\b/.test(shape) && !/\bFROM\s+DUAL\b/.test(shape)) out.push('no-where');
  return out;
}

function bigOffset(filled: string): boolean {
  const m = filled.match(/\bOFFSET\s+(\d+)/i) ?? filled.match(/\bLIMIT\s+(\d+)\s*,/i) ?? filled.match(/\b(?:RNUM|RN|ROWNUM)\s*>=?\s*(\d+)/i);
  return Boolean(m && Number(m[1]) > BIG_OFFSET);
}

function record(t: Tracker, p: Pending, rows: number | null, ms: number | null, filledSql?: string): Stat | null {
  const sql = p.sql.trim();
  if (!sql || !/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|CALL|\{)/i.test(sql)) return null;
  const shape = normalizeSql(sql);
  const key = shapeKey(shape);
  let s = t.stats.get(key);
  if (!s) {
    s = {
      key, shape, mapper: p.mapper, logger: p.logger ?? null, calls: 0, rowsTotal: 0, rowsMax: null, rowsN: 0, msTotal: 0, msMax: null, msN: 0,
      lastRows: null, sameRows: true, warnings: new Set(shapeWarnings(sql, shape)), muted: false, firstAt: p.at, lastAt: p.at, example: null,
    };
    t.stats.set(key, s);
    evict(t);
  }
  s.calls++;
  s.lastAt = p.at;
  if (p.mapper && !s.mapper) s.mapper = p.mapper;
  if (p.logger && !s.logger) { s.logger = p.logger; s.resolved = undefined; }
  if (rows !== null) {
    s.rowsTotal += rows;
    s.rowsN++;
    s.rowsMax = Math.max(s.rowsMax ?? 0, rows);
    if (s.lastRows !== null && s.lastRows !== rows) s.sameRows = false;
    s.lastRows = rows;
    if (rows > LARGE_ROWS) s.warnings.add('large');
  }
  if (ms !== null) addTime(s, ms);
  const filled = filledSql ?? bindParams(sql, p.params);
  s.example = { sql, params: p.params, filled, at: p.at };
  if (bigOffset(filled)) s.warnings.add('big-offset');
  if (p.params.some((x) => x.value?.startsWith('%')) && /\bLIKE\s+\?/i.test(sql)) s.warnings.add('like-prefix');
  // N+1: 같은 스레드에서 같은 모양이 짧은 시간에 여러 번, 파라미터만 바뀌어 나온다.
  if (p.thread) {
    const rk = `${p.thread}\u0000${key}`;
    const list = (t.recent.get(rk) ?? []).filter((x) => p.at - x.t <= NPLUS1_WINDOW_MS);
    list.push({ t: p.at, p: JSON.stringify(p.params) });
    t.recent.set(rk, list);
    if (list.length > NPLUS1_CALLS && new Set(list.map((x) => x.p)).size > 1) s.warnings.add('n+1');
    if (t.recent.size > 2000) t.recent.clear();
  }
  t.dirty.add(key);
  scheduleEmit(t);
  return s;
}

function addTime(s: Stat, ms: number) {
  s.msTotal += ms;
  s.msN++;
  s.msMax = Math.max(s.msMax ?? 0, ms);
  if (ms > SLOW_MS) s.warnings.add('slow');
}

/** 모양이 상한을 넘으면 마지막 시각이 오래된 것부터 지운다. */
function evict(t: Tracker) {
  if (t.stats.size <= MAX_SHAPES) return;
  const old = [...t.stats.values()].sort((a, b) => a.lastAt - b.lastAt).slice(0, t.stats.size - MAX_SHAPES);
  for (const s of old) { t.stats.delete(s.key); t.dirty.delete(s.key); t.removed.add(s.key); }
}

function scheduleEmit(t: Tracker) {
  t.emitTimer ??= setTimeout(() => {
    t.emitTimer = null;
    broadcast({ type: 'queries', sessionId: t.sessionId, worktreeId: t.worktreeId });
  }, EMIT_EVERY_MS);
}

// ---- 저장 ----

const upsert = db.prepare(`INSERT INTO query_stats (worktree_id, key, shape, mapper, logger, calls, rows_total, rows_max, rows_n, ms_total, ms_max, ms_n, last_rows, same_rows, warnings, muted, first_at, last_at)
  VALUES (@worktree_id, @key, @shape, @mapper, @logger, @calls, @rows_total, @rows_max, @rows_n, @ms_total, @ms_max, @ms_n, @last_rows, @same_rows, @warnings, @muted, @first_at, @last_at)
  ON CONFLICT (worktree_id, key) DO UPDATE SET mapper = excluded.mapper, logger = excluded.logger, calls = excluded.calls, rows_total = excluded.rows_total, rows_max = excluded.rows_max,
    rows_n = excluded.rows_n, ms_total = excluded.ms_total, ms_max = excluded.ms_max, ms_n = excluded.ms_n, last_rows = excluded.last_rows,
    same_rows = excluded.same_rows, warnings = excluded.warnings, muted = excluded.muted, last_at = excluded.last_at`);
const remove = db.prepare(`DELETE FROM query_stats WHERE worktree_id = ? AND key = ?`);

/** 바뀐 행만 한 트랜잭션으로 쓴다. */
export const saveQueryStats = db.transaction(() => {
  for (const t of trackers.values()) {
    for (const key of t.removed) remove.run(t.worktreeId, key);
    t.removed.clear();
    for (const key of t.dirty) {
      const s = t.stats.get(key);
      if (!s) continue;
      upsert.run({
        worktree_id: t.worktreeId, key, shape: s.shape, mapper: s.mapper, logger: s.logger, calls: s.calls, rows_total: s.rowsTotal, rows_max: s.rowsMax, rows_n: s.rowsN,
        ms_total: s.msTotal, ms_max: s.msMax, ms_n: s.msN, last_rows: s.lastRows, same_rows: s.sameRows ? 1 : 0,
        warnings: JSON.stringify([...s.warnings]), muted: s.muted ? 1 : 0, first_at: s.firstAt, last_at: s.lastAt,
      });
    }
    t.dirty.clear();
  }
});
setInterval(() => { try { saveQueryStats(); } catch { /* 다음 주기에 다시 쓴다 */ } }, SAVE_EVERY_MS).unref();

// ---- 조회 ----

export type QueryStatView = {
  key: string; shape: string; mapper: string | null; calls: number;
  rows_avg: number | null; rows_max: number | null; ms_avg: number | null; ms_max: number | null;
  warnings: QueryWarning[]; muted: boolean; first_at: number; last_at: number; has_example: boolean;
};
export type QuerySort = 'calls' | 'rows' | 'time' | 'recent';

/** 잦은 호출 경고는 측정 구간 전체를 봐야 해서 조회할 때 붙인다. 숨긴 모양은 경고를 비운다. */
function views(t: Tracker): QueryStatView[] {
  const all = [...t.stats.values()];
  const dir = worktreeDir(t.worktreeId);
  for (const s of all) {
    // 예전에 저장한 집계는 로거 이름이 없어 줄인 매퍼 이름(R.selectList)으로 찾는다.
    const name = s.logger ?? s.mapper;
    if (s.resolved !== undefined || !name || !dir) continue;
    try { s.resolved = shortMapperId(dir, name, s.example?.sql ?? s.shape); } catch { s.resolved = null; }
  }
  const cache = new Set(all.filter((s) => s.calls >= 3 && s.rowsN > 0).sort((a, b) => b.calls - a.calls).slice(0, CACHE_TOP).filter((s) => s.sameRows).map((s) => s.key));
  return all.map((s) => ({
    key: s.key, shape: s.shape, mapper: s.resolved ?? s.mapper, calls: s.calls,
    rows_avg: s.rowsN ? Math.round(s.rowsTotal / s.rowsN) : null, rows_max: s.rowsMax,
    ms_avg: s.msN ? Math.round(s.msTotal / s.msN) : null, ms_max: s.msMax,
    warnings: s.muted ? [] : [...s.warnings, ...(cache.has(s.key) ? ['cache' as const] : [])],
    muted: s.muted, first_at: s.firstAt, last_at: s.lastAt, has_example: Boolean(s.example),
  }));
}

export function listQueries(worktreeId: number, opts: { sort?: QuerySort; warningsOnly?: boolean } = {}): QueryStatView[] {
  const list = views(tracker(worktreeId)).filter((v) => !opts.warningsOnly || v.warnings.length);
  const by: Record<QuerySort, (v: QueryStatView) => number> = {
    calls: (v) => v.calls,
    rows: (v) => v.rows_max ?? -1,
    time: (v) => v.ms_max ?? -1,
    recent: (v) => v.last_at,
  };
  const f = by[opts.sort ?? 'calls'];
  return list.sort((a, b) => f(b) - f(a) || b.last_at - a.last_at);
}

/** location: 매퍼 XML 위치와 그 매퍼 메서드를 부르는 곳. logger: 로그에 찍힌 로거 이름 그대로 */
export type QueryDetail = QueryStatView & { example: Example | null; logger: string | null; location: MapperLocation | null };

export function getQuery(worktreeId: number, key: string): QueryDetail | null {
  const t = tracker(worktreeId);
  const s = t.stats.get(key);
  if (!s) return null;
  const dir = worktreeDir(worktreeId);
  let location: MapperLocation | null = null;
  const name = s.logger ?? s.mapper;
  if (dir && name) { try { location = locateMapper(dir, name, s.example?.sql ?? s.shape); } catch { /* 위치 없이 보여 준다 */ } }
  return { ...views(t).find((v) => v.key === key)!, example: s.example, logger: s.logger, location };
}

/** 매퍼 XML을 찾을 폴더. 멀티 모듈이면 매퍼가 다른 모듈에 있을 수 있어 워크트리 전체를 본다. */
function worktreeDir(worktreeId: number): string | null {
  return (db.prepare(`SELECT path FROM worktrees WHERE id = ?`).get(worktreeId) as { path: string } | undefined)?.path ?? null;
}

export function getSqlLogInfo(worktreeId: number): SqlLogInfo | null { return sqlLogInfo.get(worktreeId) ?? null; }

/** 초기화: 집계를 비우고 화면 하나만 잰다. */
export function resetQueries(worktreeId: number) {
  const t = tracker(worktreeId);
  t.stats.clear(); t.pending.clear(); t.recent.clear(); t.dirty.clear(); t.removed.clear();
  lastHibernate.delete(worktreeId);
  db.prepare(`DELETE FROM query_stats WHERE worktree_id = ?`).run(worktreeId);
  broadcast({ type: 'queries', sessionId: t.sessionId, worktreeId });
}

/** 의도한 반복 조회처럼 경고가 맞지 않는 모양은 경고를 숨긴다. */
export function muteQuery(worktreeId: number, key: string, muted: boolean) {
  const t = tracker(worktreeId);
  const s = t.stats.get(key);
  if (!s) throw new Error('쿼리가 없습니다. 초기화됐을 수 있습니다.');
  s.muted = muted;
  t.dirty.add(key);
  broadcast({ type: 'queries', sessionId: t.sessionId, worktreeId });
}

/** 워크트리를 정리할 때 집계도 지운다. */
export function dropQueryStats(worktreeIds: number[]) {
  for (const id of worktreeIds) {
    trackers.delete(id);
    sqlLogInfo.delete(id);
    lastHibernate.delete(id);
    db.prepare(`DELETE FROM query_stats WHERE worktree_id = ?`).run(id);
  }
}

// ---- 매퍼 로그 켜기 ----

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'target', 'out', 'bin', '.gradle', '.idea', 'dist', 'test']);

/**
 * SQL 로그를 켤 패키지를 찾는다. 매퍼 XML의 namespace와 @MapperScan 값에서 패키지를 뽑는다.
 * Spring 환경변수 이름(LOGGING_LEVEL_COM_EXAMPLE_MAPPER)으로 바꿀 수 있는 패키지만 쓴다.
 */
export function findMapperPackages(dir: string): { packages: string[]; hibernate: boolean } {
  const pkgs = new Set<string>();
  let files = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 14 || files > 20000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1); continue; }
      files++;
      const isXml = e.name.endsWith('.xml');
      if (!isXml && !e.name.endsWith('.java') && !e.name.endsWith('.kt')) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(d, e.name), 'utf8'); } catch { continue; }
      if (isXml) {
        const m = text.match(/<mapper\s+namespace\s*=\s*"([\w.]+)\.[A-Z]\w*"/);
        if (m) pkgs.add(m[1]);
      } else if (text.includes('@MapperScan')) {
        const ann = text.match(/@MapperScan\s*\(([\s\S]*?)\)\s*(?:\n|public|class|@)/)?.[1] ?? '';
        for (const m of ann.matchAll(/"([\w.]+)"/g)) pkgs.add(m[1]);
      }
    }
  };
  walk(dir, 0);
  const build = ['build.gradle', 'build.gradle.kts', 'pom.xml'].map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } }).join('\n');
  const hibernate = /data-jpa|hibernate/i.test(build);
  // 하위 패키지는 상위 패키지 설정에 포함되므로 뺀다. 대문자·밑줄이 든 패키지는 환경변수 이름으로 못 바꾼다.
  const valid = [...pkgs].filter((p) => /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(p)).sort();
  const packages = valid.filter((p) => !valid.some((q) => q !== p && p.startsWith(`${q}.`))).slice(0, 50);
  return { packages, hibernate };
}

export const levelKey = (pkg: string) => `LOGGING_LEVEL_${pkg.toUpperCase().replace(/\./g, '_')}`;
