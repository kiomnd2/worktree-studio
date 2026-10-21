import fs from 'node:fs';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { getProject } from './projects.js';
import type { ProjectRow } from './db.js';
import { recordUsage } from './usage.js';
import { helperModel } from './models.js';

/**
 * 프로젝트 등록 뒤 Claude가 저장소를 읽고(실행하지 않음) 실행 설정을 다듬어 제안한다.
 * 핵심은 새 워크트리에서 로그인·외부 비밀값 서비스(Doppler 등) 없이 바로 뜨는 실행 명령을 찾는 것.
 * 제안은 사용자가 골라 적용한다.
 */

export const ANALYZE_FIELDS = ['start_cmd', 'setup_cmd', 'check_cmd', 'health_path', 'port_env', 'api_env_key', 'app_url', 'login_path'] as const;
export type AnalyzeField = (typeof ANALYZE_FIELDS)[number];
export type ProjectSuggestion = { field: AnalyzeField; value: string; current: string | null; reason: string };
export type ProjectAnalysis = { suggestions: ProjectSuggestion[]; env_keys: { key: string; reason: string }[]; notes: string[] };

const SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: [...ANALYZE_FIELDS] },
          value: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['field', 'value', 'reason'],
      },
    },
    env_keys: {
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, reason: { type: 'string' } }, required: ['key', 'reason'] },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['suggestions', 'env_keys', 'notes'],
} as const;

const LABEL: Record<AnalyzeField, string> = {
  start_cmd: '실행 명령', setup_cmd: '설치 명령', check_cmd: 'PR 전 검사', health_path: '헬스체크 경로',
  port_env: '포트 변수', api_env_key: 'BE 주소 변수', app_url: '접속 주소', login_path: '로그인 경로',
};

