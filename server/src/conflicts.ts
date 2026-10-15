import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { git, originUrl, refExists } from './git.js';
import { getProject } from './projects.js';
import { getSession, type SessionView } from './sessions.js';
import { listPrs, repoCheckCmd } from './pr.js';
import { startChat } from './claude.js';

/**
 * 작업 브랜치와 기준 브랜치(origin/develop 등)의 머지 충돌.
 * 확인은 git merge-tree로 메모리에서만 해서 워크트리를 건드리지 않는다.
 * 해결은 사용자가 해결 방법을 보고 승인한 뒤에만 워크트리에서 머지를 시작하고, 새 대화에서 Claude가 충돌을 푼다.
 */

export type ConflictHunk = { line: number; ours: string; theirs: string };
export type ConflictFile = { path: string; hunks: ConflictHunk[]; note: string | null };
export type WorktreeConflict = {
  worktree_id: number;
  project_name: string;
  branch: string;
  base_branch: string;
  pr: { number: number; url: string } | null;
  /** clean: 충돌 없음, conflict: 머지하면 충돌, merging: 워크트리에서 머지 중(충돌을 푸는 중), error: 확인 실패 */
  state: 'clean' | 'conflict' | 'merging' | 'error';
  /** 기준 브랜치에 새로 들어온 커밋 수 */
  behind: number;
  /** 아직 푸시하지 않은 커밋 수(머지 커밋을 만든 뒤 푸시가 남았는지) */
  unpushed: number;
  files: ConflictFile[];
  /** 충돌 파일을 건드린 기준 브랜치 쪽 커밋. 충돌 원인을 보여 준다. */
  base_commits: { sha: string; subject: string; author: string }[];
  error: string | null;
};

export type ConflictProposal = {
  summary: string;
  files: { path: string; strategy: 'ours' | 'theirs' | 'both' | 'manual'; how: string; risk: string }[];
  checks: string[];
};

const MAX_HUNK_LINES = 60;

/** 종료 코드가 1이어도(충돌) 출력을 받는다. */
function gitAllowFail(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 2) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

function clip(lines: string[]) {
  return lines.length > MAX_HUNK_LINES ? [...lines.slice(0, MAX_HUNK_LINES), `… (${lines.length - MAX_HUNK_LINES}줄 생략)`].join('\n') : lines.join('\n');
}

/** 충돌 표시(<<<<<<< ======= >>>>>>>)가 든 파일에서 양쪽 내용을 뽑는다. diff3 형식의 공통 조상 부분은 뺀다. */
export function parseHunks(text: string): ConflictHunk[] {
  const out: ConflictHunk[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<< ')) continue;
    const start = i + 1;
    const ours: string[] = [];
    const theirs: string[] = [];
    let part: 'ours' | 'base' | 'theirs' = 'ours';
    for (i++; i < lines.length && !lines[i].startsWith('>>>>>>> '); i++) {
      if (lines[i].startsWith('||||||| ')) { part = 'base'; continue; }
      if (lines[i] === '=======') { part = 'theirs'; continue; }
      if (part === 'ours') ours.push(lines[i]); else if (part === 'theirs') theirs.push(lines[i]);
    }
    out.push({ line: start, ours: clip(ours), theirs: clip(theirs) });
  }
  return out;
}

