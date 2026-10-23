import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import { db, type ProjectRow } from './db.js';
import { git } from './git.js';
import { findFreePort, isPortFree } from './ports.js';
import { ENGINE, type Engine, defaultEnvMap, listConnections, saveConnection } from './dbconn.js';

/**
 * 새 워크트리에서 서버가 바로 뜨게 로컬 실행 환경을 맞춘다.
 *  - 클론에만 있는(커밋하지 않은) 로컬 설정 파일(.env, application-local.yml, .npmrc 등)을 워크트리로 복사
 *  - DB·Redis 같은 인프라를 docker compose로 띄움(저장소의 compose 파일, 없으면 Studio가 만든 파일)
 * 무엇을 할지는 서버 실행 창에 먼저 보여 주고, 사용자가 실행을 눌러야 한다.
 */

const execFileP = promisify(execFile);

export type DockerStack = { file: string; services: string[] };
export type ComposeService = { name: string; image: string | null; infra: Engine | 'other' | null; ports: { host: number; container: number }[]; env: Record<string, string> };

// ---------- docker 실행 파일 ----------

/** 맥 앱으로 띄우면 PATH에 /usr/local/bin이 없을 수 있어 알려진 위치도 본다. */
const DOCKER_PATHS = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', path.join(process.env.HOME ?? '', '.docker/bin/docker'), '/Applications/Docker.app/Contents/Resources/bin/docker'];
let dockerPath: string | null | undefined;

export async function dockerBin(): Promise<string | null> {
  if (dockerPath !== undefined) return dockerPath;
  try {
    await execFileP('docker', ['--version'], { timeout: 5000 });
    dockerPath = 'docker';
  } catch {
    dockerPath = DOCKER_PATHS.find((p) => fs.existsSync(p)) ?? null;
  }
  return dockerPath;
}

export type DockerState = 'ok' | 'no-cli' | 'daemon-down';

export async function dockerState(): Promise<DockerState> {
  const bin = await dockerBin();
  if (!bin) return 'no-cli';
  try { await execFileP(bin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 8000 }); return 'ok'; } catch { return 'daemon-down'; }
}

/** Docker Desktop을 켠다(맥). 데몬이 뜨는 데 수십 초 걸린다. */
export function openDockerDesktop() {
  if (process.platform !== 'darwin') throw new Error('Docker를 직접 켜 주세요.');
  spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' }).unref();
}

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

// ---------- compose ----------

const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const COMPOSE_RE = /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/;
const SKIP = new Set(['node_modules', '.git', 'build', 'dist', 'target', '.gradle', '.next', 'out', 'vendor', '.venv', 'venv']);

/** 저장소 안의 compose 파일(깊이 3까지). 로컬용 이름(local, dev)을 앞에 둔다. */
export function findComposeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && depth < 3 && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && COMPOSE_RE.test(e.name)) out.push(path.relative(root, path.join(dir, e.name)));
    }
  };
  walk(root, 0);
  const rank = (f: string) => (/local|dev/i.test(f) ? 0 : COMPOSE_NAMES.includes(path.basename(f)) ? 1 : /prod|ci|test/i.test(f) ? 3 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
}

const INFRA: [RegExp, Engine | 'other'][] = [
  [/(^|\/)(postgres|postgis|timescale)/, 'postgres'], [/(^|\/)mysql/, 'mysql'], [/(^|\/)mariadb/, 'mariadb'],
  [/oracle|gvenzl/, 'oracle'], [/mssql|sql-server|azure-sql-edge/, 'mssql'], [/(^|\/)mongo/, 'mongodb'], [/(^|\/)(redis|valkey)/, 'redis'],
  [/kafka|zookeeper|rabbitmq|localstack|minio|elasticsearch|opensearch|mailhog|mailpit|keycloak|wiremock|nats|memcached/, 'other'],
];

