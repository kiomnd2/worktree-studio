import fs from 'node:fs';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { looksSecret } from './secret.js';
import { recordUsage } from './usage.js';
import { helperModel } from './models.js';

export type FoundVar = {
  key: string;
  value: string;
  required: boolean;
  secret: boolean;
  source: 'detected' | 'ai' | 'clone';
  found_in: string | null;
  reason?: string;
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.gradle', '.idea', '.vscode', 'coverage', 'vendor', '.turbo', '.cache', 'bin', 'obj',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', 'site-packages',
]);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.kt', '.kts', '.java', '.groovy', '.py']);
/** 테스트 코드는 환경변수를 직접 넣어 쓰는 경우가 많아 필요한 값으로 보지 않는다. */
const PY_TEST = /(^|[\\/])(tests?|conftest\.py$|test_[^\\/]*\.py$)/;
const CONF_EXT = new Set(['.yml', '.yaml', '.properties']);
const EXAMPLE_FILE = /^\.env(\.[\w-]+)*\.(example|sample|template|dist)$|^\.env\.(example|sample|template)$/;
const VITE_BUILTIN = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);
const NODE_BUILTIN = new Set(['NODE_ENV', 'HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'TZ', 'CI']);

function* walk(root: string, limit = 8000): Generator<string> {
  const stack = [root];
  let n = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name)); continue; }
      if (!e.isFile()) continue;
      if (++n > limit) return;
      yield path.join(dir, e.name);
    }
  }
}

function readSmall(file: string): string | null {
  try {
    if (fs.statSync(file).size > 512 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/** KEY=VALUE 형식을 읽는다. 따옴표와 export, 주석을 처리한다. */
export function parseDotenv(text: string): { key: string; value: string; line: number }[] {
  const out: { key: string; value: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push({ key: m[1], value: v, line: i + 1 });
  });
  return out;
}

/**
 * 워크트리를 정적으로 훑어 필요한 환경변수를 찾는다.
 * cloneDir가 있으면 원본 클론 폴더의 .env(커밋되지 않아 워크트리에는 없는 파일)에서 값을 가져온다.
 */
export function scanEnv(dir: string, cloneDir?: string): FoundVar[] {
  const found = new Map<string, FoundVar>();
  const add = (v: FoundVar) => {
    const cur = found.get(v.key);
    if (!cur) { found.set(v.key, v); return; }
    if (v.required && !cur.required) { cur.required = true; cur.found_in = v.found_in; }
    if (!cur.value && v.value) cur.value = v.value;
    cur.found_in ??= v.found_in;
  };
  const rel = (f: string, line: number) => `${path.relative(dir, f)}:${line}`;

  for (const file of walk(dir)) {
    const base = path.basename(file);
    const ext = path.extname(file);
    if (EXAMPLE_FILE.test(base)) {
      const text = readSmall(file);
      if (!text) continue;
      for (const e of parseDotenv(text)) {
        add({ key: e.key, value: e.value, required: e.value === '', secret: looksSecret(e.key), source: 'detected', found_in: rel(file, e.line) });
      }
      continue;
    }
    if (!CODE_EXT.has(ext) && !CONF_EXT.has(ext)) continue;
    const text = readSmall(file);
    if (!text) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      // ${KEY} 또는 ${KEY:default} (Spring 설정, @Value)
      for (const m of line.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::([^}]*))?\}/g)) {
        // 코드 파일에서는 문자열 템플릿과 헷갈리지 않게 @Value 같은 설정 참조 줄만 본다.
        if (!CONF_EXT.has(ext) && !/@Value|getProperty|environment\./.test(line)) continue;
        // 셸·compose 문법 ${KEY:-기본값}의 "-"는 기본값에 들어가지 않는다.
        const def = m[2]?.replace(/^-/, '');
        add({ key: m[1], value: def ?? '', required: def === undefined, secret: looksSecret(m[1]), source: 'detected', found_in: rel(file, i + 1) });
      }
      if (!CODE_EXT.has(ext)) return;
      for (const m of line.matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g)) {
        const key = m[1] ?? m[2];
        if (!NODE_BUILTIN.has(key)) add({ key, value: '', required: false, secret: looksSecret(key), source: 'detected', found_in: rel(file, i + 1) });
      }
      for (const m of line.matchAll(/import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g)) {
        if (!VITE_BUILTIN.has(m[1])) add({ key: m[1], value: '', required: false, secret: looksSecret(m[1]), source: 'detected', found_in: rel(file, i + 1) });
      }
      for (const m of line.matchAll(/System\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g)) {
        add({ key: m[1], value: '', required: false, secret: looksSecret(m[1]), source: 'detected', found_in: rel(file, i + 1) });
      }
      if (ext === '.py' && !PY_TEST.test(path.relative(dir, file))) {
        // os.environ["KEY"]는 없으면 KeyError라 필수. 대입문(os.environ["KEY"] = ...)은 읽는 게 아니라 뺀다.
        for (const m of line.matchAll(/os\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\](?!\s*=[^=])/g)) {
          add({ key: m[1], value: '', required: true, secret: looksSecret(m[1]), source: 'detected', found_in: rel(file, i + 1) });
        }
        // os.environ.get("KEY", "기본값") / os.getenv("KEY", "기본값")은 기본값이 있으면 선택.
        for (const m of line.matchAll(/os\.(?:environ\.get|getenv)\(\s*['"]([A-Z_][A-Z0-9_]*)['"](?:\s*,\s*['"]([^'"]*)['"])?/g)) {
          add({ key: m[1], value: m[2] ?? '', required: false, secret: looksSecret(m[1]), source: 'detected', found_in: rel(file, i + 1) });
        }
      }
    });
  }

  if (cloneDir) {
    for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
      const file = path.join(cloneDir, name);
      const text = fs.existsSync(file) ? readSmall(file) : null;
      if (!text) continue;
      for (const e of parseDotenv(text)) {
        const cur = found.get(e.key);
        if (cur) { if (e.value) { cur.value = e.value; cur.source = 'clone'; cur.found_in = `클론 ${name}:${e.line}`; } }
        else found.set(e.key, { key: e.key, value: e.value, required: false, secret: looksSecret(e.key), source: 'clone', found_in: `클론 ${name}:${e.line}` });
      }
    }
  }
  return [...found.values()].sort((a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key));
}

