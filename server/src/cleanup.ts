import fs from 'node:fs';
import os from 'node:os';
import { db } from './db.js';
import { git } from './git.js';
import { runFile } from './exec.js';
import { getProject, listProjectRows } from './projects.js';
import { getSession, listSessions, setSession, type SessionView } from './sessions.js';
import { serverPorts, stopServers } from './runner.js';
import { releaseAccount } from './accounts.js';
import { listPrs, type PullRequestRow } from './pr.js';
import { deleteSessionScreens, screenDirSize } from './screens.js';
import { getSettings } from './settings.js';
import { sendNotification } from './notify.js';
import { broadcast } from './hub.js';

export type CleanupState = 'running' | 'protected' | 'ready' | 'waiting_merge' | 'active';

export type CleanupRow = {
  session_id: number;
  ticket: string;
  summary: string;
  workspace_name: string;
  closed: boolean;
  updated_at: string;
  idle_days: number;
  prs: Pick<PullRequestRow, 'id' | 'number' | 'url' | 'state'>[];
  servers: number;
  worktrees: { id: number; project_name: string; path: string; branch: string; exists: boolean; dirty: number; size_kb: number | null }[];
  accounts: string[];
  screens_kb: number;
  state: CleanupState;
  reason: string;
};

export type StartupReport = { at: string; orphans_killed: number; pruned: { project: string; lines: string[] }[]; accounts_released: number; missing_worktrees: number };
let startup: StartupReport | null = null;

const sizeCache = new Map<string, { at: number; kb: number | null }>();

/** 폴더 용량. node_modules가 크면 오래 걸려서 5분 동안 기억한다. */
async function folderKb(dir: string): Promise<number | null> {
  const hit = sizeCache.get(dir);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.kb;
  let kb: number | null = null;
  try {
    kb = Number((await runFile('du', ['-sk', dir], os.homedir(), 20_000)).split(/\s+/)[0]) || null;
  } catch { kb = null; }
  sizeCache.set(dir, { at: Date.now(), kb });
  return kb;
}

function daysSince(sqlite: string) {
  return Math.floor((Date.now() - new Date(`${sqlite.replace(' ', 'T')}Z`).getTime()) / 86_400_000);
}

function classify(s: SessionView, prs: PullRequestRow[], dirty: number): { state: CleanupState; reason: string } {
  if (s.status === 'running') return { state: 'running', reason: 'Claude가 작업 중' };
  if (dirty > 0) return { state: 'protected', reason: `커밋하지 않은 변경 ${dirty}개` };
  if (prs.some((p) => p.state === 'OPEN')) return { state: 'waiting_merge', reason: 'PR 머지 대기' };
  if (prs.length > 0) return { state: 'ready', reason: prs.every((p) => p.state === 'MERGED') ? 'PR 머지됨' : 'PR 닫힘' };
  if (s.closed) return { state: 'ready', reason: '닫은 세션' };
  return { state: 'active', reason: 'PR 없음' };
}

