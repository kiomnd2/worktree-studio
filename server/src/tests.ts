import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE, DATA_DIR } from './config.js';
import { db } from './db.js';
import { getProject } from './projects.js';
import { getSession, listMessages } from './sessions.js';
import { listServers } from './runner.js';
import { accountOf, assignAccount, listAccounts } from './accounts.js';
import { maskSecrets } from './secret.js';
import { broadcast } from './hub.js';
import { sendNotification } from './notify.js';
import { changedDiff, changedFiles, feWorktree } from './screens.js';
import { saveDoc } from './docs.js';

/**
 * 개발한 기능의 테스트 케이스를 만들고, 브라우저로 직접 돌려 보며 화면을 찍는다.
 * 케이스마다 필요한 역할의 계정은 사용자가 확인해야 실행한다(계정을 추측해서 쓰지 않는다).
 */

export const TEST_DIR = path.join(DATA_DIR, 'tests');

db.exec(`
CREATE TABLE IF NOT EXISTS test_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  start_path TEXT NOT NULL DEFAULT '/',
  steps TEXT NOT NULL DEFAULT '[]',
  expected TEXT NOT NULL DEFAULT '[]',
  account_id INTEGER REFERENCES test_accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  results TEXT NOT NULL DEFAULT '[]',
  shots TEXT NOT NULL DEFAULT '[]',
  ran_at TEXT
);
`);

export type TestStatus = 'draft' | 'queued' | 'running' | 'pass' | 'fail' | 'blocked' | 'error';
export type TestCase = {
  id: number; session_id: number; title: string;
  /** 필요한 사용자 역할. 빈 문자열이면 로그인 없이 확인하는 화면 */
  role: string;
  start_path: string; steps: string[]; expected: string[];
  account_id: number | null;
  status: TestStatus;
  /** 판정 이유 한두 문장 */
  summary: string | null;
  /** 단계별 결과 */
  results: { step: string; ok: boolean; note: string; shot: string | null }[];
  shots: { file: string; caption: string }[];
  ran_at: string | null;
};
type Row = Omit<TestCase, 'steps' | 'expected' | 'results' | 'shots'> & { steps: string; expected: string; results: string; shots: string };
const toView = (r: Row): TestCase => ({
  ...r, steps: JSON.parse(r.steps), expected: JSON.parse(r.expected), results: JSON.parse(r.results), shots: JSON.parse(r.shots),
});

const generating = new Set<number>();
const running = new Map<number, AbortController>();

function changed(sessionId: number) {
  broadcast({ type: 'tests.updated', sessionId });
}

export function listCases(sessionId: number): TestCase[] {
  return (db.prepare(`SELECT * FROM test_cases WHERE session_id = ? ORDER BY id`).all(sessionId) as Row[]).map(toView);
}

export function testState(sessionId: number) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const fe = feWorktree(session);
  const server = fe ? listServers(session).find((s) => s.worktree_id === fe.id && s.url) : undefined;
  const cases = listCases(sessionId);
  const roles = [...new Set(cases.map((c) => c.role).filter(Boolean))];
  return {
    cases,
    fe_project: fe ? { id: fe.project_id, name: fe.project_name } : null,
    app_url: server?.status === 'running' ? server.url : null,
    login_path: fe ? getProject(fe.project_id)?.login_path ?? null : null,
    generating: generating.has(sessionId),
    running: running.has(sessionId),
    // 역할마다 확인된 계정. 그 역할의 케이스가 모두 같은 계정을 가리켜야 확인된 것으로 본다.
    roles: roles.map((role) => {
      const ids = [...new Set(cases.filter((c) => c.role === role).map((c) => c.account_id))];
      const acc = ids.length === 1 && ids[0] !== null ? accountOf(sessionId, ids[0]) : null;
      return { role, account: acc && acc.id === ids[0] ? { id: acc.id, login: acc.login, note: acc.note } : null };
    }),
  };
}

const CASE_SCHEMA = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          role: { type: 'string' },
          start_path: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          expected: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'role', 'start_path', 'steps', 'expected'],
      },
    },
  },
  required: ['cases'],
};

