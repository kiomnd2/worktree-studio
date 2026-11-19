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
    `Review the dev server run settings of the ${p.kind.toUpperCase()} project "${p.name}" registered in Worktree Studio. Folder: ${p.local_path}${p.subdir ? ` (a subfolder of the repository root ${repo})` : ''}`,
    'Only read files; do not run or modify anything. Look at README, AGENTS.md/CLAUDE.md, docs, package.json/build.gradle/pom.xml/pyproject.toml, Makefile, .env examples and env folders, next/vite config, .nvmrc/.mise.toml, and so on.',
    '',
    'What the tool does: for each session it creates a new git worktree (a separate folder) of this repository and starts the dev server there with the commands below. The tool picks the port, substitutes it for {port}, and also sets it in PORT and the port variable. Environment values entered in the tool\'s environment values screen are passed in as process environment variables.',
    '',
    'Current settings:',
    ...ANALYZE_FIELDS.map((f) => `- ${f} (${LABEL[f]}): ${current(f) ?? '(empty)'}`),
    '',
    'Rules:',
    '- start_cmd must start right away in a fresh worktree with no human intervention. Do not use paths that need a login or an external secrets service (Doppler, Infisical, 1Password op, Vault, aws-vault, sixdrop, etc., in the form "<tool> run -- command"), SSO login, interactive input, or per-folder setup (doppler setup, etc.).',
    '  If there is a script variant that starts the same dev server directly (dev:dev, dev:local, etc.), use it; otherwise use the wrapped inner command directly (via npx if it is not an npm script). List the environment values that are then needed in env_keys.',
    '- The tool picks the port, so put {port} in start_cmd (Next: -p {port}, Vite: --port {port} --strictPort, uvicorn: --port {port}). If the app takes the port from an environment variable, as Spring does, use port_env (e.g. SERVER_PORT) and do not put it in the command. When passing arguments to an npm script, add --, as in "npm run dev -- -p {port}".',
    '- For Gradle multi-module builds, start only the app module to run (./gradlew :module:bootRun). A root bootRun fails. If a run profile (spring.profiles.active, etc.) is needed, put it in the command or env_keys.',
    '- setup_cmd: a fresh worktree has no node_modules/.venv, so use the install that matches the lock file (npm ci, pnpm install --frozen-lockfile, uv sync, etc.). If installing needs a private registry token, note it in notes.',
    '- check_cmd: a check that finishes without changing files (build, a single test run). Do not include commands that never finish, like --watch, or formatters (write).',
    '- health_path: a path that responds below 500 without login (/actuator/health if actuator is present, otherwise /).',
    '- app_url: if the dev server starts on HTTPS, https://localhost:{port}; if it must be opened on the certificate\'s domain, https://that-domain:{port}. If HTTP, leave it empty (do not suggest it).',
    '- api_env_key: the name of the environment variable the FE reads the BE address from (NEXT_PUBLIC_API_URL, etc.). Only a name the code actually reads.',
    '- login_path: the path of the FE login screen (e.g. /login). If there is none, do not suggest it.',
    '- If the current value is already right, do not suggest that field. reason is one sentence on why to change it (including the evidence file).',
    '- env_keys: names of environment values that must be set to run right away, with the reason (do not write values or secrets). Empty array if none. Do not include DB connection values (URL, account, password); the tool\'s DB settings screen sets those separately.',
    '- If there is a local profile (application-local.yml, .env.local, etc.), make the run command start with that profile (e.g. SPRING_PROFILES_ACTIVE=local goes in the command, not in env_keys: SPRING_PROFILES_ACTIVE=local ./gradlew :app:bootRun).',
    '- notes: up to two or three things a person should know (e.g. Node version, X-Frame-Options blocks the preview iframe, DB/docker required).',
    '- Write every value meant for people (reason, env_keys reasons, notes) in Korean.',
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
