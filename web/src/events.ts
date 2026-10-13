import { useEffect, useRef } from 'react';
import type { ServerEvent } from './types';

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let focus: { sessionId: number | null } = { sessionId: null };

function sendFocus() {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'focus', sessionId: focus.sessionId, visible: document.visibilityState === 'visible' && document.hasFocus() }));
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onopen = sendFocus;
  socket.onmessage = (ev) => {
    const data = JSON.parse(ev.data) as ServerEvent;
    listeners.forEach((l) => l(data));
  };
  socket.onclose = () => setTimeout(connect, 1500);
}
connect();
document.addEventListener('visibilitychange', sendFocus);
window.addEventListener('focus', sendFocus);
window.addEventListener('blur', sendFocus);

/** 지금 보고 있는 세션을 서버에 알려, 보고 있는 세션은 알림을 건너뛰게 한다. */
export function setFocusedSession(sessionId: number | null) {
  focus = { sessionId };
  sendFocus();
}

export function useServerEvents(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
}

/** 로그 줄 같은 텍스트를 프롬프트 입력창에 붙인다. */
export function insertIntoPrompt(text: string) {
  window.dispatchEvent(new CustomEvent('wts:insert-prompt', { detail: text }));
}
