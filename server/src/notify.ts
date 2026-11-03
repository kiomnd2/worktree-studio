import notifier from 'node-notifier';
import { spawn } from 'node:child_process';
import { HOST, PORT } from './config.js';
import { getSettings } from './settings.js';
import { isViewing, sendToDesktop } from './hub.js';

function openUrl(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

export function sendNotification(title: string, message: string, sessionId?: number) {
  const s = getSettings();
  if (!s.notify.os) return;
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/${sessionId ? `?session=${sessionId}` : ''}`;
  // 데스크톱 앱이 켜져 있으면(이 서버에 붙어 있든 앱이 띄운 서버든) 앱이 알림을 띄운다.
  // 누르면 브라우저 대신 앱 창에서 그 세션을 연다. terminal-notifier는 최근 macOS에서 권한 때문에 안 뜨는 경우가 많다.
  if (sendToDesktop({ title, message, url, sound: s.notify.sound })) return;
  if (process.env.WTS_DESKTOP && process.send) {
    process.send({ type: 'notify', title, message, url, sound: s.notify.sound });
    return;
  }
  // terminal-notifier 실행 파일을 못 띄우면(Apple Silicon에서 Rosetta 없음 등) 동기로 던져 서버가 죽는다. 알림만 건너뛴다.
  try {
    notifier.notify({ title, message, sound: s.notify.sound, wait: true }, () => {});
    notifier.once('click', () => openUrl(url));
  } catch { /* 알림을 띄울 수 없음 */ }
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