/** API 주소로 쓰일 법한 FE 환경변수 이름을 고른다. */
export function guessApiEnvKey(vars: FoundVar[]): string | null {
  const re = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|NUXT_PUBLIC_)?.*(API|BACKEND|SERVER|BFF).*(URL|HOST|BASE|ORIGIN|ENDPOINT)$/;
  return vars.find((v) => re.test(v.key))?.key ?? null;
}

const AI_SCHEMA = {
  type: 'object',
  properties: {
    vars: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          required: { type: 'boolean' },
          default: { type: 'string' },
          found_in: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['key', 'required', 'found_in', 'reason'],
      },
    },
  },
  required: ['vars'],
};

/** Claude에게 읽기 도구만 주고 로컬 실행에 필요한 환경변수를 분석하게 한다. */
export async function analyzeEnvWithAI(dir: string, known: string[]): Promise<FoundVar[]> {
  const prompt = [
    '이 프로젝트를 로컬에서 개발 서버로 실행하는 데 필요한 환경변수를 찾아줘.',
    '설정 파일(application*.yml, .env.example 등), 코드의 환경변수 참조, README의 실행 방법을 확인해.',
    '포트(PORT, SERVER_PORT)는 도구가 정하니 빼고, 기본값이 있어 비워도 실행되는 값은 required=false로 해.',
    '목표는 이 컴퓨터에서 바로 뜨는 로컬 실행이다. default에는 로컬 기준 값을 넣어: localhost 주소, docker-compose 파일에 적힌 로컬 DB·Redis 계정과 포트, 로컬 프로필(application-local.yml, .env.example 등)의 개발용 값, mock·local 모드 스위치(예: AUTH_MODE=mock).',
    '운영·스테이징 주소, 실제 비밀값(토큰·키)은 default에 넣지 않는다(로컬에서 꼭 필요하면 required=true로 비워 둔다).',
    'DB 접속값(DB URL·계정·비밀번호, SPRING_DATASOURCE_*, DATABASE_URL 등)은 도구의 DB 설정이 따로 넣으므로 required=false로 하고 reason에 "DB 설정에서 넣음"이라고 적어.',
    'found_in은 "상대경로:줄번호", reason은 한 문장 한국어로.',
    known.length ? `이미 찾은 키: ${known.join(', ')}. 이것들도 필수 여부를 다시 판단해서 포함해.` : '',
  ].join('\n');
  let structured: unknown = null;
  const q = query({
    prompt,
    options: {
      cwd: dir,
      tools: ['Read', 'Grep', 'Glob'],
      // 사용자 플러그인·훅을 불러오지 않는다. 훅이 작업 폴더에 상태 파일(.bkit/ 등)을 만들면 PR 커밋에 섞인다.
      settingSources: [],
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'dontAsk',
      maxTurns: 40,
      persistSession: false,
      model: helperModel('env_scan'),
      outputFormat: { type: 'json_schema', schema: AI_SCHEMA },
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    },
  });
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === 'result') {
      recordUsage(msg, { purpose: 'env_scan', cwd: dir });
      if (msg.subtype !== 'success') throw new Error('AI 분석이 끝나지 못했습니다. 다시 시도하거나 직접 추가하세요.');
      if (msg.is_error) throw new Error(msg.result || 'AI 분석 중 오류가 났습니다.');
      structured = msg.structured_output ?? safeJson(msg.result);
    }
  }
  const list = (structured as { vars?: { key: string; required: boolean; default?: string; found_in: string; reason: string }[] } | null)?.vars ?? [];
  return list
    .filter((v) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v.key) && !['PORT', 'SERVER_PORT'].includes(v.key))
    .map((v) => ({ key: v.key, value: v.default ?? '', required: Boolean(v.required), secret: looksSecret(v.key), source: 'ai' as const, found_in: v.found_in || null, reason: v.reason }));
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
