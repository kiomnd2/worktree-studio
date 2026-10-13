import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { PNG } from 'pngjs';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE, DATA_DIR } from './config.js';
import { db } from './db.js';
import { git, refExists } from './git.js';
import { getProject } from './projects.js';
import { getSession, listMessages, type SessionView } from './sessions.js';
import { listServers } from './runner.js';
import { accountOf } from './accounts.js';
import { broadcast } from './hub.js';

/**
 * 영향받는 화면 체크리스트. Claude가 바뀐 파일에서 화면 경로를 찾아 목록으로 만들고,
 * 사용자가 미리보기에서 열어 보고 확인했다고 표시한다. 자동 촬영·비교는 하지 않는다.
 */

/** 예전 버전이 남긴 스크린샷 폴더. 리소스 정리에서 지운다. */
export const SCREEN_DIR = path.join(DATA_DIR, 'screens');
const VIEWPORT = { width: 1440, height: 900 };

export type ScreenCheck = {
  id: number; session_id: number; route: string; reason: string; checked: boolean;
  /** direct: 이 화면에서 보이는 게 실제로 바뀜. indirect: 바뀐 코드를 쓰긴 하지만 보이는 변화는 확실하지 않음 */
  kind: 'direct' | 'indirect';
  /** 같은 화면 컴포넌트를 쓰는 다른 경로 */
  also_routes: string[];
  manual: boolean;
};

type Row = { id: number; session_id: number; route: string; reason: string; status: string; kind: string; also_routes: string; manual: number };
const toView = (r: Row): ScreenCheck => ({
  id: r.id, session_id: r.session_id, route: r.route, reason: r.reason, checked: r.status === 'accepted',
  kind: r.kind === 'indirect' ? 'indirect' : 'direct', also_routes: JSON.parse(r.also_routes || '[]'), manual: Boolean(r.manual),
});

const detecting = new Set<number>();

export function screenState(sessionId: number) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const fe = feWorktree(session);
  const project = fe ? getProject(fe.project_id) : undefined;
  const server = fe ? listServers(session).find((s) => s.worktree_id === fe.id && s.url) : undefined;
  const checks = (db.prepare(`SELECT id, session_id, route, reason, status, kind, also_routes, manual FROM screen_checks WHERE session_id = ? ORDER BY kind = 'indirect', id`).all(sessionId) as Row[]).map(toView);
  return {
    checks,
    preview_url: server?.status === 'running' ? server.url : null,
    detecting: detecting.has(sessionId),
    fe_project: project ? { id: project.id, name: project.name } : null,
  };
}

export function feWorktree(session: SessionView) {
  return session.worktrees.find((w) => w.project_kind === 'fe') ?? session.worktrees.find((w) => w.project_kind === 'full') ?? null;
}

function changed(sessionId: number) {
  broadcast({ type: 'screens.updated', sessionId });
}

export async function changedFiles(w: SessionView['worktrees'][number]): Promise<string[]> {
  const ref = (await refExists(w.path, `refs/remotes/origin/${w.base_branch}`)) ? `origin/${w.base_branch}` : w.base_branch;
  const tracked = await git(w.path, ['diff', '--name-only', ref]).catch(() => '');
  const untracked = await git(w.path, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))];
}

/** 기준 브랜치와 갈라진 지점부터의 diff. 무엇이 바뀌었는지 보고 화면 영향을 판단하게 한다. 너무 길면 자른다. */
export async function changedDiff(w: SessionView['worktrees'][number]): Promise<string> {
  const base = (await refExists(w.path, `refs/remotes/origin/${w.base_branch}`)) ? `origin/${w.base_branch}` : w.base_branch;
  const ref = await git(w.path, ['merge-base', base, 'HEAD']).catch(() => base);
  const diff = await git(w.path, ['diff', '-U3', ref, '--', '.', ':(exclude)package-lock.json', ':(exclude)*.lock', ':(exclude)pnpm-lock.yaml']).catch(() => '');
  return diff.length > 30_000 ? `${diff.slice(0, 30_000)}\n… (이하 생략)` : diff;
}

