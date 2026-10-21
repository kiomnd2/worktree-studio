import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { getProject, projectUrl } from './projects.js';
import { getSession } from './sessions.js';
import { resolveEnv } from './envstore.js';
import { looksSecret } from './secret.js';
import { git } from './git.js';
import { recordUsage } from './usage.js';
import { helperModel } from './models.js';

/**
 * 서버를 띄우기 전에, 이 세션의 포트로 FE와 BE가 서로 맞물리려면 바꿔야 할 환경값을 제안한다.
 * (FE가 부르는 API 주소, BE의 CORS 허용 주소, 인증·로그인 콜백 주소, 프론트 주소 등)
 * 코드는 읽기만 하고, 값은 사용자가 고르고 승인해야 이번 세션 환경값에 들어간다.
 */
export type EnvSuggestion = { worktree_id: number; project_id: number; project_name: string; key: string; value: string; current: string | null; reason: string; found_in: string };

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

// 같은 포트·환경값·실행 명령·코드로 잠깐 사이에 다시 열면 다시 읽지 않는다.
const cache = new Map<string, { at: number; result: { suggestions: EnvSuggestion[]; note: string } }>();
const TTL = 10 * 60_000;

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

export async function suggestServerEnv(sessionId: number, ports: Record<number, number>): Promise<{ suggestions: EnvSuggestion[]; note: string }> {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const rows = session.worktrees.map((w) => {
    const p = getProject(w.project_id)!;
    const { env } = resolveEnv(sessionId, p.id);
    const port = ports[w.id] ?? null;
    const auto: Record<string, string> = {};
    if (port) { auto.PORT = String(port); if (p.port_env) auto[p.port_env] = String(port); }
    const be = session.worktrees.find((x) => x.project_kind !== 'fe' && ports[x.id]);
    if (p.api_env_key && be) auto[p.api_env_key] = projectUrl(getProject(be.project_id), ports[be.id]);
    return { w, p, env, port, auto };
  });

  const code = await Promise.all(rows.map((r) => codeStamp(r.w.path)));
  const key = crypto.createHash('sha1').update(JSON.stringify([code, rows.map((r) => [r.w.id, r.p.start_cmd, r.port, r.env, r.auto])])).digest('hex');
  const hit = cache.get(`${sessionId}:${key}`);
  if (hit && Date.now() - hit.at < TTL) return hit.result;

  const show = (k: string, v: string) => (hidden(k, v) ? '(비밀값, 설정됨)' : v);
  const addr = (kind: 'fe' | 'be') => rows.filter((r) => (kind === 'fe') === (r.w.project_kind === 'fe') && r.port).map((r) => projectUrl(r.p, r.port!))[0] ?? null;
  const feUrl = addr('fe'), beUrl = addr('be');
  const prompt = [
    '이 세션의 개발 서버를 아래 포트로 띄우려 한다. FE와 BE가 이 포트로 서로 제대로 연결되고 로그인·인증 흐름이 이 세션 안에서 돌게 하려면 바꿔야 하는 환경값을 찾아 제안해줘.',
    '코드와 설정 파일은 읽기만 한다. 파일을 고치자는 제안은 하지 않고, 환경값으로 덮어쓸 수 있는 것만 제안한다.',
    '',
    `이 세션 FE 주소: ${feUrl ?? '(이번에 FE를 띄우지 않음)'} · BE 주소: ${beUrl ?? '(이번에 BE를 띄우지 않음)'}`,
    '',
    ...rows.flatMap((r) => [
      `## ${r.p.name} (${r.w.project_kind.toUpperCase()}) 폴더 ${r.w.app_path}`,
      `- 띄울 포트: ${r.port ?? '(이번에 띄우지 않음)'} · 실행 명령: ${r.p.start_cmd ?? '(없음)'}`,
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
    '- 주소를 모르는 쪽(이번에 띄우지 않는 쪽)에 대한 값은 제안하지 말고 note에 적는다. 아는 쪽 값은 다른 쪽을 몰라도 제안한다. 이미 맞으면 제안하지 않는다.',
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
    if (r.env[k] === s.value) continue;
    const cur = r.env[k] ?? null;
    suggestions.push({ worktree_id: r.w.id, project_id: r.p.id, project_name: r.p.name, key: k, value: s.value.trim(), current: cur !== null && hidden(k, cur) ? '(비밀값)' : cur, reason: s.reason, found_in: s.found_in });
  }
  const result = { suggestions, note: d?.note ?? '' };
  cache.set(`${sessionId}:${key}`, { at: Date.now(), result });
  return result;
}
