import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// 세션 개발 서버로 뜨면 PORT를 받는다. 화면은 그 포트에, 서버는 바로 다음 포트에 뜬다(server/src/config.ts와 같은 규칙).
// WTS_API_PORT가 있으면 서버는 그 포트에 뜨므로 프록시도 그쪽으로 보낸다.
const webPort = Number(process.env.PORT ?? 5317);
const apiPort = Number(process.env.WTS_API_PORT || (process.env.PORT ? webPort + 1 : (process.env.WTS_PORT ?? 4317)));
const api = `http://127.0.0.1:${apiPort}`;

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/**
 * 도구가 세션 개발 서버로 web/만 띄우면(PORT 있음) API 서버를 같이 띄운다. 짝 포트에 이미 서버가 있으면 그대로 쓴다.
 * 루트 npm run dev는 서버를 따로 띄우므로 dev:ui로 들어오면 띄우지 않는다(둘이 같은 포트를 두고 다툰다).
 * WTS_WEB_ONLY=1이어도 띄우지 않는다.
 */
function sessionApi(): Plugin {
  let child: ChildProcess | null = null;
  const stop = () => {
    if (!child?.pid) return;
    try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
    child = null;
  };
  return {
    name: 'session-api',
    apply: 'serve',
    async configureServer(server) {
      if (!process.env.PORT || process.env.WTS_WEB_ONLY === '1' || process.env.npm_lifecycle_event === 'dev:ui') return;
      if (await listening(apiPort)) return;
      child = spawn('npm', ['run', 'dev', '-w', 'server'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, WTS_API_PORT: String(apiPort) },
        stdio: 'inherit',
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
      });
      server.httpServer?.once('close', stop);
      process.once('exit', stop);
    },
  };
}

export default defineConfig({
  plugins: [react(), sessionApi()],
  server: {
    port: webPort,
    // 세션 서버는 짝 포트(PORT+1)로 API를 찾으므로 다른 포트로 비켜 뜨면 안 된다.
    strictPort: !!process.env.PORT,
    proxy: {
      '/api': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
