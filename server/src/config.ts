import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 도구가 세션 개발 서버로 띄우면 PORT(화면 포트)가 넘어온다. 앱이 쓰는 4317과 겹치지 않게 바로 다음 포트를 쓴다.
// 예전 앱은 자기 WTS_PORT(4317)를 세션 서버에 물려주므로 PORT가 있으면 그쪽을 먼저 본다.
// WTS_API_PORT를 주면 무엇보다 먼저 그 포트를 쓴다(환경값으로 서버 포트를 직접 정할 때).
export const PORT = Number(process.env.WTS_API_PORT || (process.env.PORT ? Number(process.env.PORT) + 1 : (process.env.WTS_PORT ?? 4317)));
// 다른 도구가 세션 개발 서버로 띄운 것인지. 이때는 그 도구와 studio.db를 같이 쓰므로 그 도구가 띄운 서버를 건드리면 안 된다.
export const SESSION_SERVER = Boolean(process.env.WTS_API_PORT || process.env.PORT);
export const HOST = process.env.WTS_HOST ?? '127.0.0.1';
export const DATA_DIR = process.env.WTS_DATA_DIR ?? path.join(os.homedir(), '.worktree-studio');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'studio.db');
export const CLAUDE_EXECUTABLE = process.env.WTS_CLAUDE_PATH || undefined;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
