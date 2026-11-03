// Worktree Studio 데스크톱 앱.
// 이미 떠 있는 Worktree Studio 서버(개발 서버 등)가 있으면 그 서버에 창만 붙이고,
// 없으면 앱에 든 서버를 Electron의 Node로 띄운 뒤 창에서 연다.
const { app, BrowserWindow, Menu, Notification, dialog, shell } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// 기본은 도구 포트(4317). WTS_DESKTOP_PORT로 바꿀 수 있다(같은 PC에서 따로 띄워 볼 때).
const DEFAULT_PORT = Number(process.env.WTS_DESKTOP_PORT) || 4317;
const DATA_DIR = process.env.WTS_DATA_DIR || path.join(os.homedir(), '.worktree-studio');
const LOG_DIR = path.join(DATA_DIR, 'logs');

let win = null;
let server = null;
let baseUrl = null;
/** API 서버 주소. 개발 화면(5317)을 열 때는 화면 주소(baseUrl)와 다르다. */
let apiPort = null;
let quitting = false;
/** 붙어 있던 서버가 내려가 '연결 끊김' 화면을 보여 주는 중인지 */
let offline = false;

/**
 * Dock에서 연 앱은 터미널의 PATH를 받지 못해 git, gh, claude, node, gradle 등을 찾지 못한다.
 * 로그인 셸을 한 번 띄워 그 환경값을 가져온다. rc 파일이 찍는 글자와 섞이지 않게 표시 뒤의 출력만 읽는다.
 */
function loginShellEnv() {
  const shellPath = process.env.SHELL || '/bin/zsh';
  const mark = '__WTS_ENV_START__';
  try {
    const out = execFileSync(shellPath, ['-ilc', `printf '${mark}'; env -0`], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const body = out.slice(out.lastIndexOf(mark) + mark.length);
    const env = {};
    for (const kv of body.split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(kv.slice(0, i))) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env;
  } catch {
    return {};
  }
}

function serverEnv() {
  const env = { ...process.env, ...loginShellEnv() };
  // 셸에서 못 읽었을 때를 대비해 흔한 위치를 덧붙인다.
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', path.join(os.homedir(), '.local/bin')];
  const parts = (env.PATH || '').split(':').filter(Boolean);
  env.PATH = [...parts, ...extra.filter((p) => !parts.includes(p))].join(':');
  // Electron 실행 파일을 Node로 쓴다. 서버가 띄우는 Node 자식(Playwright MCP 등)도 이 값을 물려받는다.
  env.ELECTRON_RUN_AS_NODE = '1';
  env.WTS_DESKTOP = '1';
  return env;
}

function get(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** 그 포트에 Worktree Studio 서버가 떠 있는지 */
async function isStudio(port) {
  const r = await get(`http://127.0.0.1:${port}/api/settings`, 1500);
  if (!r || r.status !== 200) return false;
  try { return 'permissionMode' in JSON.parse(r.body); } catch { return false; }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 50; p++) if (await isPortFree(p)) return p;
  throw new Error('비어 있는 포트를 찾지 못했습니다.');
}

function startServer(port) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.createWriteStream(path.join(LOG_DIR, 'desktop-server.log'), { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} 서버 시작 (포트 ${port}) ---\n`);
  const entry = path.join(app.getAppPath(), 'server', 'dist', 'index.js');
  const child = spawn(process.execPath, [entry], {
    cwd: os.homedir(),
    env: { ...serverEnv(), WTS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('message', (m) => { if (m && m.type === 'notify') notify(m); });
  child.on('exit', (code, signal) => {
    log.write(`--- 서버 종료 code=${code} signal=${signal} ---\n`);
    server = null;
    if (quitting) return;
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      message: '서버가 멈췄습니다',
      detail: `로그: ${path.join(LOG_DIR, 'desktop-server.log')}`,
      buttons: ['다시 시작', '종료'],
      defaultId: 0,
    });
    if (choice === 0) boot().catch(fail); else app.quit();
  });
  return child;
}

async function waitReady(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!server) throw new Error('서버가 시작하자마자 멈췄습니다.');
    if (await isStudio(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('서버가 시간 안에 뜨지 않았습니다.');
}

function notify(m) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: m.title, body: m.message, silent: !m.sound });
  n.on('click', () => {
    showWindow();
    if (win && m.url) win.loadURL(m.url.replace(/^http:\/\/[^/]+/, baseUrl));
  });
  n.show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: 'Worktree Studio',
    backgroundColor: '#EEF0F3',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  // 새 창 요청.
  // - 미리보기(개발 서버) 페이지가 연 팝업: 앱 안의 작은 창으로 연다. 원래 페이지와의 연결(window.opener)이 살아 있어
  //   인증서 팝업처럼 결과를 원래 페이지로 돌려주고 스스로 닫는 흐름이 브라우저와 똑같이 동작한다.
  //   연결이 필요 없다고 밝힌 팝업(noopener)은 새 미리보기 탭으로 연다.
  // - 그 밖(PR·Jira 링크, "새 창" 버튼 등)은 기본 브라우저로 연다.
  win.webContents.setWindowOpenHandler((details) => {
    const { url, referrer, features } = details;
    if (!/^https?:/.test(url)) return { action: 'deny' };
    const ui = safeOrigin(baseUrl);
    const from = referrer && referrer.url ? safeOrigin(referrer.url) : null;
    // noreferrer로 연 팝업은 출처가 비어 온다. 그때는 주소가 로컬 서버(이 화면이 아닌 localhost·127.0.0.1)면 미리보기에서 연 것으로 본다.
    // 이 화면의 링크(새 창 버튼 등)는 출처를 보내도록 해 두어 여기에 걸리지 않는다.
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    const fromPreview = from ? from !== ui : (safeOrigin(url) !== ui && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host));
    if (fromPreview) {
      if (/\bnoopener\b/.test(features || '') || details.disposition === 'background-tab') {
        win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('wts:preview-popup', { detail: ${JSON.stringify(url)} }))`).catch(() => {});
        return { action: 'deny' };
      }
      return { action: 'allow', overrideBrowserWindowOptions: popupOptions(features) };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // 미리보기 팝업 창 안에서 또 여는 팝업도 같은 방식으로 앱 안 창으로 연다.
  win.webContents.on('did-create-window', attachPopup);
  win.webContents.on('will-navigate', (e, url) => {
    if (baseUrl && !url.startsWith(baseUrl) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(baseUrl);
}

function safeOrigin(u) {
  try { return new URL(u).origin; } catch { return null; }
}

const loopbackCache = new Map();
/** 그 호스트가 이 PC(루프백)를 가리키는지. 개발 서버·로컬 목업 인증 서버만 골라 낸다. */
function isLoopbackHost(host) {
  if (loopbackCache.has(host)) return Promise.resolve(loopbackCache.get(host));
  return new Promise((resolve) => {
    require('node:dns').lookup(host, (err, address) => {
      const ok = !err && (/^127\./.test(address) || address === '::1');
      loopbackCache.set(host, ok);
      resolve(ok);
    });
  });
}

/**
 * 미리보기 iframe에서 로컬 서버(이 PC를 가리키는 주소)가 X-Frame-Options·CSP frame-ancestors로 프레임을 막으면
 * "연결을 거부했습니다"가 뜬다. 앱 안의 미리보기에서만 쓰는 것이라 로컬 서버의 프레임 안 응답에서는 그 헤더를 뺀다.
 */
function allowLocalFraming(ses) {
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'subFrame') { callback({}); return; }
    let host;
    try { host = new URL(details.url).hostname.replace(/^\[|\]$/g, ''); } catch { callback({}); return; }
    isLoopbackHost(host).then((local) => {
      if (!local) { callback({}); return; }
      const headers = {};
      for (const [k, v] of Object.entries(details.responseHeaders || {})) {
        const key = k.toLowerCase();
        if (key === 'x-frame-options') continue;
        if (key === 'content-security-policy') {
          headers[k] = v.map((x) => x.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';'));
          continue;
        }
        headers[k] = v;
      }
      callback({ responseHeaders: headers });
    });
  });
}