/** 바뀐 내용과 대화에서 이번에 개발한 기능을 확인하는 테스트 케이스를 만든다. 이전에 만든 케이스는 바꾼다. */
export async function generateCases(sessionId: number): Promise<number> {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const fe = feWorktree(session);
  if (!fe) throw new Error('이 세션에는 FE 워크트리가 없어 화면 테스트를 만들 수 없습니다.');
  if (generating.has(sessionId)) throw new Error('이미 테스트 케이스를 만드는 중입니다.');
  if (running.has(sessionId)) throw new Error('테스트를 실행하는 중입니다.');
  const repos = await Promise.all(session.worktrees.map(async (w) => ({ w, files: await changedFiles(w), diff: await changedDiff(w) })));
  if (repos.every((r) => r.files.length === 0)) throw new Error('기준 브랜치와 달라진 파일이 없습니다.');

  generating.add(sessionId);
  changed(sessionId);
  try {
    const asked = listMessages(sessionId).filter((m) => m.kind === 'user' && m.payload?.text).slice(-8)
      .map((m) => `- ${String(m.payload.text).replace(/\s+/g, ' ').slice(0, 400)}`);
    // 이 워크스페이스에서 쓸 수 있는 계정(전용·공용)의 역할 메모만 참고로 준다.
    const roles = [...new Set(listAccounts().filter((a) => a.workspace_id === null || a.workspace_id === session.workspace_id).map((a) => a.note.trim()).filter(Boolean))];
    const prompt = [
      '이 세션에서 개발한 기능을 사람이 화면에서 확인하듯 검증하는 테스트 케이스를 만들어줘. 브라우저 자동화 에이전트가 이 케이스를 그대로 따라 실행한다.',
      '',
      '규칙:',
      '- 이번 변경으로 달라진 동작만 다룬다. 정상 흐름 하나를 먼저, 그다음 꼭 필요한 예외(권한, 빈 값, 경계값)만. 보통 2~5개, 최대 8개.',
      '- role: 이 화면을 보려면 로그인해야 하는 사용자 역할(예: 관리자, 사업자, 지자체). 로그인 없이 보이는 화면이면 빈 문자열.',
      roles.length ? `  계정 풀에 메모로 적힌 역할: ${roles.join(', ')}. 맞는 게 있으면 이 표현을 그대로 쓴다.` : '',
      '- start_path: 시작할 화면 경로("/"로 시작, 호스트 없이). 상세 화면처럼 ID가 필요하면 목록에서 들어가는 단계로 쓴다.',
      '- steps: 화면에서 할 행동을 한 줄씩. 버튼·메뉴·입력란은 화면에 보이는 글자로 가리킨다(예: "[조회] 버튼을 누른다").',
      '- expected: 결과로 화면에 보여야 할 것을 확인 가능한 문장으로. 데이터 값은 개발 DB에 따라 달라지니 열 이름·라벨·형식 위주로.',
      '- 저장·삭제·승인처럼 데이터를 바꾸는 행동은 꼭 필요할 때만, 그 경우 제목에 "(데이터 변경)"을 붙인다.',
      '- 모두 한국어로.',
      '',
      `## 사용자가 이 세션에서 요청한 작업\n${asked.join('\n') || '(대화 없음)'}`,
      ...repos.map(({ w, files, diff }) => [
        '',
        `## ${w.project_name} (${w.project_kind}) 바뀐 파일`,
        files.slice(0, 200).join('\n') || '(없음)',
        diff ? `### diff\n\`\`\`diff\n${diff}\n\`\`\`` : '',
      ].join('\n')),
    ].join('\n');
    let structured: unknown = null;
    const q = query({
      prompt,
      options: {
        cwd: fe.path,
        additionalDirectories: session.worktrees.filter((w) => w.id !== fe.id).map((w) => w.path),
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ['Read', 'Grep', 'Glob'],
        // 사용자 플러그인·훅을 불러오지 않는다. 훅이 작업 폴더에 상태 파일을 만들면 커밋에 섞인다.
        settingSources: [],
        permissionMode: 'dontAsk',
        maxTurns: 30,
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: CASE_SCHEMA },
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success' || msg.is_error) throw new Error('테스트 케이스를 만들지 못했습니다. 다시 시도하세요.');
        structured = msg.structured_output ?? JSON.parse(msg.result);
      }
    }
    type Gen = { title: string; role: string; start_path: string; steps: string[]; expected: string[] };
    const list = ((structured as { cases?: Gen[] } | null)?.cases ?? []).slice(0, 8)
      .map((c) => ({ ...c, start_path: normalizePath(c.start_path), role: c.role.trim() }))
      .filter((c) => c.title.trim() && c.steps.length);
    // 이전 케이스와 결과 파일을 지우고 새로 넣는다. 같은 역할에 이미 확인한 계정이 있으면 이어서 쓴다.
    const prevAccount = new Map(listCases(sessionId).filter((c) => c.role && c.account_id).map((c) => [c.role, c.account_id]));
    db.transaction(() => {
      db.prepare(`DELETE FROM test_cases WHERE session_id = ?`).run(sessionId);
      const ins = db.prepare(`INSERT INTO test_cases (session_id, title, role, start_path, steps, expected, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const c of list) ins.run(sessionId, c.title.trim(), c.role, c.start_path, JSON.stringify(c.steps), JSON.stringify(c.expected), prevAccount.get(c.role) ?? null);
    })();
    fs.rmSync(path.join(TEST_DIR, String(sessionId)), { recursive: true, force: true });
    return list.length;
  } finally {
    generating.delete(sessionId);
    changed(sessionId);
  }
}

function normalizePath(p: string): string {
  const r = p.trim().replace(/^https?:\/\/[^/]+/, '');
  return r ? (r.startsWith('/') ? r : `/${r}`) : '/';
}

export function saveCase(sessionId: number, input: { id?: number; title: string; role: string; start_path: string; steps: string[]; expected: string[] }) {
  const steps = input.steps.map((s) => s.trim()).filter(Boolean);
  const expected = input.expected.map((s) => s.trim()).filter(Boolean);
  if (!input.title.trim()) throw new Error('케이스 제목을 넣어 주세요.');
  if (steps.length === 0) throw new Error('단계를 하나 이상 넣어 주세요.');
  if (input.id) {
    db.prepare(`UPDATE test_cases SET title = ?, role = ?, start_path = ?, steps = ?, expected = ?, status = 'draft', summary = NULL, results = '[]' WHERE id = ? AND session_id = ?`)
      .run(input.title.trim(), input.role.trim(), normalizePath(input.start_path), JSON.stringify(steps), JSON.stringify(expected), input.id, sessionId);
  } else {
    db.prepare(`INSERT INTO test_cases (session_id, title, role, start_path, steps, expected) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, input.title.trim(), input.role.trim(), normalizePath(input.start_path), JSON.stringify(steps), JSON.stringify(expected));
  }
  changed(sessionId);
}

export function deleteCase(sessionId: number, id: number) {
  db.prepare(`DELETE FROM test_cases WHERE id = ? AND session_id = ?`).run(id, sessionId);
  fs.rmSync(path.join(TEST_DIR, String(sessionId), String(id)), { recursive: true, force: true });
  changed(sessionId);
}

/**
 * 역할에 쓸 계정을 사용자가 정한다. 풀에서 고른 계정이면 세션에 배정한 뒤 그 역할의 모든 케이스에 건다.
 * 계정 확인은 이 함수로만 한다. 실행할 때 계정을 추측해서 고르지 않는다.
 */
export function confirmRoleAccount(sessionId: number, role: string, accountId: number) {
  if (!accountOf(sessionId, accountId) || accountOf(sessionId, accountId)!.id !== accountId) assignAccount(sessionId, accountId);
  const acc = accountOf(sessionId, accountId);
  if (!acc || acc.id !== accountId) throw new Error('계정을 배정하지 못했습니다.');
  db.prepare(`UPDATE test_cases SET account_id = ? WHERE session_id = ? AND role = ?`).run(accountId, sessionId, role);
  changed(sessionId);
}

const require = createRequire(import.meta.url);
function playwrightMcpCli(): string {
  // 패키지 exports에 cli.js가 없어 package.json 위치로 찾는다.
  return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { step: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' }, screenshot: { type: 'string' } },
        required: ['step', 'ok', 'note', 'screenshot'],
      },
    },
  },
  required: ['status', 'summary', 'steps'],
};

