import { spawn, type ChildProcess } from 'node:child_process';
import { db } from './db.js';
import { broadcast, type LogLine } from './hub.js';
import { getProject } from './projects.js';
import { getSession, type SessionView } from './sessions.js';
import { missingRequired, resolveEnv } from './envstore.js';
import { findFreePort } from './ports.js';
import { maskSecrets } from './secret.js';
import { getSettings } from './settings.js';
import { sendNotification } from './notify.js';

export type ServerStatus = 'starting' | 'running' | 'unhealthy' | 'failed' | 'stopped';

type Running = {
  worktreeId: number;
  sessionId: number;
  projectId: number;
  port: number;
  child: ChildProcess;
  status: ServerStatus;
  stopping: boolean;
  exitCode: number | null;
  startedAt: number;
  logs: LogLine[];
  seq: number;
  pending: LogLine[];
  flushTimer: NodeJS.Timeout | null;
  healthTimer: NodeJS.Timeout | null;
  secrets: string[];
};

const MAX_LOG_LINES = 3000;
const HEALTH_TIMEOUT_MS = 5 * 60 * 1000;
/** 처음 실행은 의존성 설치까지 하므로 더 기다린다. */
const SETUP_HEALTH_TIMEOUT_MS = 15 * 60 * 1000;
const servers = new Map<number, Running>();
// 서버가 꺼진 뒤에도 마지막 로그와 상태를 볼 수 있게 남겨 둔다.
const lastRun = new Map<number, { status: ServerStatus; exitCode: number | null; port: number; logs: LogLine[] }>();

export type ServerView = {
  worktree_id: number;
  project_id: number;
  project_name: string;
  project_kind: string;
  status: ServerStatus | 'idle';
  port: number | null;
  url: string | null;
  exit_code: number | null;
  started_at: number | null;
  can_start: boolean;
  start_cmd: string | null;
  cwd: string;
  health_path: string;
  /** 이 워크트리에서 아직 설치를 안 했으면 실행 전에 돌릴 설치 명령 */
  setup_pending: string | null;
};

export function listServers(session: SessionView): ServerView[] {
  return session.worktrees.map((w) => {
    const r = servers.get(w.id);
    const last = lastRun.get(w.id);
    const project = getProject(w.project_id);
    const port = r?.port ?? last?.port ?? null;
    const status = r?.status ?? last?.status ?? 'idle';
    return {
      worktree_id: w.id,
      project_id: w.project_id,
      project_name: w.project_name,
      project_kind: w.project_kind,
      status,
      port,
      url: port && r ? `http://localhost:${port}` : null,
      exit_code: r?.exitCode ?? last?.exitCode ?? null,
      started_at: r?.startedAt ?? null,
      can_start: Boolean(project?.start_cmd),
      start_cmd: project?.start_cmd ?? null,
      cwd: w.path,
      health_path: project?.health_path || '/',
      setup_pending: project?.setup_cmd && !w.setup_done ? project.setup_cmd : null,
    };
  });
}

export function serverPorts(sessionId: number): { project_name: string; kind: string; port: number; status: ServerStatus }[] {
  const s = getSession(sessionId);
  if (!s) return [];
  return s.worktrees.flatMap((w) => {
    const r = servers.get(w.id);
    return r ? [{ project_name: w.project_name, kind: w.project_kind, port: r.port, status: r.status }] : [];
  });
}

export function getLogs(worktreeId: number): LogLine[] {
  return servers.get(worktreeId)?.logs ?? lastRun.get(worktreeId)?.logs ?? [];
}

/**
 * 로그 줄의 수준. Spring·Python 로거는 ERROR/WARN 같은 단어를 찍지만,
 * npm·Next·Vite·tsc는 기호나 고유 문구로 오류를 알려서 따로 잡는다.
 */
const ERROR_PATTERNS = [
  /\b(ERROR|FATAL|SEVERE|CRITICAL)\b/, // Spring, Python logging, Vite "✘ [ERROR]"
  /Exception\b|Traceback \(most recent call last\)/, // Java, Python
  /\b\w*Error:/, // Error:, TypeError:, SyntaxError:, ModuleNotFoundError: ...
  /^\s*npm (ERR!|error)\b/, // npm 6 / npm 7+
  /\bELIFECYCLE\b|ERR_PNPM_|^\s*error Command failed/, // npm·pnpm·yarn 스크립트 실패
  /^\s*⨯/, // Next.js 오류 표시
  /Failed to compile|Module not found|Can't resolve '|Cannot find module|Unhandled Runtime Error|Build failed|Internal server error/i,
  /\berror TS\d+|\berror\s{2,}/, // tsc "error TS2322", eslint "  12:3  error  ..."
];
const WARN_PATTERNS = [
  /\bWARN(ING)?\b|\bWarning:/,
  /^\s*npm WARN|^\s*npm warn\b/,
  /^\s*⚠/, // Next.js 경고
  /\bwarning\s{2,}|\bDeprecationWarning\b/, // eslint, Node
];

