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
  /** 등록할 때 사용자에게 알릴 것(예: 실행 모듈 후보가 여럿) */
  note?: string | null;
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

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'out', 'target', 'bin', 'obj', 'vendor', 'docs', '.next', '.nuxt', 'coverage', 'tmp', 'logs']);

/** settings.gradle(.kts)에 include한 모듈과 그 폴더. projectDir을 바꾼 것도 따른다. */
function gradleModules(root: string): { name: string; dir: string }[] {
  const text = read(root, 'settings.gradle') || read(root, 'settings.gradle.kts');
  if (!text) return [];
  const names = new Set<string>();
  for (const m of text.matchAll(/include\s*\(?([^\n)]*)/g)) {
    for (const q of m[1].matchAll(/["']:?([\w.:-]+)["']/g)) names.add(q[1]);
  }
  return [...names].map((name) => {
    const custom = text.match(new RegExp(`project\\(\\s*["']:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*\\)\\.projectDir\\s*=\\s*(?:file\\(\\s*)?(?:new File\\([^,]+,\\s*)?["']([^"']+)["']`));
    return { name, dir: path.join(root, custom ? custom[1] : name.replaceAll(':', '/')) };
  });
}

/** @SpringBootApplication이 있는 소스 파일이 그 폴더 안에 있는지 얕게 찾는다. */
function hasBootApp(dir: string, depth = 0): boolean {
  if (depth > 9) return false;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.name === 'test' || e.name === 'resources') continue;
      if (hasBootApp(path.join(dir, e.name), depth + 1)) return true;
    } else if (/\.(java|kt)$/.test(e.name) && /@SpringBootApplication/.test(read(dir, e.name))) {
      return true;
    }
  }
  return false;
}

/**
 * Gradle 멀티 모듈이면 Spring Boot 앱 모듈을 찾아 그 모듈만 띄운다(예: ./gradlew :bootstrap:bootRun).
 * 루트에서 그냥 bootRun을 돌리면 모든 모듈에서 bootRun을 찾다가 실패한다.
 * @SpringBootApplication이 있는 모듈이 여럿이면(API·배치 등) 웹 서버로 띄울 모듈을 점수로 고른다:
 *  - bootRun { } 설정이 있으면 +3 (개발 때 띄우는 모듈이라는 표시)
 *  - spring-boot-starter-batch를 쓰거나 이름이 batch·worker·job·scheduler·consumer면 -3
 *  - 이름이 api·web·server·app·bootstrap이면 +1
 * 점수가 같으면 settings.gradle에 먼저 나온 모듈. 고르지 않은 후보는 note로 알려 준다.
 */