/** 고른 케이스를 차례로 실행한다. 계정이 필요한데 확인되지 않은 케이스가 있으면 시작하지 않는다. */
export function runTests(sessionId: number, ids?: number[]) {
  const state = testState(sessionId);
  if (running.has(sessionId)) throw new Error('이미 테스트를 실행하는 중입니다.');
  if (!state.app_url) throw new Error('FE 서버가 실행 중이 아닙니다. 서버를 띄우고 헬스체크가 통과한 뒤 실행하세요.');
  const targets = state.cases.filter((c) => !ids || ids.includes(c.id));
  if (targets.length === 0) throw new Error('실행할 테스트 케이스가 없습니다.');
  const unconfirmed = [...new Set(targets.filter((c) => c.role && !(c.account_id && accountOf(sessionId, c.account_id)?.id === c.account_id)).map((c) => c.role))];
  if (unconfirmed.length) throw new Error(`계정을 확인하지 않은 역할이 있습니다: ${unconfirmed.join(', ')}. 역할마다 쓸 계정을 고른 뒤 실행하세요.`);

  const abort = new AbortController();
  running.set(sessionId, abort);
  const mark = db.prepare(`UPDATE test_cases SET status = 'queued' WHERE id = ?`);
  for (const t of targets) mark.run(t.id);
  changed(sessionId);

  (async () => {
    let pass = 0, fail = 0;
    for (const t of targets) {
      if (abort.signal.aborted) break;
      const r = await runCase(sessionId, t, state.app_url!, state.login_path, abort).catch((err) => ({ status: 'error' as const, summary: (err as Error).message }));
      if (r.status === 'pass') pass++; else fail++;
    }
    if (abort.signal.aborted) db.prepare(`UPDATE test_cases SET status = 'draft' WHERE session_id = ? AND status IN ('queued', 'running')`).run(sessionId);
    running.delete(sessionId);
    changed(sessionId);
    const s = getSession(sessionId);
    if (!abort.signal.aborted) {
      try { archiveTestReport(sessionId, targets.map((t) => t.id)); } catch (err) { console.warn('[tests] 결과서를 보관하지 못했습니다:', (err as Error).message); }
      sendNotification(`${s?.ticket ?? ''} 테스트 끝`, `통과 ${pass}개, 실패·확인 불가 ${fail}개`, sessionId);
    }
  })();
}

