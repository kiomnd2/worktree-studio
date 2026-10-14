import type { WebSocket } from 'ws';

export type ServerEvent =
  | { type: 'session.updated'; sessionId: number }
  | { type: 'sessions.changed' }
  | { type: 'message'; sessionId: number; message: { id: number; kind: string; payload: unknown; created_at: string } }
  | { type: 'server.updated'; sessionId: number }
  | { type: 'log'; sessionId: number; worktreeId: number; lines: LogLine[] }
  | { type: 'pr.updated'; sessionId: number }
  | { type: 'screens.updated'; sessionId: number }
  | { type: 'cleanup.changed' }
  | { type: 'approvals.updated'; sessionId: number }
  | { type: 'docs.updated'; sessionId: number }
  | { type: 'tests.updated'; sessionId: number }
  | { type: 'tasks.updated'; sessionId: number };

export type LogLine = { seq: number; t: number; stream: 'out' | 'err' | 'sys'; level: 'error' | 'warn' | 'info'; text: string };

type Client = { socket: WebSocket; viewing: number | null; visible: boolean };
const clients = new Set<Client>();

export function addClient(socket: WebSocket) {
  const client: Client = { socket, viewing: null, visible: true };
  clients.add(client);
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
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

/** 사용자가 이 세션을 지금 화면에 띄워 보고 있는지 */
export function isViewing(sessionId: number): boolean {
  for (const c of clients) if (c.visible && c.viewing === sessionId) return true;
  return false;
}
