import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { getProject, projectUrl } from './projects.js';
import { sessionBeUrl } from './runner.js';
import { getSession } from './sessions.js';
import { resolveEnv } from './envstore.js';
import { looksSecret } from './secret.js';
import { git } from './git.js';
import { recordUsage } from './usage.js';
import { helperModel } from './models.js';
import { db } from './db.js';
import { renderPorts, sameServer, sessionAddrs, toTemplate } from './portvars.js';

/**
 * 서버를 띄우기 전에, 이 세션의 포트로 FE와 BE가 서로 맞물리려면 바꿔야 할 환경값을 제안한다.
 * (FE가 부르는 API 주소, BE의 CORS 허용 주소, 인증·로그인 콜백 주소, 프론트 주소 등)
 * 코드는 읽기만 하고, 값은 사용자가 고르고 승인해야 환경값에 들어간다.
 * 이 세션 주소는 포트 자리({be_url} 등)로 바꿔 프로필에 저장하므로, 한 번 승인하면 다른 세션·포트에서도 맞물린다.
 */
export type EnvSuggestion = { worktree_id: number; project_id: number; project_name: string; key: string; value: string; template: string; current: string | null; reason: string; found_in: string };
export type EnvSuggestResult = { suggestions: EnvSuggestion[]; note: string; skipped?: boolean };

/** 주소·포트 값. 키 이름에 AUTH 같은 말이 있어도(CERT_AUTH_CALLBACK_URL) 주소는 비밀값이 아니다. */
const isAddress = (v: string) => /^(https?|wss?):\/\/\S+$/i.test(v.trim()) || /^\d{2,5}$/.test(v.trim());
const hidden = (k: string, v: string) => looksSecret(k) && !isAddress(v);

const SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          reason: { type: 'string' },
          found_in: { type: 'string' },
        },
        required: ['project', 'key', 'value', 'reason', 'found_in'],
      },
    },
    note: { type: 'string' },
  },
  required: ['suggestions', 'note'],
};

// 포트·환경값·실행 명령·코드가 그대로면 다시 읽지 않고 같은 결과를 쓴다. FE와 BE를 따로 띄워도 제안이 흔들리지 않는다.
const cache = new Map<number, { key: string; result: EnvSuggestResult }>();

