import fs from 'node:fs';
import path from 'node:path';

export type Detected = {
  kind: 'be' | 'fe' | 'full' | 'unknown';
  /** {port} 자리에 배정된 포트가 들어간다 */
  startCmd: string | null;
  checkCmd: string | null;
  healthPath: string | null;
  /** 포트를 환경변수로 받는 프로젝트라면 그 이름 */
  portEnv: string | null;
  /** 새 워크트리에서 처음 실행하기 전에 한 번 돌릴 의존성 설치 명령 */
  setupCmd: string | null;
};

function exists(dir: string, file: string) {
  return fs.existsSync(path.join(dir, file));
}

function packageManager(dir: string) {
  if (exists(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(dir, 'yarn.lock')) return 'yarn';
  if (exists(dir, 'bun.lockb') || exists(dir, 'bun.lock')) return 'bun';
  return 'npm';
}

function read(dir: string, file: string): string {
  try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return ''; }
}

const PY_SKIP = new Set(['.venv', 'venv', 'node_modules', '.git', '__pycache__', 'tests', 'test', 'migrations', 'alembic', 'docs', 'scripts']);

/** 파이썬 파일을 얕게(깊이 3) 훑는다. 앱 진입점은 보통 루트나 src/패키지 바로 아래에 있다. */
function pyFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length > 400) return out;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory() && !PY_SKIP.has(e.name) && !e.name.startsWith('.')) pyFiles(path.join(dir, e.name), depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.py')) out.push(path.join(dir, e.name));
  }
  return out;
}

/** "src/drms/main.py" → "drms.main". src 레이아웃은 패키지로 설치되므로 src/를 뗀다. */
function moduleOf(root: string, file: string): string {
  return path.relative(root, file).replace(/\.py$/, '').replace(/^src[\\/]/, '').split(path.sep).join('.');
}

type PyApp = { framework: 'fastapi' | 'flask' | 'django'; target: string | null };