const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    screens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          route: { type: 'string' },
          also_routes: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: ['direct', 'indirect'] },
          reason: { type: 'string' },
        },
        required: ['route', 'also_routes', 'kind', 'reason'],
      },
    },
  },
  required: ['screens'],
};

/** 바뀐 파일에서 라우터 설정과 import를 따라가 영향받는 화면 경로를 Claude에게 찾게 한다. */
export async function detectScreens(sessionId: number) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const fe = feWorktree(session);
  if (!fe) throw new Error('이 세션에는 FE 워크트리가 없어 화면을 찾을 수 없습니다.');
  if (detecting.has(sessionId)) throw new Error('이미 영향 화면을 찾는 중입니다.');
  const files = await Promise.all(session.worktrees.map(async (w) => ({ w, files: await changedFiles(w), diff: await changedDiff(w) })));
  if (files.every((f) => f.files.length === 0)) throw new Error('기준 브랜치와 달라진 파일이 없습니다.');

  detecting.add(sessionId);
  changed(sessionId);
  try {
    const asked = listMessages(sessionId).filter((m) => m.kind === 'user' && m.payload?.text).slice(-6)
      .map((m) => `- ${String(m.payload.text).replace(/\s+/g, ' ').slice(0, 300)}`);
    const prompt = [
      '이 작업 때문에 사람이 직접 열어서 확인해야 하는 화면을 골라줘. 목록이 짧고 정확해야 한다. 넓게 잡지 마.',
      '',
      '규칙:',
      '- 화면 하나 = 화면을 그리는 페이지 컴포넌트 하나. 같은 페이지 컴포넌트를 여러 라우트(예: /rego/x, /gov/rego/x)가 쓰면 대표 경로 하나를 route에, 나머지는 also_routes에 넣는다.',
      '- kind=direct: 바뀐 코드 때문에 그 화면에서 보이는 내용·배치·동작이 실제로 달라지는 경우만. 바뀐 diff를 읽고, 그 화면이 바뀐 부분(컴포넌트, 렌더링에 쓰는 필드·라벨, 호출하는 API의 바뀐 응답 필드)을 실제로 쓰는지 확인해.',
      '- kind=indirect: 바뀐 파일을 import하지만 바뀐 부분을 쓰지 않거나 보이는 변화가 확실하지 않은 경우. 타입 정의만 가져다 쓰는 화면은 대부분 indirect다. indirect는 정말 의심스러운 것만 넣는다.',
      '- BE만 바뀌었으면 바뀐 API의 응답 필드가 그 화면에 표시되는지 확인한 뒤에만 direct로 넣는다.',
      '- 사용자가 요청한 작업 범위(아래)를 기준으로 판단해. 그 범위 밖 화면은 확실할 때만 넣는다.',
      '- 상세 화면처럼 경로에 ID가 들어가면 목 데이터·시드·테스트 코드에서 있을 법한 값을 고르고, 못 찾으면 1을 넣어.',
      '- route와 also_routes는 "/"로 시작하는 경로만(호스트 없이). reason은 무엇이 어떻게 달라 보이는지 한 문장 한국어로.',
      '- direct는 보통 1~3개다. 전체 10개를 넘기지 마.',
      '',
      `## 사용자가 이 세션에서 요청한 작업\n${asked.join('\n') || '(대화 없음)'}`,
      '',
      ...files.map(({ w, files: list, diff }) => [
        `## ${w.project_name} (${w.project_kind}) 바뀐 파일`,
        list.slice(0, 200).join('\n') || '(없음)',
        diff ? `### 바뀐 내용 (diff)\n\`\`\`diff\n${diff}\n\`\`\`` : '',
      ].join('\n')),
    ].join('\n');
    let structured: unknown = null;
    const q = query({
      prompt,
      options: {
        cwd: fe.path,
        additionalDirectories: session.worktrees.filter((w) => w.id !== fe.id).map((w) => w.path),
        tools: ['Read', 'Grep', 'Glob'],
        // 사용자 플러그인·훅을 불러오지 않는다. 훅이 작업 폴더에 상태 파일(.bkit/ 등)을 만들면 PR 커밋에 섞인다.
        settingSources: [],
        allowedTools: ['Read', 'Grep', 'Glob'],
        permissionMode: 'dontAsk',
        maxTurns: 40,
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: DETECT_SCHEMA },
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success' || msg.is_error) throw new Error('영향 화면 분석이 끝나지 못했습니다. 다시 시도하거나 직접 추가하세요.');
        structured = msg.structured_output ?? JSON.parse(msg.result);
      }
    }
    type Found = { route: string; also_routes: string[]; kind: string; reason: string };
    const list = ((structured as { screens?: Found[] } | null)?.screens ?? [])
      .map((s) => ({
        route: normalizeRoute(s.route),
        also: [...new Set((s.also_routes ?? []).map(normalizeRoute).filter((r) => r && r !== normalizeRoute(s.route)))],
        kind: s.kind === 'indirect' ? 'indirect' : 'direct',
        reason: s.reason.trim(),
      }))
      .filter((s) => s.route)
      .slice(0, 10);
    // 다시 찾으면 이전에 찾은 목록을 새 결과로 바꾼다. 직접 추가했거나 확인 표시한 화면은 남긴다.
    db.transaction(() => {
      db.prepare(`DELETE FROM screen_checks WHERE session_id = ? AND manual = 0 AND status != 'accepted'`).run(sessionId);
      const upsert = db.prepare(`INSERT INTO screen_checks (session_id, route, reason, kind, also_routes) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, route) DO UPDATE SET reason = excluded.reason, kind = excluded.kind, also_routes = excluded.also_routes`);
      for (const s of list) upsert.run(sessionId, s.route, s.reason, s.kind, JSON.stringify(s.also));
      // 새 결과에서 다른 화면의 also_routes로 묶인 경로가 따로 남아 있으면 지운다(확인 표시한 것 제외).
      const grouped = list.flatMap((s) => s.also);
      const del = db.prepare(`DELETE FROM screen_checks WHERE session_id = ? AND route = ? AND manual = 0`);
      for (const r of grouped) del.run(sessionId, r);
    })();
    return list.filter((s) => s.kind === 'direct').length;
  } finally {
    detecting.delete(sessionId);
    changed(sessionId);
  }
}