function gradleBootTask(root: string): { cmd: string; note: string | null } {
  const boot = gradleModules(root).filter((m) => hasBootApp(path.join(m.dir, 'src', 'main')));
  if (boot.length === 0) return { cmd: './gradlew bootRun', note: null };
  const score = (m: { name: string; dir: string }) => {
    const build = read(m.dir, 'build.gradle') || read(m.dir, 'build.gradle.kts');
    const last = m.name.split(':').pop() ?? m.name;
    let n = 0;
    if (/^\s*(tasks\.named\(["']bootRun["']\)|bootRun\s*\{)/m.test(build)) n += 3;
    if (/starter-batch/.test(build) || /batch|worker|job|scheduler|consumer/i.test(last)) n -= 3;
    if (/api|web|server|app|bootstrap/i.test(last)) n += 1;
    return n;
  };
  const ranked = boot.map((m, i) => ({ m, i, n: score(m) })).sort((a, b) => b.n - a.n || a.i - b.i);
  const others = ranked.slice(1).map((r) => `:${r.m.name}`);
  return {
    cmd: `./gradlew :${ranked[0].m.name}:bootRun`,
    note: others.length ? `실행 모듈로 :${ranked[0].m.name}을 골랐습니다. 다른 Spring Boot 앱: ${others.join(', ')} (실행 명령에서 바꿀 수 있습니다)` : null,
  };
}

/** actuator가 있어야 /actuator/health로 확인한다. 없으면 루트 경로가 응답하는지만 본다. */
function springHealth(root: string): string {
  const files = [read(root, 'build.gradle'), read(root, 'build.gradle.kts'), read(root, 'pom.xml'),
    ...gradleModules(root).flatMap((m) => [read(m.dir, 'build.gradle'), read(m.dir, 'build.gradle.kts')]),
    read(root, 'gradle/libs.versions.toml')].join('\n');
  return /actuator/.test(files) ? '/actuator/health' : '/';
}

export type DetectedApp = { subdir: string; detected: Detected };

/**
 * 저장소 안의 앱들을 찾는다. 루트와 깊이 2까지의 하위 폴더에서 FE(package.json), BE(Gradle·Maven), 파이썬 앱을 본다.
 * 루트에 Gradle 빌드가 있으면 하위 Gradle 모듈은 루트 빌드의 일부로 보고 따로 세지 않는다.
 * 앱이 하나면 지금처럼 루트를 한 프로젝트로 등록하고, 여럿이면 앱마다 등록한다.
 */
export function detectApps(root: string): DetectedApp[] {
  const rootJvm = exists(root, 'build.gradle') || exists(root, 'build.gradle.kts') || exists(root, 'settings.gradle') || exists(root, 'settings.gradle.kts') || exists(root, 'pom.xml');
  const dirs: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      dirs.push(sub);
      walk(sub, depth + 1);
    }
  };
  walk(root, 1);
  const apps: DetectedApp[] = [];
  for (const dir of dirs) {
    const isJvm = exists(dir, 'build.gradle') || exists(dir, 'build.gradle.kts') || exists(dir, 'pom.xml');
    // 루트 Gradle/Maven 빌드의 하위 모듈이거나, 이미 찾은 앱 안의 폴더면 건너뛴다.
    if (isJvm && rootJvm) continue;
    if (apps.some((a) => dir.startsWith(path.join(root, a.subdir) + path.sep))) continue;
    const hasPkg = exists(dir, 'package.json');
    const hasPy = exists(dir, 'pyproject.toml') || exists(dir, 'requirements.txt') || exists(dir, 'manage.py');
    if (!isJvm && !hasPkg && !hasPy) continue;
    const d = detectProject(dir);
    // 실행할 수 없는 라이브러리 패키지(예: packages/utils)는 앱으로 보지 않는다.
    if (d.kind === 'unknown' || !d.startCmd) continue;
    apps.push({ subdir: path.relative(root, dir), detected: d.kind === 'full' ? { ...d, kind: 'be' } : d });
  }
  if (apps.length === 0) return [{ subdir: '', detected: detectProject(root) }];
  // 루트에도 앱(예: Gradle 백엔드)이 있으면 함께 등록한다. docker-compose만 있는 루트는 앱이 아니다.
  const rootApp = detectProject(root, { ignoreCompose: true });
  if (rootApp.startCmd && rootApp.kind !== 'unknown') apps.unshift({ subdir: '', detected: rootApp });
  return apps;
}

/** 폴더 안의 빌드 파일을 보고 BE/FE/통합을 추정한다. 사용자가 나중에 고칠 수 있다. */
export function detectProject(dir: string, opts: { ignoreCompose?: boolean } = {}): Detected {
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
  const compose = !opts.ignoreCompose && (exists(dir, 'docker-compose.yml') || exists(dir, 'compose.yaml'));
  const kind: Detected['kind'] = (be && fe) || compose ? 'full' : be ? 'be' : fe ? 'fe' : 'unknown';

  if (be && !fe) {
    // Spring Boot는 SERVER_PORT 환경변수를 server.port로 읽는다.
    if (gradle) { const boot = gradleBootTask(dir); return { kind, startCmd: boot.cmd, checkCmd: './gradlew build', healthPath: springHealth(dir), portEnv: 'SERVER_PORT', setupCmd: null, note: boot.note }; }
    return { kind, startCmd: './mvnw spring-boot:run', checkCmd: './mvnw verify', healthPath: springHealth(dir), portEnv: 'SERVER_PORT', setupCmd: null };
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
