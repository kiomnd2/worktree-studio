import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { db } from './db.js';
import { git, refExists } from './git.js';
import { runFile, runShell } from './exec.js';
import { getProject } from './projects.js';
import { getSession, isJiraKey, listMessages, type SessionView } from './sessions.js';
import { resolveEnv } from './envstore.js';
import { accountsOf } from './accounts.js';
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
  /** 커밋 메시지를 맞춘 템플릿. from은 다른 프로젝트 템플릿을 빌려 썼을 때 그 프로젝트 이름 */
  commit_template: { path: string; from: string | null } | null;
  /** 형식을 따라 쓴 최근 머지된 PR들. 없으면 템플릿이나 기본 형식을 쓴다. */
  style_examples: { number: number; title: string; author: string; mine: boolean }[];
  /** 이 브랜치로 이미 만든 PR(열린 것 우선, 없으면 가장 최근 것) */
  existing_pr: BranchPr | null;
  /**
   * new: 새 PR을 만든다. update: 열린 PR에 이어서 푸시한다(제목·본문은 그대로).
   * none: PR이 이미 올라가 있고 새로 올릴 게 없다.
   */
  pr_mode: 'new' | 'update' | 'none';
  /** pr_mode가 none인 이유 등 사람에게 보여 줄 한 문장 */
  pr_note: string | null;
  commit_message: string;
  title: string;
  body: string;
};

type StepName = 'commit' | 'check' | 'push' | 'pr';
/** ignored: 검사가 실패했지만 사용자가 무시하고 진행하기로 함 */
type StepState = { name: StepName; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'ignored'; started_at: number | null; ended_at: number | null; detail: string | null; output: string | null };
type RepoJob = { worktree_id: number; project_name: string; steps: StepState[]; pr_url: string | null };
export type PrJob = {
  session_id: number;
  status: 'running' | 'done' | 'failed';
  started_at: number;
  ended_at: number | null;
  repos: RepoJob[];
  error: string | null;
  servers_stopped: boolean;
  /** 검사(빌드·테스트)가 실패해도 PR까지 진행한다 */
  ignore_check_failures: boolean;
  /** 실패 뒤 "무시하고 진행"으로 다시 돌릴 때 쓰는 입력 */
  items: PrItem[];
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
  for (const acc of accountsOf(session.id)) if (acc.password) out.add(acc.password);
  return [...out];
}

export type BranchPr = { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; head_oid: string };

/** 이 브랜치로 만든 PR. 열린 PR이 있으면 그것, 없으면 가장 최근에 머지·닫힌 PR. */
async function branchPr(dir: string, branch: string): Promise<BranchPr | null> {
  try {
    const out = await runFile('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state,headRefOid', '--limit', '5'], dir, 20_000);
    const list = (JSON.parse(out || '[]') as { number: number; url: string; state: BranchPr['state']; headRefOid: string }[])
      .map((p) => ({ number: p.number, url: p.url, state: p.state, head_oid: p.headRefOid }));
    return list.find((p) => p.state === 'OPEN') ?? list.sort((a, b) => b.number - a.number)[0] ?? null;
  } catch {
    return null;
  }
}

async function existingPr(dir: string, branch: string): Promise<{ number: number; url: string } | null> {
  const p = await branchPr(dir, branch);
  return p?.state === 'OPEN' ? p : null;
}

/**
 * 이미 PR이 있으면 그 PR에 올라간 커밋 뒤로 새로 생긴 게 있는지 본다.
 * 커밋 안 한 변경이 있거나, PR 머리 커밋 뒤에 새 커밋이 있으면 새로 올릴 게 있는 것이다.
 */
