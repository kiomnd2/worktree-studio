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

  const show = (k: string, v: string) => (hidden(k, v) ? '(비밀값, 설정됨)' : v);
  const addr = (kind: 'fe' | 'be') => rows.filter((r) => (kind === 'fe') === (r.w.project_kind === 'fe') && r.port).map((r) => projectUrl(r.p, r.port!))[0] ?? null;
  const feUrl = addr('fe'), beUrl = addr('be');
  const sessionPorts = rows.flatMap((r) => (r.port ? [String(r.port)] : []));
  const prompt = [
    '이 세션의 개발 서버를 아래 포트로 띄우려 한다. FE와 BE가 이 포트로 서로 제대로 연결되고 로그인·인증 흐름이 이 세션 안에서 돌게 하려면 바꿔야 하는 환경값을 찾아 제안해줘.',
    '코드와 설정 파일은 읽기만 한다. 파일을 고치자는 제안은 하지 않고, 환경값으로 덮어쓸 수 있는 것만 제안한다.',
    '',
    `이 세션 FE 주소: ${feUrl ?? '(이 세션에 FE 없음)'} · BE 주소: ${beUrl ?? '(이 세션에 BE 없음)'}`,
    'FE와 BE는 따로 띄울 수도 있지만 항상 위 주소로 뜬다. 지금 꺼져 있는 쪽도 이 주소를 기준으로 맞춘다.',
    '',
    ...rows.flatMap((r) => [
      `## ${r.p.name} (${r.w.project_kind.toUpperCase()}) 폴더 ${r.w.app_path}`,
      `- 포트: ${r.port ?? '(정하지 못함)'} · 실행 명령: ${r.p.start_cmd ?? '(없음)'}`,
      `- 도구가 자동으로 넣는 값(제안하지 말 것): ${Object.entries(r.auto).map(([k, v]) => `${k}=${v}`).join(', ') || '없음'}`,
      `- 지금 환경값: ${Object.entries(r.env).map(([k, v]) => `${k}=${show(k, v)}`).join(', ') || '없음'}`,
    ]),
    '',
    '찾을 것 (실제로 코드·설정에서 읽히는 것만):',
    '- FE가 부르는 API 주소, 프록시 대상(next.config rewrites, vite proxy 등)이 이 세션 BE 포트를 가리키는지.',
    '- BE의 CORS 허용 주소, 프론트 주소(리다이렉트·메일·QR 링크에 쓰는 값)가 이 세션 FE 포트를 가리키는지.',
    '- 로그인·SSO·인증서·OAuth 콜백/리다이렉트 주소가 이 세션 BE·FE 포트로 돌아오는지. mock 인증 서버 주소도.',
    '- 쿠키 도메인, 웹소켓 주소처럼 포트·호스트가 들어가는 값.',
    '규칙:',
    '- 실행 명령과 환경값으로 정해지는 활성 프로필(예: Spring local)의 설정 파일 값을 기준으로 한다. 실제로 쓰이는 값이 FE 쪽을 가리켜야 하는데 위 FE 주소와 다르면(예: localhost:3000) FE 주소로, BE 쪽을 가리켜야 하는데 위 BE 주소와 다르면 BE 주소로 바꾸자고 제안한다. 경로(/auth/callback 등)는 그대로 둔다.',
    '- 세션에 없는 쪽(주소가 없음)에 대한 값은 제안하지 말고 note에 적는다. 이미 맞으면 제안하지 않는다.',
    '- 근거 파일을 직접 열어 그 키가 실제로 있고, 지금 값이 이 세션 주소와 다른 것을 확인한 것만 제안한다. 짐작으로 키 이름을 만들지 않는다.',
    '- Spring 설정 키는 환경변수로 덮어쓸 수 있는 relaxed binding 이름으로 쓴다(예: cert-auth.callback-url → CERT_AUTH_CALLBACK_URL). Next.js 브라우저 값은 NEXT_PUBLIC_ 이름 그대로.',
    '- 이미 환경값에 같은 뜻의 다른 이름이 있어도 실제로 읽히는 이름을 제안한다. value는 주소(http://…) 또는 포트 숫자만. 비밀번호·토큰 같은 비밀값은 제안하지 않는다.',
    '- project는 위 프로젝트 이름 그대로. reason은 왜 바꿔야 하는지 한 문장, found_in은 근거 파일 경로와 키(예: src/main/resources/application-local.yml cert-auth.callback-url).',
    '- 바꿀 것이 없으면 suggestions를 비운다. note에는 확인하지 못한 것이나 재시작이 필요한 것 등을 한두 문장(없으면 빈 문자열). 모두 한국어로.',
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