/** docker compose config로 서비스를 읽는다(변수 치환·여러 파일 병합을 compose가 해 준다). docker가 없으면 이미지 줄만 훑는다. */
export async function readCompose(file: string): Promise<ComposeService[]> {
  const bin = await dockerBin();
  if (bin) {
    try {
      const { stdout } = await execFileP(bin, ['compose', '-f', file, 'config', '--format', 'json'], { cwd: path.dirname(file), timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      const cfg = JSON.parse(stdout) as { services?: Record<string, { image?: string; ports?: { published?: string | number; target?: number }[]; environment?: Record<string, string | null> }> };
      return Object.entries(cfg.services ?? {}).map(([name, s]) => service(name, s.image ?? null,
        (s.ports ?? []).flatMap((p) => (p.published && p.target ? [{ host: Number(p.published), container: p.target }] : [])),
        Object.fromEntries(Object.entries(s.environment ?? {}).map(([k, v]) => [k, v ?? '']))));
    } catch { /* 아래 간단한 읽기로 */ }
  }
  return roughCompose(fs.readFileSync(file, 'utf8'));
}

function service(name: string, image: string | null, ports: ComposeService['ports'], env: Record<string, string>): ComposeService {
  const hay = `${image ?? ''} ${name}`.toLowerCase();
  const infra = image ? INFRA.find(([re]) => re.test(hay))?.[1] ?? null : null;
  return { name, image, infra, ports, env };
}

/** YAML 파서 없이 services 아래 이름·image·ports만 읽는다. docker CLI가 없을 때 무엇이 필요한지 알리는 용도. */
function roughCompose(text: string): ComposeService[] {
  const out: ComposeService[] = [];
  let inServices = false;
  let cur: { name: string; image: string | null; ports: ComposeService['ports']; env: Record<string, string> } | null = null;
  let indent = -1;
  for (const line of text.split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = false; continue; }
    if (!inServices) continue;
    const m = /^(\s+)([\w.-]+):\s*$/.exec(line);
    if (m && (indent < 0 || m[1].length === indent)) {
      indent = m[1].length;
      if (cur) out.push(service(cur.name, cur.image, cur.ports, cur.env));
      cur = { name: m[2], image: null, ports: [], env: {} };
      continue;
    }
    if (!cur) continue;
    const img = /^\s+image:\s*["']?([^"'\s]+)/.exec(line);
    if (img) cur.image = img[1];
    const port = /^\s+-\s*["']?(?:[\d.]+:)?(\d+):(\d+)/.exec(line);
    if (port) cur.ports.push({ host: Number(port[1]), container: Number(port[2]) });
    const env = /^\s+(?:-\s*)?([A-Z_][A-Z0-9_]*)\s*[:=]\s*["']?([^"'\s#]*)/.exec(line);
    if (env) cur.env[env[1]] = env[2];
  }
  if (cur) out.push(service(cur.name, cur.image, cur.ports, cur.env));
  return out;
}

export function stackPath(p: Pick<ProjectRow, 'repo_root'>, file: string) {
  return path.isAbsolute(file) ? file : path.join(p.repo_root, file);
}

/** Studio가 만든 compose 파일은 프로젝트 이름을 고정해 두었다. 저장소 파일은 클론 폴더 이름(사람이 직접 띄울 때와 같은 컨테이너)을 쓴다. */
export function upCommand(bin: string, p: Pick<ProjectRow, 'repo_root'>, stack: DockerStack): string {
  const abs = stackPath(p, stack.file);
  return `${q(bin)} compose -f ${q(abs)} --project-directory ${q(path.dirname(abs))} up -d --wait ${stack.services.map(q).join(' ')}`.trim();
}

// ---------- Studio가 만드는 로컬 DB ----------

const STUDIO_IMAGE: Partial<Record<Engine, { image: string; data: string; env: (db: string) => Record<string, string>; health: string[]; database: (db: string) => string; user: string }>> = {
  postgres: { image: 'postgres:16-alpine', data: '/var/lib/postgresql/data', env: (d) => ({ POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'app', POSTGRES_DB: d }), health: ['CMD-SHELL', 'pg_isready -U app'], database: (d) => d, user: 'app' },
  mysql: { image: 'mysql:8.4', data: '/var/lib/mysql', env: (d) => ({ MYSQL_ROOT_PASSWORD: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'app', MYSQL_DATABASE: d }), health: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '-uroot', '-papp'], database: (d) => d, user: 'app' },
  mariadb: { image: 'mariadb:11', data: '/var/lib/mysql', env: (d) => ({ MARIADB_ROOT_PASSWORD: 'app', MARIADB_USER: 'app', MARIADB_PASSWORD: 'app', MARIADB_DATABASE: d }), health: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], database: (d) => d, user: 'app' },
  oracle: { image: 'gvenzl/oracle-free:23-slim-faststart', data: '/opt/oracle/oradata', env: () => ({ ORACLE_PASSWORD: 'app', APP_USER: 'app', APP_USER_PASSWORD: 'app' }), health: ['CMD', 'healthcheck.sh'], database: () => 'FREEPDB1', user: 'app' },
  mongodb: { image: 'mongo:7', data: '/data/db', env: (d) => ({ MONGO_INITDB_ROOT_USERNAME: 'app', MONGO_INITDB_ROOT_PASSWORD: 'app', MONGO_INITDB_DATABASE: d }), health: ['CMD', 'mongosh', '--quiet', '--eval', "db.adminCommand('ping')"], database: (d) => d, user: 'app' },
  redis: { image: 'redis:7-alpine', data: '/data', env: () => ({}), health: ['CMD', 'redis-cli', 'ping'], database: () => '', user: '' },
};
export const STUDIO_ENGINES = Object.keys(STUDIO_IMAGE) as Engine[];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';

/** 저장된 compose 포트를 다른 프로젝트·프로그램이 쓰고 있으면 비켜 간다. */
async function studioPort(engine: Engine): Promise<number> {
  const def = ENGINE[engine].port;
  const used = new Set((db.prepare(`SELECT port FROM db_connections WHERE port IS NOT NULL`).all() as { port: number }[]).map((r) => r.port));
  if (!used.has(def) && (await isPortFree(def))) return def;
  return findFreePort(def + 10000 > 65000 ? def + 1 : def + 10000, used);
}

/**
 * Studio 데이터 폴더에 이 프로젝트 전용 로컬 DB compose 파일을 만들고, DB 연결과 실행 전 도커 목록에 넣는다.
 * 저장소에는 아무것도 쓰지 않는다. 계정은 로컬 전용(app/app)이다.
 */
export async function createStudioDb(p: ProjectRow, engine: Engine, knownKeys: { key: string; value: string }[]) {
  const spec = STUDIO_IMAGE[engine];
  if (!spec) throw new Error(`${engine}는 Studio가 만드는 로컬 DB로 지원하지 않습니다.`);
  const name = `${slug(p.name)}-${engine}`;
  const dir = path.join(DATA_DIR, 'docker', name);
  fs.mkdirSync(dir, { recursive: true });
  const dbName = slug(path.basename(p.repo_root)).replace(/-/g, '_');
  const port = await studioPort(engine);
  const container = ENGINE[engine].port;
  const env = spec.env(dbName);
  const yaml = [
    `# Worktree Studio가 만든 로컬 ${engine} (프로젝트 ${p.name}). 로컬 개발 전용 계정이다.`,
    `name: wts-${name}`,
    'services:',
    `  ${engine}:`,
    `    image: ${spec.image}`,
    '    restart: unless-stopped',
    '    ports:',
    `      - "127.0.0.1:${port}:${container}"`,
    ...(Object.keys(env).length ? ['    environment:', ...Object.entries(env).map(([k, v]) => `      ${k}: "${v}"`)] : []),
    '    volumes:',
    `      - data:${spec.data}`,
    '    healthcheck:',
    `      test: ${JSON.stringify(spec.health)}`,
    '      interval: 3s',
    '      timeout: 5s',
    '      retries: 100',
    'volumes:',
    '  data: {}',
    '',
  ].join('\n');
  const file = path.join(dir, 'compose.yaml');
  fs.writeFileSync(file, yaml);
  addStack(p, { file, services: [engine] });
  return saveConnection(p.id, {
    name: `로컬 도커 ${engine}`, engine, host: 'localhost', port, database: spec.database(dbName), username: spec.user, password: spec.user ? 'app' : '',
    env_map: defaultEnvMap(p, engine, knownKeys), enabled: true, note: `Studio가 만든 도커 DB (${file})`,
  });
}

// ---------- 프로젝트 설정 ----------

export function stacksOf(p: Pick<ProjectRow, 'docker_stacks'>): DockerStack[] {
  try { return (JSON.parse(p.docker_stacks || '[]') as DockerStack[]).filter((s) => s.file && s.services?.length); } catch { return []; }
}

export function setStacks(projectId: number, stacks: DockerStack[]) {
  db.prepare(`UPDATE projects SET docker_stacks = ? WHERE id = ?`).run(JSON.stringify(stacks.filter((s) => s.file && s.services.length)), projectId);
}

function addStack(p: ProjectRow, stack: DockerStack) {
  const list = stacksOf(p).filter((s) => s.file !== stack.file);
  setStacks(p.id, [...list, stack]);
}

export function setCopyFiles(projectId: number, files: string[] | null) {
  db.prepare(`UPDATE projects SET copy_files = ? WHERE id = ?`).run(files === null ? null : JSON.stringify(files), projectId);
}

// ---------- 클론에서 복사할 로컬 파일 ----------

/** 커밋하지 않는 로컬 설정 파일. 예시 파일(.env.example)은 커밋돼 있어 대상이 아니다. */
const LOCAL_FILE = [
  /^\.env(\.[\w-]+)?$/,
  /^application(-[\w-]+)?\.(ya?ml|properties)$/,
  /^bootstrap(-[\w-]+)?\.(ya?ml|properties)$/,
  /\.local\.(json|ya?ml|properties|js|cjs|mjs|ts|toml)$/,
  /^(local|dev)\.(json|ya?ml|properties|toml)$/,
  /^\.npmrc$|^\.yarnrc\.yml$/,
  /^gradle\.properties$/,
  /^\.dev\.vars$/,
];
const NOT_LOCAL = /\.(example|sample|template|dist)$/;

/** 클론에서 git이 무시하는(커밋되지 않는) 파일 중 로컬 설정으로 보이는 것. 저장소 루트 기준 경로. */
export async function detectCopyFiles(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory']).catch(() => '');
  return out.split('\n').map((l) => l.trim()).filter((f) => f && !f.endsWith('/'))
    .filter((f) => !f.split('/').some((seg) => SKIP.has(seg) || seg === '.idea' || seg === '.vscode'))
    .filter((f) => LOCAL_FILE.some((re) => re.test(path.basename(f))) && !NOT_LOCAL.test(f))
    .filter((f) => { try { return fs.statSync(path.join(repoRoot, f)).size < 256 * 1024; } catch { return false; } })
    .slice(0, 40);
}

export async function copyFilesOf(p: ProjectRow): Promise<string[]> {
  if (p.copy_files !== null) { try { return JSON.parse(p.copy_files) as string[]; } catch { return []; } }
  return detectCopyFiles(p.repo_root);
}

/** 워크트리에 없는 파일만 복사한다(워크트리에서 고친 파일을 덮지 않는다). */
export function pendingCopies(repoRoot: string, worktree: string, files: string[]): string[] {
  return files.filter((f) => fs.existsSync(path.join(repoRoot, f)) && !fs.existsSync(path.join(worktree, f)));
}

export function copyIntoWorktree(repoRoot: string, worktree: string, files: string[]): string[] {
  const done: string[] = [];
  for (const f of pendingCopies(repoRoot, worktree, files)) {
    const dest = path.join(worktree, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, f), dest);
    done.push(f);
  }
  return done;
}

// ---------- 찾기(설정 화면) ----------

export type DbCandidate = { from: string; engine: Engine; host: string; port: number; database: string; username: string; password: string; stack: DockerStack | null };

/** compose 서비스의 환경값에서 로컬 DB 계정을 읽는다. */
function candidateFrom(file: string, s: ComposeService): DbCandidate | null {
  if (!s.infra || s.infra === 'other') return null;
  const e = s.env;
  const engine = s.infra;
  const cport = ENGINE[engine].port;
  const host = s.ports.find((x) => x.container === cport)?.host ?? s.ports[0]?.host;
  if (!host) return null;
  const pick = (...keys: string[]) => keys.map((k) => e[k]).find((v) => v) ?? '';
  const byEngine: Record<Engine, () => Omit<DbCandidate, 'from' | 'engine' | 'host' | 'port' | 'stack'>> = {
    postgres: () => ({ database: pick('POSTGRES_DB', 'POSTGRES_USER') || 'postgres', username: pick('POSTGRES_USER') || 'postgres', password: pick('POSTGRES_PASSWORD') }),
    mysql: () => ({ database: pick('MYSQL_DATABASE'), username: pick('MYSQL_USER') || 'root', password: pick('MYSQL_USER') ? pick('MYSQL_PASSWORD') : pick('MYSQL_ROOT_PASSWORD') }),
    mariadb: () => ({ database: pick('MARIADB_DATABASE', 'MYSQL_DATABASE'), username: pick('MARIADB_USER', 'MYSQL_USER') || 'root', password: pick('MARIADB_USER', 'MYSQL_USER') ? pick('MARIADB_PASSWORD', 'MYSQL_PASSWORD') : pick('MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD') }),
    oracle: () => ({ database: pick('ORACLE_DATABASE') || 'FREEPDB1', username: pick('APP_USER') || 'system', password: pick('APP_USER') ? pick('APP_USER_PASSWORD') : pick('ORACLE_PASSWORD', 'ORACLE_PWD') }),
    mssql: () => ({ database: 'master', username: 'sa', password: pick('MSSQL_SA_PASSWORD', 'SA_PASSWORD') }),
    mongodb: () => ({ database: pick('MONGO_INITDB_DATABASE') || 'admin', username: pick('MONGO_INITDB_ROOT_USERNAME'), password: pick('MONGO_INITDB_ROOT_PASSWORD') }),
    redis: () => ({ database: '', username: '', password: '' }),
  };
  return { from: `${file} · ${s.name}`, engine, host: 'localhost', port: host, ...byEngine[engine](), stack: { file, services: [s.name] } };
}

/** 의존성에 DB 드라이버가 있으면 그 엔진. DB가 필요한지 알리는 데 쓴다. */
export function neededEngines(p: Pick<ProjectRow, 'local_path' | 'repo_root'>): Engine[] {
  const files = ['build.gradle', 'build.gradle.kts', 'pom.xml', 'package.json', 'pyproject.toml', 'requirements.txt', 'gradle/libs.versions.toml']
    .flatMap((f) => [path.join(p.local_path, f), path.join(p.repo_root, f)])
    .map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  const found = new Set<Engine>();
  if (/postgresql|"pg"|psycopg|asyncpg|r2dbc-postgres/.test(files)) found.add('postgres');
  if (/mysql-connector|mysql2|pymysql|mysqlclient|"mysql"/.test(files)) found.add('mysql');
  if (/mariadb/.test(files)) found.add('mariadb');
  if (/ojdbc|oracledb|cx_oracle|cx-oracle/i.test(files)) found.add('oracle');
  if (/mssql-jdbc|"mssql"|tedious|pyodbc/.test(files)) found.add('mssql');
  if (/mongodb|mongoose|pymongo|motor/.test(files)) found.add('mongodb');
  if (/redis|lettuce|jedis|ioredis|valkey/.test(files)) found.add('redis');
  return [...found];
}

export type LocalSetup = {
  copy_files: { auto: boolean; files: string[]; detected: string[] };
  stacks: DockerStack[];
  compose: { file: string; services: ComposeService[] }[];
  candidates: DbCandidate[];
  needs: Engine[];
  docker: DockerState;
};

/** 설정 화면에 보여 줄 지금 설정과 찾은 것. */
export async function localSetup(p: ProjectRow): Promise<LocalSetup> {
  const [detected, docker] = await Promise.all([detectCopyFiles(p.repo_root), dockerState()]);
  const files = findComposeFiles(p.repo_root).slice(0, 6);
  const compose = await Promise.all(files.map(async (file) => ({ file, services: await readCompose(path.join(p.repo_root, file)).catch(() => []) })));
  const conns = listConnections(p.id);
  const candidates = compose.flatMap((c) => c.services.map((s) => candidateFrom(c.file, s)).filter((x): x is DbCandidate => x !== null))
    // 이미 같은 엔진·포트로 만든 연결은 다시 권하지 않는다.
    .filter((c) => !conns.some((x) => x.engine === c.engine && x.port === c.port));
  return {
    copy_files: { auto: p.copy_files === null, files: await copyFilesOf(p), detected },
    stacks: stacksOf(p),
    compose: compose.filter((c) => c.services.length),
    candidates,
    needs: neededEngines(p),
    docker,
  };
}
