import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, refExists } from './git.js';
import { getSession, type SessionView } from './sessions.js';

const run = promisify(execFile);

/** base: 기준 브랜치에서 갈라진 뒤 바뀐 것 전부(커밋 + 커밋 안 한 것). uncommitted: 마지막 커밋 이후만. */
export type ChangeScope = 'base' | 'uncommitted';

export type ChangedFile = {
  path: string;
  /** 이름이 바뀐 경우 예전 경로 */
  old_path: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type WorktreeChanges = {
  worktree_id: number;
  project_name: string;
  branch: string;
  base_branch: string;
  /** 비교 기준 커밋(기준 브랜치와 갈라진 지점 또는 HEAD) */
  compare_ref: string;
  files: ChangedFile[];
  error: string | null;
};

type Wt = SessionView['worktrees'][number];

/** 기준 브랜치와 갈라진 지점. 기준 브랜치가 그 뒤로 앞서가도 남의 변경이 섞이지 않는다. */
async function compareRef(w: Wt, scope: ChangeScope): Promise<string> {
  if (scope === 'uncommitted') return 'HEAD';
  const base = (await refExists(w.path, `refs/remotes/origin/${w.base_branch}`)) ? `origin/${w.base_branch}` : w.base_branch;
  return git(w.path, ['merge-base', base, 'HEAD']);
}

function countLines(file: string): number | null {
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null;
    if (buf.length === 0) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch { return null; }
}

async function worktreeChanges(w: Wt, scope: ChangeScope): Promise<WorktreeChanges> {
  const out: WorktreeChanges = { worktree_id: w.id, project_name: w.project_name, branch: w.branch, base_branch: w.base_branch, compare_ref: '', files: [], error: null };
  try {
    const ref = await compareRef(w, scope);
    out.compare_ref = ref.slice(0, 12);
    // 작업 트리와 비교해서 커밋하지 않은 변경도 들어간다. -M으로 이름 바꾼 파일을 한 줄로 본다.
    const nameStatus = await git(w.path, ['diff', '-M', '--name-status', '-z', ref]);
    const numstat = await git(w.path, ['diff', '-M', '--numstat', '-z', ref]);
    const stats = new Map<string, { add: number | null; del: number | null; binary: boolean }>();
    {
      const parts = numstat.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const head = parts[i];
        if (!head) continue;
        const [a, d, p] = head.split('\t');
        // 이름이 바뀐 줄은 "a\td\t" 다음에 예전 경로, 새 경로가 따로 온다.
        const file = p === '' ? (i += 2, parts[i]) : p;
        stats.set(file, { add: a === '-' ? null : Number(a), del: d === '-' ? null : Number(d), binary: a === '-' });
      }
    }
    const parts = nameStatus.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      if (!code) continue;
      let oldPath: string | null = null;
      let file = parts[++i];
      if (code.startsWith('R') || code.startsWith('C')) { oldPath = file; file = parts[++i]; }
      const s = stats.get(file);
      out.files.push({
        path: file,
        old_path: oldPath,
        status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified',
        additions: s?.add ?? null,
        deletions: s?.del ?? null,
        binary: s?.binary ?? false,
      });
    }
    const untracked = await git(w.path, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const file of untracked.split('\0').filter(Boolean)) {
      const lines = countLines(path.join(w.path, file));
      out.files.push({ path: file, old_path: null, status: 'untracked', additions: lines, deletions: lines === null ? null : 0, binary: lines === null });
    }
    out.files.sort((a, b) => a.path.localeCompare(b.path));
  } catch (err) {
    out.error = (err as Error).message.split('\n')[0];
  }
  return out;
}

export async function sessionChanges(sessionId: number, scope: ChangeScope): Promise<WorktreeChanges[]> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  return Promise.all(s.repos.filter((w) => fs.existsSync(w.path)).map((w) => worktreeChanges(w, scope)));
}

/**
 * 파일 하나의 unified diff. 화면에서 나란히 보기와 한 줄 보기로 나눠 그린다.
 * full이면 파일 전체를 문맥으로 넣는다.
 */
export async function fileDiff(worktreeId: number, sessionId: number, file: string, opts: { scope: ChangeScope; full: boolean; ignoreWhitespace: boolean }): Promise<{ patch: string; binary: boolean }> {
  const s = getSession(sessionId);
  const w = s?.repos.find((x) => x.id === worktreeId);
  if (!w) throw new Error('워크트리가 없습니다.');
  const norm = path.normalize(file);
  if (path.isAbsolute(norm) || norm.startsWith('..')) throw new Error('잘못된 경로입니다.');
  const flags = ['--no-color', '-M', `-U${opts.full ? 100000 : 5}`, ...(opts.ignoreWhitespace ? ['-w'] : [])];
  const tracked = (await git(w.path, ['ls-files', '--error-unmatch', '--', norm]).then(() => true, () => false))
    || (await git(w.path, ['cat-file', '-e', `HEAD:${norm}`]).then(() => true, () => false));
  let patch: string;
  if (!tracked && fs.existsSync(path.join(w.path, norm))) {
    // 새 파일(추적 안 함)은 빈 파일과 비교한다. 차이가 있으면 종료 코드 1이라 출력을 직접 받는다.
    try {
      const r = await run('git', ['diff', '--no-index', ...flags, '--', '/dev/null', norm], { cwd: w.path, maxBuffer: 32 * 1024 * 1024 });
      patch = r.stdout;
    } catch (err) {
      patch = (err as { stdout?: string }).stdout ?? '';
    }
  } else {
    const ref = await compareRef(w, opts.scope);
    patch = await git(w.path, ['diff', ...flags, ref, '--', norm]);
  }
  return { patch, binary: /^Binary files /m.test(patch) };
}