export function stopTests(sessionId: number) {
  running.get(sessionId)?.abort();
}

async function runCase(sessionId: number, t: TestCase, appUrl: string, loginPath: string | null, abort: AbortController): Promise<{ status: TestStatus; summary: string }> {
  db.prepare(`UPDATE test_cases SET status = 'running', summary = NULL, results = '[]', shots = '[]' WHERE id = ?`).run(t.id);
  changed(sessionId);
  const dir = path.join(TEST_DIR, String(sessionId), String(t.id));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const account = t.role && t.account_id ? accountOf(sessionId, t.account_id) : null;
  const secrets = account ? [account.password] : [];
  const prompt = [
    '브라우저 도구(mcp__browser__*)로 아래 테스트 케이스를 실행하고 결과를 판정해줘. 코드는 읽거나 고치지 않는다.',
    '',
    `앱 주소: ${appUrl}`,
    `시작 화면: ${new URL(t.start_path, appUrl).toString()}`,
    account
      ? `로그인 계정: 아이디 ${account.login} / 비밀번호 ${account.password} (역할: ${t.role})${loginPath ? `. 로그인 화면 경로: ${loginPath}` : ''}. 로그인 화면이 나오면 이 계정으로 로그인한다.`
      : '로그인하지 않는다. 로그인 화면으로 보내지면 status=blocked로 판정한다.',
    '',
    `## 케이스: ${t.title}`,
    '### 단계',
    ...t.steps.map((s, i) => `${i + 1}. ${s}`),
    '### 기대 결과',
    ...t.expected.map((e) => `- ${e}`),
    '',
    '규칙:',
    '- 브라우저는 1440x900 크기다. 단계마다 화면 스냅샷으로 상태를 확인하며 진행한다.',
    '- 확인이 필요한 화면(각 기대 결과를 볼 수 있는 화면, 실패한 화면)은 mcp__browser__browser_take_screenshot으로 찍는다. filename은 "step-<단계번호>.png" 형식으로 준다.',
    '- 기대 결과를 모두 화면에서 확인했으면 status=pass, 하나라도 다르면 fail, 로그인 실패·화면을 찾을 수 없음·서버 오류처럼 확인 자체를 못 하면 blocked.',
    '- 케이스에 없는 데이터 변경(저장·삭제·승인)은 하지 않는다. 단계에 있으면 한다.',
    '- steps에는 단계마다 결과를 적고, 찍었으면 screenshot에 파일 이름을, 안 찍었으면 빈 문자열을 넣는다. summary는 판정 이유 한두 문장. 모두 한국어로.',
    '- 비밀번호는 결과 문장에 적지 않는다.',
  ].join('\n');

  let structured: unknown = null;
  try {
    const q = query({
      prompt,
      options: {
        cwd: dir,
        tools: [],
        mcpServers: {
          browser: {
            type: 'stdio',
            command: process.execPath,
            args: [playwrightMcpCli(), '--headless', '--browser', 'chrome', '--isolated', '--viewport-size', '1440,900', '--output-dir', dir],
          },
        },
        allowedTools: ['mcp__browser'],
        settingSources: [],
        permissionMode: 'dontAsk',
        maxTurns: 60,
        persistSession: false,
        abortController: abort,
        outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success' || msg.is_error) throw new Error('테스트를 끝까지 실행하지 못했습니다.');
        structured = msg.structured_output ?? JSON.parse(msg.result);
      }
    }
  } catch (err) {
    if (abort.signal.aborted) return { status: 'draft', summary: '' };
    const summary = maskSecrets((err as Error).message, secrets);
    db.prepare(`UPDATE test_cases SET status = 'error', summary = ?, shots = ?, ran_at = datetime('now') WHERE id = ?`).run(summary, JSON.stringify(collectShots(dir, [])), t.id);
    changed(sessionId);
    return { status: 'error', summary };
  }
  type Res = { status: 'pass' | 'fail' | 'blocked'; summary: string; steps: { step: string; ok: boolean; note: string; screenshot: string }[] };
  const r = structured as Res;
  const results = (r?.steps ?? []).map((s) => ({ step: maskSecrets(s.step, secrets), ok: s.ok, note: maskSecrets(s.note, secrets), shot: shotName(dir, s.screenshot) }));
  const shots = collectShots(dir, results);
  const status: TestStatus = r?.status ?? 'error';
  const summary = maskSecrets(r?.summary ?? '결과를 읽지 못했습니다.', secrets);
  db.prepare(`UPDATE test_cases SET status = ?, summary = ?, results = ?, shots = ?, ran_at = datetime('now') WHERE id = ?`)
    .run(status, summary, JSON.stringify(results), JSON.stringify(shots), t.id);
  changed(sessionId);
  return { status, summary };
}

/** 결과에 적힌 파일 이름을 실제 파일과 맞춘다. 에이전트가 경로까지 적어도 이름만 본다. */
function shotName(dir: string, name: string): string | null {
  const base = path.basename(name || '');
  return base && fs.existsSync(path.join(dir, base)) ? base : null;
}

/** 폴더의 스크린샷을 단계 설명과 묶어 순서대로 돌려준다. 결과에 안 적힌 것도 빠뜨리지 않는다. */
function collectShots(dir: string, results: { step: string; shot: string | null }[]): { file: string; caption: string }[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
  const byFile = new Map(results.filter((r) => r.shot).map((r) => [r.shot!, r.step]));
  return files
    .map((f) => ({ file: f, caption: byFile.get(f) ?? '', at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.at - b.at)
    .map(({ file, caption }) => ({ file, caption }));
}

export function testShotPath(sessionId: number, caseId: number, file: string): string | null {
  if (!/^[\w.-]+\.(png|jpe?g)$/i.test(file)) return null;
  const full = path.join(TEST_DIR, String(sessionId), String(caseId), file);
  return fs.existsSync(full) ? full : null;
}

export function deleteSessionTests(sessionId: number) {
  fs.rmSync(path.join(TEST_DIR, String(sessionId)), { recursive: true, force: true });
  db.prepare(`DELETE FROM test_cases WHERE session_id = ?`).run(sessionId);
}

const STATUS_LABEL: Record<TestStatus, string> = { draft: '실행 전', queued: '대기', running: '실행 중', pass: '통과', fail: '실패', blocked: '확인 불가', error: '오류' };
const escHtml = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * 테스트를 돌릴 때마다 결과서를 산출물 보관함에 남긴다. 스크린샷을 파일 안에 넣어 한 파일로 완결되게 하고,
 * 케이스를 다시 만들거나 리소스를 정리해 원본 스크린샷이 지워져도 남는다. 실행할 때마다 새 판이 된다.
 */
export function archiveTestReport(sessionId: number, ranIds: number[]) {
  const s = getSession(sessionId);
  const cases = listCases(sessionId).filter((c) => ranIds.includes(c.id) && c.ran_at);
  if (!s || cases.length === 0) return;
  const count = (st: TestStatus[]) => cases.filter((c) => st.includes(c.status)).length;
  const img = (caseId: number, file: string) => {
    const full = testShotPath(sessionId, caseId, file);
    if (!full) return '';
    const type = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    return `data:${type};base64,${fs.readFileSync(full).toString('base64')}`;
  };
  const body = cases.map((c) => {
    const acc = c.account_id ? accountOf(sessionId, c.account_id) : null;
    const steps = c.results.length
      ? c.results.map((r, i) => `<tr><td>${i + 1}</td><td>${escHtml(r.step)}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '통과' : '실패'}</td><td>${escHtml(r.note)}</td></tr>`).join('')
      : c.steps.map((st, i) => `<tr><td>${i + 1}</td><td>${escHtml(st)}</td><td>-</td><td></td></tr>`).join('');
    const shots = c.shots.map((sh) => { const src = img(c.id, sh.file); return src ? `<figure><img src="${src}" alt=""><figcaption>${escHtml(sh.caption || sh.file)}</figcaption></figure>` : ''; }).join('');
    return `<section><h2><span class="st ${c.status}">${STATUS_LABEL[c.status]}</span> ${escHtml(c.title)}</h2>
<p class="m">역할 ${escHtml(c.role || '로그인 없음')}${acc ? ` · 계정 ${escHtml(acc.login)}` : ''} · 시작 화면 <code>${escHtml(c.start_path)}</code> · ${new Date(`${c.ran_at!.replace(' ', 'T')}Z`).toLocaleString('ko-KR')}</p>
${c.summary ? `<p>${escHtml(c.summary)}</p>` : ''}
<table><thead><tr><th>#</th><th>단계</th><th>결과</th><th>메모</th></tr></thead><tbody>${steps}</tbody></table>
<h3>기대 결과</h3><ul>${c.expected.map((e) => `<li>${escHtml(e)}</li>`).join('')}</ul>
${shots ? `<div class="shots">${shots}</div>` : ''}</section>`;
  }).join('');
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escHtml(s.ticket)} 테스트 결과서</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:32px;color:#1b2230;max-width:1100px}h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:0 0 4px}h3{font-size:14px;margin:12px 0 4px}.m{color:#6b7280;font-size:13px;margin:0 0 8px}
section{border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13.5px;vertical-align:top}th{background:#f6f7f9}td:nth-child(1){width:24px}td:nth-child(2){width:34%}td:nth-child(3),th:nth-child(3){white-space:nowrap}
.st{font-size:12px;padding:2px 8px;border-radius:999px;background:#e5e7eb;margin-right:6px}.st.pass,.ok{color:#137333}.st.pass{background:#e6f4ea}.st.fail,.st.error,.bad{color:#b3261e}.st.fail,.st.error{background:#fce8e6}.st.blocked{background:#fef7e0;color:#8a5a00}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;margin-top:12px}figure{margin:0}img{width:100%;border:1px solid #e5e7eb;border-radius:6px}figcaption{font-size:12.5px;color:#6b7280;margin-top:4px}</style></head>
<body><h1>${escHtml(s.ticket)} 테스트 결과서</h1>
<p class="m">${escHtml(s.summary)} · ${s.worktrees.map((w) => `${escHtml(w.project_name)} <code>${escHtml(w.branch)}</code>`).join(', ')}</p>
<p>케이스 ${cases.length}개 · 통과 ${count(['pass'])} · 실패 ${count(['fail'])} · 확인 불가·오류 ${count(['blocked', 'error'])}</p>
${body}</body></html>`;
  saveDoc(sessionId, { name: 'test-report', title: '화면 테스트 결과서', kind: 'test', html }, { maxBytes: 60 * 1024 * 1024 });
}
