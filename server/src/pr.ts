import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { db } from './db.js';
import { git, refExists } from './git.js';
import { runFile, runShell } from './exec.js';
import { getProject } from './projects.js';
import { getSession, listMessages, type SessionView } from './sessions.js';
import { resolveEnv } from './envstore.js';
import { accountOf } from './accounts.js';
import { maskSecrets } from './secret.js';
import { stopServers } from './runner.js';
import { getSettings } from './settings.js';
import { sendNotification } from './notify.js';
import { broadcast } from './hub.js';

export type PullRequestRow = {
  id: number; session_id: number; worktree_id: number; number: number; url: string; title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED'; created_at: string; checked_at: string | null;
};

export type PrDraft = {
  worktree_id: number;
  project_name: string;
  project_kind: string;
  branch: string;
  base_branch: string;
  dirty_files: string[];
  commits_ahead: number;
  has_changes: boolean;
  check_cmd: string | null;
  template_path: string | null;
  existing_pr: { number: number; url: string } | null;
  commit_message: string;
  title: string;
  body: string;
};

type StepName = 'commit' | 'check' | 'push' | 'pr';
type StepState = { name: StepName; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; started_at: number | null; ended_at: number | null; detail: string | null; output: string | null };
type RepoJob = { worktree_id: number; project_name: string; steps: StepState[]; pr_url: string | null };
export type PrJob = {
  session_id: number;
  status: 'running' | 'done' | 'failed';
  started_at: number;
  ended_at: number | null;
  repos: RepoJob[];
  error: string | null;
  servers_stopped: boolean;
};

const jobs = new Map<number, PrJob>();

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', '.gitlab/merge_request_templates/default.md',
];

function findTemplate(dir: string): string | null {
  for (const rel of TEMPLATE_PATHS) if (fs.existsSync(path.join(dir, rel))) return rel;
  const folder = path.join(dir, '.github/PULL_REQUEST_TEMPLATE');
  if (fs.existsSync(folder)) {
    const first = fs.readdirSync(folder).filter((f) => f.endsWith('.md')).sort()[0];
    if (first) return `.github/PULL_REQUEST_TEMPLATE/${first}`;
  }
  return null;
}

async function baseRef(repo: string, base: string) {
  return (await refExists(repo, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

/** 로그, 환경값의 비밀값, 계정 비밀번호처럼 PR 본문에 섞이면 안 되는 값 */
export function sessionSecrets(session: SessionView): string[] {
  const out = new Set<string>();
  for (const w of session.worktrees) {
    const { env, vars } = resolveEnv(session.id, w.project_id);
    for (const v of vars) if (v.secret && env[v.key]) out.add(env[v.key]);
  }
  const acc = accountOf(session.id);
  if (acc?.password) out.add(acc.password);
  return [...out];
}

async function existingPr(dir: string, branch: string): Promise<{ number: number; url: string } | null> {
  try {
    const out = await runFile('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1'], dir, 20_000);
    const list = JSON.parse(out || '[]') as { number: number; url: string }[];
    return list[0] ?? null;
  } catch {
    return null;
  }
}

/** 대화에서 사용자 요청과 Claude의 마지막 설명을 뽑아 PR 본문 재료로 쓴다. */
function conversationDigest(sessionId: number): string {
  const parts: string[] = [];
  for (const m of listMessages(sessionId)) {
    if (m.kind === 'user' && m.payload?.text) parts.push(`[요청] ${String(m.payload.text).slice(0, 800)}`);
    if (m.kind === 'sdk' && m.payload?.type === 'assistant' && !m.payload.parent_tool_use_id) {
      for (const b of m.payload.message?.content ?? []) if (b.type === 'text' && b.text.trim()) parts.push(`[Claude] ${b.text.slice(0, 1200)}`);
    }
  }
  let text = '';
  for (let i = parts.length - 1; i >= 0 && text.length < 9000; i--) text = `${parts[i]}\n${text}`;
  return text.trim();
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    repos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          worktree_id: { type: 'number' },
          title: { type: 'string' },
          body: { type: 'string' },
          commit_message: { type: 'string' },
        },
        required: ['worktree_id', 'title', 'body', 'commit_message'],
      },
    },
  },
  required: ['repos'],
};

/** git 헬퍼가 출력을 trim해서 첫 줄의 앞 공백(" M")이 사라질 수 있다. 상태 글자 수에 기대지 않고 파일 이름만 뽑는다. */
function porcelainFiles(porcelain: string): string[] {
  return porcelain.split('\n').filter(Boolean).map((l) => l.replace(/^[ MADRCU?!T]{1,2}\s+/, ''));
}

type RepoFacts = { draft: PrDraft; template: string | null; diffStat: string; diff: string; log: string };

