import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from './db.js';
import { decrypt, encrypt } from './secret.js';
import { PORT } from './config.js';

/**
 * Jira는 Atlassian 공식 원격 MCP 서버(mcp.atlassian.com)로 쓴다.
 * MCP 표준 OAuth(클라이언트 자동 등록 + PKCE)라서 사용자는 "Jira로 로그인"만 누르면 된다. API 키도, 앱 등록도 없다.
 * 검색·조회·생성은 Claude를 거치지 않고 Atlassian 도구를 직접 부른다.
 */

const MCP_URL = new URL(process.env.WTS_ATLASSIAN_MCP ?? 'https://mcp.atlassian.com/v1/mcp');
export const OAUTH_CALLBACK = `http://localhost:${PORT}/api/jira/oauth/callback`;

export type JiraIssue = {
  key: string; summary: string; status: string; status_category: string; type: string;
  assignee: string | null; url: string; updated: string;
};
type Site = { id: string; name: string; url: string };
type State = {
  client_info?: OAuthClientInformationMixed;
  tokens?: string; // 암호화한 OAuthTokens JSON
  verifier?: string;
  cloud_id?: string; site_url?: string; sites?: Site[];
  user?: { account_id: string; name: string };
};

function load(): State {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'jira_mcp'`).get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as State) : {};
}
function save(patch: Partial<State>) {
  const next = { ...load(), ...patch };
  for (const k of Object.keys(patch) as (keyof State)[]) if (patch[k] === undefined) delete next[k];
  db.prepare(`INSERT INTO settings (key, value) VALUES ('jira_mcp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
}

/** MCP SDK가 OAuth에 쓰는 저장소. 클라이언트 정보·토큰·PKCE verifier를 DB에 둔다(토큰은 암호화). */
class Provider implements OAuthClientProvider {
  authUrl: URL | null = null;
  constructor(private readonly loginState?: string) {}
  get redirectUrl() { return OAUTH_CALLBACK; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Worktree Studio',
      redirect_uris: [OAUTH_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() { return this.loginState ?? crypto.randomBytes(16).toString('hex'); }
  clientInformation() { return load().client_info; }
  saveClientInformation(info: OAuthClientInformationMixed) { save({ client_info: info }); }
  tokens(): OAuthTokens | undefined {
    const t = load().tokens;
    return t ? (JSON.parse(decrypt(t)) as OAuthTokens) : undefined;
  }
  saveTokens(tokens: OAuthTokens) { save({ tokens: encrypt(JSON.stringify(tokens)) }); }
  redirectToAuthorization(url: URL) { this.authUrl = url; }
  saveCodeVerifier(v: string) { save({ verifier: v }); }
  codeVerifier() {
    const v = load().verifier;
    if (!v) throw new Error('로그인 요청이 만료됐습니다. 다시 로그인하세요.');
    return v;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') save({ client_info: undefined });
    if (scope === 'all' || scope === 'tokens') save({ tokens: undefined });
    if (scope === 'all' || scope === 'verifier') save({ verifier: undefined });
  }
}

let client: Client | null = null;
async function connected(): Promise<Client> {
  if (client) return client;
  if (!load().tokens) throw new Error('Jira에 로그인하지 않았습니다. 설정에서 "Jira로 로그인"을 누르세요.');
  const c = new Client({ name: 'worktree-studio', version: '1.0.0' });
  try {
    await c.connect(new StreamableHTTPClientTransport(MCP_URL, { authProvider: new Provider() }));
  } catch (err) {
    if (err instanceof UnauthorizedError) throw new Error('Jira 로그인이 만료됐습니다. 설정에서 다시 로그인하세요.');
    throw new Error(`Jira(Atlassian MCP)에 연결하지 못했습니다: ${(err as Error).message}`);
  }
  client = c;
  return c;
}

/** Atlassian 도구를 부르고 결과 JSON을 돌려준다. 연결이 끊겼으면 한 번 다시 연결한다. */
async function tool<T>(name: string, args: Record<string, unknown>, retried = false): Promise<T> {
  const c = await connected();
  let r: Awaited<ReturnType<Client['callTool']>>;
  try {
    r = await c.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  } catch (err) {
    client = null;
    if (!retried && !(err instanceof UnauthorizedError)) return tool<T>(name, args, true);
    if (err instanceof UnauthorizedError) throw new Error('Jira 로그인이 만료됐습니다. 설정에서 다시 로그인하세요.');
    throw err;
  }
  const text = (r.content as { type: string; text?: string }[]).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('');
  // 도구가 {"error":true,"message":"..."} 모양으로 실패를 알리기도 한다.
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* 글자 그대로 */ }
  const failed = r.isError || (typeof parsed === 'object' && parsed !== null && (parsed as { error?: unknown }).error === true);
  if (failed) {
    const msg = typeof parsed === 'object' && parsed ? String((parsed as { message?: string }).message ?? text) : text;
    // 일시적인 네트워크 오류는 한 번 더 해 본다.
    if (!retried && /fetch failed|ECONNRESET|ETIMEDOUT|timeout|503|502/i.test(msg)) return tool<T>(name, args, true);
    throw new Error(`Jira: ${msg.slice(0, 300) || '요청이 실패했습니다.'}`);
  }
  return parsed as T;
}

// 로그인을 시작한 화면 주소. 콜백 뒤에 그 화면으로 돌려보낸다. state로 위조된 콜백을 막는다.
const pending = new Map<string, { origin: string; at: number }>();

/** 로그인을 시작한다. 이미 유효한 토큰이 있어도 다시 동의를 받는다. 돌려준 주소로 브라우저를 보낸다. */
export async function oauthStart(origin: string): Promise<string> {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error('이 도구 화면에서만 로그인할 수 있습니다.');
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { origin, at: Date.now() });
  save({ tokens: undefined, verifier: undefined });
  client = null;
  const provider = new Provider(state);
  try {
    await new Client({ name: 'worktree-studio', version: '1.0.0' }).connect(new StreamableHTTPClientTransport(MCP_URL, { authProvider: provider }));
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !provider.authUrl) throw new Error(`Atlassian 로그인을 시작하지 못했습니다: ${(err as Error).message}`);
  }
  if (!provider.authUrl) throw new Error('Atlassian 로그인 주소를 받지 못했습니다.');
  return provider.authUrl.toString();
}