async function rowOf(s: SessionView): Promise<CleanupRow> {
  const prs = listPrs(s.id);
  const worktrees = await Promise.all(s.worktrees.map(async (w) => {
    const exists = fs.existsSync(w.path);
    const dirty = exists ? (await git(w.path, ['status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean).length : 0;
    return { id: w.id, project_name: w.project_name, path: w.path, branch: w.branch, exists, dirty, size_kb: exists ? await folderKb(w.path) : 0 };
  }));
  const dirty = worktrees.reduce((n, w) => n + w.dirty, 0);
  return {
    session_id: s.id,
    ticket: s.ticket,
    summary: s.summary,
    workspace_name: s.workspace_name,
    closed: Boolean(s.closed),
    updated_at: s.updated_at,
    idle_days: daysSince(s.updated_at),
    prs: prs.map((p) => ({ id: p.id, number: p.number, url: p.url, state: p.state })),
    servers: serverPorts(s.id).length,
    worktrees,
    accounts: s.accounts.map((a) => a.login),
    screens_kb: Math.round(screenDirSize(s.id) / 1024),
    ...classify(s, prs, dirty),
  };
}

/** 정리 화면 목록. 닫았지만 워크트리 폴더나 계정이 남은 세션도 넣는다. */
export async function listCleanup(): Promise<{ rows: CleanupRow[]; startup: StartupReport | null }> {
  const sessions = listSessions(true).filter((s) => !s.closed || s.worktrees.some((w) => fs.existsSync(w.path)) || s.accounts.length > 0 || screenDirSize(s.id) > 0);
  return { rows: await Promise.all(sessions.map(rowOf)), startup };
}

export type CleanStep = { name: string; ok: boolean; detail: string };

/** 서버 종료 → 워크트리 삭제 → 로컬 브랜치 삭제 → (원격 브랜치 삭제) → 계정 반납 → 스크린샷 삭제 → 세션 보관 */
export async function cleanSession(sessionId: number, opts: { deleteRemote: boolean; force: boolean }): Promise<CleanStep[]> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const row = await rowOf(s);
  if (row.state === 'running') throw new Error(`${s.ticket}: Claude가 작업 중이라 정리할 수 없습니다.`);
  if (row.state === 'waiting_merge') throw new Error(`${s.ticket}: PR이 아직 열려 있습니다. 머지하거나 닫은 뒤 정리하세요.`);
  if (row.state === 'protected' && !opts.force) throw new Error(`${s.ticket}: 커밋하지 않은 변경이 있어 남겨 뒀습니다.`);

  const steps: CleanStep[] = [];
  const attempt = async (name: string, fn: () => Promise<string | void>) => {
    try { steps.push({ name, ok: true, detail: (await fn()) || '' }); } catch (err) { steps.push({ name, ok: false, detail: (err as Error).message }); }
  };

  await attempt('서버 종료', async () => { await stopServers(sessionId); });
  for (const w of s.worktrees) {
    const project = getProject(w.project_id);
    if (!project) continue;
    await attempt(`${w.project_name} 워크트리 삭제`, async () => {
      if (!fs.existsSync(w.path)) { await git(project.local_path, ['worktree', 'prune']).catch(() => {}); return '이미 없음'; }
      await git(project.local_path, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), w.path]);
      sizeCache.delete(w.path);
    });
    await attempt(`${w.project_name} 로컬 브랜치 ${w.branch} 삭제`, async () => {
      const exists = await git(project.local_path, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`]).then(() => true, () => false);
      if (!exists) return '이미 없음';
      await git(project.local_path, ['branch', '-D', w.branch]);
    });
    if (opts.deleteRemote && row.prs.length > 0) {
      await attempt(`${w.project_name} 원격 브랜치 삭제`, async () => {
        await runFile('git', ['push', 'origin', '--delete', w.branch], project.local_path, 60_000).catch((e) => {
          if (/remote ref does not exist/.test((e as Error).message)) return;
          throw e;
        });
      });
    }
  }
  await attempt('계정 반납', async () => { releaseAccount(sessionId); });
  await attempt('스크린샷 삭제', async () => { deleteSessionScreens(sessionId); });
  await attempt('세션 기록 보관', async () => { if (!s.closed) setSession(sessionId, { closed: 1 }); });
  broadcast({ type: 'sessions.changed' });
  broadcast({ type: 'cleanup.changed' });
  return steps;
}

/** gh로 열린 PR 상태를 확인하고, 머지·닫힘이 되면 정리 대기로 알린다. */
export async function refreshPrStates(): Promise<number> {
  const open = db.prepare(`SELECT * FROM pull_requests WHERE state = 'OPEN'`).all() as PullRequestRow[];
  let changedCount = 0;
  const touched = new Set<number>();
  for (const pr of open) {
    try {
      const out = await runFile('gh', ['pr', 'view', pr.url, '--json', 'state'], os.homedir(), 20_000);
      const state = (JSON.parse(out) as { state: string }).state;
      db.prepare(`UPDATE pull_requests SET checked_at = datetime('now'), state = ? WHERE id = ?`).run(state, pr.id);
      if (state !== 'OPEN') { changedCount++; touched.add(pr.session_id); }
    } catch { /* 오프라인이거나 gh 로그인이 풀렸으면 다음에 다시 본다 */ }
  }
  const settings = getSettings();
  for (const sessionId of touched) {
    broadcast({ type: 'pr.updated', sessionId });
    const prs = listPrs(sessionId);
    if (prs.some((p) => p.state === 'OPEN')) continue;
    const s = getSession(sessionId);
    if (!s) continue;
    const row = await rowOf(s);
    if (settings.cleanup.autoCleanMerged && row.state === 'ready') {
      const steps = await cleanSession(sessionId, { deleteRemote: settings.cleanup.deleteRemoteBranch, force: false }).catch(() => null);
      if (steps && settings.notify.onCleanup) sendNotification(`${s.ticket} 정리했습니다`, 'PR이 머지·닫혀 워크트리와 브랜치를 지웠습니다.');
    } else if (settings.notify.onCleanup) {
      sendNotification(`${s.ticket} 정리 대기`, row.state === 'protected' ? 'PR은 끝났지만 커밋하지 않은 변경이 있어 남겨 뒀습니다.' : 'PR이 머지·닫혔습니다. 리소스 정리에서 지울 수 있습니다.');
    }
  }
  if (touched.size) broadcast({ type: 'cleanup.changed' });
  return changedCount;
}

/** 오래 손대지 않은 세션은 지우지 않고 알리기만 한다. 세션당 한 번. */
function notifyStale() {
  const days = getSettings().cleanup.staleDays;
  if (!days || !getSettings().notify.onCleanup) return;
  for (const s of listSessions()) {
    if (s.status === 'running' || s.stale_notified) continue;
    if (daysSince(s.updated_at) < days || listPrs(s.id).length > 0) continue;
    sendNotification(`${s.ticket} ${days}일 동안 활동이 없습니다`, '필요 없으면 리소스 정리에서 지울 수 있습니다.', s.id);
    db.prepare(`UPDATE sessions SET stale_notified = 1 WHERE id = ?`).run(s.id);
  }
}

/** 도구를 시작할 때 폴더 없는 워크트리 기록과 닫힌 세션에 묶인 계정을 정리한다. */
export async function startupSweep(orphansKilled: number): Promise<StartupReport> {
  const pruned: StartupReport['pruned'] = [];
  for (const p of listProjectRows()) {
    if (!fs.existsSync(p.local_path)) continue;
    const out = await git(p.local_path, ['worktree', 'prune', '--verbose']).catch(() => '');
    const lines = out.split('\n').filter(Boolean);
    if (lines.length) pruned.push({ project: p.name, lines });
  }
  const released = db.prepare(`UPDATE test_accounts SET session_id = NULL WHERE session_id IN (SELECT id FROM sessions WHERE closed = 1)`).run().changes;
  const missing = (db.prepare(`SELECT w.path FROM worktrees w JOIN sessions s ON s.id = w.session_id WHERE s.closed = 0`).all() as { path: string }[])
    .filter((w) => !fs.existsSync(w.path)).length;
  startup = { at: new Date().toISOString(), orphans_killed: orphansKilled, pruned, accounts_released: released, missing_worktrees: missing };
  return startup;
}

let timer: NodeJS.Timeout | null = null;

/** PR 상태 확인과 미활동 알림을 설정한 간격으로 돌린다. 설정이 바뀌면 다시 부른다. */
export function scheduleCleanupPoll() {
  if (timer) clearInterval(timer);
  const minutes = Math.max(1, getSettings().cleanup.pollMinutes);
  const tick = () => { refreshPrStates().catch(() => {}); notifyStale(); };
  timer = setInterval(tick, minutes * 60 * 1000);
  setTimeout(tick, 15_000);
}