async function collectFacts(session: SessionView): Promise<RepoFacts[]> {
  return Promise.all(session.worktrees.map(async (w) => {
    const project = getProject(w.project_id);
    const ref = await baseRef(w.path, w.base_branch);
    const porcelain = await git(w.path, ['status', '--porcelain']).catch(() => '');
    const dirty = porcelainFiles(porcelain);
    const ahead = Number(await git(w.path, ['rev-list', '--count', `${ref}..HEAD`]).catch(() => '0')) || 0;
    // 작업 트리 기준 diff라서 아직 커밋하지 않은 변경도 들어간다. 새 파일은 이름만 따로 붙인다.
    const diffStat = await git(w.path, ['diff', '--stat', ref]).catch(() => '');
    const diff = await git(w.path, ['diff', ref]).catch(() => '');
    const untracked = porcelainFiles(porcelain.split('\n').filter((l) => l.startsWith('??')).join('\n'));
    const log = await git(w.path, ['log', '--oneline', `${ref}..HEAD`]).catch(() => '');
    const templatePath = findTemplate(w.path);
    const template = templatePath ? fs.readFileSync(path.join(w.path, templatePath), 'utf8') : null;
    const draft: PrDraft = {
      worktree_id: w.id,
      project_name: w.project_name,
      project_kind: w.project_kind,
      branch: w.branch,
      base_branch: w.base_branch,
      dirty_files: dirty,
      commits_ahead: ahead,
      has_changes: dirty.length > 0 || ahead > 0,
      check_cmd: project?.check_cmd ?? null,
      template_path: templatePath,
      existing_pr: await existingPr(w.path, w.branch),
      commit_message: `${session.ticket} ${session.summary}`.trim(),
      title: `[${session.ticket}] ${session.summary || w.branch}`.trim(),
      body: template ?? '',
    };
    return {
      draft,
      template,
      diffStat: untracked.length ? `${diffStat}\n새 파일: ${untracked.join(', ')}` : diffStat,
      diff: diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n… (이하 생략)` : diff,
      log,
    };
  }));
}

/** PR을 만들 레포별로 변경 내용을 모으고 Claude에게 템플릿대로 제목과 본문을 쓰게 한다. */
export async function preparePr(sessionId: number): Promise<{ drafts: PrDraft[]; ai_error: string | null }> {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const facts = await collectFacts(session);
  const targets = facts.filter((f) => f.draft.has_changes);
  if (targets.length === 0) return { drafts: facts.map((f) => f.draft), ai_error: null };

  const secrets = sessionSecrets(session);
  const mask = (s: string) => maskSecrets(s, secrets);
  const prompt = [
    `티켓 ${session.ticket}${session.summary ? ` (${session.summary})` : ''}의 PR 제목, 본문, 커밋 메시지를 레포별로 써줘.`,
    '본문은 레포의 PR 템플릿 형식과 항목을 그대로 따르고, 모든 항목을 채워. 템플릿이 없으면 "## 작업 내용", "## 테스트", "## 체크리스트"로 써.',
    '작업 내용은 diff와 대화에서 실제로 바뀐 것만 적고 추측하지 마. 테스트 항목은 표로, 확인 못 한 것은 "미확인"이라고 적어.',
    '레포가 둘 이상이면 본문 끝에 "관련 PR" 자리를 두고 도구가 링크를 넣는다고 비워 둬. 비밀번호, 토큰 같은 값은 절대 넣지 마.',
    '제목은 "[티켓] 요약" 형식의 한 줄, 커밋 메시지는 한 줄. 모두 한국어로.',
    '',
    `## 대화 기록 (요약 재료)\n${mask(conversationDigest(sessionId)) || '(없음)'}`,
    ...targets.map((f) => [
      '',
      `## 레포 worktree_id=${f.draft.worktree_id} ${f.draft.project_name} (${f.draft.project_kind}) ${f.draft.branch} → ${f.draft.base_branch}`,
      `### PR 템플릿 (${f.draft.template_path ?? '없음'})\n${f.template ?? '(없음)'}`,
      `### 커밋\n${f.log || '(아직 커밋 없음)'}`,
      `### 변경 요약\n${f.diffStat}`,
      `### diff\n\`\`\`diff\n${mask(f.diff)}\n\`\`\``,
    ].join('\n')),
  ].join('\n');

  let aiError: string | null = null;
  try {
    let structured: unknown = null;
    const q = query({
      prompt,
      options: {
        cwd: session.worktrees[0].path,
        tools: [],
        // 사용자 플러그인·훅을 불러오지 않는다. 훅이 작업 폴더에 상태 파일(.bkit/ 등)을 만들면 PR 커밋에 섞인다.
        settingSources: [],
        permissionMode: 'dontAsk',
        maxTurns: 4,
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: DRAFT_SCHEMA },
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success' || msg.is_error) throw new Error('Claude가 본문을 끝까지 쓰지 못했습니다.');
        structured = msg.structured_output ?? JSON.parse(msg.result);
      }
    }
    const repos = (structured as { repos?: { worktree_id: number; title: string; body: string; commit_message: string }[] } | null)?.repos ?? [];
    for (const r of repos) {
      const f = targets.find((t) => t.draft.worktree_id === r.worktree_id);
      if (!f) continue;
      f.draft.title = mask(r.title.trim()) || f.draft.title;
      f.draft.body = mask(r.body.trim()) || f.draft.body;
      f.draft.commit_message = mask(r.commit_message.trim()) || f.draft.commit_message;
    }
  } catch (err) {
    aiError = `본문 자동 작성에 실패해 템플릿만 채웠습니다: ${(err as Error).message}`;
  }
  return { drafts: facts.map((f) => f.draft), ai_error: aiError };
}

export function getPrJob(sessionId: number): PrJob | null {
  return jobs.get(sessionId) ?? null;
}

export function listPrs(sessionId: number): PullRequestRow[] {
  return db.prepare(`SELECT * FROM pull_requests WHERE session_id = ? ORDER BY id`).all(sessionId) as PullRequestRow[];
}

export type PrItem = { worktree_id: number; title: string; body: string; commit_message: string };

function update(job: PrJob) {
  broadcast({ type: 'pr.updated', sessionId: job.session_id });
}

async function step<T>(job: PrJob, repo: RepoJob, name: StepName, fn: (s: StepState) => Promise<T>): Promise<T> {
  const s = repo.steps.find((x) => x.name === name)!;
  s.status = 'running';
  s.started_at = Date.now();
  update(job);
  try {
    const out = await fn(s);
    if (s.status === 'running') s.status = 'done';
    return out;
  } catch (err) {
    s.status = 'failed';
    s.detail = (err as Error).message;
    throw err;
  } finally {
    s.ended_at = Date.now();
    update(job);
  }
}

/**
 * 커밋 → 검사 → 푸시 → PR 생성. 모든 레포의 검사를 먼저 통과시킨 뒤에 푸시해서,
 * 한쪽만 PR이 올라가는 일이 없게 한다.
 */
export function startPr(sessionId: number, items: PrItem[]): PrJob {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.status === 'running') throw new Error('Claude가 작업 중입니다. 끝난 뒤에 PR을 만드세요.');
  if (jobs.get(sessionId)?.status === 'running') throw new Error('이미 PR을 만드는 중입니다.');
  if (items.length === 0) throw new Error('PR을 만들 레포를 하나 이상 고르세요.');
  for (const it of items) {
    if (!session.worktrees.some((w) => w.id === it.worktree_id)) throw new Error('세션에 없는 워크트리입니다.');
    if (!it.title.trim()) throw new Error('PR 제목을 넣어 주세요.');
  }

  const job: PrJob = {
    session_id: sessionId, status: 'running', started_at: Date.now(), ended_at: null, error: null, servers_stopped: false,
    repos: items.map((it) => ({
      worktree_id: it.worktree_id,
      project_name: session.worktrees.find((w) => w.id === it.worktree_id)!.project_name,
      pr_url: null,
      steps: (['commit', 'check', 'push', 'pr'] as StepName[]).map((name) => ({ name, status: 'pending', started_at: null, ended_at: null, detail: null, output: null })),
    })),
  };
  jobs.set(sessionId, job);
  update(job);
  runJob(session, job, items).catch(() => { /* runJob이 job에 오류를 기록한다 */ });
  return job;
}

async function runJob(session: SessionView, job: PrJob, items: PrItem[]) {
  const secrets = sessionSecrets(session);
  const wt = (id: number) => session.worktrees.find((w) => w.id === id)!;
  try {
    for (const repo of job.repos) {
      const w = wt(repo.worktree_id);
      const item = items.find((i) => i.worktree_id === repo.worktree_id)!;
      await step(job, repo, 'commit', async (s) => {
        const dirty = await git(w.path, ['status', '--porcelain']);
        if (!dirty) { s.status = 'skipped'; s.detail = '커밋할 변경 없음'; return; }
        await git(w.path, ['add', '-A']);
        await runFile('git', ['commit', '-m', item.commit_message.trim() || item.title.trim()], w.path, 120_000);
        s.detail = (await git(w.path, ['log', '-1', '--format=%h %s'])).slice(0, 200);
      });
      await step(job, repo, 'check', async (s) => {
        const cmd = getProject(w.project_id)?.check_cmd;
        if (!cmd) { s.status = 'skipped'; s.detail = '검사 명령 없음 (설정에서 넣을 수 있습니다)'; return; }
        s.detail = `$ ${cmd}`;
        const r = await runShell(cmd, w.path, { timeoutMs: 30 * 60 * 1000 });
        s.output = maskSecrets(r.output.split('\n').slice(-120).join('\n'), secrets);
        if (r.timedOut) throw new Error('검사가 30분 안에 끝나지 않았습니다.');
        if (r.code !== 0) throw new Error(`검사가 실패했습니다 (코드 ${r.code}). PR을 만들지 않았습니다.`);
      });
    }

    for (const repo of job.repos) {
      const w = wt(repo.worktree_id);
      await step(job, repo, 'push', async (s) => {
        await runFile('git', ['push', '-u', 'origin', w.branch], w.path, 180_000);
        s.detail = `origin/${w.branch}`;
      });
    }

    const created: { repo: RepoJob; number: number; url: string; body: string }[] = [];
    for (const repo of job.repos) {
      const w = wt(repo.worktree_id);
      const item = items.find((i) => i.worktree_id === repo.worktree_id)!;
      await step(job, repo, 'pr', async (s) => {
        const body = maskSecrets(item.body, secrets);
        const existing = await existingPr(w.path, w.branch);
        let url: string;
        if (existing) {
          url = existing.url;
          s.detail = `이미 열린 PR #${existing.number}에 푸시했습니다.`;
        } else {
          const file = path.join(os.tmpdir(), `wts-pr-${session.id}-${w.id}.md`);
          fs.writeFileSync(file, body);
          try {
            const out = await runFile('gh', ['pr', 'create', '--base', w.base_branch, '--head', w.branch, '--title', item.title.trim(), '--body-file', file], w.path, 60_000);
            url = out.split('\n').find((l) => /^https?:\/\//.test(l.trim()))?.trim() ?? out.trim();
          } finally {
            fs.rmSync(file, { force: true });
          }
          s.detail = url;
        }
        const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
        repo.pr_url = url;
        created.push({ repo, number, url, body });
        const known = db.prepare(`SELECT id FROM pull_requests WHERE session_id = ? AND url = ?`).get(session.id, url) as { id: number } | undefined;
        if (known) db.prepare(`UPDATE pull_requests SET state = 'OPEN', title = ? WHERE id = ?`).run(item.title.trim(), known.id);
        else db.prepare(`INSERT INTO pull_requests (session_id, worktree_id, number, url, title, state) VALUES (?, ?, ?, ?, ?, 'OPEN')`)
          .run(session.id, w.id, number, url, item.title.trim());
      });
    }

    // BE와 FE PR을 서로 관련 PR로 연결한다.
    if (created.length > 1) {
      for (const c of created) {
        const others = created.filter((o) => o !== c).map((o) => `- ${o.repo.project_name}: ${o.url}`).join('\n');
        const file = path.join(os.tmpdir(), `wts-pr-link-${session.id}-${c.repo.worktree_id}.md`);
        fs.writeFileSync(file, `${c.body.replace(/\s+$/, '')}\n\n### 관련 PR\n${others}\n`);
        await runFile('gh', ['pr', 'edit', c.url, '--body-file', file], wt(c.repo.worktree_id).path, 60_000).catch(() => {});
        fs.rmSync(file, { force: true });
      }
    }

    job.status = 'done';
    if (getSettings().cleanup.stopServersOnPr) {
      await stopServers(session.id).catch(() => {});
      job.servers_stopped = true;
    }
    if (getSettings().notify.onPr) {
      sendNotification(`${session.ticket} PR을 만들었습니다`, created.map((c) => c.url).join('\n'), session.id);
    }
  } catch (err) {
    job.status = 'failed';
    job.error = (err as Error).message;
    if (getSettings().notify.onPr) sendNotification(`${session.ticket} PR을 만들지 못했습니다`, job.error.slice(0, 140), session.id);
  } finally {
    job.ended_at = Date.now();
    update(job);
    broadcast({ type: 'cleanup.changed' });
  }
}

export async function closePr(prId: number) {
  const pr = db.prepare(`SELECT p.*, w.path FROM pull_requests p JOIN worktrees w ON w.id = p.worktree_id WHERE p.id = ?`).get(prId) as (PullRequestRow & { path: string }) | undefined;
  if (!pr) throw new Error('PR 기록이 없습니다.');
  await runFile('gh', ['pr', 'close', pr.url], fs.existsSync(pr.path) ? pr.path : os.homedir(), 60_000);
  db.prepare(`UPDATE pull_requests SET state = 'CLOSED', checked_at = datetime('now') WHERE id = ?`).run(prId);
  broadcast({ type: 'pr.updated', sessionId: pr.session_id });
  broadcast({ type: 'cleanup.changed' });
}
