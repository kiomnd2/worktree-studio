import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { db, type ProjectRow } from './db.js';
import type { SessionView } from './sessions.js';
import { decrypt, encrypt } from './secret.js';

/**
 * DB 연결 설정. 환경값 프로필과 따로 프로젝트마다 두고, 서버를 띄울 때 env_map의 틀대로 환경변수를 만든다.
 * 예: SPRING_DATASOURCE_URL={jdbc_url}, DATABASE_URL={url}, DB_HOST={host}
 * 값이 겹치면 프로필 < DB 설정 < 이번 세션 덮어쓰기 순으로 이긴다.
 */
export type Engine = 'postgres' | 'mysql' | 'mariadb' | 'oracle' | 'mssql' | 'mongodb' | 'redis';
export const ENGINES: Engine[] = ['postgres', 'mysql', 'mariadb', 'oracle', 'mssql', 'mongodb', 'redis'];

type EngineInfo = { port: number; jdbc: string | null; url: string; sql: boolean };
export const ENGINE: Record<Engine, EngineInfo> = {
  postgres: { port: 5432, jdbc: 'jdbc:postgresql://{host}:{port}/{database}', url: 'postgresql://{username}:{password}@{host}:{port}/{database}', sql: true },
  mysql: { port: 3306, jdbc: 'jdbc:mysql://{host}:{port}/{database}', url: 'mysql://{username}:{password}@{host}:{port}/{database}', sql: true },
  mariadb: { port: 3306, jdbc: 'jdbc:mariadb://{host}:{port}/{database}', url: 'mysql://{username}:{password}@{host}:{port}/{database}', sql: true },
  // database 칸은 서비스 이름(FREEPDB1, XEPDB1 등)이다.
  oracle: { port: 1521, jdbc: 'jdbc:oracle:thin:@//{host}:{port}/{database}', url: 'oracle://{username}:{password}@{host}:{port}/{database}', sql: true },
  mssql: { port: 1433, jdbc: 'jdbc:sqlserver://{host}:{port};databaseName={database};encrypt=false', url: 'mssql://{username}:{password}@{host}:{port}/{database}', sql: true },
  mongodb: { port: 27017, jdbc: null, url: 'mongodb://{username}:{password}@{host}:{port}/{database}?authSource=admin', sql: false },
  redis: { port: 6379, jdbc: null, url: 'redis://{host}:{port}', sql: false },
};

export type DbConnection = {
  id: number; project_id: number; name: string; engine: Engine;
  host: string; port: number | null; database: string; username: string; password: string;
  env_map: Record<string, string>; enabled: boolean; note: string;
};
type Row = Omit<DbConnection, 'env_map' | 'enabled' | 'password'> & { env_map: string; enabled: number; password: string | null };

const fromRow = (r: Row): DbConnection => ({ ...r, password: decrypt(r.password), env_map: JSON.parse(r.env_map || '{}'), enabled: Boolean(r.enabled) });

export function listConnections(projectId: number): DbConnection[] {
  return (db.prepare(`SELECT * FROM db_connections WHERE project_id = ? ORDER BY enabled DESC, id`).all(projectId) as Row[]).map(fromRow);
}

/** 세션 앱들의 DB 연결. 같은 프로젝트는 한 번만 본다. */
export function sessionDbs(session: Pick<SessionView, 'worktrees'>): (DbConnection & { project_name: string })[] {
  const projects = new Map(session.worktrees.map((w) => [w.project_id, w.project_name]));
  return [...projects].flatMap(([id, name]) => listConnections(id).map((c) => ({ ...c, project_name: name })));
}