/** 코드가 바뀌었는지 알아볼 표시: HEAD와 커밋 안 한 파일들의 수정 시각. */
async function codeStamp(dir: string): Promise<string> {
  const head = await git(dir, ['rev-parse', 'HEAD']).catch(() => '');
  const status = await git(dir, ['status', '--porcelain']).catch(() => '');
  const times = status.split('\n').filter(Boolean).map((l) => {
    const f = l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');
    try { return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`; } catch { return f; }
  });
  return `${head.trim()}|${times.join(',')}`;
}

/** 제안 값이 이 세션 FE·BE 주소(경로가 붙어도 된다)나 포트 숫자인지. */
function pointsToSession(value: string, urls: (string | null)[], ports: string[]): boolean {
  if (/^\d+$/.test(value)) return ports.includes(value);
  try {
    const v = new URL(value);
    return urls.some((x) => x !== null && sameServer(new URL(x), v));
  } catch { return false; }
}

/** found_in 앞쪽의 파일 경로가 앱 폴더나 워크트리 안에 실제로 있는지. */
function evidenceExists(foundIn: string, dirs: string[]): boolean {
  const file = foundIn.trim().split(/\s+/)[0]?.replace(/[:#].*$/, '');
  if (!file) return false;
  if (path.isAbsolute(file)) return fs.existsSync(file);
  return dirs.some((d) => fs.existsSync(path.join(d, file)));
}

/** 살펴본 프로젝트로 표시한다. 다음 세션부터는 다시 살펴보기를 누를 때만 Claude가 읽는다. */
export function markPortEnvChecked(projectIds: number[]) {
  const up = db.prepare(`UPDATE projects SET port_env_checked = 1 WHERE id = ?`);
  for (const id of new Set(projectIds)) up.run(id);
}

export async function suggestServerEnv(sessionId: number, ports: Record<number, number>, force = false): Promise<EnvSuggestResult> {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  // 모든 앱을 이미 살펴봤으면 저장해 둔 포트 자리 값으로 충분하다.
  if (!force && !cache.has(sessionId) && session.worktrees.every((w) => getProject(w.project_id)?.port_env_checked)) {
    return { suggestions: [], note: '', skipped: true };
  }
  const addrs = sessionAddrs(session, ports);
  const rows = session.worktrees.map((w) => {
    const p = getProject(w.project_id)!;
    const port = ports[w.id] ?? null;
    // 포트 자리로 저장한 값은 이 세션 주소로 채워 보여 준다. 이미 맞으니 다시 제안하지 않는다.
    const { env } = renderPorts(resolveEnv(sessionId, p.id).env, addrs, port);
    const auto: Record<string, string> = {};
    if (port) { auto.PORT = String(port); if (p.port_env) auto[p.port_env] = String(port); }
    const beUrl = sessionBeUrl(session, ports);
    if (p.api_env_key && beUrl) auto[p.api_env_key] = beUrl;
    return { w, p, env, port, auto };
  });

  const code = await Promise.all(rows.map((r) => codeStamp(r.w.path)));
  const key = crypto.createHash('sha1').update(JSON.stringify([code, rows.map((r) => [r.w.id, r.p.start_cmd, r.port, r.env, r.auto])])).digest('hex');
  const hit = cache.get(sessionId);
  if (hit?.key === key && !force) return hit.result;

  const show = (k: string, v: string) => (hidden(k, v) ? '(secret, set)' : v);
  const addr = (kind: 'fe' | 'be') => rows.filter((r) => (kind === 'fe') === (r.w.project_kind === 'fe') && r.port).map((r) => projectUrl(r.p, r.port!))[0] ?? null;
  const feUrl = addr('fe'), beUrl = addr('be');
  const sessionPorts = rows.flatMap((r) => (r.port ? [String(r.port)] : []));
  const prompt = [
    'This session\'s dev servers are about to start on the ports below. Find and suggest the environment values that must change so that the FE and BE connect to each other correctly on these ports and the login/authentication flow stays within this session.',
    'Only read code and config files. Do not suggest editing files; suggest only things that can be overridden with environment values.',
    '',
    `This session's FE address: ${feUrl ?? '(no FE in this session)'} · BE address: ${beUrl ?? '(no BE in this session)'}`,
    'The FE and BE may be started separately, but they always start on the addresses above. Align the side that is currently stopped to these addresses as well.',
    '',
    ...rows.flatMap((r) => [
      `## ${r.p.name} (${r.w.project_kind.toUpperCase()}) folder ${r.w.app_path}`,
      `- Port: ${r.port ?? '(not determined)'} · Run command: ${r.p.start_cmd ?? '(none)'}`,
      `- Values the tool sets automatically (do not suggest these): ${Object.entries(r.auto).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
      `- Current environment values: ${Object.entries(r.env).map(([k, v]) => `${k}=${show(k, v)}`).join(', ') || 'none'}`,
    ]),
    '',
    'What to look for (only things actually read from code/config):',
    '- Whether the API address the FE calls and proxy targets (next.config rewrites, vite proxy, etc.) point to this session\'s BE port.',
    '- Whether the BE\'s CORS allowed origins and front-end address (values used for redirects, emails, QR links) point to this session\'s FE port.',
    '- Whether login/SSO/certificate/OAuth callback/redirect addresses come back to this session\'s BE/FE ports. Mock auth server addresses too.',
    '- Values that include a port or host, such as cookie domains and websocket addresses.',
    'Rules:',
    '- Base this on the config file values of the active profile determined by the run command and environment values (e.g. Spring local). If a value actually in use should point to the FE side but differs from the FE address above (e.g. localhost:3000), suggest changing it to the FE address; if it should point to the BE side but differs from the BE address above, suggest changing it to the BE address. Keep the path (/auth/callback, etc.) as is.',
    '- Do not suggest values for a side that is not in the session (no address); write it in note instead. If a value is already right, do not suggest it.',
    '- Suggest only what you confirmed by opening the evidence file yourself: the key actually exists there and its current value differs from this session\'s address. Do not invent key names by guessing.',
    '- Write Spring config keys as relaxed-binding names that can be overridden by environment variables (e.g. cert-auth.callback-url → CERT_AUTH_CALLBACK_URL). Keep Next.js browser values under their NEXT_PUBLIC_ names as is.',
    '- Even if the environment values already contain a different name with the same meaning, suggest the name that is actually read. value must be an address (http://…) or a port number only. Do not suggest secrets such as passwords or tokens.',
    '- project is the project name exactly as written above. reason is one sentence on why it must change; found_in is the evidence file path and key (e.g. src/main/resources/application-local.yml cert-auth.callback-url).',
    '- If nothing needs to change, leave suggestions empty. note is one or two sentences on things you could not confirm or that need a restart, etc. (empty string if none).',
    '- Write every value meant for people (reason, note) in Korean.',
  ].join('\n');

  // 같은 저장소의 앱은 워크트리가 같으므로 한 번만 연다.
  const dirs = [...new Set(rows.map((r) => r.w.path))];
  let structured: unknown = null;
  const q = query({
    prompt,
    options: {
      cwd: dirs[0],
      additionalDirectories: dirs.slice(1),
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      // 사용자 플러그인·훅을 불러오지 않는다. 훅이 저장소에 상태 파일을 만들면 커밋에 섞인다.
      settingSources: [],
      permissionMode: 'dontAsk',
      maxTurns: 30,
      persistSession: false,
      model: helperModel('env_suggest'),
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    },
  });
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === 'result') {
      recordUsage(msg, { purpose: 'env_suggest', sessionId, cwd: dirs[0] });
      if (msg.subtype !== 'success' || msg.is_error) throw new Error('설정을 살펴보지 못했습니다.');
      structured = msg.structured_output ?? JSON.parse(msg.result);
    }
  }
  const d = structured as { suggestions: { project: string; key: string; value: string; reason: string; found_in: string }[]; note: string };
  const suggestions: EnvSuggestion[] = [];
  for (const s of d?.suggestions ?? []) {
    const r = rows.find((x) => x.p.name === s.project) ?? (rows.length === 1 ? rows[0] : undefined);
    const k = s.key.trim();
    // 주소·포트만 제안받는다. 비밀값으로 보이는 지금 값은 보여 주지 않는다.
    if (!r || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) || !isAddress(s.value) || k in r.auto) continue;
    if (r.env[k] === s.value.trim()) continue;
    // 값은 이 세션 FE·BE 주소나 포트여야 한다. 다른 주소(스테이징 등)를 짐작해 넣은 제안은 버린다.
    if (!pointsToSession(s.value.trim(), [feUrl, beUrl], sessionPorts)) continue;
    // 근거 파일이 실제로 있어야 한다.
    if (!evidenceExists(s.found_in, [r.w.app_path, r.w.path])) continue;
    const cur = r.env[k] ?? null;
    suggestions.push({ worktree_id: r.w.id, project_id: r.p.id, project_name: r.p.name, key: k, value: s.value.trim(), template: toTemplate(s.value, addrs), current: cur !== null && hidden(k, cur) ? '(비밀값)' : cur, reason: s.reason, found_in: s.found_in });
  }
  const result = { suggestions, note: d?.note ?? '' };
  cache.set(sessionId, { key, result });
  if (suggestions.length === 0) markPortEnvChecked(rows.map((r) => r.p.id));
  return result;
}