export function levelOf(text: string): LogLine['level'] {
  if (ERROR_PATTERNS.some((re) => re.test(text))) return 'error';
  if (WARN_PATTERNS.some((re) => re.test(text))) return 'warn';
  return 'info';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function pushLine(r: Running, stream: LogLine['stream'], raw: string) {
  const text = maskSecrets(raw.replace(ANSI, '').replace(/\r$/, ''), r.secrets);
  const line: LogLine = { seq: ++r.seq, t: Date.now(), stream, level: stream === 'sys' ? 'info' : levelOf(text), text };
  r.logs.push(line);
  if (r.logs.length > MAX_LOG_LINES) r.logs.splice(0, r.logs.length - MAX_LOG_LINES);
  r.pending.push(line);
  r.flushTimer ??= setTimeout(() => {
    r.flushTimer = null;
    const lines = r.pending.splice(0);
    if (lines.length) broadcast({ type: 'log', sessionId: r.sessionId, worktreeId: r.worktreeId, lines });
  }, 150);
}

function attachStream(r: Running, stream: NodeJS.ReadableStream | null, kind: 'out' | 'err') {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) pushLine(r, kind, p);
    if (buf.length > 8000) { pushLine(r, kind, buf); buf = ''; }
  });
  stream.on('end', () => { if (buf) pushLine(r, kind, buf); });
}

function setStatus(r: Running, status: ServerStatus) {
  r.status = status;
  db.prepare(`UPDATE servers SET status = ? WHERE worktree_id = ?`).run(status, r.worktreeId);
  broadcast({ type: 'server.updated', sessionId: r.sessionId });
}

async function checkHealth(port: number, healthPath: string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(1500),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch { /* already gone */ }
}

export class MissingEnvError extends Error {
  statusCode = 409;
  constructor(public details: { missing: { projectId: number; project: string; keys: string[] }[] }) {
    super('필수 환경값이 비어 있어 서버를 띄울 수 없습니다.');
  }
}

async function allocate(kind: string): Promise<number> {
  const taken = new Set<number>([...servers.values()].map((r) => r.port));
  return findFreePort(kind === 'fe' ? 3401 : 8081, taken);
}

/**
 * 세션 워크트리의 서버를 띄운다. worktreeIds가 없으면 전부. BE를 먼저 띄워 FE가 BE 주소를 받게 한다.
 * commands에 워크트리 ID별 명령이 있으면 이번 실행에만 프로젝트 실행 명령 대신 쓴다.
 */