function findPyApp(dir: string, deps: string): PyApp | null {
  if (exists(dir, 'manage.py') && /django/i.test(deps)) return { framework: 'django', target: null };
  const files = pyFiles(dir).sort((a, b) => Number(!/(main|app|asgi|wsgi|server)\.py$/.test(a)) - Number(!/(main|app|asgi|wsgi|server)\.py$/.test(b)));
  for (const f of files) {
    const text = read(path.dirname(f), path.basename(f));
    const asgi = text.match(/^(\w+)\s*(?::\s*\w+\s*)?=\s*(?:fastapi\.)?(FastAPI|Starlette)\(/m);
    if (asgi) return { framework: 'fastapi', target: `${moduleOf(dir, f)}:${asgi[1]}` };
    const flask = text.match(/^(\w+)\s*=\s*(?:flask\.)?Flask\(/m);
    if (flask) return { framework: 'flask', target: `${moduleOf(dir, f)}:${flask[1]}` };
  }
  if (/fastapi|starlette/i.test(deps)) return { framework: 'fastapi', target: null };
  if (/flask/i.test(deps)) return { framework: 'flask', target: null };
  return null;
}

/** 패키지 관리 도구에 맞춰 실행 접두어와 설치 명령을 고른다. 워크트리에는 .venv가 없어서 설치가 먼저 필요하다. */
function pythonTool(dir: string, pyproject: string): { run: string; setup: string } {
  if (exists(dir, 'uv.lock') || /\[tool\.uv\]|\[dependency-groups\]/.test(pyproject)) return { run: 'uv run ', setup: 'uv sync' };
  if (exists(dir, 'poetry.lock') || /\[tool\.poetry\]/.test(pyproject)) return { run: 'poetry run ', setup: 'poetry install' };
  if (exists(dir, 'Pipfile')) return { run: 'pipenv run ', setup: 'pipenv install --dev' };
  const req = ['requirements-dev.txt', 'requirements.txt'].filter((f) => exists(dir, f)).map((f) => `-r ${f}`).join(' ');
  const install = req || (pyproject ? '-e .' : '');
  return { run: '.venv/bin/', setup: `python3 -m venv .venv${install ? ` && .venv/bin/pip install ${install}` : ''}` };
}

function detectPython(dir: string): Detected | null {
  const pyproject = read(dir, 'pyproject.toml');
  const reqs = ['requirements.txt', 'requirements-dev.txt', 'Pipfile'].map((f) => read(dir, f)).join('\n');
  if (!pyproject && !reqs && !exists(dir, 'manage.py')) return null;
  const deps = `${pyproject}\n${reqs}`;
  const tool = pythonTool(dir, pyproject);
  const app = findPyApp(dir, deps);
  const py = (cmd: string) => `${tool.run}${cmd}`;

  let startCmd: string | null = null;
  let healthPath: string | null = '/';
  if (app?.framework === 'django') {
    startCmd = py('python manage.py runserver 127.0.0.1:{port}');
  } else if (app?.framework === 'fastapi') {
    startCmd = py(`uvicorn ${app.target ?? 'main:app'} --reload --host 127.0.0.1 --port {port}`);
    // 헬스 라우트가 있으면 쓰고, 없으면 FastAPI 기본 문서 페이지로 뜬 것만 확인한다.
    const src = pyFiles(dir).slice(0, 300).map((f) => read(path.dirname(f), path.basename(f))).join('\n');
    healthPath = src.match(/["'](\/(?:api\/)?health[z]?)["']/)?.[1] ?? '/docs';
  } else if (app?.framework === 'flask') {
    startCmd = py(`flask --app ${app.target ?? 'app'} run --debug --port {port}`);
  }

  // 커밋 전 검사는 고치지 않고 확인만 하는 것으로 고른다(ruff format처럼 파일을 바꾸는 명령은 넣지 않는다).
  const checks: string[] = [];
  if (/\bruff\b/.test(deps)) checks.push(py('ruff check .'));
  if (/\bpytest\b/.test(deps)) checks.push(py(`pytest -q${exists(dir, 'tests/unit') ? ' tests/unit' : ''}`));
  else if (app?.framework === 'django') checks.push(py('python manage.py test'));

  return { kind: app ? 'be' : 'unknown', startCmd, checkCmd: checks.length ? checks.join(' && ') : null, healthPath: app ? healthPath : null, portEnv: null, setupCmd: tool.setup };
}

/** 폴더 안의 빌드 파일을 보고 BE/FE/통합을 추정한다. 사용자가 나중에 고칠 수 있다. */
export function detectProject(dir: string): Detected {
  const gradle = exists(dir, 'build.gradle') || exists(dir, 'build.gradle.kts');
  const maven = exists(dir, 'pom.xml');
  let fe = false;
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  if (exists(dir, 'package.json')) {
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
      fe = ['vite', 'next', 'react-scripts', '@angular/core', 'vue', 'nuxt', 'svelte'].some((d) => d in deps);
    } catch { /* unreadable package.json */ }
  }
  // 파이썬 웹 프로젝트는 DB용 docker-compose가 같이 있는 경우가 많아 통합으로 보지 않고 먼저 판단한다.
  if (!gradle && !maven && !fe) {
    const python = detectPython(dir);
    if (python) return python;
  }
  const be = gradle || maven;
  const compose = exists(dir, 'docker-compose.yml') || exists(dir, 'compose.yaml');
  const kind: Detected['kind'] = (be && fe) || compose ? 'full' : be ? 'be' : fe ? 'fe' : 'unknown';

  if (be && !fe) {
    // Spring Boot는 SERVER_PORT 환경변수를 server.port로 읽는다.
    if (gradle) return { kind, startCmd: './gradlew bootRun', checkCmd: './gradlew build', healthPath: '/actuator/health', portEnv: 'SERVER_PORT', setupCmd: null };
    return { kind, startCmd: './mvnw spring-boot:run', checkCmd: './mvnw verify', healthPath: '/actuator/health', portEnv: 'SERVER_PORT', setupCmd: null };
  }
  if (pkg) {
    const pm = packageManager(dir);
    const runScript = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
    // 개발 서버마다 포트를 받는 방식이 달라 인자로 넘긴다. npm은 스크립트 인자 앞에 --가 필요하다.
    const sep = pm === 'npm' ? ' --' : '';
    let portArgs = '';
    if ('vite' in deps) portArgs = `${sep} --port {port} --strictPort`;
    else if ('next' in deps) portArgs = `${sep} -p {port}`;
    else if ('nuxt' in deps) portArgs = `${sep} --port {port}`;
    const start = script ? `${runScript(script)}${portArgs}` : null;
    const checks = ['build', 'test'].filter((s) => scripts[s]).map(runScript);
    // 워크트리에는 node_modules가 없다. 락 파일대로 설치한다.
    const setupCmd = pm === 'npm' ? (exists(dir, 'package-lock.json') ? 'npm ci' : 'npm install') : `${pm} install`;
    return { kind, startCmd: start, checkCmd: checks.length ? checks.join(' && ') : null, healthPath: '/', portEnv: 'PORT', setupCmd };
  }
  return { kind, startCmd: null, checkCmd: null, healthPath: null, portEnv: null, setupCmd: null };
}
