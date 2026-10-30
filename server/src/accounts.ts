import { db } from './db.js';
import { decrypt, encrypt } from './secret.js';
import { broadcast } from './hub.js';

export type AccountView = {
  id: number; login: string; note: string;
  /** 이 계정을 쓰는 워크스페이스. null이면 모든 워크스페이스에서 쓰는 공용 계정 */
  workspace_id: number | null; workspace_name: string | null;
};

/**
 * 테스트 계정은 세션에 묶지 않는다. 세션은 자기 워크스페이스 계정과 공용 계정을 모두 쓰고,
 * 같은 계정을 여러 세션이 함께 쓴다. (예전에는 세션마다 배정·반납했다. 남은 배정 기록은 지운다.)
 */
db.prepare(`UPDATE test_accounts SET session_id = NULL WHERE session_id IS NOT NULL`).run();

export function listAccounts(): AccountView[] {
  return db.prepare(`SELECT a.id, a.login, a.note, a.workspace_id, w.name AS workspace_name FROM test_accounts a
    LEFT JOIN workspaces w ON w.id = a.workspace_id ORDER BY w.name IS NULL, w.name, a.login`).all() as AccountView[];
}

/** 워크스페이스에서 쓸 수 있는 계정: 그 워크스페이스 계정과 공용 계정. 워크스페이스 계정을 먼저. */
export function accountsForWorkspace(workspaceId: number): AccountView[] {
  return listAccounts().filter((a) => a.workspace_id === null || a.workspace_id === workspaceId)
    .sort((a, b) => Number(a.workspace_id === null) - Number(b.workspace_id === null));
}

function workspaceOfSession(sessionId: number): number | null {
  return (db.prepare(`SELECT workspace_id FROM sessions WHERE id = ?`).get(sessionId) as { workspace_id: number } | undefined)?.workspace_id ?? null;
}

export function addAccount(login: string, password: string, note = '', workspaceId: number | null = null) {
  if (!login.trim() || !password) throw new Error('계정과 비밀번호를 넣어 주세요.');
  try {
    db.prepare(`INSERT INTO test_accounts (login, password, note, workspace_id) VALUES (?, ?, ?, ?)`).run(login.trim(), encrypt(password), note, workspaceId);
  } catch {
    throw new Error('이미 등록된 계정입니다.');
  }
  broadcast({ type: 'sessions.changed' });
}

export function updateAccount(id: number, patch: { password?: string; note?: string; workspace_id?: number | null }) {
  if (patch.password) db.prepare(`UPDATE test_accounts SET password = ? WHERE id = ?`).run(encrypt(patch.password), id);
  if (patch.note !== undefined) db.prepare(`UPDATE test_accounts SET note = ? WHERE id = ?`).run(patch.note, id);
  if (patch.workspace_id !== undefined) db.prepare(`UPDATE test_accounts SET workspace_id = ? WHERE id = ?`).run(patch.workspace_id, id);
  broadcast({ type: 'sessions.changed' });
}

export function deleteAccount(id: number) {
  db.prepare(`DELETE FROM test_accounts WHERE id = ?`).run(id);
  broadcast({ type: 'sessions.changed' });
}

export function accountPassword(id: number): string {
  const row = db.prepare(`SELECT password FROM test_accounts WHERE id = ?`).get(id) as { password: string } | undefined;
  if (!row) throw new Error('계정이 없습니다.');
  return decrypt(row.password);
}

export type SessionAccount = { id: number; login: string; password: string; note: string };

/** 세션이 쓸 수 있는 계정 전부(워크스페이스 계정과 공용 계정). 역할(사업자, 지자체, 관리자 등)마다 다른 계정을 고른다. */
export function accountsOf(sessionId: number): SessionAccount[] {
  const ws = workspaceOfSession(sessionId);
  if (ws === null) return [];
  const rows = db.prepare(`SELECT id, login, password, note FROM test_accounts WHERE workspace_id = ? OR workspace_id IS NULL
    ORDER BY workspace_id IS NULL, login`).all(ws) as SessionAccount[];
  return rows.map((r) => ({ ...r, password: decrypt(r.password) }));
}

/** 세션이 쓸 수 있는 계정 하나. id가 없거나 쓸 수 없는 계정이면 첫 계정. */
export function accountOf(sessionId: number, accountId?: number | null): SessionAccount | null {
  const list = accountsOf(sessionId);
  return list.find((a) => a.id === accountId) ?? list[0] ?? null;
}

/** 세션이 이 계정을 쓸 수 있는지 확인한다. 다른 워크스페이스 전용 계정이면 오류. */
export function checkAccountUsable(sessionId: number, accountId: number) {
  const row = db.prepare(`SELECT workspace_id FROM test_accounts WHERE id = ?`).get(accountId) as { workspace_id: number | null } | undefined;
  if (!row) throw new Error('계정이 없습니다.');
  if (row.workspace_id !== null && row.workspace_id !== workspaceOfSession(sessionId)) {
    throw new Error('다른 워크스페이스의 계정입니다. 설정의 테스트 계정 풀에서 워크스페이스를 바꾸거나 이 워크스페이스 계정을 고르세요.');
  }
}
