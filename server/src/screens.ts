import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE, DATA_DIR } from './config.js';
import { db } from './db.js';
import { git, refExists } from './git.js';
import { getProject } from './projects.js';
import { getSession, type SessionView } from './sessions.js';
import { listServers } from './runner.js';
import { accountOf } from './accounts.js';
import { broadcast } from './hub.js';

export const SCREEN_DIR = path.join(DATA_DIR, 'screens');
const VIEWPORT = { width: 1440, height: 900 };
/** 이 비율보다 적게 바뀌면 같은 화면으로 본다. 글꼴 렌더링 같은 잡음을 흘려보내는 값. */
const SAME_RATIO = 0.0005;
const MAX_HEIGHT = 8000;

export type Box = { x: number; y: number; w: number; h: number };
export type ScreenCheck = {
  id: number; session_id: number; route: string; reason: string;
  before_file: string | null; after_file: string | null; diff_file: string | null;
  diff_ratio: number | null; boxes: Box[];
  status: 'pending' | 'capturing' | 'changed' | 'same' | 'failed' | 'accepted';
  error: string | null; captured_at: string | null;
};

type Row = Omit<ScreenCheck, 'boxes'> & { boxes: string };
const toView = (r: Row): ScreenCheck => ({ ...r, boxes: JSON.parse(r.boxes || '[]') });

const capturing = new Set<number>();
const detecting = new Set<number>();

export function screenState(sessionId: number) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const fe = feWorktree(session);
  const project = fe ? getProject(fe.project_id) : undefined;
  const after = fe ? listServers(session).find((s) => s.worktree_id === fe.id && s.url) : undefined;
  const checks = (db.prepare(`SELECT * FROM screen_checks WHERE session_id = ? ORDER BY id`).all(sessionId) as Row[]).map(toView);
  return {
    checks,
    baseline_url: project?.baseline_url ?? null,
    after_url: after?.status === 'running' ? after.url : null,
    login_path: project?.login_path ?? null,
    account: session.account?.login ?? null,
    viewport: VIEWPORT,
    capturing: capturing.has(sessionId),
    detecting: detecting.has(sessionId),
    fe_project: project ? { id: project.id, name: project.name } : null,
  };
}

function feWorktree(session: SessionView) {
  return session.worktrees.find((w) => w.project_kind === 'fe') ?? session.worktrees.find((w) => w.project_kind === 'full') ?? null;
}

function changed(sessionId: number) {
  broadcast({ type: 'screens.updated', sessionId });
}

async function changedFiles(w: SessionView['worktrees'][number]): Promise<string[]> {
  const ref = (await refExists(w.path, `refs/remotes/origin/${w.base_branch}`)) ? `origin/${w.base_branch}` : w.base_branch;
  const tracked = await git(w.path, ['diff', '--name-only', ref]).catch(() => '');
  const untracked = await git(w.path, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))];
}