function normalizeRoute(route: string): string {
  const r = route.trim().replace(/^https?:\/\/[^/]+/, '');
  if (!r) return '';
  return r.startsWith('/') ? r : `/${r}`;
}

export function addScreen(sessionId: number, route: string) {
  const r = normalizeRoute(route);
  if (!r) throw new Error('화면 경로를 넣어 주세요. 예: /resources/12');
  db.prepare(`INSERT INTO screen_checks (session_id, route, reason, manual) VALUES (?, ?, '직접 추가', 1) ON CONFLICT(session_id, route) DO UPDATE SET manual = 1`).run(sessionId, r);
  changed(sessionId);
}

export function removeScreen(id: number) {
  const row = db.prepare(`SELECT session_id FROM screen_checks WHERE id = ?`).get(id) as { session_id: number } | undefined;
  if (!row) return;
  db.prepare(`DELETE FROM screen_checks WHERE id = ?`).run(id);
  changed(row.session_id);
}

/** 사용자가 화면을 보고 확인했다고 표시한다. */
export function setScreenChecked(id: number, checked: boolean) {
  const row = db.prepare(`SELECT session_id FROM screen_checks WHERE id = ?`).get(id) as { session_id: number } | undefined;
  if (!row) throw new Error('화면 기록이 없습니다.');
  db.prepare(`UPDATE screen_checks SET status = ? WHERE id = ?`).run(checked ? 'accepted' : 'pending', id);
  changed(row.session_id);
}

export function deleteSessionScreens(sessionId: number) {
  fs.rmSync(path.join(SCREEN_DIR, String(sessionId)), { recursive: true, force: true });
  db.prepare(`DELETE FROM screen_checks WHERE session_id = ?`).run(sessionId);
}

export function screenDirSize(sessionId: number): number {
  const dir = path.join(SCREEN_DIR, String(sessionId));
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
}

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true });
    } catch {
      throw new Error('화면을 찍을 브라우저를 열지 못했습니다. Google Chrome을 설치하거나 npx playwright install chromium을 실행하세요.');
    }
  }
}

