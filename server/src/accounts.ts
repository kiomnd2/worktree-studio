import { db } from './db.js';
import { decrypt, encrypt } from './secret.js';
import { broadcast } from './hub.js';

export type AccountView = {
  id: number; login: string; note: string; session_id: number | null; ticket: string | null;
  /** 이 계정을 쓰는 워크스페이스. null이면 모든 워크스페이스에서 쓰는 공용 계정 */
  workspace_id: number | null; workspace_name: string | null;
};

export function listAccounts(): AccountView[] {
  return db.prepare(`SELECT a.id, a.login, a.note, a.session_id, s.ticket, a.workspace_id, w.name AS workspace_name FROM test_accounts a
    LEFT JOIN sessions s ON s.id = a.session_id LEFT JOIN workspaces w ON w.id = a.workspace_id ORDER BY w.name IS NULL, w.name, a.login`).all() as AccountView[];
}

/** 세션의 워크스페이스에서 쓸 수 있는 남은 계정: 그 워크스페이스 계정과 공용 계정 */
export function freeAccountsFor(workspaceId: number): AccountView[] {
  return listAccounts().filter((a) => !a.session_id && (a.workspace_id === null || a.workspace_id === workspaceId));
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
}

export function updateAccount(id: number, patch: { password?: string; note?: string; workspace_id?: number | null }) {
  if (patch.password) db.prepare(`UPDATE test_accounts SET password = ? WHERE id = ?`).run(encrypt(patch.password), id);
  if (patch.note !== undefined) db.prepare(`UPDATE test_accounts SET note = ? WHERE id = ?`).run(patch.note, id);
  if (patch.workspace_id !== undefined) {
    // 다른 워크스페이스 세션이 쓰는 중이면 옮기지 않는다. 그 세션에서 반납한 뒤 옮긴다.
    const row = db.prepare(`SELECT a.session_id, s.workspace_id FROM test_accounts a LEFT JOIN sessions s ON s.id = a.session_id WHERE a.id = ?`).get(id) as { session_id: number | null; workspace_id: number | null } | undefined;
    if (row?.session_id && patch.workspace_id !== null && row.workspace_id !== patch.workspace_id) {
      throw new Error('다른 워크스페이스 세션이 쓰고 있는 계정입니다. 그 세션에서 반납한 뒤 옮기세요.');
    }
    db.prepare(`UPDATE test_accounts SET workspace_id = ? WHERE id = ?`).run(patch.workspace_id, id);
  }
}

export function deleteAccount(id: number) {
  db.prepare(`DELETE FROM test_accounts WHERE id = ?`).run(id);
}

export function accountPassword(id: number): string {
  const row = db.prepare(`SELECT password FROM test_accounts WHERE id = ?`).get(id) as { password: string } | undefined;
  if (!row) throw new Error('계정이 없습니다.');
  return decrypt(row.password);
}

export type SessionAccount = { id: number; login: string; password: string; note: string };

/** 세션에 배정된 계정 전부. 역할(사업자, 지자체, 관리자 등)이 다른 계정을 여러 개 쓸 수 있다. 배정한 순서대로. */
export function accountsOf(sessionId: number): SessionAccount[] {
  const rows = db.prepare(`SELECT id, login, password, note FROM test_accounts WHERE session_id = ? ORDER BY assigned_at, id`).all(sessionId) as SessionAccount[];
  return rows.map((r) => ({ ...r, password: decrypt(r.password) }));
}

/** 세션의 계정 하나. id가 없거나 이 세션 계정이 아니면 처음 배정한 계정. */
export function accountOf(sessionId: number, accountId?: number | null): SessionAccount | null {
  const list = accountsOf(sessionId);
  return list.find((a) => a.id === accountId) ?? list[0] ?? null;
}

/**
 * 계정을 배정한다. accountId를 주면 그 계정을(비어 있어야 함), 안 주면 세션에 계정이 없을 때만 남은 계정 하나를.
 * 남은 계정이 없으면 null.
 */
export function assignAccount(sessionId: number, accountId?: number): AccountView | null {
  let id = accountId;
  if (id === undefined) {
    const existing = accountsOf(sessionId)[0];
    if (existing) return listAccounts().find((a) => a.id === existing.id) ?? null;
    // 워크스페이스 전용 계정을 공용 계정보다 먼저 배정한다.
    id = (db.prepare(`SELECT id FROM test_accounts WHERE session_id IS NULL AND (workspace_id = ? OR workspace_id IS NULL)
      ORDER BY workspace_id IS NULL, login LIMIT 1`).get(workspaceOfSession(sessionId)) as { id: number } | undefined)?.id;
    if (id === undefined) return null;
  } else {
    const row = db.prepare(`SELECT session_id, workspace_id FROM test_accounts WHERE id = ?`).get(id) as { session_id: number | null; workspace_id: number | null } | undefined;
    if (!row) throw new Error('계정이 없습니다.');
    if (row.workspace_id !== null && row.workspace_id !== workspaceOfSession(sessionId)) {
      throw new Error('다른 워크스페이스의 계정입니다. 설정의 테스트 계정 풀에서 워크스페이스를 바꾸거나 이 워크스페이스 계정을 고르세요.');
    }
    if (row.session_id === sessionId) return listAccounts().find((a) => a.id === id) ?? null;
    if (row.session_id !== null) throw new Error('다른 세션이 쓰고 있는 계정입니다. 그 세션에서 반납한 뒤 고르세요.');
  }
  db.prepare(`UPDATE test_accounts SET session_id = ?, assigned_at = datetime('now') WHERE id = ?`).run(sessionId, id);
  broadcast({ type: 'session.updated', sessionId });
  return listAccounts().find((a) => a.id === id) ?? null;
}

/** 세션 계정을 반납한다. accountId를 주면 그 계정만, 아니면 전부. */
export function releaseAccount(sessionId: number, accountId?: number) {
  if (accountId === undefined) db.prepare(`UPDATE test_accounts SET session_id = NULL WHERE session_id = ?`).run(sessionId);
  else db.prepare(`UPDATE test_accounts SET session_id = NULL WHERE session_id = ? AND id = ?`).run(sessionId, accountId);
  broadcast({ type: 'session.updated', sessionId });
}

/** 계정 하나를 어느 세션이 쓰든 반납한다(설정의 계정 풀에서). */
export function releaseAccountById(accountId: number) {
  const row = db.prepare(`SELECT session_id FROM test_accounts WHERE id = ?`).get(accountId) as { session_id: number | null } | undefined;
  if (row?.session_id) releaseAccount(row.session_id, accountId);
}

export function freeAccountCount(workspaceId?: number): number {
  if (workspaceId === undefined) return (db.prepare(`SELECT COUNT(*) AS n FROM test_accounts WHERE session_id IS NULL`).get() as { n: number }).n;
  return freeAccountsFor(workspaceId).length;
}