/** 로그인 뒤 돌아오면 코드를 토큰으로 바꾸고, 계정과 Jira 사이트를 읽어 둔다. 돌아갈 화면 주소를 돌려준다. */
export async function oauthCallback(code: string, state: string): Promise<string> {
  const p = pending.get(state);
  if (!p) throw new Error('로그인 요청이 만료됐거나 올바르지 않습니다. 설정에서 다시 로그인하세요.');
  pending.delete(state);
  await new StreamableHTTPClientTransport(MCP_URL, { authProvider: new Provider(state) }).finishAuth(code);
  save({ verifier: undefined });
  client = null;
  const user = await tool<{ account_id: string; name: string }>('atlassianUserInfo', {});
  const resources = await tool<{ id: string; name: string; url: string; scopes: string[] }[]>('getAccessibleAtlassianResources', {});
  const sites = [...new Map(resources.filter((r) => r.scopes?.some((s) => s.includes('jira'))).map((r) => [r.id, { id: r.id, name: r.name, url: r.url }])).values()];
  if (sites.length === 0) throw new Error('이 계정으로 쓸 수 있는 Jira 사이트가 없습니다.');
  const keep = sites.find((s) => s.id === load().cloud_id) ?? sites[0];
  save({ user: { account_id: user.account_id, name: user.name }, sites, cloud_id: keep.id, site_url: keep.url });
  return p.origin;
}

export function chooseSite(cloudId: string) {
  const s = load().sites?.find((x) => x.id === cloudId);
  if (!s) throw new Error('목록에 없는 Jira 사이트입니다.');
  save({ cloud_id: s.id, site_url: s.url });
}

