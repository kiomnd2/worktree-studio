import { useEffect, useRef, useState } from 'react';
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

/**
 * 도구 화면(로그, 변경 파일, 문서, 화면 테스트, 미리보기 캡처 등)에서 넘기는 프롬프트는 사용자가 고른 곳(메인 대화나 새 대화 탭)에 넣는다.
 * 새 대화 탭이 이미 열려 있으면 거기에 더한다. 보내기는 사용자가 한다.
 */
export type SendTarget = 'main' | 'new';
export type NewChatItem = ({ text: string } | { image: { mediaType: string; data: string; name: string } }) & { target: SendTarget };
let newChatPending: NewChatItem[] = [];

const SEND_TARGET_KEY = 'wts:send-target';
let sendTarget: SendTarget = (() => { try { return localStorage.getItem(SEND_TARGET_KEY) === 'main' ? 'main' : 'new'; } catch { return 'new'; } })();

/** 도구 화면에서 넘길 곳. 마지막으로 고른 곳을 기억한다. */
export const getSendTarget = () => sendTarget;

export function setSendTarget(t: SendTarget) {
  sendTarget = t;
  try { localStorage.setItem(SEND_TARGET_KEY, t); } catch { /* 사생활 보호 모드 등 */ }
  window.dispatchEvent(new CustomEvent('wts:send-target'));
}

/** 넘길 곳이 바뀌면 다시 그린다(보내기 버튼 이름에 쓴다). */
export function useSendTarget(): SendTarget {
  const [t, setT] = useState(sendTarget);
  useEffect(() => {
    const on = () => setT(sendTarget);
    window.addEventListener('wts:send-target', on);
    return () => window.removeEventListener('wts:send-target', on);
  }, []);
  return t;
}

function toNewChat(item: NewChatItem) {
  newChatPending.push(item);
  window.dispatchEvent(new CustomEvent('wts:new-chat', { detail: item.target }));
}

/** 미리보기 캡처 같은 이미지를 대화의 첨부에 넣는다. data는 base64. */
export function attachToPrompt(image: { mediaType: string; data: string; name: string }, target = sendTarget) {
  toNewChat({ image, target });
}

/** 로그 줄 같은 텍스트를 대화의 입력창에 넣는다. 대화 화면이 없으면 나타날 때 넣는다. */
export function insertIntoPrompt(text: string, target = sendTarget) {
  toNewChat({ text, target });
}

/** 넣을 것이 남아 있으면 그 곳(대화 화면이 나타날 때 어느 탭을 열지 정한다) */
export const pendingTarget = (): SendTarget | null => newChatPending[newChatPending.length - 1]?.target ?? null;

/** 입력창이 자기 쪽으로 기다리던 텍스트와 이미지를 가져간다. */
export function takeNewChatPending(target: SendTarget): NewChatItem[] {
  const out = newChatPending.filter((i) => i.target === target);
  newChatPending = newChatPending.filter((i) => i.target !== target);
  return out;
}

/** 오른쪽 패널 미리보기에서 이 경로를 연다. */
export function openInPreview(path: string) {
  window.dispatchEvent(new CustomEvent('wts:preview-open', { detail: path }));
}

/** 대화 화면에서 이 대화 탭을 연다(충돌 해결처럼 도구가 시작한 대화). */
export function openChat(chatId: number) {
  window.dispatchEvent(new CustomEvent('wts:open-chat', { detail: chatId }));
}

/** 세션의 문서 화면을 연다. name이 있으면 그 문서를 고른다. */
export function openDoc(name?: string) {
  window.dispatchEvent(new CustomEvent('wts:open-doc', { detail: name ?? null }));
}