export async function analyzeProject(id: number): Promise<ProjectAnalysis> {
  const p = getProject(id);
  if (!p) throw new Error('프로젝트가 없습니다.');
  if (!fs.existsSync(p.local_path)) throw new Error(`폴더를 찾을 수 없습니다: ${p.local_path}`);
  const repo = p.repo_root || p.local_path;
  const current = (f: AnalyzeField) => (p[f as keyof ProjectRow] as string | null) ?? null;

  const prompt = [
    `Worktree Studio에 등록한 ${p.kind.toUpperCase()} 프로젝트 "${p.name}"의 개발 서버 실행 설정을 점검해 줘. 폴더: ${p.local_path}${p.subdir ? ` (저장소 루트 ${repo}의 하위 폴더)` : ''}`,
    '파일은 읽기만 하고 아무것도 실행하거나 고치지 않는다. README, AGENTS.md·CLAUDE.md, docs, package.json·build.gradle·pom.xml·pyproject.toml, Makefile, .env 예시·env 폴더, next/vite 설정, .nvmrc·.mise.toml 등을 본다.',
    '',
    '도구가 하는 일: 세션마다 이 저장소의 새 git 워크트리(다른 폴더)를 만들고, 거기서 아래 명령으로 개발 서버를 띄운다. 포트는 도구가 정해 {port} 자리에 넣고 PORT와 포트 변수에도 넣는다. 환경값은 도구의 환경값 화면에서 넣은 값이 프로세스 환경변수로 들어간다.',
    '',
    '지금 설정:',
    ...ANALYZE_FIELDS.map((f) => `- ${f} (${LABEL[f]}): ${current(f) ?? '(비어 있음)'}`),
    '',
    '규칙:',
    '- start_cmd는 새 워크트리에서 사람 손 없이 바로 떠야 한다. 로그인이나 외부 비밀값 서비스(Doppler, Infisical, 1Password op, Vault, aws-vault, sixdrop 등 "<도구> run -- 명령" 꼴), SSO 로그인, 대화형 입력, 폴더별 설정(doppler setup 등)이 필요한 경로는 쓰지 않는다.',
    '  같은 개발 서버를 바로 띄우는 스크립트 변형(dev:dev, dev:local 등)이 있으면 그것을, 없으면 감싼 안쪽 명령을 직접 쓴다(npm 스크립트가 아니면 npx로). 그 대신 필요한 환경값은 env_keys에 적는다.',
    '- 포트는 도구가 정하므로 start_cmd에 {port}를 넣는다(Next: -p {port}, Vite: --port {port} --strictPort, uvicorn: --port {port}). Spring처럼 환경변수로 받으면 port_env(예: SERVER_PORT)를 쓰고 명령에는 넣지 않는다. npm 스크립트에 인자를 넘길 때는 "npm run dev -- -p {port}"처럼 --를 붙인다.',
    '- Gradle 멀티 모듈은 실행할 앱 모듈만 띄운다(./gradlew :모듈:bootRun). 루트 bootRun은 실패한다. 실행 프로필(spring.profiles.active 등)이 필요하면 명령이나 env_keys에 적는다.',
    '- setup_cmd: 새 워크트리에는 node_modules·.venv가 없으므로 락 파일에 맞는 설치(npm ci, pnpm install --frozen-lockfile, uv sync 등). 설치에 비공개 레지스트리 토큰이 필요하면 notes에 적는다.',
    '- check_cmd: 파일을 바꾸지 않고 끝나는 검사(build, 한 번 도는 test). --watch처럼 끝나지 않는 명령이나 포매터(write)는 넣지 않는다.',
    '- health_path: 로그인 없이 500 미만으로 응답하는 경로(actuator가 있으면 /actuator/health, 없으면 /).',
    '- app_url: 개발 서버가 HTTPS로 뜨면 https://localhost:{port}, 인증서 도메인으로 열어야 하면 https://그도메인:{port}. HTTP면 비워 둔다(제안하지 않음).',
    '- api_env_key: FE가 BE 주소를 읽는 환경변수 이름(NEXT_PUBLIC_API_URL 등). 코드에서 실제로 읽는 이름만.',
    '- login_path: FE 로그인 화면 경로(예: /login). 없으면 제안하지 않는다.',
    '- 지금 값이 이미 맞으면 그 항목은 제안하지 않는다. reason은 왜 바꾸는지 한 문장(근거 파일 포함).',
    '- env_keys: 바로 실행할 때 꼭 넣어야 하는 환경값 이름과 이유(값이나 비밀값은 적지 않는다). 없으면 빈 배열.',
    '- notes: 사람이 알아야 할 것 두세 개까지(예: Node 버전, X-Frame-Options로 미리보기 iframe이 막힘, DB·docker 필요). 모두 한국어로.',
  ].join('\n');

  let structured: unknown = null;
  const q = query({
    prompt,
    options: {
      cwd: p.local_path,
      additionalDirectories: repo !== p.local_path ? [repo] : [],
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      // 사용자 플러그인·훅을 불러오지 않는다. 훅이 저장소에 상태 파일을 만들면 커밋에 섞인다.
      settingSources: [],
      permissionMode: 'dontAsk',
      maxTurns: 40,
      persistSession: false,
      model: helperModel('project_analyze'),
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    },
  });
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === 'result') {
      recordUsage(msg, { purpose: 'project_analyze', cwd: p.local_path });
      if (msg.subtype !== 'success' || msg.is_error) throw new Error('프로젝트를 살펴보지 못했습니다.');
      structured = msg.structured_output ?? JSON.parse(msg.result);
    }
  }
  const d = structured as { suggestions: { field: AnalyzeField; value: string; reason: string }[]; env_keys: ProjectAnalysis['env_keys']; notes: string[] };
  const seen = new Set<string>();
  const suggestions = (d?.suggestions ?? [])
    .filter((s) => ANALYZE_FIELDS.includes(s.field) && typeof s.value === 'string')
    .map((s) => ({ field: s.field, value: s.value.trim(), current: current(s.field), reason: s.reason }))
    .filter((s) => s.value !== (s.current ?? '') && !seen.has(s.field) && seen.add(s.field))
    // 실행 명령은 포트를 받아야 한다(명령에 {port}가 없고 포트 변수도 없으면 같은 포트로 여러 세션이 부딪힌다).
    .filter((s) => s.field !== 'start_cmd' || s.value.includes('{port}') || Boolean(p.port_env) || suggestionsHasPortEnv(d.suggestions));
  return {
    suggestions,
    env_keys: (d?.env_keys ?? []).filter((k) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k.key)),
    notes: (d?.notes ?? []).slice(0, 4),
  };
}

function suggestionsHasPortEnv(list: { field: string; value: string }[] | undefined): boolean {
  return Boolean(list?.some((s) => s.field === 'port_env' && s.value.trim()));
}
