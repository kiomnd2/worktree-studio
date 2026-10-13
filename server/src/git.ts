import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ['rev-parse', '--show-toplevel']);
}

export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const b = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return b === 'HEAD' ? null : b;
  } catch {
    return null;
  }
}

export async function originUrl(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['remote', 'get-url', 'origin'])) || null;
  } catch {
    return null;
  }
}

/** 로컬 브랜치와 origin 브랜치를 합쳐 이름만 돌려준다. */
export async function listBranches(dir: string): Promise<string[]> {
  const out = await git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
  const names = new Set<string>();
  for (const ref of out.split('\n').filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/origin/')) {
      const n = ref.slice('refs/remotes/origin/'.length);
      if (n !== 'HEAD') names.add(n);
    }
  }
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function rank(name: string) {
  if (name === 'develop') return 0;
  if (name === 'main' || name === 'master') return 1;
  return 2;
}

export async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

export async function fetchOrigin(dir: string): Promise<void> {
  if (!(await originUrl(dir))) return;
  await git(dir, ['fetch', 'origin', '--prune']);
}

export async function worktreeCount(dir: string): Promise<number> {
  const out = await git(dir, ['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((l) => l.startsWith('worktree ')).length - 1;
}

export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<void> {
  const baseRef = (await refExists(repo, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
  if (await refExists(repo, `refs/heads/${branch}`)) {
    throw new Error(`브랜치 ${branch}가 이미 있습니다. 다른 이름을 쓰세요.`);
  }
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', worktreePath]);
}
