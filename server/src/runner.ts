import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { db } from './db.js';
import { broadcast, type LogLine } from './hub.js';
import { getProject, projectUrl } from './projects.js';
import { getSession, type SessionView } from './sessions.js';
import { missingRequired, resolveEnv } from './envstore.js';
import { findFreePort, isPortFree } from './ports.js';
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
  /** 끝난 서버를 정리한다(한 번만). exit이 오지 않는 경우에도 부를 수 있다. */
  finish?: (code: number | null, signal: NodeJS.Signals | null) => void;
  secrets: string[];
};

const MAX_LOG_LINES = 3000;
const HEALTH_TIMEOUT_MS = 5 * 60 * 1000;
/** 처음 실행은 의존성 설치까지 하므로 더 기다린다. */
const SETUP_HEALTH_TIMEOUT_MS = 15 * 60 * 1000;
const servers = new Map<number, Running>();
// 서버가 꺼진 뒤에도 마지막 로그와 상태를 볼 수 있게 남겨 둔다.
const lastRun = new Map<number, { status: ServerStatus; exitCode: number | null; port: number; logs: LogLine[] }>();

/** 서버가 예기치 않게 멈췄거나 응답하지 않을 때 남기는 기록. 화면에 오류 요약으로 보여 준다. */
export type ServerFailure = {
  kind: 'exit' | 'unhealthy';
  at: number;
  exit_code: number | null;
  command: string;
  /** 한 줄 요약: 첫 오류 줄이나 종료 코드 */
  summary: string;
  /** 첫 오류 앞뒤와 마지막 줄들. 비밀값은 로그 단계에서 이미 가려져 있다. */
  excerpt: string;
};
const failures = new Map<number, ServerFailure>();

export function getFailure(worktreeId: number) { return failures.get(worktreeId) ?? null; }
export function clearFailure(worktreeId: number, sessionId: number) {
  failures.delete(worktreeId);
  broadcast({ type: 'server.updated', sessionId });
}

/** 첫 오류 줄 앞뒤와 마지막 줄들을 모은다. 스택 트레이스는 첫 오류 뒤에 이어지는 경우가 많다. */
function failureExcerpt(logs: LogLine[]): { summary: string | null; excerpt: string } {
  const body = logs.filter((l) => l.stream !== 'sys');
  const i = body.findIndex((l) => l.level === 'error');
  const picked = new Set<LogLine>();
  if (i >= 0) body.slice(Math.max(0, i - 5), i + 40).forEach((l) => picked.add(l));
  body.slice(-40).forEach((l) => picked.add(l));
  const lines = body.filter((l) => picked.has(l));
  const out: string[] = [];
  lines.forEach((l, k) => {
    if (k > 0 && l.seq - lines[k - 1].seq > 1) out.push('…');
    out.push(l.text);
  });
  // "Traceback ..."이나 "npm ERR! code ..." 같은 머리줄보다 실제 예외 줄(NameError: ..., TypeError: ...)이 요약으로 낫다.
  const errs = body.filter((l) => l.level === 'error');
  const head = errs.find((l) => /\b\w+(Error|Exception)\b.*:/.test(l.text) && !/Traceback/.test(l.text)) ?? errs[0];
  return { summary: head ? head.text.trim().slice(0, 240) : null, excerpt: out.join('\n').slice(-12000) };
}

function recordFailure(r: Running, kind: ServerFailure['kind'], command: string) {
  const { summary, excerpt } = failureExcerpt(r.logs);
  failures.set(r.worktreeId, {
    kind, at: Date.now(), exit_code: r.exitCode, command, excerpt,
    summary: summary ?? (kind === 'exit' ? `종료 코드 ${r.exitCode}` : '헬스체크에 응답하지 않습니다'),
  });
}

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
  failure: ServerFailure | null;
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
      url: port && r ? projectUrl(project, port) : null,
      exit_code: r?.exitCode ?? last?.exitCode ?? null,
      started_at: r?.startedAt ?? null,
      can_start: Boolean(project?.start_cmd),
      start_cmd: project?.start_cmd ?? null,
      cwd: w.path,
      health_path: project?.health_path || '/',
      setup_pending: project?.setup_cmd && !w.setup_done ? project.setup_cmd : null,
      failure: failures.get(w.id) ?? null,
    };
  });
}