export function getConnection(id: number): DbConnection | undefined {
  const r = db.prepare(`SELECT * FROM db_connections WHERE id = ?`).get(id) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

export type ConnectionInput = Omit<DbConnection, 'id' | 'project_id'>;

export function saveConnection(projectId: number, c: ConnectionInput, id?: number): DbConnection {
  if (!c.name.trim()) throw new Error('연결 이름을 넣어 주세요.');
  const vals = [c.name.trim(), c.engine, c.host.trim() || 'localhost', c.port ?? null, c.database.trim(), c.username.trim(), c.password ? encrypt(c.password) : null, JSON.stringify(c.env_map), c.enabled ? 1 : 0, c.note ?? ''];
  if (id) {
    const cur = getConnection(id);
    if (!cur || cur.project_id !== projectId) throw new Error('이 프로젝트의 DB 연결이 아닙니다.');
    db.prepare(`UPDATE db_connections SET name = ?, engine = ?, host = ?, port = ?, database = ?, username = ?, password = ?, env_map = ?, enabled = ?, note = ? WHERE id = ?`).run(...vals, id);
  } else {
    id = Number(db.prepare(`INSERT INTO db_connections (name, engine, host, port, database, username, password, env_map, enabled, note, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, projectId).lastInsertRowid);
  }
  if (c.enabled) enableConnection(id);
  return getConnection(id)!;
}

export function deleteConnection(id: number) {
  db.prepare(`DELETE FROM db_connections WHERE id = ?`).run(id);
}

/** 같은 엔진의 다른 연결은 끈다(로컬 도커 DB와 공용 개발 DB를 번갈아 쓰는 경우). */
export function enableConnection(id: number) {
  const c = getConnection(id);
  if (!c) throw new Error('DB 연결이 없습니다.');
  db.transaction(() => {
    db.prepare(`UPDATE db_connections SET enabled = 0 WHERE project_id = ? AND engine = ? AND id != ?`).run(c.project_id, c.engine, id);
    db.prepare(`UPDATE db_connections SET enabled = 1 WHERE id = ?`).run(id);
  })();
}

/** 틀의 {host} 같은 자리를 채운다. {url} 안의 계정·비밀번호는 URL 인코딩한다. */
export function render(tpl: string, c: Pick<DbConnection, 'engine' | 'host' | 'port' | 'database' | 'username' | 'password'>): string {
  const info = ENGINE[c.engine];
  const base = { host: c.host || 'localhost', port: String(c.port ?? info.port), database: c.database, username: c.username, password: c.password };
  const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k] : m));
  let url = fill(info.url, { ...base, username: encodeURIComponent(c.username), password: encodeURIComponent(c.password) });
  // 계정이 없으면 "://:@host" 대신 "://host"
  url = url.replace('://:@', '://').replace(/:\/\/([^:@/]+):@/, '://$1@');
  return fill(tpl, { ...base, url, jdbc_url: info.jdbc ? fill(info.jdbc, base) : url });
}

export type DbEnvEntry = { key: string; value: string; secret: boolean; connection: string };

/** 켜 둔 연결들이 만드는 환경변수. 비밀번호가 들어간 값은 비밀값으로 표시한다. */
export function dbEnv(projectId: number): DbEnvEntry[] {
  const out = new Map<string, DbEnvEntry>();
  for (const c of listConnections(projectId).filter((x) => x.enabled)) {
    for (const [key, tpl] of Object.entries(c.env_map)) {
      if (!key.trim()) continue;
      const value = render(tpl, c);
      out.set(key, { key, value, secret: /\{(password|url)\}/.test(tpl) && Boolean(c.password), connection: c.name });
    }
  }
  return [...out.values()];
}

/** JVM(Spring) 앱인지. Spring은 SPRING_DATASOURCE_* 환경변수를 설정 파일보다 먼저 읽는다. */
export function isJvm(p: Pick<ProjectRow, 'local_path' | 'start_cmd'>): boolean {
  return ['build.gradle', 'build.gradle.kts', 'pom.xml'].some((f) => fs.existsSync(path.join(p.local_path, f))) || /gradlew|mvnw|bootRun/.test(p.start_cmd ?? '');
}

const FAMILY = (k: string): 'redis' | 'mongodb' | 'sql' => (/REDIS/.test(k) ? 'redis' : /MONGO/.test(k) ? 'mongodb' : 'sql');
const DB_KEY = /^(?:[A-Z0-9]+_)*?(DB|DATABASE|DATASOURCE|POSTGRES(?:QL)?|PG|MYSQL|MARIADB|ORACLE|MSSQL|MONGO(?:DB)?|REDIS)_?(URL|URI|DSN|JDBC_URL|HOST|HOSTNAME|SERVER|PORT|NAME|DATABASE|DB|SCHEMA|SID|SERVICE|SERVICE_NAME|USER|USERNAME|PASS|PASSWORD|PWD)$/;

/**
 * 연결에 쓸 기본 환경변수 틀. 앱 종류에 맞는 표준 이름에, 코드·설정에서 찾은 DB 관련 키(DB_HOST, DB_URL 등)를 더한다.
 * knownKeys는 환경값 분석에서 찾은 키(값은 jdbc 주소인지 보려고 함께 받는다).
 */
export function defaultEnvMap(p: Pick<ProjectRow, 'local_path' | 'start_cmd'>, engine: Engine, known: { key: string; value: string }[]): Record<string, string> {
  const jvm = isJvm(p);
  const family = engine === 'redis' ? 'redis' : engine === 'mongodb' ? 'mongodb' : 'sql';
  const map: Record<string, string> = {};
  if (jvm) {
    if (family === 'sql') Object.assign(map, { SPRING_DATASOURCE_URL: '{jdbc_url}', SPRING_DATASOURCE_USERNAME: '{username}', SPRING_DATASOURCE_PASSWORD: '{password}' });
    if (family === 'mongodb') map.SPRING_DATA_MONGODB_URI = '{url}';
    if (family === 'redis') Object.assign(map, { SPRING_DATA_REDIS_HOST: '{host}', SPRING_DATA_REDIS_PORT: '{port}' });
  } else {
    map[family === 'redis' ? 'REDIS_URL' : family === 'mongodb' ? 'MONGODB_URI' : 'DATABASE_URL'] = '{url}';
  }
  for (const { key, value } of known) {
    const m = DB_KEY.exec(key);
    if (!m || FAMILY(key) !== family || key in map) continue;
    const part = m[2];
    if (/URL|URI|DSN/.test(part)) map[key] = jvm || /^jdbc:/.test(value) ? (family === 'sql' ? '{jdbc_url}' : '{url}') : '{url}';
    else if (/HOST|SERVER/.test(part)) map[key] = '{host}';
    else if (part === 'PORT') map[key] = '{port}';
    else if (/NAME|DATABASE|DB|SCHEMA|SID|SERVICE/.test(part)) map[key] = '{database}';
    else if (/USER/.test(part)) map[key] = '{username}';
    else map[key] = '{password}';
  }
  return map;
}

export type ParsedDb = { engine: Engine; host: string; port: number | null; database: string; username: string; password: string };

/** jdbc:postgresql://h:5432/db, postgres://u:p@h/db 같은 주소를 나눈다. 모르는 꼴이면 null. */
export function parseDbUrl(raw: string): ParsedDb | null {
  const v = raw.trim();
  const ora = /^jdbc:oracle:thin:@(?:\/\/)?([^:/]+)(?::(\d+))?[/:]([\w.$-]+)/.exec(v);
  if (ora) return { engine: 'oracle', host: ora[1], port: ora[2] ? Number(ora[2]) : null, database: ora[3], username: '', password: '' };
  const ms = /^jdbc:sqlserver:\/\/([^:;/]+)(?::(\d+))?.*?databaseName=([^;]+)/i.exec(v);
  if (ms) return { engine: 'mssql', host: ms[1], port: ms[2] ? Number(ms[2]) : null, database: ms[3], username: '', password: '' };
  const scheme: Record<string, Engine> = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongodb: 'mongodb', redis: 'redis' };
  const m = /^(?:jdbc:)?([a-z]+)(?:\+\w+)?:\/\/(.+)$/.exec(v);
  if (!m || !scheme[m[1]]) return null;
  try {
    const u = new URL(`x://${m[2]}`);
    return {
      engine: scheme[m[1]], host: u.hostname || 'localhost', port: u.port ? Number(u.port) : null,
      database: decodeURIComponent(u.pathname.replace(/^\//, '').split('/')[0] ?? ''),
      username: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    };
  } catch { return null; }
}

/** 프로필에 이미 넣어 둔 DB 값(주소·계정)에서 연결을 짐작한다. */
export function guessFromEnv(env: Record<string, string>): ParsedDb[] {
  const out: ParsedDb[] = [];
  for (const [k, v] of Object.entries(env)) {
    const m = DB_KEY.exec(k);
    if (!m || !/URL|URI|DSN/.test(m[2])) continue;
    const p = parseDbUrl(v);
    if (!p || out.some((x) => x.engine === p.engine)) continue;
    const prefix = k.slice(0, k.length - m[2].length);
    p.username ||= env[`${prefix}USERNAME`] ?? env[`${prefix}USER`] ?? '';
    p.password ||= env[`${prefix}PASSWORD`] ?? env[`${prefix}PASS`] ?? '';
    out.push(p);
  }
  return out;
}

/** 포트가 열려 있는지만 본다(계정 확인은 하지 않는다). */
export function probe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