const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    screens: {
      type: 'array',
      items: {
        type: 'object',
        properties: { route: { type: 'string' }, reason: { type: 'string' } },
        required: ['route', 'reason'],
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
  const files = await Promise.all(session.worktrees.map(async (w) => ({ w, files: await changedFiles(w) })));
  if (files.every((f) => f.files.length === 0)) throw new Error('기준 브랜치와 달라진 파일이 없습니다.');

  detecting.add(sessionId);
  changed(sessionId);
  try {
    const prompt = [
      '이 FE 프로젝트에서 아래 변경 때문에 화면이 달라질 수 있는 페이지 경로(URL path)를 찾아줘.',
      '라우터 설정(react-router, Next.js app/pages 디렉터리, vue-router 등)과 import 관계를 따라가서, 바뀐 컴포넌트·훅·스타일·API 호출을 쓰는 페이지를 모두 찾아.',
      'BE 파일이 바뀌었으면 바뀐 API 경로를 FE 코드에서 검색해 그 API를 부르는 페이지도 넣어.',
      '상세 화면처럼 경로에 ID가 들어가면 목 데이터, 시드 데이터, 테스트 코드에서 실제로 있을 법한 값을 골라 넣고, 못 찾으면 1을 넣어.',
      'route는 "/"로 시작하는 경로만(호스트 없이), reason은 "직접 수정" 또는 "어떤 파일을 통해" 영향받는지 한 문장 한국어로. 최대 15개.',
      '',
      ...files.map(({ w, files: list }) => `## ${w.project_name} (${w.project_kind}) 바뀐 파일\n${list.slice(0, 200).join('\n') || '(없음)'}`),
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
    const list = ((structured as { screens?: { route: string; reason: string }[] } | null)?.screens ?? [])
      .map((s) => ({ route: normalizeRoute(s.route), reason: s.reason.trim() }))
      .filter((s) => s.route);
    const upsert = db.prepare(`INSERT INTO screen_checks (session_id, route, reason) VALUES (?, ?, ?)
      ON CONFLICT(session_id, route) DO UPDATE SET reason = excluded.reason`);
    db.transaction(() => { for (const s of list.slice(0, 15)) upsert.run(sessionId, s.route, s.reason); })();
    return list.length;
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
  db.prepare(`INSERT INTO screen_checks (session_id, route, reason) VALUES (?, ?, '직접 추가') ON CONFLICT(session_id, route) DO NOTHING`).run(sessionId, r);
  changed(sessionId);
}

export function removeScreen(id: number) {
  const row = db.prepare(`SELECT * FROM screen_checks WHERE id = ?`).get(id) as Row | undefined;
  if (!row) return;
  removeFiles(row);
  db.prepare(`DELETE FROM screen_checks WHERE id = ?`).run(id);
  changed(row.session_id);
}

export function setScreenStatus(id: number, accepted: boolean) {
  const row = db.prepare(`SELECT * FROM screen_checks WHERE id = ?`).get(id) as Row | undefined;
  if (!row) throw new Error('화면 기록이 없습니다.');
  const status = accepted ? 'accepted' : row.diff_ratio === null ? 'pending' : row.diff_ratio < SAME_RATIO ? 'same' : 'changed';
  db.prepare(`UPDATE screen_checks SET status = ? WHERE id = ?`).run(status, id);
  changed(row.session_id);
}

function removeFiles(row: Pick<Row, 'session_id' | 'before_file' | 'after_file' | 'diff_file'>) {
  for (const f of [row.before_file, row.after_file, row.diff_file]) {
    if (f) fs.rmSync(path.join(SCREEN_DIR, String(row.session_id), f), { force: true });
  }
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
    return null;
  } catch (err) {
    return `${base} 로그인을 못 했습니다 (${(err as Error).message.split('\n')[0]}). 로그인 없이 찍었습니다.`;
  } finally {
    await page.close().catch(() => {});
  }
}

async function shoot(ctx: BrowserContext, url: string): Promise<Buffer> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
      await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    });
    // 깜빡이는 커서와 애니메이션이 차이로 잡히지 않게 멈춘다.
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
    await page.waitForTimeout(400);
    return await page.screenshot({ fullPage: true, animations: 'disabled', clip: undefined });
  } finally {
    await page.close().catch(() => {});
  }
}

function pad(img: PNG, w: number, h: number): PNG {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, Math.min(img.width, w), Math.min(img.height, h), 0, 0);
  return out;
}

/** 차이 픽셀을 격자로 묶어 사람이 볼 만한 상자 몇 개로 만든다. */
function diffBoxes(diff: PNG, cell = 16): Box[] {
  const cols = Math.ceil(diff.width / cell);
  const rows = Math.ceil(diff.height / cell);
  const hit = new Uint8Array(cols * rows);
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) hit[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const boxes: Box[] = [];
  for (let start = 0; start < hit.length; start++) {
    if (!hit[start] || seen[start]) continue;
    let minX = cols, minY = rows, maxX = 0, maxY = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cols, cy = Math.floor(c / cols);
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      // 한 칸 떨어진 차이도 같은 덩어리로 묶는다.
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (hit[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    boxes.push({ x: minX * cell, y: minY * cell, w: (maxX - minX + 1) * cell, h: (maxY - minY + 1) * cell });
  }
  return boxes.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 20).sort((a, b) => a.y - b.y || a.x - b.x);
}

function compare(before: Buffer, after: Buffer): { diff: Buffer; ratio: number; boxes: Box[] } {
  const a0 = PNG.sync.read(before);
  const b0 = PNG.sync.read(after);
  const w = Math.max(a0.width, b0.width);
  const h = Math.min(Math.max(a0.height, b0.height), MAX_HEIGHT);
  const a = pad(a0, w, h);
  const b = pad(b0, w, h);
  const diff = new PNG({ width: w, height: h });
  // 같은 브라우저·같은 기기에서 찍어 렌더링 잡음이 거의 없으므로 기본값(0.1)보다 훨씬 엄격하게 본다.
  // 0.1이면 흰 바탕이 연한 분홍으로 바뀌는 정도의 배경색 변경을 놓친다. 안티앨리어싱은 pixelmatch가 따로 거른다.
  const n = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.005, alpha: 0.25 });
  return { diff: PNG.sync.write(diff), ratio: n / (w * h), boxes: diffBoxes(diff) };
}