/** window.open의 features(width=600,height=700 등)를 앱 안 팝업 창 크기로 옮긴다. */
function popupOptions(features) {
  const num = (k) => { const m = new RegExp(`\\b${k}\\s*=\\s*(\\d+)`).exec(features || ''); return m ? Number(m[1]) : null; };
  return {
    parent: win,
    width: Math.max(360, num('width') ?? 900),
    height: Math.max(320, num('height') ?? 760),
    autoHideMenuBar: true,
    backgroundColor: '#FFFFFF',
    webPreferences: { contextIsolation: true, sandbox: true },
  };
}

function attachPopup(child) {
  child.webContents.setWindowOpenHandler(({ url, features }) => (/^https?:/.test(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { ...popupOptions(features), parent: child } }
    : { action: 'deny' }));
  child.webContents.on('did-create-window', attachPopup);
}

function showWindow() {
  if (!baseUrl) return;
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로 고침' },
        { role: 'forceReload', label: '강제 새로 고침' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        { type: 'separator' },
        { label: '브라우저에서 열기', click: () => baseUrl && shell.openExternal(baseUrl) },
        { label: '서버 로그 폴더 열기', click: () => shell.openPath(LOG_DIR) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 개발 화면(Vite, 5317)이 떠 있는지. 떠 있으면 빌드해 둔 화면 대신 지금 코드의 화면을 연다. */
async function devUiUrl() {
  const port = Number(process.env.WTS_DESKTOP_UI_PORT) || 5317;
  // Vite는 IPv6(::1)에만 열리기도 해서 localhost와 127.0.0.1을 다 본다.
  for (const host of ['localhost', '127.0.0.1']) {
    const r = await get(`http://${host}:${port}/`, 1000);
    if (r && r.status === 200 && r.body.includes('/@vite/client')) return `http://${host}:${port}`;
  }
  return null;
}

async function boot() {
  // 개발 서버처럼 이미 떠 있는 Worktree Studio가 있으면 같은 데이터를 두 서버가 동시에 다루지 않도록 그 서버에 붙는다.
  if (await isStudio(DEFAULT_PORT)) {
    apiPort = DEFAULT_PORT;
    baseUrl = (await devUiUrl()) || `http://localhost:${DEFAULT_PORT}`;
  } else {
    const port = await pickPort();
    server = startServer(port);
    await waitReady(port, 60_000);
    apiPort = port;
    // 화면은 localhost로 연다. 미리보기 개발 서버(localhost:포트)와 같은 사이트로 취급돼야 프레임 안 로그인 쿠키가 막히지 않는다.
    baseUrl = `http://localhost:${port}`;
  }
  if (win) win.loadURL(baseUrl); else createWindow();
}

/**
 * 서버에 '데스크톱 앱' 연결을 하나 맺어 알림을 받는다. 앱이 붙은 서버가 개발 서버여도 알림은 앱이 띄운다
 * (서버 쪽 terminal-notifier는 최근 macOS에서 권한 때문에 안 뜨는 경우가 많고, 누르면 브라우저가 열린다).
 */
function connectNotifier() {
  let ws;
  const open = () => {
    if (quitting || !apiPort) return;
    try { ws = new WebSocket(`ws://127.0.0.1:${apiPort}/ws`); } catch { setTimeout(open, 3000); return; }
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', desktop: true }));
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(String(ev.data)); if (m.type === 'notify') notify(m); } catch { /* 다른 이벤트 */ }
    };
    ws.onclose = () => { if (!quitting) setTimeout(open, 3000); };
    ws.onerror = () => { try { ws.close(); } catch { /* 이미 닫힘 */ } };
  };
  open();
}

const OFFLINE_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Worktree Studio</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#EEF0F3;color:#1B2230;font-family:'Apple SD Gothic Neo',system-ui,sans-serif}
div{max-width:460px;padding:28px 32px;background:#fff;border-radius:12px;box-shadow:0 4px 16px rgba(27,34,48,.08)}h1{font-size:18px;margin:0 0 10px}p{margin:0;color:#586274;font-size:14px;line-height:1.6}</style></head>
<body><div><h1>서버와 연결이 끊겼습니다</h1><p>Worktree Studio 서버가 응답하지 않습니다. 개발 서버를 다시 시작하는 중이면 다시 뜨는 대로 저절로 연결합니다.</p></div></body></html>`)}`;

/**
 * 붙어 있던 서버(개발 서버 등)가 내려가면 연결 끊김 화면을 보여 주고, 다시 뜨면 원래 화면을 다시 연다.
 * 앱이 대신 서버를 띄우지 않는다. 개발 서버가 다시 뜰 때 포트를 못 잡게 되기 때문이다.
 */
function watchServer() {
  let failures = 0;
  setInterval(async () => {
    if (quitting || !apiPort || !win) return;
    const up = await isStudio(apiPort);
    if (up) {
      failures = 0;
      if (offline) { offline = false; win.loadURL(baseUrl); }
      return;
    }
    // 앱이 띄운 서버가 멈춘 것은 exit 처리에서 묻는다.
    if (server || offline) return;
    if (++failures >= 2) { offline = true; win.loadURL(OFFLINE_PAGE); }
  }, 2000);
}

function fail(err) {
  dialog.showErrorBox('Worktree Studio를 시작하지 못했습니다', `${err.message}\n\n로그: ${path.join(LOG_DIR, 'desktop-server.log')}`);
  quitting = true;
  app.quit();
}

// 미리보기의 HTTPS 개발 서버(자체 서명·mkcert 인증서)를 연다. 주소가 이 PC(루프백)를 가리킬 때만 인증서 오류를 넘긴다.
app.on('certificate-error', (event, _webContents, url, _error, _cert, callback) => {
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { callback(false); return; }
  event.preventDefault();
  require('node:dns').lookup(host, (err, address) => {
    callback(!err && (/^127\./.test(address) || address === '::1'));
  });
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    buildMenu();
    allowLocalFraming(require('electron').session.defaultSession);
    boot().then(() => { watchServer(); connectNotifier(); }).catch(fail);
  });
  app.on('activate', showWindow);
  // 창을 닫아도 서버와 알림은 계속 돈다(macOS 관례). 완전히 끄려면 종료(⌘Q).
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  // 앱이 띄운 서버를 끈다. 서버는 자기가 띄운 개발 서버도 함께 끈다.
  app.on('before-quit', (e) => {
    quitting = true;
    if (!server) return;
    e.preventDefault();
    const child = server;
    const done = () => { server = null; app.quit(); };
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => { if (server) { child.kill('SIGKILL'); done(); } }, 10_000);
  });
}