async function prModeOf(dir: string, pr: BranchPr | null, dirty: number, ahead: number): Promise<{ mode: PrDraft['pr_mode']; note: string | null }> {
  if (!pr) return { mode: dirty || ahead ? 'new' : 'none', note: dirty || ahead ? null : '기준 브랜치와 차이가 없습니다.' };
  const head = await git(dir, ['rev-parse', 'HEAD']).catch(() => '');
  // PR 머리 커밋이 로컬에 있으면 그 뒤 커밋 수를, 없으면(다른 곳에서 푸시) 같은지만 본다.
  const after = await git(dir, ['rev-list', '--count', `${pr.head_oid}..HEAD`]).then(Number, () => (head === pr.head_oid ? 0 : 1));
  const fresh = dirty > 0 || after > 0;
  if (pr.state === 'OPEN') {
    return fresh
      ? { mode: 'update', note: `열린 PR #${pr.number}에 이어서 푸시합니다${after ? ` (새 커밋 ${after}개)` : ''}${dirty ? ` (커밋 안 한 파일 ${dirty}개)` : ''}.` }
      : { mode: 'none', note: `이미 PR #${pr.number}에 모두 올라가 있습니다.` };
  }
  const done = pr.state === 'MERGED' ? '머지됐' : '닫혔';
  return fresh
    ? { mode: 'new', note: `이전 PR #${pr.number}은 이미 ${done}습니다. 그 뒤 변경으로 새 PR을 만듭니다.` }
    : { mode: 'none', note: `PR #${pr.number}은 이미 ${done}고, 그 뒤로 새로 올릴 변경이 없습니다.` };
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

type PrExample = { number: number; title: string; body: string; author: string; mine: boolean };
type RepoFacts = {
  draft: PrDraft; template: string | null; diffStat: string; diff: string; log: string; examples: PrExample[]; commitStyle: string;
  commitTemplate: string | null;
};

const CT_SKIP = new Set(['node_modules', '.git', 'build', 'dist', 'out', 'target', '.gradle', '.idea', '.venv', 'venv', '.next', '.claude', '.bkit', 'static', 'public']);
const CT_NAME = /^(commit[_-]?(message[_-]?)?template.*\.(md|txt)|\.gitmessage(\.txt)?)$/i;

/** 저장소에서 커밋 메시지 템플릿을 찾는다: git config commit.template, 그다음 commit_template*.md 같은 파일(깊이 4). */
async function findCommitTemplate(dir: string): Promise<string | null> {
  const configured = await git(dir, ['config', 'commit.template']).catch(() => '');
  if (configured) {
    const abs = path.resolve(dir, configured.replace(/^~(?=\/)/, os.homedir()));
    if (fs.existsSync(abs)) return abs;
  }
  const walk = (d: string, depth: number): string | null => {
    if (depth > 4) return null;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) if (e.isFile() && CT_NAME.test(e.name)) return path.join(d, e.name);
    for (const e of entries) {
      if (!e.isDirectory() || CT_SKIP.has(e.name)) continue;
      const hit = walk(path.join(d, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(dir, 0);
}

/** 프로젝트 설정의 경로가 있으면 그것을, 없으면 저장소에서 찾은 것을 읽는다. 돌려주는 path는 표시용. */
async function commitTemplateOf(w: SessionView['worktrees'][number], setting: string | null): Promise<{ path: string; content: string } | null> {
  const abs = setting?.trim()
    ? path.resolve(w.path, setting.trim().replace(/^~(?=\/)/, os.homedir()))
    : await findCommitTemplate(w.path);
  if (!abs || !fs.existsSync(abs)) return null;
  const content = fs.readFileSync(abs, 'utf8').slice(0, 8000);
  const rel = path.relative(w.path, abs);
  return { path: rel.startsWith('..') ? abs : rel, content };
}

let myLogin: Promise<string | null> | null = null;
/** gh에 로그인한 계정. 내 PR을 형식 예시로 먼저 고르는 데 쓴다. */
function ghLogin(): Promise<string | null> {
  myLogin ??= runFile('gh', ['api', 'user', '--jq', '.login'], os.homedir(), 15_000).then((s) => s.trim() || null, () => null);
  return myLogin;
}

/**
 * 이 레포에서 최근 머지된 PR 본문을 형식 예시로 고른다. 팀이 실제로 쓰는 제목·본문 형식을 따르게 하기 위해서다.
 * 내 PR을 먼저, 그다음 다른 사람 PR. 배포용 머지 PR(main < develop 등)과 본문이 짧은 PR은 뺀다.
 */
async function recentPrExamples(dir: string): Promise<PrExample[]> {
  try {
    const out = await runFile('gh', ['pr', 'list', '--state', 'merged', '--limit', '30', '--json', 'number,title,body,author,headRefName'], dir, 30_000);
    const me = await ghLogin();
    const list = (JSON.parse(out) as { number: number; title: string; body: string | null; author: { login: string }; headRefName: string }[])
      .filter((p) => (p.body ?? '').trim().length >= 200)
      .filter((p) => !/^(main|master|develop|release)/.test(p.headRefName) && !/^\s*(main|master)\s*<\s*develop/i.test(p.title))
      .map((p) => ({ number: p.number, title: p.title, body: (p.body ?? '').trim(), author: p.author.login, mine: p.author.login === me }));
    return [...list.filter((p) => p.mine), ...list.filter((p) => !p.mine)].slice(0, 3)
      .map((p) => ({ ...p, body: p.body.length > 2500 ? `${p.body.slice(0, 2500)}\n…` : p.body }));
  } catch {
    return [];
  }
}

async function collectFacts(session: SessionView): Promise<RepoFacts[]> {
  const facts = await collectEach(session);
  // 커밋 템플릿이 없는 레포(FE 등)는 같은 세션의 다른 레포 템플릿을 쓴다. 팀 규칙이 한 저장소에만 있는 경우가 많다.
  const donor = facts.find((f) => f.commitTemplate);
  for (const f of facts) {
    if (!f.commitTemplate && donor) {
      f.commitTemplate = donor.commitTemplate;
      f.draft.commit_template = { path: donor.draft.commit_template!.path, from: donor.draft.project_name };
    }
  }
  return facts;
}

async function collectEach(session: SessionView): Promise<RepoFacts[]> {
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
    // 커밋 메시지 형식 예시: 기준 브랜치의 최근 커밋 제목(머지 커밋 제외)
    const commitStyle = await git(w.path, ['log', ref, '--no-merges', '-8', '--format=%s']).catch(() => '');
    const examples = await recentPrExamples(w.path);
    const templatePath = findTemplate(w.path);
    const ct = await commitTemplateOf(w, project?.commit_template ?? null);
    const template = templatePath ? fs.readFileSync(path.join(w.path, templatePath), 'utf8') : null;
    const pr = await branchPr(w.path, w.branch);
    const { mode, note } = await prModeOf(w.path, pr, dirty.length, ahead);
    const draft: PrDraft = {
      worktree_id: w.id,
      project_name: w.project_name,
      project_kind: w.project_kind,
      branch: w.branch,
      base_branch: w.base_branch,
      dirty_files: dirty,
      commits_ahead: ahead,
      // 이미 PR로 올라간 것만 있으면 새로 올릴 변경이 없는 것으로 본다.
      has_changes: mode !== 'none',
      check_cmd: project?.check_cmd ?? null,
      template_path: templatePath,
      commit_template: ct ? { path: ct.path, from: null } : null,
      existing_pr: pr,
      pr_mode: mode,
      pr_note: note,
      style_examples: examples.map(({ number, title, author, mine }) => ({ number, title, author, mine })),
      commit_message: isJiraKey(session.ticket) ? `${session.ticket} ${session.summary}`.trim() : session.summary || session.ticket,
      title: isJiraKey(session.ticket) ? `[${session.ticket}] ${session.summary || w.branch}`.trim() : session.summary || w.branch,
      body: template ?? '',
    };
    return {
      draft,
      template,
      diffStat: untracked.length ? `${diffStat}\n새 파일: ${untracked.join(', ')}` : diffStat,
      diff: diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n… (이하 생략)` : diff,
      log,
      examples,
      commitStyle,
      commitTemplate: ct?.content ?? null,
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
  const jiraKey = isJiraKey(session.ticket);
  const prompt = [
    `${jiraKey ? '티켓' : 'Jira 티켓이 없는 작업'} ${session.ticket}${session.summary ? ` (${session.summary})` : ''}의 PR 제목, 본문, 커밋 메시지를 레포별로 써줘.`,
    '형식 우선순위: (1) 레포마다 붙인 "최근 머지된 PR" 예시가 있으면 그 형식을 따른다. 제목의 접두어·이모지·티켓 표기 위치, 본문 섹션 구성과 제목, 문체와 길이를 맞춘다. "내 PR"로 표시된 예시를 가장 우선한다.',
    '  예시의 내용은 다른 작업이니 내용을 베끼지 말고 형식만 따른다. (2) 예시가 없으면 레포의 PR 템플릿 항목을 채운다. (3) 둘 다 없으면 "## 개요", "## 변경", "## 확인"으로 쓴다.',
    '커밋 메시지: 레포에 "커밋 메시지 템플릿"이 붙어 있으면 그 Format을 그대로 따른다(이모지·type은 템플릿 표에서 고르고, 본문 목록과 Jira 줄까지).',
    `  ${jiraKey ? `Jira 줄의 이슈 키는 ${session.ticket}을 쓴다.` : '이 작업은 Jira 티켓이 없으니 Jira 줄은 빼고 이슈 키를 지어내지 않는다.'} 템플릿의 주의사항을 지키고, Co-Authored-By 같은 꼬리말은 쓰지 않는다. 템플릿이 없으면 "최근 커밋 제목" 형식의 한 줄로 쓴다.`,
    '내용은 diff와 대화에서 실제로 바뀐 것만 적고 추측하지 마. 확인하지 못한 것은 확인했다고 쓰지 마.',
    '레포가 둘 이상이면 도구가 본문 끝에 관련 PR 링크를 붙이니 따로 쓰지 마. 비밀번호, 토큰 같은 값은 절대 넣지 마. 모두 한국어로.',
    jiraKey
      ? `티켓 번호 ${session.ticket}은 예시가 티켓을 표기하는 방식대로 제목에 넣는다.`
      : `Jira 티켓이 없으니 제목에 티켓 번호를 넣지 않고, "${session.ticket}"(작업 이름)도 제목에 넣지 않는다.`,
    '',
    `## 대화 기록 (요약 재료)\n${mask(conversationDigest(sessionId)) || '(없음)'}`,
    ...targets.map((f) => [
      '',
      `## 레포 worktree_id=${f.draft.worktree_id} ${f.draft.project_name} (${f.draft.project_kind}) ${f.draft.branch} → ${f.draft.base_branch}`,
      f.examples.length
        ? `### 최근 머지된 PR (형식 예시)\n${f.examples.map((e) => `#### #${e.number}${e.mine ? ' (내 PR)' : ''} 제목: ${e.title}\n${e.body}`).join('\n\n')}`
        : `### PR 템플릿 (${f.draft.template_path ?? '없음'})\n${f.template ?? '(없음)'}`,
      f.commitTemplate
        ? `### 커밋 메시지 템플릿 (${f.draft.commit_template!.path}${f.draft.commit_template!.from ? `, ${f.draft.commit_template!.from} 것을 같이 씀` : ''})\n${f.commitTemplate}`
        : `### 최근 커밋 제목 (커밋 메시지 형식 예시)\n${f.commitStyle || '(없음)'}`,
      `### 이번 브랜치 커밋\n${f.log || '(아직 커밋 없음)'}`,
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
      f.draft.commit_message = cleanCommitMessage(mask(r.commit_message.trim())) || f.draft.commit_message;
    }
  } catch (err) {
    aiError = `본문 자동 작성에 실패해 템플릿만 채웠습니다: ${(err as Error).message}`;
  }
  return { drafts: facts.map((f) => f.draft), ai_error: aiError };
}

/** 꼬리말(Co-Authored-By 등)을 빼고 줄 끝 공백을 정리한다. 팀 템플릿이 금지하는 꼬리말이 섞이지 않게 한다. */
function cleanCommitMessage(msg: string): string {
  return msg.split('\n').filter((l) => !/^\s*Co-Authored-By:/i.test(l)).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 이미 PR로 다 올라가 새로 올릴 게 없는 레포가 섞여 있으면 막는다. 같은 변경으로 PR을 또 만들지 않게. */
export async function assertNewWork(sessionId: number, items: PrItem[]) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  for (const it of items) {
    const w = session.worktrees.find((x) => x.id === it.worktree_id);
    if (!w) continue;
    const ref = await baseRef(w.path, w.base_branch);
    const dirty = porcelainFiles(await git(w.path, ['status', '--porcelain']).catch(() => '')).length;
    const ahead = Number(await git(w.path, ['rev-list', '--count', `${ref}..HEAD`]).catch(() => '0')) || 0;
    const { mode, note } = await prModeOf(w.path, await branchPr(w.path, w.branch), dirty, ahead);
    if (mode === 'none') throw new Error(`${w.project_name}: ${note ?? '새로 올릴 변경이 없습니다.'}`);
  }
}

export function getPrJob(sessionId: number): PrJob | null {
  return jobs.get(sessionId) ?? null;
}

export function listPrs(sessionId: number): PullRequestRow[] {
  return db.prepare(`SELECT * FROM pull_requests WHERE session_id = ? ORDER BY id`).all(sessionId) as PullRequestRow[];
}

/** update_body: 열린 PR에 이어서 푸시할 때 제목·본문도 새로 쓴 것으로 바꿀지 */
export type PrItem = { worktree_id: number; title: string; body: string; commit_message: string; update_body?: boolean };

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
export function startPr(sessionId: number, items: PrItem[], opts: { ignoreCheckFailures?: boolean; prior?: PrJob } = {}): PrJob {
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
    ignore_check_failures: Boolean(opts.ignoreCheckFailures), items,
    repos: items.map((it) => ({
      worktree_id: it.worktree_id,
      project_name: session.worktrees.find((w) => w.id === it.worktree_id)!.project_name,
      pr_url: null,
      steps: (['commit', 'check', 'push', 'pr'] as StepName[]).map((name) => ({ name, status: 'pending', started_at: null, ended_at: null, detail: null, output: null })),
    })),
  };
  jobs.set(sessionId, job);
  update(job);
  runJob(session, job, items, opts.prior).catch(() => { /* runJob이 job에 오류를 기록한다 */ });
  return job;
}

/** 검사가 실패해 멈춘 작업을 검사 실패를 무시하고 이어서 진행한다. 이미 돌린 검사는 다시 돌리지 않는다. */
export function continueIgnoringChecks(sessionId: number): PrJob {
  const prior = jobs.get(sessionId);
  if (!prior || prior.status !== 'failed') throw new Error('이어서 진행할 PR 작업이 없습니다.');
  return startPr(sessionId, prior.items, { ignoreCheckFailures: true, prior });
}

async function runJob(session: SessionView, job: PrJob, items: PrItem[], prior?: PrJob) {
  const secrets = sessionSecrets(session);
  const ignored = new Map<number, string>(); // 검사를 무시한 레포: worktree_id → 검사 명령
  const wt = (id: number) => session.worktrees.find((w) => w.id === id)!;
  try {
    for (const repo of job.repos) {
      const w = wt(repo.worktree_id);
      const item = items.find((i) => i.worktree_id === repo.worktree_id)!;
      await step(job, repo, 'commit', async (s) => {
        const dirty = await git(w.path, ['status', '--porcelain']);
        if (!dirty) { s.status = 'skipped'; s.detail = '커밋할 변경 없음'; return; }
        await git(w.path, ['add', '-A']);
        await runFile('git', ['commit', '-m', cleanCommitMessage(item.commit_message) || item.title.trim()], w.path, 120_000);
        s.detail = (await git(w.path, ['log', '-1', '--format=%h %s'])).slice(0, 200);
      });
      await step(job, repo, 'check', async (s) => {
        const cmd = getProject(w.project_id)?.check_cmd;
        if (!cmd) { s.status = 'skipped'; s.detail = '검사 명령 없음 (설정에서 넣을 수 있습니다)'; return; }
        // 이어서 진행할 때는 이미 돌린 검사 결과를 그대로 쓴다. 빌드를 다시 기다리지 않게.
        const before = prior?.repos.find((x) => x.worktree_id === repo.worktree_id)?.steps.find((x) => x.name === 'check');
        if (before && (before.status === 'done' || before.status === 'failed' || before.status === 'ignored')) {
          s.output = before.output;
          if (before.status === 'done') { s.detail = `${before.detail ?? ''} (앞에서 통과)`; return; }
          s.status = 'ignored';
          s.detail = '앞에서 실패했지만 무시하고 진행합니다';
          ignored.set(repo.worktree_id, cmd);
          return;
        }
        s.detail = `$ ${cmd}`;
        const r = await runShell(cmd, w.path, { timeoutMs: 30 * 60 * 1000 });
        s.output = maskSecrets(r.output.split('\n').slice(-120).join('\n'), secrets);
        const failure = r.timedOut ? '검사가 30분 안에 끝나지 않았습니다.' : r.code !== 0 ? `검사가 실패했습니다 (코드 ${r.code}).` : null;
        if (!failure) return;
        if (job.ignore_check_failures) {
          s.status = 'ignored';
          s.detail = `${failure} 무시하고 진행합니다.`;
          ignored.set(repo.worktree_id, cmd);
          return;
        }
        throw new Error(`${failure} PR을 만들지 않았습니다.`);
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
    // 관련 PR 링크용: 이번에 새로 만든 PR과 이어서 푸시한 기존 PR 모두
    const linked: { repo: RepoJob; number: number; url: string; body: string; fresh: boolean }[] = [];
    for (const repo of job.repos) {
      const w = wt(repo.worktree_id);
      const item = items.find((i) => i.worktree_id === repo.worktree_id)!;
      await step(job, repo, 'pr', async (s) => {
        // 검사를 무시하고 올리면 리뷰하는 사람이 알 수 있게 본문 끝에 남긴다.
        const note = ignored.has(repo.worktree_id) ? `\n\n> ⚠️ PR 전 검사(\`${ignored.get(repo.worktree_id)}\`)가 실패한 상태로 올렸습니다.` : '';
        const body = maskSecrets(item.body.replace(/\s+$/, '') + note, secrets);
        const existing = await existingPr(w.path, w.branch);
        let url: string;
        if (existing) {
          url = existing.url;
          // 열린 PR은 사용자가 고르지 않는 한 제목·본문을 건드리지 않는다. 리뷰 중 고친 내용이 날아가지 않게.
          if (item.update_body) {
            const file = path.join(os.tmpdir(), `wts-pr-${session.id}-${w.id}.md`);
            fs.writeFileSync(file, body);
            try {
              await runFile('gh', ['pr', 'edit', url, '--title', item.title.trim(), '--body-file', file], w.path, 60_000);
            } finally {
              fs.rmSync(file, { force: true });
            }
            s.detail = `열린 PR #${existing.number}에 푸시하고 제목·본문을 고쳤습니다.`;
          } else {
            s.detail = `열린 PR #${existing.number}에 푸시했습니다. 제목·본문은 그대로 두었습니다.`;
          }
          s.status = 'done';
          repo.pr_url = url;
          const number = existing.number;
          const known = db.prepare(`SELECT id FROM pull_requests WHERE session_id = ? AND url = ?`).get(session.id, url) as { id: number } | undefined;
          if (!known) db.prepare(`INSERT INTO pull_requests (session_id, worktree_id, number, url, title, state) VALUES (?, ?, ?, ?, ?, 'OPEN')`).run(session.id, w.id, number, url, item.title.trim());
          linked.push({ repo, number, url, body, fresh: false });
          return;
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
        linked.push({ repo, number, url, body, fresh: true });
        const known = db.prepare(`SELECT id FROM pull_requests WHERE session_id = ? AND url = ?`).get(session.id, url) as { id: number } | undefined;
        if (known) db.prepare(`UPDATE pull_requests SET state = 'OPEN', title = ? WHERE id = ?`).run(item.title.trim(), known.id);
        else db.prepare(`INSERT INTO pull_requests (session_id, worktree_id, number, url, title, state) VALUES (?, ?, ?, ?, ?, 'OPEN')`)
          .run(session.id, w.id, number, url, item.title.trim());
      });
    }

    // BE와 FE PR을 서로 관련 PR로 연결한다. 본문은 이번에 새로 만든 PR만 고친다(기존 PR 본문은 그대로).
    if (linked.length > 1) {
      for (const c of linked.filter((l) => l.fresh)) {
        const others = linked.filter((o) => o !== c).map((o) => `- ${o.repo.project_name}: ${o.url}`).join('\n');
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