export function jiraLogout() {
  save({ tokens: undefined, verifier: undefined, user: undefined, cloud_id: undefined, site_url: undefined, sites: undefined });
  client = null;
}

export function jiraConfigView() {
  const s = load();
  return {
    logged_in: Boolean(s.tokens && s.cloud_id),
    user: s.user?.name ?? null,
    site: s.cloud_id ? { id: s.cloud_id, url: s.site_url ?? '' } : null,
    sites: s.sites ?? [],
  };
}

/**
 * 연결 상태. 로그인이 풀린 경우만 끊긴 것으로 보고, 일시적인 오류는 연결된 것으로 둔다
 * (사용자 정보 조회가 잠깐 실패했다고 새 세션 화면이 티켓 직접 입력으로 바뀌지 않게).
 */
export async function jiraStatus(): Promise<{ connected: boolean; user: string | null; error: string | null; site: string | null }> {
  const s = load();
  if (!s.tokens || !s.cloud_id) return { connected: false, user: null, error: null, site: null };
  try {
    const u = await tool<{ name: string }>('atlassianUserInfo', {});
    return { connected: true, user: u.name, error: null, site: s.site_url ?? null };
  } catch (err) {
    const msg = (err as Error).message;
    if (/로그인|만료|Unauthorized|401/i.test(msg)) return { connected: false, user: null, error: msg, site: s.site_url ?? null };
    console.warn('[jira] 상태 확인이 잠깐 실패했습니다:', msg);
    return { connected: true, user: s.user?.name ?? null, error: null, site: s.site_url ?? null };
  }
}

function cloud(): string {
  const id = load().cloud_id;
  if (!id) throw new Error('Jira에 로그인하지 않았습니다. 설정에서 "Jira로 로그인"을 누르세요.');
  return id;
}

type RawIssue = {
  key: string; webUrl?: string;
  fields: {
    summary: string; updated: string;
    status?: { name: string; statusCategory?: { key: string } };
    issuetype?: { name: string };
    assignee?: { displayName: string } | null;
  };
};
const FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'updated'];

/** 검색 결과는 연결에 따라 issues가 배열이거나 { nodes: [...] }로 온다. 둘 다 받는다. */
function nodesOf<T>(r: { issues?: T[] | { nodes?: T[] } }): T[] {
  return Array.isArray(r.issues) ? r.issues : r.issues?.nodes ?? [];
}

function view(r: RawIssue): JiraIssue {
  return {
    key: r.key,
    summary: r.fields.summary,
    status: r.fields.status?.name ?? '',
    status_category: r.fields.status?.statusCategory?.key ?? '',
    type: r.fields.issuetype?.name ?? '',
    assignee: r.fields.assignee?.displayName ?? null,
    url: r.webUrl ?? `${load().site_url ?? ''}/browse/${r.key}`,
    updated: r.fields.updated,
  };
}

const jqlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * 프로젝트의 이슈를 찾는다. 검색어가 없으면 나에게 배정됐고 끝나지 않은 이슈를 최근 순으로.
 * 검색어가 이슈 키 모양이면 그 키를, 숫자만이면 프로젝트 키를 붙여서, 아니면 제목으로 찾는다.
 */
