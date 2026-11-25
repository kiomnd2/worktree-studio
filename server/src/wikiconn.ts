import { execFileSync } from 'node:child_process';
import { db } from './db.js';
import { decrypt, encrypt } from './secret.js';

/**
 * Project-Wiki(Guide Manager) 게시 연결. 워크스페이스마다 Guide Manager 주소와 게시 토큰(gmp_…, 위키 프로젝트 1개 범위)을 둔다.
 * 토큰은 Guide Manager › 프로젝트 › 설정 › 게시 토큰에서 발급받아 설정 화면에서만 넣는다. 암호화해 저장하고 화면·로그·Claude에는 내보내지 않는다.
 * 게시 API 계약(60hz-vibe guide-manager lib/devDoc.ts PublishInput):
 *   GET    /api/ext/v1/whoami                → { project: { id, name }, token: { name, created_by } }
 *   POST   /api/ext/v1/publish               → { status: created|updated|unchanged, note, path, url, source_id, content_hash, published_at }
 *   DELETE /api/ext/v1/publish?note=DOC-…    → { status: deleted|unchanged, note, path }
 */

type Conn = {
  base_url: string;
  token: string;
  /** 게시자. 위키 노트 이름(DOC-{hash8})을 정하는 열쇠의 일부라 세션마다 바뀌지 않게 설정에 둔다. */
  author_email: string;
  project: { id: string; name: string } | null;
  token_name: string | null;
  ask_on_plan: boolean;
  ask_on_report: boolean;
  checked_at: string | null;
};
type State = Record<string, Conn>;

export type WikiProject = { id: string; name: string };
export type WhoAmI = { project: WikiProject; token: { name: string; created_by: string | null } };
export type PublishBody = {
  channel: 'worktree-studio';
  workspace: string;
  session_id: number;
  ticket: string;
  jira_key?: string;
  name: string;
  kind: 'plan' | 'report' | 'db';
  title: string;
  version: number;
  markdown: string;
  branch?: string;
  prs?: string[];
  author_email: string;
  doc_updated_at?: string;
};
export type PublishResult = { status: 'created' | 'updated' | 'unchanged'; note: string; path: string; url: string; source_id: string; content_hash: string; published_at: string };
export type UnpublishResult = { status: 'deleted' | 'unchanged'; note: string; path: string };

/** Guide Manager가 거절한 것. status는 HTTP 상태(네트워크 오류는 0), sensitive는 422에서 걸린 줄. */
export class WikiError extends Error {
  constructor(message: string, readonly status: number, readonly sensitive: { line: number; kind: string }[] = []) { super(message); }
}

