// macOS 앱(.dmg, .zip)을 만든다.
// 1) 웹·서버를 빌드하고 2) 저장소 밖 임시 폴더에 앱에 들어갈 것만 모아 그 안에서만 의존성을 설치한 뒤
// 3) electron-builder로 묶는다. 저장소 안에 두면 electron-builder가 루트를 워크스페이스로 보고 루트 node_modules를 다룬다.
// better-sqlite3는 Node·Electron 공용(N-API) 미리 빌드된 바이너리를 쓰므로 다시 빌드하지 않는다.
// 루트 node_modules는 건드리지 않아 개발 서버(npm run dev)가 그대로 돈다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Arch, build, Platform } from 'electron-builder';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const stage = path.join(os.tmpdir(), 'worktree-studio-stage');
const require = createRequire(import.meta.url);

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('▶ 웹·서버 빌드');
run('npm', ['run', 'build'], root);

console.log('▶ 앱에 넣을 파일 모으기');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, 'server', 'dist'), path.join(stage, 'server', 'dist'), { recursive: true });
fs.writeFileSync(path.join(stage, 'server', 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
fs.cpSync(path.join(root, 'web', 'dist'), path.join(stage, 'web', 'dist'), { recursive: true });
fs.copyFileSync(path.join(desktop, 'main.cjs'), path.join(stage, 'main.cjs'));

// 개발 때 쓰는 것과 같은 버전을 넣는다(루트에 설치된 버전으로 고정).
const rootPkg = readJson(path.join(root, 'package.json'));
const serverPkg = readJson(path.join(root, 'server', 'package.json'));
// 설치 폴더의 package.json에서 버전을 읽는다. require.resolve('<이름>/package.json')은 exports에 따라
// 하위 폴더의 package.json(버전 없음)을 가리킬 수 있어 쓰지 않는다. 못 읽으면 server/package.json의 범위를 쓴다.
const deps = Object.fromEntries(Object.entries(serverPkg.dependencies).map(([name, range]) => {
  for (const dir of [path.join(root, 'server', 'node_modules', name), path.join(root, 'node_modules', name)]) {
    try { const v = readJson(path.join(dir, 'package.json')).version; if (v) return [name, v]; } catch { /* 다음 위치 */ }
  }
  return [name, range];
}));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'worktree-studio',
  productName: 'Worktree Studio',
  version: rootPkg.version,
  description: 'Jira 티켓마다 git 워크트리를 만들고 Claude Code로 작업하는 로컬 도구',
  author: '60Hertz',
  main: 'main.cjs',
  dependencies: deps,
}, null, 2));

console.log('▶ 앱 의존성 설치');
// 루트 워크스페이스와 섞이지 않게 stage를 독립 프로젝트로 설치한다.
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--workspaces=false', '--install-links=false'], stage);

console.log('▶ 패키징');
const electronVersion = readJson(require.resolve('electron/package.json')).version;
const result = await build({
  targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
  projectDir: stage,
  config: {
    appId: 'io.sixtyhz.worktree-studio',
    productName: 'Worktree Studio',
    electronVersion,
    directories: { output: path.join(desktop, 'release'), buildResources: path.join(desktop, 'build') },
    // Claude·Playwright 실행 파일을 직접 띄우므로 asar로 묶지 않는다.
    asar: false,
    npmRebuild: false,
    // better-sqlite3의 다른 OS용 바이너리와 C 소스는 뺀다.
    files: ['**/*', '!node_modules/better-sqlite3/{deps,src}/**', '!node_modules/better-sqlite3/prebuilds/{win32,linux,linuxmusl}-*.node', '!node_modules/better-sqlite3/prebuilds/darwin-x64.node'],
    mac: {
      category: 'public.app-category.developer-tools',
      icon: path.join(desktop, 'build', 'icon.png'),
      // Apple 개발자 서명(CSC_NAME)이 없으면 ad-hoc('-')으로 서명한다. Apple Silicon은 서명이 깨진 앱을 열지 않는다.
      // ad-hoc 앱은 내 Mac에서는 바로 열리고, 내려받은 다른 Mac에서는 우클릭 → 열기로 한 번 허용해야 한다.
      identity: process.env.CSC_NAME || '-',
      // 강화된 런타임은 공증할 때만 필요하다. ad-hoc 서명에서 켜면 네이티브 모듈·Claude 실행 파일을 못 불러올 수 있다.
      hardenedRuntime: Boolean(process.env.CSC_NAME),
      extendInfo: { NSUserNotificationAlertStyle: 'alert' },
    },
    dmg: { title: 'Worktree Studio ${version}' },
  },
});
// 묶인 앱에서 서버가 실제로 뜨는지 확인한다(빠진 모듈이 있으면 여기서 실패한다). 임시 데이터 폴더와 빈 포트를 쓴다.
console.log('▶ 묶인 앱의 서버 시작 확인');
const appDir = path.join(desktop, 'release', 'mac-arm64', 'Worktree Studio.app');
const missing = Object.keys(serverPkg.dependencies).filter((n) => !fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'app', 'node_modules', n, 'package.json')));
if (missing.length) throw new Error(`앱에 빠진 모듈: ${missing.join(', ')}`);
{
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-smoke-'));
  const child = spawn(path.join(appDir, 'Contents', 'MacOS', 'Worktree Studio'), [path.join(appDir, 'Contents', 'Resources', 'app', 'server', 'dist', 'index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WTS_PORT: String(port), WTS_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let ok = false;
  for (let i = 0; i < 60 && child.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ok = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.ok, () => false);
    if (ok) break;
  }
  child.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!ok) throw new Error(`묶인 앱에서 서버가 뜨지 않았습니다.\n${stderr.split('\n').slice(-15).join('\n')}`);
  console.log('  서버가 정상으로 떴습니다.');
}
console.log('\n✔ 완료');
for (const f of result) console.log('  ' + path.relative(root, f));
