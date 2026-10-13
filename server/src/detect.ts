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
  const be = gradle || maven;
  const compose = exists(dir, 'docker-compose.yml') || exists(dir, 'compose.yaml');
  const kind: Detected['kind'] = (be && fe) || compose ? 'full' : be ? 'be' : fe ? 'fe' : 'unknown';

  if (be && !fe) {
    // Spring Boot는 SERVER_PORT 환경변수를 server.port로 읽는다.
    if (gradle) return { kind, startCmd: './gradlew bootRun', checkCmd: './gradlew build', healthPath: '/actuator/health', portEnv: 'SERVER_PORT' };
    return { kind, startCmd: './mvnw spring-boot:run', checkCmd: './mvnw verify', healthPath: '/actuator/health', portEnv: 'SERVER_PORT' };
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
    return { kind, startCmd: start, checkCmd: checks.length ? checks.join(' && ') : null, healthPath: '/', portEnv: 'PORT' };
  }
  return { kind, startCmd: null, checkCmd: null, healthPath: null, portEnv: null };
}
