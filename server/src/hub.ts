import type { WebSocket } from 'ws';

export type ServerEvent =
  | { type: 'session.updated'; sessionId: number }
  | { type: 'sessions.changed' }
  | { type: 'message'; sessionId: number; message: { id: number; chat_id: number; kind: string; payload: unknown; created_at: string } }
  | { type: 'server.updated'; sessionId: number }
  | { type: 'log'; sessionId: number; worktreeId: number; lines: LogLine[] }
  | { type: 'pr.updated'; sessionId: number }
  | { type: 'screens.updated'; sessionId: number }
  | { type: 'cleanup.changed' }
  | { type: 'approvals.updated'; sessionId: number }
  | { type: 'docs.updated'; sessionId: number }
  | { type: 'tests.updated'; sessionId: number }
  | { type: 'tasks.updated'; sessionId: number }
  /** 화면 테스트 케이스 하나가 끝남 */
  | { type: 'test.result'; sessionId: number; ticket: string; caseId: number; title: string; status: string; summary: string; index: number; total: number };

export type LogLine = { seq: number; t: number; stream: 'out' | 'err' | 'sys'; level: 'error' | 'warn' | 'info'; text: string };

/** desktop: 데스크톱 앱(Electron 메인 프로세스)의 연결. 화면이 아니라 알림을 받는 곳이다. */
type Client = { socket: WebSocket; viewing: number | null; visible: boolean; desktop: boolean };
const clients = new Set<Client>();

export function addClient(socket: WebSocket) {
  const client: Client = { socket, viewing: null, visible: false, desktop: false };
  clients.add(client);
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello' && msg.desktop) client.desktop = true;
      if (msg.type === 'focus') {
        client.viewing = typeof msg.sessionId === 'number' ? msg.sessionId : null;
        client.visible = Boolean(msg.visible);
      }
    } catch { /* ignore malformed client messages */ }
  });
  socket.on('close', () => clients.delete(client));
}

export function broadcast(event: ServerEvent) {
  const data = JSON.stringify(event);
  for (const c of clients) {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(data);
  }
}

/** 데스크톱 앱이 연결돼 있으면 알림을 앱으로 보낸다. 보냈으면 true */
export function sendToDesktop(payload: { title: string; message: string; url: string; sound: boolean }): boolean {
  const data = JSON.stringify({ type: 'notify', ...payload });
  let sent = false;
  for (const c of clients) {
    if (c.desktop && c.socket.readyState === c.socket.OPEN) { c.socket.send(data); sent = true; }
  }
  return sent;
}

/** 사용자가 이 세션을 지금 화면에 띄워 보고 있는지 */
export function isViewing(sessionId: number): boolean {
  for (const c of clients) if (c.visible && c.viewing === sessionId) return true;
  return false;
}