/** 로그인 경로가 있으면 배정 계정으로 로그인한다. 아이디·비밀번호 입력란이 하나씩 있는 일반 폼만 처리한다. */
async function login(ctx: BrowserContext, base: string, loginPath: string, account: { login: string; password: string }): Promise<string | null> {
  const page = await ctx.newPage();
  try {
    await page.goto(new URL(loginPath, base).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const pw = page.locator('input[type=password]').first();
    await pw.waitFor({ timeout: 15_000 });
    const user = page.locator('input[type=email], input[autocomplete=username], input[name*=id i], input[name*=user i], input[name*=login i], input[name*=email i], input[type=text]').first();
    await user.fill(account.login);
    await pw.fill(account.password);
    await pw.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    // 제출 뒤에도 비밀번호 입력란이 보이면 로그인이 안 된 것이다(틀린 비밀번호, 추가 인증, 다른 형식의 폼 등).
    if (await page.locator('input[type=password]').first().isVisible().catch(() => false)) {
      return `${base}에서 ${account.login} 계정으로 로그인하지 못했습니다. 제출 뒤에도 로그인 화면입니다 (비밀번호, 추가 인증, 폼 형식을 확인하세요).`;
    }
    return null;
  } catch (err) {
    return `${base}에서 로그인하지 못했습니다 (${loginPath}에서 아이디·비밀번호 입력란을 못 찾음: ${(err as Error).message.split('\n')[0]}).`;
  } finally {
    await page.close().catch(() => {});
  }
}

type Shot = { buf: Buffer; path: string; loginWall: boolean };

const normPath = (p: string) => p.replace(/\/+$/, '') || '/';

/** 찍은 뒤 실제로 도착한 경로와 로그인 화면인지를 함께 돌려준다. 로그인이 안 되면 앱이 다른 화면으로 보내기 때문. */
async function shoot(ctx: BrowserContext, url: string): Promise<Shot> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    });
    // 깜빡이는 커서와 애니메이션이 차이로 잡히지 않게 멈춘다.
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
    await page.waitForTimeout(400);
    const landed = new URL(page.url());
    const wanted = new URL(url);
    // 로그인 화면 자체를 찍으려는 경우가 아니면, 보이는 비밀번호 입력란은 로그인 벽으로 본다.
    const loginWall = !/login|signin|sign-in/i.test(wanted.pathname)
      && await page.locator('input[type=password]').first().isVisible().catch(() => false);
    const buf = await page.screenshot({ fullPage: true, animations: 'disabled' });
    return { buf, path: normPath(landed.pathname), loginWall };
  } finally {
    await page.close().catch(() => {});
  }
}

/** 미리보기에 띄운 주소를 찍어 프롬프트 첨부용 이미지로 돌려준다. 로그인 경로가 있으면 배정 계정으로 먼저 로그인한다. */
export async function capturePreview(sessionId: number, url: string, accountId?: number): Promise<{ data: string; warning: string | null }> {
  const state = screenState(sessionId);
  if (!state.preview_url || !url.startsWith(state.preview_url)) throw new Error('이 세션의 FE 미리보기 주소만 찍을 수 있습니다.');
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const account = accountOf(sessionId, accountId);
    const loginPath = state.fe_project ? getProject(state.fe_project.id)?.login_path ?? null : null;
    const loginWarning = account && loginPath ? await login(ctx, state.preview_url, loginPath, account) : null;
    const shot = await shoot(ctx, url);
    const buf = shot.buf;
    const warning = shot.loginWall
      ? `로그인 화면이 찍혔습니다. ${loginWarning ?? (!account ? '세션에 테스트 계정이 없습니다.' : !loginPath ? '설정에 로그인 경로가 없습니다.' : '')}`.trim()
      : loginWarning;
    const img = PNG.sync.read(buf);
    // 첨부는 장당 5MB까지라 화면 두 장 높이로 자른다.
    const h = Math.min(img.height, VIEWPORT.height * 2);
    const out = new PNG({ width: img.width, height: h });
    PNG.bitblt(img, out, 0, 0, img.width, h, 0, 0);
    return { data: PNG.sync.write(out).toString('base64'), warning };
  } finally {
    await browser.close().catch(() => {});
  }
}
