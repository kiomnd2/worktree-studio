import { db } from './db.js';
import { decrypt, encrypt } from './secret.js';
import { broadcast } from './hub.js';

export type AccountView = { id: number; login: string; note: string; session_id: number | null; ticket: string | null };

export function listAccounts(): AccountView[] {
  return db.prepare(`SELECT a.id, a.login, a.note, a.session_id, s.ticket FROM test_accounts a
    LEFT JOIN sessions s ON s.id = a.session_id ORDER BY a.login`).all() as AccountView[];
}

export function addAccount(login: string, password: string, note = '') {
  if (!login.trim() || !password) throw new Error('계정과 비밀번호를 넣어 주세요.');
  try {
    db.prepare(`INSERT INTO test_accounts (login, password, note) VALUES (?, ?, ?)`).run(login.trim(), encrypt(password), note);
  } catch {
    throw new Error('이미 등록된 계정입니다.');
  }
}

export function updateAccount(id: number, patch: { password?: string; note?: string }) {
  if (patch.password) db.prepare(`UPDATE test_accounts SET password = ? WHERE id = ?`).run(encrypt(patch.password), id);
  if (patch.note !== undefined) db.prepare(`UPDATE test_accounts SET note = ? WHERE id = ?`).run(patch.note, id);
}

export function deleteAccount(id: number) {
  db.prepare(`DELETE FROM test_accounts WHERE id = ?`).run(id);
}

export function accountPassword(id: number): string {
  const row = db.prepare(`SELECT password FROM test_accounts WHERE id = ?`).get(id) as { password: string } | undefined;
  if (!row) throw new Error('계정이 없습니다.');
  return decrypt(row.password);
}

export function accountOf(sessionId: number): { id: number; login: string; password: string } | null {
  const row = db.prepare(`SELECT id, login, password FROM test_accounts WHERE session_id = ?`).get(sessionId) as { id: number; login: string; password: string } | undefined;
  return row ? { ...row, password: decrypt(row.password) } : null;
}

/** 비어 있는 계정을 하나 배정한다. 없으면 null. */
export function assignAccount(sessionId: number): AccountView | null {
  const existing = accountOf(sessionId);
  if (existing) return listAccounts().find((a) => a.id === existing.id) ?? null;
  const free = db.prepare(`SELECT id FROM test_accounts WHERE session_id IS NULL ORDER BY login LIMIT 1`).get() as { id: number } | undefined;
  if (!free) return null;
  db.prepare(`UPDATE test_accounts SET session_id = ? WHERE id = ?`).run(sessionId, free.id);
  broadcast({ type: 'session.updated', sessionId });
  return listAccounts().find((a) => a.id === free.id) ?? null;
}

export function releaseAccount(sessionId: number) {
  db.prepare(`UPDATE test_accounts SET session_id = NULL WHERE session_id = ?`).run(sessionId);
}

export function freeAccountCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM test_accounts WHERE session_id IS NULL`).get() as { n: number }).n;
}