/** 기준 서버와 작업 서버에서 같은 계정·같은 해상도로 화면을 찍고 비교한다. 진행 상황은 이벤트로 알린다. */
export async function captureScreens(sessionId: number, ids?: number[]): Promise<{ warnings: string[] }> {
  const state = screenState(sessionId);
  if (!state.baseline_url) throw new Error(`기준 서버 주소가 없습니다. 설정의 ${state.fe_project?.name ?? 'FE'} 프로젝트에 develop 기준 서버 주소를 넣으세요.`);
  if (!state.after_url) throw new Error('FE 서버가 실행 중이 아닙니다. 서버를 띄우고 헬스체크가 통과한 뒤 찍으세요.');
  if (capturing.has(sessionId)) throw new Error('이미 화면을 찍는 중입니다.');
  const targets = state.checks.filter((c) => !ids || ids.includes(c.id));
  if (targets.length === 0) throw new Error('찍을 화면이 없습니다. 영향 화면을 찾거나 직접 추가하세요.');

  capturing.add(sessionId);
  const mark = db.prepare(`UPDATE screen_checks SET status = 'capturing', error = NULL WHERE id = ?`);
  for (const t of targets) mark.run(t.id);
  changed(sessionId);

  const dir = path.join(SCREEN_DIR, String(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  const warnings: string[] = [];
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const account = accountOf(sessionId);
    const beforeCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const afterCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    if (account && state.login_path) {
      for (const [ctx, base] of [[beforeCtx, state.baseline_url], [afterCtx, state.after_url]] as const) {
        const w = await login(ctx, base, state.login_path, account);
        if (w) warnings.push(w);
      }
    }
    for (const t of targets) {
      const stamp = Date.now();
      try {
        const [before, after] = await Promise.all([
          shoot(beforeCtx, new URL(t.route, state.baseline_url).toString()),
          shoot(afterCtx, new URL(t.route, state.after_url).toString()),
        ]);
        const { diff, ratio, boxes } = compare(before, after);
        const files = { before: `${t.id}-${stamp}-before.png`, after: `${t.id}-${stamp}-after.png`, diff: `${t.id}-${stamp}-diff.png` };
        fs.writeFileSync(path.join(dir, files.before), before);
        fs.writeFileSync(path.join(dir, files.after), after);
        fs.writeFileSync(path.join(dir, files.diff), diff);
        const old = db.prepare(`SELECT * FROM screen_checks WHERE id = ?`).get(t.id) as Row | undefined;
        if (old) removeFiles(old);
        db.prepare(`UPDATE screen_checks SET before_file = ?, after_file = ?, diff_file = ?, diff_ratio = ?, boxes = ?, status = ?, error = NULL, captured_at = datetime('now') WHERE id = ?`)
          .run(files.before, files.after, files.diff, ratio, JSON.stringify(boxes), ratio < SAME_RATIO ? 'same' : 'changed', t.id);
      } catch (err) {
        db.prepare(`UPDATE screen_checks SET status = 'failed', error = ? WHERE id = ?`).run((err as Error).message.split('\n')[0].slice(0, 300), t.id);
      }
      changed(sessionId);
    }
    await beforeCtx.close();
    await afterCtx.close();
  } catch (err) {
    db.prepare(`UPDATE screen_checks SET status = 'failed', error = ? WHERE session_id = ? AND status = 'capturing'`).run((err as Error).message, sessionId);
    throw err;
  } finally {
    await browser?.close().catch(() => {});
    capturing.delete(sessionId);
    changed(sessionId);
  }
  return { warnings };
}

/** 첫 차이 상자 주변만 잘라 Claude에게 보낼 이미지로 만든다. 전체 화면은 너무 클 수 있다. */
export function cropForPrompt(sessionId: number, file: string, box: Box | undefined): string {
  const img = PNG.sync.read(fs.readFileSync(path.join(SCREEN_DIR, String(sessionId), file)));
  const top = Math.max(0, Math.min(img.height - 1, (box?.y ?? 0) - 300));
  const h = Math.min(img.height - top, 1800);
  const out = new PNG({ width: img.width, height: h });
  PNG.bitblt(img, out, 0, top, img.width, h, 0, 0);
  return PNG.sync.write(out).toString('base64');
}

export function getScreen(id: number): ScreenCheck | undefined {
  const r = db.prepare(`SELECT * FROM screen_checks WHERE id = ?`).get(id) as Row | undefined;
  return r ? toView(r) : undefined;
}

/** 미리보기에 띄운 주소를 찍어 프롬프트 첨부용 이미지로 돌려준다. 로그인 경로가 있으면 배정 계정으로 먼저 로그인한다. */
export async function capturePreview(sessionId: number, url: string): Promise<{ data: string; warning: string | null }> {
  const state = screenState(sessionId);
  if (!state.after_url || !url.startsWith(state.after_url)) throw new Error('이 세션의 FE 미리보기 주소만 찍을 수 있습니다.');
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const account = accountOf(sessionId);
    const warning = account && state.login_path ? await login(ctx, state.after_url, state.login_path, account) : null;
    const buf = await shoot(ctx, url);
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
