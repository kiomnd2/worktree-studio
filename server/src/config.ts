import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const PORT = Number(process.env.WTS_PORT ?? 4317);
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