async function baseRef(dir: string, base: string) {
  return (await refExists(dir, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

async function isMerging(dir: string) {
  const gitDir = await git(dir, ['rev-parse', '--git-dir']);
  return fs.existsSync(path.resolve(dir, gitDir, 'MERGE_HEAD'));
}

async function checkWorktree(session: SessionView, w: SessionView['repos'][number]): Promise<WorktreeConflict> {
  const pr = listPrs(session.id).find((p) => p.worktree_id === w.id && p.state === 'OPEN');
  const res: WorktreeConflict = {
    worktree_id: w.id, project_name: w.project_name, branch: w.branch, base_branch: w.base_branch,
    pr: pr ? { number: pr.number, url: pr.url } : null,
    state: 'clean', behind: 0, unpushed: 0, files: [], base_commits: [], error: null,
  };
  try {
    if (await originUrl(w.path)) await git(w.path, ['fetch', 'origin', w.base_branch, w.branch]).catch(() => git(w.path, ['fetch', 'origin', w.base_branch]));
    const base = await baseRef(w.path, w.base_branch);
    res.behind = Number(await git(w.path, ['rev-list', '--count', `HEAD..${base}`]));
    if (await refExists(w.path, `refs/remotes/origin/${w.branch}`)) res.unpushed = Number(await git(w.path, ['rev-list', '--count', `origin/${w.branch}..HEAD`]));

    if (await isMerging(w.path)) {
      // 머지를 시작해 충돌을 푸는 중. 남은 충돌 파일은 워크트리에서 읽는다.
      res.state = 'merging';
      const left = (await git(w.path, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      res.files = left.map((p) => {
        let text = '';
        try { text = fs.readFileSync(path.join(w.path, p), 'utf8'); } catch { /* 지워진 파일 */ }
        return { path: p, hunks: parseHunks(text), note: text ? null : '한쪽에서 지운 파일' };
      });
    } else {
      const r = await gitAllowFail(w.path, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', base]);
      if (r.code === 0) return res;
      if (r.code !== 1) throw new Error('git merge-tree를 실행하지 못했습니다. git 2.38 이상이 필요합니다.');
      res.state = 'conflict';
      const [tree, ...names] = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const p of [...new Set(names)]) {
        const shown = await gitAllowFail(w.path, ['show', `${tree}:${p}`]);
        res.files.push(shown.code === 0
          ? { path: p, hunks: parseHunks(shown.stdout), note: null }
          : { path: p, hunks: [], note: '한쪽에서 지우거나 옮긴 파일' });
      }
    }
    if (res.files.length) {
      const mb = await git(w.path, ['merge-base', 'HEAD', base]).catch(() => '');
      if (mb) {
        const log = await git(w.path, ['log', '--format=%h%x09%s%x09%an', `${mb}..${base}`, '--', ...res.files.map((f) => f.path)]);
        res.base_commits = log.split('\n').filter(Boolean).slice(0, 20).map((l) => { const [sha, subject, author] = l.split('\t'); return { sha, subject, author }; });
      }
    }
  } catch (err) {
    res.state = 'error';
    res.error = (err as Error).message.split('\n').slice(-3).join(' ');
  }
  return res;
}

/** 세션의 워크트리마다 기준 브랜치와 머지 충돌이 있는지 본다. 워크트리는 바꾸지 않는다. */
export async function checkConflicts(sessionId: number): Promise<WorktreeConflict[]> {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  return Promise.all(session.repos.map((w) => checkWorktree(session, w)));
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          strategy: { type: 'string', enum: ['ours', 'theirs', 'both', 'manual'] },
          how: { type: 'string' },
          risk: { type: 'string' },
        },
        required: ['path', 'strategy', 'how', 'risk'],
      },
    },
    checks: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files', 'checks'],
} as const;

/**
 * Claude가 코드를 읽기만 하고 파일별 해결 방법을 제안한다. 작업 브랜치 쪽은 워크트리에서 읽고,
 * 기준 브랜치 쪽 변경은 충돌 부분과 기준 브랜치 커밋의 diff로 준다.
 */
export async function proposeResolution(sessionId: number, worktreeId: number): Promise<ConflictProposal> {
  const session = getSession(sessionId);
  const w = session?.repos.find((x) => x.id === worktreeId);
  if (!session || !w) throw new Error('워크트리가 없습니다.');
  const c = await checkWorktree(session, w);
  if (c.state === 'clean') throw new Error('충돌이 없습니다.');
  if (c.state === 'error') throw new Error(c.error ?? '충돌을 확인하지 못했습니다.');
  const base = await baseRef(w.path, w.base_branch);
  const mb = await git(w.path, ['merge-base', 'HEAD', base]).catch(() => '');
  const files = c.files.map((f) => f.path);
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (생략)` : s);
  const theirsDiff = mb ? cut(await git(w.path, ['diff', mb, base, '--', ...files]), 40_000) : '';
  const oursDiff = mb ? cut(await git(w.path, ['diff', mb, 'HEAD', '--', ...files]), 40_000) : '';

  const prompt = [
    `작업 브랜치 ${w.branch}(이 워크트리 ${w.path})를 ${base}에 머지하면 아래 파일이 충돌한다. 어떻게 풀지 파일별로 제안해 줘. 파일은 고치지 말고 읽기만 한다.`,
    '',
    `기준 브랜치에 새로 들어온 커밋 중 충돌 파일을 건드린 것:\n${c.base_commits.map((b) => `- ${b.sha} ${b.subject} (${b.author})`).join('\n') || '- (없음)'}`,
    '',
    '충돌 부분 (ours = 작업 브랜치, theirs = 기준 브랜치):',
    ...c.files.map((f) => [`### ${f.path}${f.note ? ` (${f.note})` : ''}`, ...f.hunks.map((h, i) => `#${i + 1} ${h.line}행 근처\n[ours]\n${h.ours}\n[theirs]\n${h.theirs}`)].join('\n')),
    '',
    `작업 브랜치가 갈라진 뒤 바꾼 내용 (git diff merge-base HEAD):\n${oursDiff || '(없음)'}`,
    '',
    `기준 브랜치가 갈라진 뒤 바꾼 내용 (git diff merge-base ${base}):\n${theirsDiff || '(없음)'}`,
    '',
    '규칙:',
    '- 두 쪽의 의도를 모두 살리는 것을 먼저 생각한다. 한쪽을 버려야 하면 왜인지 적는다.',
    '- strategy: ours(작업 브랜치 것을 씀), theirs(기준 브랜치 것을 씀), both(두 쪽을 합침), manual(사람이 정해야 함).',
    '- how: 그 파일을 실제로 어떻게 고칠지 구체적으로(메서드·쿼리·changeSet 이름 등). risk: 잘못 풀면 생기는 문제나 확인할 점, 없으면 빈 문자열.',
    '- Liquibase changelog처럼 순서가 중요한 파일은 기준 브랜치 항목을 먼저 두고 작업 브랜치 항목을 뒤에 붙이는지, id가 겹치지 않는지 본다.',
    '- 필요하면 워크트리의 다른 파일을 Read·Grep으로 읽어 호출하는 쪽과 맞는지 확인한다.',
    '- summary: 충돌 원인과 전체 해결 방향 두세 문장. checks: 해결 뒤 확인할 것(컴파일, 특정 API·화면 등) 몇 개. 모두 한국어로.',
  ].join('\n');

  let structured: unknown = null;
  const q = query({
    prompt,
    options: {
      cwd: w.path,
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      // 사용자 플러그인·훅을 불러오지 않는다. 훅이 저장소에 상태 파일을 만들면 커밋에 섞인다.
      settingSources: [],
      permissionMode: 'dontAsk',
      maxTurns: 40,
      persistSession: false,
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    },
  });
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === 'result') {
      if (msg.subtype !== 'success' || msg.is_error) throw new Error('해결 방법을 만들지 못했습니다.');
      structured = msg.structured_output ?? JSON.parse(msg.result);
    }
  }
  const d = structured as ConflictProposal;
  return { summary: d?.summary ?? '', files: (d?.files ?? []).filter((f) => files.includes(f.path)), checks: d?.checks ?? [] };
}

