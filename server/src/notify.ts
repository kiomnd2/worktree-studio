import notifier from 'node-notifier';
import { spawn } from 'node:child_process';
import { HOST, PORT } from './config.js';
import { getSettings } from './settings.js';
import { isViewing } from './hub.js';

function openUrl(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

export function sendNotification(title: string, message: string, sessionId?: number) {
  const s = getSettings();
  if (!s.notify.os) return;
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/${sessionId ? `?session=${sessionId}` : ''}`;
  notifier.notify({ title, message, sound: s.notify.sound, wait: true }, () => {});
  notifier.once('click', () => openUrl(url));
}

/** 프롬프트 작업이 끝났을 때 설정에 맞으면 알린다. */
export function notifyRunFinished(opts: { sessionId: number; ticket: string; ok: boolean; durationMs: number; summary: string }) {
  const s = getSettings();
  if (opts.ok && !s.notify.onComplete) return;
  if (!opts.ok && !s.notify.onError) return;
  if (opts.ok && opts.durationMs < s.notify.minSeconds * 1000) return;
  if (s.notify.skipWhenViewing && isViewing(opts.sessionId)) return;
  const title = opts.ok ? `${opts.ticket} 작업 완료` : `${opts.ticket} 작업이 멈췄습니다`;
  sendNotification(title, opts.summary.slice(0, 140) || (opts.ok ? '결과를 확인하세요.' : '오류를 확인하세요.'), opts.sessionId);
}