export function serverPorts(sessionId: number): { project_name: string; kind: string; port: number; status: ServerStatus; url: string }[] {
  const s = getSession(sessionId);
  if (!s) return [];
  return s.worktrees.flatMap((w) => {
    const r = servers.get(w.id);
    return r ? [{ project_name: w.project_name, kind: w.project_kind, port: r.port, status: r.status, url: projectUrl(getProject(w.project_id), r.port) }] : [];
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
  /No such file or directory|command not found|can't open file|is not recognized as|Permission denied/, // 셸·실행 단계 실패
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

/** 응답이 오면(500 미만) 뜬 것으로 본다. HTTPS 개발 서버는 자체 서명 인증서가 많아 인증서는 확인하지 않는다. */
function checkHealth(baseUrl: string, healthPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL(`${baseUrl}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`); } catch { resolve(false); return; }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', timeout: 1500, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
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

async function allocate(kind: string, want?: number): Promise<number> {
  const taken = new Set<number>([...servers.values()].map((r) => r.port));
  // 실행 전에 정해 둔 포트(설정 제안이 그 포트를 기준으로 했다)가 아직 비어 있으면 그대로 쓴다.
  if (want && !taken.has(want) && (await isPortFree(want))) return want;
  return findFreePort(kind === 'fe' ? 3401 : 8081, taken);
}

/**
 * 서버를 띄우기 전에 쓸 포트를 미리 정한다. 이미 실행 중인 서버는 지금 포트, 재시작할 서버는 지금 포트를 그대로,
 * 새로 띄울 서버는 빈 포트. 설정 제안이 이 포트를 기준으로 하고, 실행할 때 같은 포트를 쓴다.
 */
export async function planPorts(sessionId: number, worktreeIds?: number[], restart = false): Promise<Record<number, number>> {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const out: Record<number, number> = {};
  const taken = new Set<number>([...servers.values()].map((r) => r.port));
  for (const w of session.worktrees) {
    const r = servers.get(w.id);
    if (r && (!restart || !worktreeIds || worktreeIds.includes(w.id))) out[w.id] = r.port;
  }
  for (const w of session.worktrees) {
    if (out[w.id] || (worktreeIds && !worktreeIds.includes(w.id))) continue;
    const p = await findFreePort(w.project_kind === 'fe' ? 3401 : 8081, taken);
    taken.add(p);
    out[w.id] = p;
  }
  return out;
}

/**
 * 세션 워크트리의 서버를 띄운다. worktreeIds가 없으면 전부. BE를 먼저 띄워 FE가 BE 주소를 받게 한다.
 * commands에 워크트리 ID별 명령이 있으면 이번 실행에만 프로젝트 실행 명령 대신 쓴다.
 */
export async function startServers(sessionId: number, worktreeIds?: number[], commands: Record<number, string> = {}, ports: Record<number, number> = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const targets = session.worktrees
    .filter((w) => (!worktreeIds || worktreeIds.includes(w.id)) && !servers.has(w.id))
    .sort((a, b) => Number(a.project_kind === 'fe') - Number(b.project_kind === 'fe'));
  if (targets.length === 0) return;

  // 워크트리 폴더가 지워졌으면 띄울 수 없다(spawn이 'ENOENT'로만 실패해 원인을 알기 어렵다).
  const gone = targets.filter((w) => !fs.existsSync(w.app_path));
  if (gone.length) {
    throw new Error(`워크트리 폴더가 없습니다: ${gone.map((w) => w.app_path).join(', ')}. 지워진 워크트리는 되살릴 수 없으니, 리소스 정리에서 이 세션을 정리하고 새 세션을 만드세요.`);
  }
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
    const port = await allocate(w.project_kind, ports[w.id]);
    const { env, vars } = resolveEnv(sessionId, p.id);
    const secretKeys = new Set(vars.filter((v) => v.secret).map((v) => v.key));
    const auto: Record<string, string> = { PORT: String(port) };
    if (p.port_env) auto[p.port_env] = String(port);
    if (p.api_env_key) {
      const be = session.worktrees.map((x) => servers.get(x.id)).find((r) => r && getProject(r.projectId)?.kind !== 'fe');
      if (be) auto[p.api_env_key] = projectUrl(getProject(be.projectId), be.port);
    }
    const startCmd = (commands[w.id]?.trim() || p.start_cmd!).replaceAll('{port}', String(port));
    // 새 워크트리에는 .venv나 node_modules가 없어 처음 한 번은 설치부터 한다. 설치가 실패하면 서버를 띄우지 않는다.
    const setup = p.setup_cmd && !w.setup_done ? p.setup_cmd : null;
    const cmd = setup ? `${setup} && ${startCmd}` : startCmd;
    const child = spawn(cmd, {
      // 모노레포면 앱 폴더(frontend/ 등)에서 띄운다.
      cwd: w.app_path,
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
    failures.delete(w.id);
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
      if (await checkHealth(projectUrl(p, port), healthPath)) {
        pushLine(r, 'sys', `헬스체크 통과 (${healthPath})`);
        if (setup) db.prepare(`UPDATE worktrees SET setup_done = 1 WHERE id = ?`).run(w.id);
        setStatus(r, 'running');
      } else if (r.status === 'starting' && Date.now() - r.startedAt > (setup ? SETUP_HEALTH_TIMEOUT_MS : HEALTH_TIMEOUT_MS)) {
        pushLine(r, 'sys', `${setup ? '15분' : '5분'} 안에 ${healthPath} 응답이 없습니다. 실행 명령이나 헬스체크 경로를 확인하세요.`);
        recordFailure(r, 'unhealthy', cmd);
        setStatus(r, 'unhealthy');
      }
    }, 1500);

    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      if (r.healthTimer) clearInterval(r.healthTimer);
      r.exitCode = code;
      const status: ServerStatus = r.stopping ? 'stopped' : 'failed';
      pushLine(r, 'sys', r.stopping ? '서버를 껐습니다.' : `서버가 종료됐습니다 (코드 ${code ?? signal}).`);
      if (r.flushTimer) { clearTimeout(r.flushTimer); r.flushTimer = null; }
      const lines = r.pending.splice(0);
      if (lines.length) broadcast({ type: 'log', sessionId, worktreeId: w.id, lines });
      servers.delete(w.id);
      lastRun.set(w.id, { status, exitCode: code, port, logs: r.logs });
      if (!r.stopping) recordFailure(r, 'exit', cmd);
      else failures.delete(w.id);
      db.prepare(`DELETE FROM servers WHERE worktree_id = ?`).run(w.id);
      broadcast({ type: 'server.updated', sessionId });
      if (!r.stopping && getSettings().notify.onServerFail) {
        sendNotification(`${session.ticket} ${p.name} 서버가 멈췄습니다`, `${failures.get(w.id)?.summary ?? `종료 코드 ${code ?? signal}`}\n로그를 확인하세요.`, sessionId);
      }
    };
    r.finish = finish;
    // 실행 자체가 실패하면(셸·폴더 없음 등) exit이 오지 않을 수 있어 여기서 끝낸다. 안 그러면 '시작 중'으로 남고 끌 수도 없다.
    child.on('error', (err) => { pushLine(r, 'sys', `실행 실패: ${err.message}`); if (child.pid === undefined || child.exitCode !== null) finish(child.exitCode, null); });
    child.on('exit', (code, signal) => finish(code, signal));
  }
}

export async function stopServers(sessionId: number, worktreeIds?: number[]) {
  const list = [...servers.values()].filter((r) => r.sessionId === sessionId && (!worktreeIds || worktreeIds.includes(r.worktreeId)));
  await Promise.all(list.map((r) => new Promise<void>((resolve) => {
    r.stopping = true;
    // 뜨지도 못했거나 이미 끝난 프로세스는 기다릴 것이 없다.
    if (r.child.pid === undefined || r.child.exitCode !== null || r.child.signalCode !== null) {
      r.finish?.(r.child.exitCode, r.child.signalCode);
      resolve();
      return;
    }
    pushLine(r, 'sys', '서버를 끄는 중');
    const done = () => { clearTimeout(force); resolve(); };
    r.child.once('exit', done);
    killGroup(r.child, 'SIGTERM');
    // SIGKILL 뒤에도 exit이 오지 않으면 목록에서 직접 정리해 '끄는 중'으로 남지 않게 한다.
    const force = setTimeout(() => { killGroup(r.child, 'SIGKILL'); setTimeout(() => { r.finish?.(null, 'SIGKILL'); resolve(); }, 1500); }, 6000);
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