/**
 * 사용자가 승인한 해결 방법으로 충돌을 푼다. 워크트리에서 기준 브랜치 머지를 시작하고(충돌 상태로 멈춤),
 * 새 대화에서 Claude가 충돌을 풀고 검사한 뒤 머지 커밋을 만든다. 푸시는 사용자가 한다.
 */
export async function resolveConflicts(sessionId: number, worktreeId: number, proposal: ConflictProposal): Promise<{ chat_id: number }> {
  const session = getSession(sessionId);
  const w = session?.repos.find((x) => x.id === worktreeId);
  if (!session || !w) throw new Error('워크트리가 없습니다.');
  if (session.busy) throw new Error('Claude가 작업 중입니다. 머지는 워크트리 전체를 바꾸므로 작업이 끝난 뒤에 시작하세요.');
  const base = await baseRef(w.path, w.base_branch);
  if (!(await isMerging(w.path))) {
    const dirty = (await git(w.path, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean);
    if (dirty.length) throw new Error(`커밋하지 않은 변경이 ${dirty.length}개 있어 머지를 시작할 수 없습니다. 먼저 커밋하거나 정리하세요: ${dirty.slice(0, 5).map((l) => l.trim().replace(/^\S+\s+/, '')).join(', ')}`);
    const r = await gitAllowFail(w.path, ['merge', '--no-ff', '--no-commit', base]);
    if (r.code !== 0 && !(await isMerging(w.path))) throw new Error(`머지를 시작하지 못했습니다: ${r.stdout.split('\n').slice(-3).join(' ')}`);
  }
  const check = repoCheckCmd(w);
  const text = [
    `${w.project_name} 워크트리(${w.path})에서 ${base}를 머지하는 중이고 충돌이 났어. 도구가 \`git merge --no-ff --no-commit ${base}\`로 머지를 시작해 뒀어.`,
    '사용자가 승인한 해결 방법대로 충돌을 풀어줘.',
    '',
    `방향: ${proposal.summary}`,
    ...proposal.files.map((f) => `- ${f.path} [${f.strategy}] ${f.how}${f.risk ? ` (주의: ${f.risk})` : ''}`),
    '',
    '순서:',
    '1. `git diff --name-only --diff-filter=U`로 남은 충돌 파일을 보고, 파일마다 위 방법대로 충돌 표시(<<<<<<< ======= >>>>>>>)를 모두 없앤다. 방법이 manual이거나 위 방법이 실제 코드와 맞지 않으면 추측하지 말고 AskUserQuestion으로 묻는다.',
    '2. 푼 파일은 `git add`한다. 충돌 파일 말고 다른 파일은 고치지 않는다(머지로 함께 들어온 변경은 그대로 둔다).',
    `3. ${check ? `\`${check}\`로 검사한다. 실패하면 머지 때문에 생긴 문제만 고친다.` : '컴파일이나 타입 검사로 깨지지 않았는지 확인한다.'}`,
    '4. 충돌 표시가 남지 않았고 검사가 통과하면 `git commit --no-edit`로 머지 커밋을 만든다. 푸시는 하지 않는다.',
    '5. 파일별로 어떻게 풀었는지와 확인할 것을 짧게 정리한다.',
    ...(proposal.checks.length ? ['', `해결 뒤 확인할 것: ${proposal.checks.join(' / ')}`] : []),
    '',
    '머지를 그만둬야 할 것 같으면 `git merge --abort` 하지 말고 이유를 말해줘. 사용자가 화면에서 취소한다.',
  ].join('\n');
  const chat = startChat(sessionId, text, [], { title: `충돌 해결 · ${w.project_name}` });
  return { chat_id: chat.id };
}

/** 워크트리에서 진행 중인 머지를 취소해 머지 전으로 되돌린다. */
export async function abortMerge(sessionId: number, worktreeId: number) {
  const session = getSession(sessionId);
  const w = session?.repos.find((x) => x.id === worktreeId);
  if (!session || !w) throw new Error('워크트리가 없습니다.');
  if (session.busy) throw new Error('Claude가 작업 중입니다. 먼저 중단하세요.');
  if (!(await isMerging(w.path))) throw new Error('진행 중인 머지가 없습니다.');
  await git(w.path, ['merge', '--abort']);
}
