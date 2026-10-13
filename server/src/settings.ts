import { db } from './db.js';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export type Settings = {
  permissionMode: PermissionMode;
  notify: {
    onComplete: boolean;
    onError: boolean;
    onServerFail: boolean;
    os: boolean;
    sound: boolean;
    skipWhenViewing: boolean;
    minSeconds: number;
  };
};

const DEFAULTS: Settings = {
  permissionMode: 'auto',
  notify: { onComplete: true, onError: true, onServerFail: true, os: true, sound: false, skipWhenViewing: true, minSeconds: 30 },
};

export function getSettings(): Settings {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'app'`).get() as { value: string } | undefined;
  if (!row) return structuredClone(DEFAULTS);
  const saved = JSON.parse(row.value) as Partial<Settings>;
  return { ...DEFAULTS, ...saved, notify: { ...DEFAULTS.notify, ...(saved.notify ?? {}) } };
}

export function saveSettings(next: Settings): Settings {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(next));
  return next;
}