export async function searchIssues(projectKey: string, q: string): Promise<JiraIssue[]> {
  const text = q.trim();
  let jql: string;
  if (!text) jql = `project = ${jqlString(projectKey)} AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
  else if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(text)) jql = `key = ${jqlString(text.toUpperCase())}`;
  else if (/^\d+$/.test(text)) jql = `key = ${jqlString(`${projectKey}-${text}`)}`;
  else jql = `project = ${jqlString(projectKey)} AND summary ~ ${jqlString(text)} ORDER BY updated DESC`;
  try {
    const r = await tool<{ issues?: RawIssue[] | { nodes?: RawIssue[] } }>('searchJiraIssuesUsingJql', { cloudId: cloud(), jql, fields: FIELDS, maxResults: 50 });
    return nodesOf(r).slice(0, 20).map(view);
  } catch (err) {
    // 없는 키를 찾으면 Jira가 오류를 돌려준다. 결과 없음으로 본다.
    if (text && /does not exist|존재하지|not exist|400/i.test((err as Error).message)) return [];
    throw err;
  }
}

export async function getIssue(key: string): Promise<JiraIssue> {
  const r = await tool<RawIssue>('getJiraIssue', { cloudId: cloud(), issueIdOrKey: key, fields: FIELDS });
  return view(r);
}

export async function issueTypes(projectKey: string): Promise<{ id: string; name: string }[]> {
  const r = await tool<{ issueTypes?: { id: string; name: string; subtask: boolean }[] }>('getJiraProjectIssueTypesMetadata', { cloudId: cloud(), projectIdOrKey: projectKey });
  return (r.issueTypes ?? []).filter((t) => !t.subtask).map((t) => ({ id: t.id, name: t.name }));
}

/** 이슈를 만들고 나에게 배정한다. 유형은 화면에서 고른 id를 이름으로 바꿔 넘긴다. */
export async function createIssue(projectKey: string, input: { summary: string; description: string; issuetype_id: string }): Promise<JiraIssue> {
  if (!input.summary.trim()) throw new Error('티켓 제목을 넣어 주세요.');
  const type = (await issueTypes(projectKey)).find((t) => t.id === input.issuetype_id);
  if (!type) throw new Error('티켓 유형을 다시 고르세요.');
  const me = load().user?.account_id;
  const created = await tool<{ key?: string }>('createJiraIssue', {
    cloudId: cloud(),
    projectKey,
    issueTypeName: type.name,
    summary: input.summary.trim(),
    ...(input.description.trim() ? { description: input.description.trim(), contentFormat: 'markdown' } : {}),
    ...(me ? { assignee_account_id: me } : {}),
  });
  const key = created.key ?? (typeof created === 'string' ? (created as string).match(/[A-Z][A-Z0-9_]*-\d+/)?.[0] : undefined);
  if (!key) throw new Error('티켓은 만들었지만 키를 읽지 못했습니다. Jira에서 확인하세요.');
  return getIssue(key);
}

/**
 * 새 티켓 설명의 형식 예시: 내가 이 프로젝트에 쓴 최근 티켓 중 설명이 있는 것.
 * 내 티켓에 설명이 없으면 같은 프로젝트에서 다른 사람이 쓴 최근 티켓을 쓴다(팀 형식을 따르게).
 */
export async function recentTicketExamples(projectKey: string): Promise<{ key: string; summary: string; type: string; description: string; mine: boolean }[]> {
  const find = async (mine: boolean) => {
    type N = { key: string; fields: { summary: string; issuetype?: { name: string }; description?: unknown } };
    const r = await tool<{ issues?: N[] | { nodes?: N[] } }>('searchJiraIssuesUsingJql', {
      cloudId: cloud(),
      jql: `project = ${jqlString(projectKey)}${mine ? ' AND reporter = currentUser()' : ''} AND description is not EMPTY AND issuetype not in subTaskIssueTypes() ORDER BY created DESC`,
      fields: ['summary', 'issuetype', 'description'],
      maxResults: 50,
      responseContentFormat: 'markdown',
    });
    return nodesOf(r)
      .map((n) => ({ key: n.key, summary: n.fields.summary, type: n.fields.issuetype?.name ?? '', description: typeof n.fields.description === 'string' ? n.fields.description : '', mine }))
      .filter((n) => n.description.trim().length >= 80)
      .slice(0, 3)
      .map((n) => ({ ...n, description: n.description.length > 1500 ? `${n.description.slice(0, 1500)}\n…` : n.description }));
  };
  try {
    const mine = await find(true);
    return mine.length ? mine : await find(false);
  } catch (err) {
    console.warn('[jira] 형식 예시를 찾지 못했습니다:', (err as Error).message);
    return [];
  }
}
