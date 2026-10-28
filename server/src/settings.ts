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
    onPr: boolean;
    onCleanup: boolean;
  };
  cleanup: {
    stopServersOnPr: boolean;
    /** PR이 머지되거나 닫히면 확인 없이 정리한다. 미커밋 변경이 있으면 이 설정과 상관없이 남긴다. */
    autoCleanMerged: boolean;
    deleteRemoteBranch: boolean;
    pollMinutes: number;
    staleDays: number;
  };
  /** 대화(세션·추가 대화·DB 대화)에 쓸 모델. 빈 값이면 Claude Code 기본 모델. */
  defaultModel: string;
  /** 보조 호출(models.ts HELPER_PURPOSES)마다 쓸 모델. 없거나 빈 값이면 defaultModel. */
  helperModels: Record<string, string>;
};

const DEFAULTS: Settings = {
  permissionMode: 'auto',
  notify: { onComplete: true, onError: true, onServerFail: true, os: true, sound: false, skipWhenViewing: true, minSeconds: 30, onPr: true, onCleanup: true },
  cleanup: { stopServersOnPr: true, autoCleanMerged: false, deleteRemoteBranch: false, pollMinutes: 10, staleDays: 7 },
  defaultModel: '',
  helperModels: {},
};

export function getSettings(): Settings {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'app'`).get() as { value: string } | undefined;
  if (!row) return structuredClone(DEFAULTS);
  const saved = JSON.parse(row.value) as Partial<Settings>;
  return {
    ...DEFAULTS, ...saved,
    notify: { ...DEFAULTS.notify, ...(saved.notify ?? {}) },
    cleanup: { ...DEFAULTS.cleanup, ...(saved.cleanup ?? {}) },
    helperModels: { ...(saved.helperModels ?? {}) },
  };
}

export function saveSettings(next: Settings): Settings {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(next));
  return next;
}