export async function startServers(sessionId: number, worktreeIds?: number[], commands: Record<number, string> = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const targets = session.worktrees
    .filter((w) => (!worktreeIds || worktreeIds.includes(w.id)) && !servers.has(w.id))
    .sort((a, b) => Number(a.project_kind === 'fe') - Number(b.project_kind === 'fe'));
  if (targets.length === 0) return;

  const missing: { projectId: number; project: string; keys: string[] }[] = [];
  for (const w of targets) {
    const p = getProject(w.project_id)!;
    if (!commands[w.id]?.trim() && !p.start_cmd) throw new Error(`${p.name}의 실행 명령이 없습니다. 프로젝트 설정에서 넣어 주세요.`);
    const auto = ['PORT', ...(p.port_env ? [p.port_env] : []), ...(p.api_env_key ? [p.api_env_key] : [])];
    const keys = missingRequired(sessionId, p.id, auto);
    if (keys.length) missing.push({ projectId: p.id, project: p.name, keys });
  }
  if (missing.length) throw new MissingEnvError({ missing });

  for (const w of targets) {
    const p = getProject(w.project_id)!;
    const port = await allocate(w.project_kind);
    const { env, vars } = resolveEnv(sessionId, p.id);
    const secretKeys = new Set(vars.filter((v) => v.secret).map((v) => v.key));
    const auto: Record<string, string> = { PORT: String(port) };
    if (p.port_env) auto[p.port_env] = String(port);
    if (p.api_env_key) {
      const be = session.worktrees.map((x) => servers.get(x.id)).find((r) => r && getProject(r.projectId)?.kind !== 'fe');
      if (be) auto[p.api_env_key] = `http://localhost:${be.port}`;
    }
    const startCmd = (commands[w.id]?.trim() || p.start_cmd!).replaceAll('{port}', String(port));
    // 새 워크트리에는 .venv나 node_modules가 없어 처음 한 번은 설치부터 한다. 설치가 실패하면 서버를 띄우지 않는다.
    const setup = p.setup_cmd && !w.setup_done ? p.setup_cmd : null;
    const cmd = setup ? `${setup} && ${startCmd}` : startCmd;
    const child = spawn(cmd, {
      cwd: w.path,
      shell: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...env, ...auto, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const r: Running = {
      worktreeId: w.id, sessionId, projectId: p.id, port, child, status: 'starting', stopping: false, exitCode: null,
      startedAt: Date.now(), logs: [], seq: 0, pending: [], flushTimer: null, healthTimer: null,
      secrets: Object.entries(env).filter(([k, v]) => secretKeys.has(k) && v.length >= 4).map(([, v]) => v),
    };
    servers.set(w.id, r);
    lastRun.delete(w.id);
    db.prepare(`INSERT OR REPLACE INTO servers (worktree_id, port, pid, status) VALUES (?, ?, ?, 'starting')`).run(w.id, port, child.pid ?? null);
    if (setup) pushLine(r, 'sys', `이 워크트리에서 처음 실행해 의존성부터 설치합니다: ${setup}`);
    pushLine(r, 'sys', `$ ${cmd}`);
    pushLine(r, 'sys', `포트 ${port}${Object.keys(auto).length > 1 ? ` · 자동 값 ${Object.entries(auto).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
    attachStream(r, child.stdout, 'out');
    attachStream(r, child.stderr, 'err');
    broadcast({ type: 'server.updated', sessionId });

    const healthPath = p.health_path || '/';
    r.healthTimer = setInterval(async () => {
      if (r.status !== 'starting' && r.status !== 'unhealthy') return;
      if (await checkHealth(port, healthPath)) {
        pushLine(r, 'sys', `헬스체크 통과 (${healthPath})`);
        if (setup) db.prepare(`UPDATE worktrees SET setup_done = 1 WHERE id = ?`).run(w.id);
        setStatus(r, 'running');
      } else if (r.status === 'starting' && Date.now() - r.startedAt > (setup ? SETUP_HEALTH_TIMEOUT_MS : HEALTH_TIMEOUT_MS)) {
        pushLine(r, 'sys', `${setup ? '15분' : '5분'} 안에 ${healthPath} 응답이 없습니다. 실행 명령이나 헬스체크 경로를 확인하세요.`);
        setStatus(r, 'unhealthy');
      }
    }, 1500);

    child.on('error', (err) => pushLine(r, 'sys', `실행 실패: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (r.healthTimer) clearInterval(r.healthTimer);
      r.exitCode = code;
      const status: ServerStatus = r.stopping ? 'stopped' : 'failed';
      pushLine(r, 'sys', r.stopping ? '서버를 껐습니다.' : `서버가 종료됐습니다 (코드 ${code ?? signal}).`);
      if (r.flushTimer) { clearTimeout(r.flushTimer); r.flushTimer = null; }
      const lines = r.pending.splice(0);
      if (lines.length) broadcast({ type: 'log', sessionId, worktreeId: w.id, lines });
      servers.delete(w.id);
      lastRun.set(w.id, { status, exitCode: code, port, logs: r.logs });
      db.prepare(`DELETE FROM servers WHERE worktree_id = ?`).run(w.id);
      broadcast({ type: 'server.updated', sessionId });
      if (!r.stopping && getSettings().notify.onServerFail) {
        sendNotification(`${session.ticket} ${p.name} 서버가 멈췄습니다`, `종료 코드 ${code ?? signal}. 로그를 확인하세요.`, sessionId);
      }
    });
  }
}

export async function stopServers(sessionId: number, worktreeIds?: number[]) {
  const list = [...servers.values()].filter((r) => r.sessionId === sessionId && (!worktreeIds || worktreeIds.includes(r.worktreeId)));
  await Promise.all(list.map((r) => new Promise<void>((resolve) => {
    r.stopping = true;
    pushLine(r, 'sys', '서버를 끄는 중');
    const done = () => { clearTimeout(force); resolve(); };
    r.child.once('exit', done);
    killGroup(r.child, 'SIGTERM');
    const force = setTimeout(() => { killGroup(r.child, 'SIGKILL'); setTimeout(resolve, 500); }, 6000);
  })));
}

export async function stopAll() {
  const ids = new Set([...servers.values()].map((r) => r.sessionId));
  for (const id of ids) await stopServers(id);
}

/** 이전 실행에서 남은 서버 프로세스를 정리한다. 이 도구가 띄운 것만 기록돼 있다. */
export function cleanupOrphans(): number {
  const rows = db.prepare(`SELECT worktree_id, pid FROM servers`).all() as { worktree_id: number; pid: number | null }[];
  let killed = 0;
  for (const row of rows) {
    if (row.pid) {
      try { process.kill(process.platform === 'win32' ? row.pid : -row.pid, 'SIGTERM'); killed++; } catch { /* not running */ }
    }
  }
  db.prepare(`DELETE FROM servers`).run();
  return killed;
}