function load(): State {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'project_wiki'`).get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as State) : {};
}
function save(next: State) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('project_wiki', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
}

const connOf = (workspaceId: number): Conn | null => {
  const c = load()[String(workspaceId)];
  return c && c.base_url && c.token ? c : null;
};

/** 이 워크스페이스에 게시 연결이 있는지. 없으면 게시 카드·배지를 전혀 보이지 않는다. */
export const wikiConnected = (workspaceId: number) => connOf(workspaceId) !== null;

export function wikiConn(workspaceId: number): Omit<Conn, 'token'> | null {
  const c = connOf(workspaceId);
  if (!c) return null;
  const { token: _t, ...rest } = c;
  return rest;
}

let gitEmail: string | null = null;
function defaultEmail(): string {
  if (gitEmail === null) {
    try { gitEmail = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { gitEmail = ''; }
  }
  return gitEmail;
}

export function wikiConfigView(workspaceId: number) {
  const c = load()[String(workspaceId)];
  return {
    connected: Boolean(c?.base_url && c?.token),
    base_url: c?.base_url ?? '',
    has_token: Boolean(c?.token),
    author_email: c?.author_email || defaultEmail(),
    project: c?.project ?? null,
    token_name: c?.token_name ?? null,
    ask_on_plan: c?.ask_on_plan ?? true,
    ask_on_report: c?.ask_on_report ?? true,
    checked_at: c?.checked_at ?? null,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanUrl(v: string) {
  const url = v.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error('Guide Manager 주소는 http:// 또는 https:// 로 시작해야 합니다.');
  return url;
}
function cleanToken(v: string) {
  const t = v.trim();
  if (!/^gmp_[A-Za-z0-9_-]{10,}$/.test(t)) throw new Error('게시 토큰은 gmp_ 로 시작해야 합니다. Guide Manager › 프로젝트 › 설정 › 게시 토큰에서 발급한 값을 붙여 넣으세요.');
  return t;
}

/** 입력한 값(없으면 저장된 값)으로 연결을 확인한다. 저장하지 않는다. */
export async function checkWiki(workspaceId: number, input: { base_url?: string; token?: string }): Promise<WhoAmI> {
  const c = load()[String(workspaceId)];
  const base = input.base_url?.trim() ? cleanUrl(input.base_url) : c?.base_url;
  const token = input.token?.trim() ? cleanToken(input.token) : decrypt(c?.token ?? null);
  if (!base) throw new Error('Guide Manager 주소를 넣어 주세요.');
  if (!token) throw new Error('게시 토큰을 넣어 주세요.');
  return call<WhoAmI>(base, token, 'GET', '/api/ext/v1/whoami');
}

/** token: 비우면 저장된 토큰을 그대로 쓴다. 저장 전에 연결 확인이 성공해야 한다. */
export async function saveWikiConfig(workspaceId: number, patch: { base_url: string; token?: string; author_email: string; ask_on_plan: boolean; ask_on_report: boolean }) {
  const state = load();
  const prev = state[String(workspaceId)];
  const base_url = cleanUrl(patch.base_url);
  const token = patch.token?.trim() ? cleanToken(patch.token) : decrypt(prev?.token ?? null);
  if (!token) throw new Error('게시 토큰을 넣어 주세요.');
  const author_email = patch.author_email.trim();
  if (!EMAIL.test(author_email) || author_email.length > 200) throw new Error('게시자 이메일 형식이 올바르지 않습니다.');
  const who = await call<WhoAmI>(base_url, token, 'GET', '/api/ext/v1/whoami');
  state[String(workspaceId)] = {
    base_url, token: encrypt(token), author_email,
    project: { id: String(who.project.id), name: String(who.project.name) }, token_name: who.token?.name ?? null,
    ask_on_plan: patch.ask_on_plan, ask_on_report: patch.ask_on_report, checked_at: new Date().toISOString(),
  };
  save(state);
  return wikiConfigView(workspaceId);
}

/** 연결 해제. 저장한 토큰만 지우고 이미 게시한 노트와 보관함의 게시 기록은 그대로 둔다. */
export function removeWikiConfig(workspaceId: number) {
  const state = load();
  delete state[String(workspaceId)];
  save(state);
  return wikiConfigView(workspaceId);
}

function need(workspaceId: number) {
  const c = connOf(workspaceId);
  if (!c) throw new WikiError('이 워크스페이스는 Project-Wiki에 연결되어 있지 않습니다. 설정 › Project-Wiki에서 연결하세요.', 0);
  return { base: c.base_url, token: decrypt(c.token) };
}

/** 게시. 409(같은 노트를 동시에 고침 등)는 한 번만 다시 시도한다. */
export async function publishToWiki(workspaceId: number, body: PublishBody): Promise<PublishResult> {
  const { base, token } = need(workspaceId);
  try {
    return await call<PublishResult>(base, token, 'POST', '/api/ext/v1/publish', body);
  } catch (err) {
    if (err instanceof WikiError && err.status === 409) return call<PublishResult>(base, token, 'POST', '/api/ext/v1/publish', body);
    throw err;
  }
}

/** 게시 취소. 위키 노트는 지우지 않고 deleted 표시만 남는다. */
export async function unpublishFromWiki(workspaceId: number, note: string): Promise<UnpublishResult> {
  const { base, token } = need(workspaceId);
  return call<UnpublishResult>(base, token, 'DELETE', `/api/ext/v1/publish?note=${encodeURIComponent(note)}`);
}

async function call<T>(base: string, token: string, method: 'GET' | 'POST' | 'DELETE', pathname: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const e = err as Error;
    throw new WikiError(e.name === 'TimeoutError' ? 'Guide Manager가 30초 안에 답하지 않았습니다.' : `Guide Manager에 연결하지 못했습니다: ${e.message}`, 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* HTML 오류 페이지 등 */ }
  if (res.ok) {
    if (json === null) throw new WikiError(`Guide Manager 응답을 읽지 못했습니다(${res.status}). 주소가 맞는지 확인하세요.`, res.status);
    return json as T;
  }
  const e = (json ?? {}) as { error?: string; sensitive?: { line: number; kind: string }[] };
  const said = (e.error ?? text.slice(0, 200)).trim();
  const msg = res.status === 401 ? 'Guide Manager가 이 게시 토큰을 모릅니다(401). 설정 › Project-Wiki에서 토큰을 다시 넣으세요.'
    : res.status === 403 ? '게시 토큰이 폐기되었거나 권한이 없습니다(403). Guide Manager에서 새 토큰을 발급해 설정 › Project-Wiki에 넣으세요.'
    : res.status === 413 ? '문서가 너무 커서(1MB 초과) 게시하지 못했습니다(413).'
    : res.status === 429 ? '게시 요청이 많아 잠시 막혔습니다(429). 1분 뒤 다시 시도하세요.'
    : res.status === 422 ? `민감 정보로 보이는 내용이 남아 있어 거절됐습니다(422). ${said}`
    : res.status === 404 && !e.error ? 'Guide Manager 게시 API를 찾지 못했습니다(404). 주소가 맞는지, 게시 기능이 배포됐는지 확인하세요.'
    : `Guide Manager가 거절했습니다(${res.status}). ${said}`;
  throw new WikiError(msg, res.status, Array.isArray(e.sensitive) ? e.sensitive : []);
}
