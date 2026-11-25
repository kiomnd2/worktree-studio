import crypto from 'node:crypto';
import os from 'node:os';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { accountsOf } from './accounts.js';
import { pendingWikiPublish, requestWikiPublish, type Decision, type WikiPublishDoc, type WikiPublishRequest } from './approvals.js';
import { DATA_DIR } from './config.js';
import { docSource, listDocs, prsOf, setPublished, type DocMeta } from './docs.js';
import { resolveEnv } from './envstore.js';
import { looksSecret } from './secret.js';
import { getSession, type SessionView } from './sessions.js';
import { publishToWiki, unpublishFromWiki, wikiConn, WikiError, type PublishBody } from './wikiconn.js';

/**
 * 산출물(계획서·DB 변경 설계서·완료 보고서)을 Project-Wiki에 게시하는 흐름.
 * 원본은 보관함에 그대로 두고, 게시본(Markdown 사본)을 만들어 민감 정보를 가린 뒤 승인 카드에 띄운다.
 * 사용자가 카드에서 고르고 고쳐 승인한 게시본만 Guide Manager로 보낸다. Claude에게는 게시 도구가 없다.
 * 그림 제거·민감 정보 검사 규칙은 Guide Manager(lib/devDoc.ts cleanMarkdown·findSensitive)와 맞춰 서버 거절(422)을 미리 막는다.
 */

const CHANNEL = 'worktree-studio';
const KINDS = new Set(['plan', 'db', 'report']);
/** Guide Manager 문서 이름 규칙(studio는 64자까지 허용) */
const GM_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MAX_BYTES = 1024 * 1024;
const FIGURE = '_(그림은 보낸 쪽 원본 참고)_';
/** Guide Manager jira_key 규칙 */
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export type Masked = WikiPublishDoc['masked'][number];

// ── 게시본 만들기 ─────────────────────────────

/** 코드 블록 밖에서만 fn을 적용 (Guide Manager와 같음) */
function outsideFences(md: string, fn: (s: string) => string) {
  return md.split(/(^```[\s\S]*?^```[^\n]*$)/m).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

/** 위키는 원본 HTML·그림을 담지 못한다. SVG·이미지는 자리 표시로, 나머지 태그는 지운다. */
export function cleanMarkdown(md: string) {
  return outsideFences(md.replace(/\r/g, ''), (s) => s
    .replace(/<svg[\s\S]*?<\/svg>/gi, FIGURE)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, FIGURE)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, FIGURE)
    .replace(/\]\(\s*(javascript|data|vbscript):[^)]*\)/gi, ']()')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-zA-Z][\w-]*(\s[^<>]*)?\/?>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** 완료 보고서처럼 HTML로 저장한 문서를 Markdown으로. 그림은 변환 전에 자리 표시로 바꾼다. */
export function htmlToMarkdown(html: string) {
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html)
    .replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<p>WTSFIGURE</p>')
    .replace(/<img\b[^>]*>/gi, '<p>WTSFIGURE</p>');
  // 변환기가 _를 이스케이프하지 않게 변환 뒤에 자리 표시로 바꾼다.
  return NodeHtmlMarkdown.translate(body).replace(/WTSFIGURE/g, FIGURE);
}

// ── 민감 정보 ────────────────────────────────

/** Guide Manager 2차 검사와 같은 규칙. 하나라도 걸리면 서버가 422로 거절한다. */
const SENSITIVE: [string, RegExp][] = [
  ['개인 키', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS 키', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub 토큰', /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['API 토큰', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bgmp_[A-Za-z0-9_-]{20,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['접속 정보', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['접속 정보', /\bjdbc:[^\s]*[/:@][^\s/:@]+\/[^\s@]+@/i],
  ['비밀값', /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|비밀번호)\b["']?\s*[:=]\s*["']?(?!«|\*{3}|<|\$\{|…|-|xxx)[^\s"'`|]{6,}/i],
  ['이메일', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['사설 IP', /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['로컬 경로', /(^|[\s`(])\/(Users|home)\/[^\s/`]+\//],
];

/** 게시본에 남은 민감 정보. 줄 번호는 1부터. */
export function precheck(md: string) {
  const out: { line: number; kind: string }[] = [];
  md.split('\n').forEach((l, i) => {
    for (const [kind, re] of SENSITIVE) if (re.test(l)) { out.push({ line: i + 1, kind }); break; }
  });
  return out;
}

type Rule = { kind: string; re: RegExp; to?: (m: string, ...g: string[]) => string };
const tag = (kind: string) => `«가림:${kind}»`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 값으로 가리는 것(세션 환경값 중 비밀값, 테스트 계정)과 경로를 바꾸는 규칙. 패턴 규칙보다 먼저 쓴다. */
function contextRules(session: SessionView): Rule[] {
  const rules: Rule[] = [];
  const secrets = new Set<string>();
  for (const w of session.worktrees) {
    try {
      for (const [k, v] of Object.entries(resolveEnv(session.id, w.project_id).env)) if (looksSecret(k) && v.length >= 4) secrets.add(v);
    } catch { /* 환경값을 못 읽어도 패턴 규칙으로 가린다 */ }
  }
  const accounts = new Set<string>();
  for (const a of accountsOf(session.id)) {
    if (a.password.length >= 4) secrets.add(a.password);
    // 흔한 단어(admin 등)까지 가리지 않게 숫자·기호가 섞였거나 긴 아이디만
    if (/[\d@._-]/.test(a.login) ? a.login.length >= 4 : a.login.length >= 8) accounts.add(a.login);
  }
  // 긴 값부터 바꿔야 겹치는 값이 반만 가려지지 않는다.
  const byLen = (a: string, b: string) => b.length - a.length;
  for (const v of [...secrets].sort(byLen)) rules.push({ kind: '환경값', re: new RegExp(escapeRe(v), 'g') });
  for (const v of [...accounts].sort(byLen)) rules.push({ kind: '테스트 계정', re: new RegExp(`(?<![\\w.@-])${escapeRe(v)}(?![\\w@-])`, 'g') });
  // 워크트리 경로는 저장소 안 상대 경로로, 보관함·홈 폴더는 ~로.
  // 경로 끝은 /나 공백·따옴표·괄호로 끝나야 한다(worktree-studio가 worktree-studio-fix-docs 앞부분에 걸리지 않게).
  const END = '(?=[/\\s`\'")\\],;:]|$)';
  const roots = [...new Set(session.worktrees.flatMap((w) => [w.app_path, w.path]))].sort(byLen);
  for (const r of roots) rules.push({ kind: '로컬 경로', re: new RegExp(`${escapeRe(r)}(/|${END})`, 'g'), to: (m) => (m.endsWith('/') ? '' : '.') });
  rules.push({ kind: '로컬 경로', re: new RegExp(`${escapeRe(DATA_DIR)}${END}`, 'g'), to: () => '~/.worktree-studio' });
  const home = os.homedir();
  if (home.length > 1) rules.push({ kind: '로컬 경로', re: new RegExp(`${escapeRe(home)}${END}`, 'g'), to: () => '~' });
  return rules;
}

/** 환경값처럼 대문자로 쓴 키는 looksSecret으로, 글 속 소문자 키는 이름이 딱 맞을 때만 비밀로 본다(author 같은 말을 가리지 않게). */
const secretKey = (key: string) => (/^[A-Z][A-Z0-9_]*$/.test(key) && looksSecret(key))
  || /^(password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|api[_-]?key|access[_-]?key|비밀번호)$/i.test(key);

const PATTERN_RULES: Rule[] = [
  { kind: '토큰', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-(ant-)?[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bgmp_[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: '접속정보', re: /\bjdbc:[^\s`'"|)<>]+/gi },
  { kind: '접속정보', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s`'"|)<>]*/gi },
  // KEY=VALUE 중 비밀 같은 키의 값
  { kind: '비밀값', re: /(?<![A-Za-z0-9_가-힣])([A-Za-z_가-힣][A-Za-z0-9_.가-힣-]*)(\s*[:=]\s*["']?)(?!«|\*{3}|<|\$\{|…|xxx)([^\s"'`|,;)]{4,})/g,
    to: (m, key, sep) => (secretKey(key) ? `${key}${sep}${tag('비밀값')}` : m) },
  { kind: '이메일', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: '사설 IP', re: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(:\d+)?\b/g },
  { kind: '로컬 경로', re: /\/(Users|home)\/[^\s/`]+(?=\/)/g, to: () => '~' },
];

/** 줄 단위로 규칙을 적용하고 바꾼 것을 기록한다(줄 수는 바뀌지 않는다). */
function applyRules(md: string, rules: Rule[]): { markdown: string; masked: Masked[] } {
  const masked: Masked[] = [];
  // 여러 줄짜리 개인 키는 먼저 한 줄 자리 표시로
  const text = md.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, (m, offset: number) => {
    masked.push({ kind: '개인 키', line: md.slice(0, offset).split('\n').length, before: m.split('\n')[0] + '…', after: tag('개인 키') });
    return tag('개인 키');
  });
  const lines = text.split('\n').map((line, i) => {
    let out = line;
    for (const r of rules) {
      out = out.replace(r.re, (m: string, ...g: unknown[]) => {
        const after = r.to ? r.to(m, ...(g.filter((x) => typeof x === 'string') as string[])) : tag(r.kind);
        if (after !== m) masked.push({ kind: r.kind, line: i + 1, before: m, after });
        return after;
      });
    }
    return out;
  });
  return { markdown: lines.join('\n'), masked };
}

/** 원문에 없던 그림 자리 표시를 "그림" 가림으로 기록한다. */
function figureMarks(original: string, cleaned: string): Masked[] {
  const had = original.split(FIGURE).length - 1;
  const out: Masked[] = [];
  let seen = 0;
  cleaned.split('\n').forEach((l, i) => {
    for (let k = l.split(FIGURE).length - 1; k > 0; k--) {
      if (seen++ >= had) out.push({ kind: '그림', line: i + 1, before: '그림(SVG·이미지)', after: FIGURE });
    }
  });
  return out;
}

/** 문서 하나의 게시본. original은 카드 왼쪽에 보여 줄 원문(HTML이면 변환 전 그대로). */
export function buildCopy(session: SessionView, meta: DocMeta, source: string) {
  const md = meta.format === 'html' ? htmlToMarkdown(source) : source;
  const cleaned = cleanMarkdown(md);
  const { markdown, masked } = applyRules(cleaned, [...contextRules(session), ...PATTERN_RULES]);
  return { original: source, markdown, masked: [...figureMarks(md, markdown), ...masked].sort((a, b) => a.line - b.line), precheck: precheck(markdown) };
}

// ── 노트 이름 ────────────────────────────────

/** Guide Manager와 같은 규칙: DOC-{sha1(channel|이메일 소문자|워크스페이스|세션)[:8]}-{이름} */
export function noteName(authorEmail: string, workspace: string, sessionId: number, name: string) {
  const h = crypto.createHash('sha1').update(`${CHANNEL}|${authorEmail.toLowerCase()}|${workspace.trim()}|${sessionId}`, 'utf8').digest('hex').slice(0, 8);
  return `DOC-${h}-${name}`;
}

// ── 카드 띄우기·게시 ─────────────────────────

const publishable = (d: DocMeta) => KINDS.has(d.kind);

function docFor(session: SessionView, meta: DocMeta, authorEmail: string): WikiPublishDoc {
  const note = noteName(authorEmail, session.workspace_name, session.id, meta.name);
  const p = meta.published;
  const base = {
    name: meta.name, title: meta.title, kind: meta.kind as WikiPublishDoc['kind'], version: meta.version, note,
    update: Boolean(p && p.note === note), published_version: p && p.note === note && !p.deleted_at ? p.version : null,
  };
  if (!GM_NAME.test(meta.name)) return { ...base, original: '', markdown: '', masked: [], precheck: [], blocked: '문서 이름이 60자를 넘어 위키에 게시할 수 없습니다.' };
  const { source } = docSource(session.id, meta.name);
  const copy = buildCopy(session, meta, source);
  const blocked = Buffer.byteLength(copy.markdown) > MAX_BYTES ? '게시본이 1MB를 넘어 게시할 수 없습니다.' : undefined;
  return { ...base, ...copy, ...(blocked ? { blocked } : {}) };
}

/**
 * 게시 카드를 띄운다. trigger가 plan·report면 연결 설정의 "묻기"가 꺼져 있을 때 아무것도 하지 않는다(산출물 버튼은 항상).
 * 연결이 없거나 게시할 문서가 없으면 null. 이미 카드에 올라 있는 문서는 다시 넣지 않는다.
 */
export function openPublishCard(sessionId: number, chatId: number, trigger: WikiPublishRequest['trigger'], names: string[]): WikiPublishDoc[] | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const conn = wikiConn(session.workspace_id);
  if (!conn) {
    if (trigger === 'manual') throw new Error('이 워크스페이스는 Project-Wiki에 연결되어 있지 않습니다. 설정 › Project-Wiki에서 연결하세요.');
    return null;
  }
  if ((trigger === 'plan' && !conn.ask_on_plan) || (trigger === 'report' && !conn.ask_on_report)) return null;
  const waiting = new Set(pendingWikiPublish(sessionId).flatMap((a) => a.request.docs.map((d) => d.name)));
  const metas = listDocs(sessionId).filter((d) => names.includes(d.name) && publishable(d));
  const fresh = metas.filter((d) => !waiting.has(d.name));
  if (fresh.length === 0) {
    if (trigger === 'manual') throw new Error(metas.length ? '이 문서의 게시 승인 카드가 이미 떠 있습니다. 대화 화면이나 산출물 화면에서 확인하세요.' : '계획서·DB 변경 설계서·완료 보고서만 게시할 수 있습니다.');
    return null;
  }
  const docs = fresh.map((m) => docFor(session, m, conn.author_email));
  showCard(session, chatId, trigger, docs, conn);
  return docs;
}

function showCard(session: SessionView, chatId: number, trigger: WikiPublishRequest['trigger'], docs: WikiPublishDoc[], conn: NonNullable<ReturnType<typeof wikiConn>>) {
  const request: WikiPublishRequest = {
    kind: 'wikipublish', workspace_id: session.workspace_id, workspace_name: session.workspace_name,
    target: { project_name: conn.project?.name ?? '(이름 모름)', base_url: conn.base_url, author_email: conn.author_email },
    trigger, docs,
  };
  requestWikiPublish(session.id, chatId, request, (d) => runPublish(session.id, chatId, request, d).catch((err) => `게시하지 못했습니다: ${(err as Error).message}`));
}

/** 승인한 문서를 차례로 게시한다. 실패한 문서는 사용자가 고친 게시본 그대로 새 카드에 다시 올린다. */
async function runPublish(sessionId: number, chatId: number, request: WikiPublishRequest, d: Decision): Promise<string> {
  if (!d.approve) return '게시하지 않았습니다.';
  const session = getSession(sessionId);
  const conn = session ? wikiConn(session.workspace_id) : null;
  if (!session || !conn) return '이 워크스페이스는 Project-Wiki 연결이 해제되어 게시하지 않았습니다.';
  const chosen = new Map((d.docs ?? []).map((x) => [x.name, x.markdown]));
  const metas = new Map(listDocs(sessionId).map((m) => [m.name, m]));
  const repo = session.repos[0];
  const prs = prsOf(sessionId).map((p) => p.url).filter((u) => /^https?:\/\//.test(u) && u.length <= 300).slice(0, 20);
  const ok: string[] = [];
  const failed: WikiPublishDoc[] = [];
  for (const doc of request.docs) {
    const markdown = chosen.get(doc.name);
    if (markdown === undefined || doc.blocked) continue;
    const meta = metas.get(doc.name);
    const fail = (error: string, extra: Partial<WikiPublishDoc> = {}) => failed.push({ ...doc, markdown, precheck: precheck(markdown), error, ...extra });
    if (!meta) { fail('보관함에서 문서가 지워졌습니다.'); continue; }
    if (!markdown.trim()) { fail('게시본이 비어 있습니다.'); continue; }
    const hits = precheck(markdown);
    if (hits.length) { fail(`민감 정보로 보이는 내용이 남아 있습니다: ${hits.slice(0, 5).map((h) => `${h.line}행 ${h.kind}`).join(', ')}`); continue; }
    const body: PublishBody = {
      channel: CHANNEL, workspace: session.workspace_name.trim(), session_id: session.id, ticket: session.ticket.slice(0, 100),
      ...(JIRA_KEY.test(session.ticket.trim()) ? { jira_key: session.ticket.trim() } : {}),
      name: doc.name, kind: doc.kind, title: (meta.title || doc.name).slice(0, 200),
      // 카드를 띄운 뒤 새 판이 저장됐어도 사용자가 본 게시본의 판으로 기록한다.
      version: doc.version, markdown,
      ...(repo?.branch ? { branch: repo.branch.slice(0, 200) } : {}),
      ...(prs.length ? { prs } : {}),
      author_email: conn.author_email, doc_updated_at: meta.updated_at,
    };
    try {
      const r = await publishToWiki(session.workspace_id, body);
      setPublished(sessionId, doc.name, {
        note: r.note, path: r.path, url: r.url, source_id: r.source_id, content_hash: r.content_hash,
        version: doc.version, status: r.status, published_at: r.published_at, project: conn.project, deleted_at: null,
      });
      ok.push(`${doc.title} ${r.status === 'unchanged' ? '(이미 같은 내용)' : r.status === 'created' ? '(새로 만듦)' : '(갱신)'}`);
    } catch (err) {
      const e = err as Error;
      fail(e.message, err instanceof WikiError && err.sensitive.length ? { precheck: err.sensitive } : {});
    }
  }
  if (failed.length) showCard(session, chatId, request.trigger, failed, conn);
  if (ok.length === 0 && failed.length === 0) return '고른 문서가 없어 게시하지 않았습니다.';
  return [ok.length ? `Project-Wiki에 게시했습니다: ${ok.join(', ')}` : '', failed.length ? `${failed.length}건은 실패해 카드에 다시 올렸습니다.` : ''].filter(Boolean).join(' ');
}

/** 게시 취소. 위키 노트는 deleted로 남고, 보관함 기록에 취소 시각을 남긴다. */
export async function unpublishDoc(sessionId: number, name: string) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  const meta = listDocs(sessionId).find((d) => d.name === name);
  const p = meta?.published;
  if (!meta || !p) throw new Error('게시한 기록이 없는 문서입니다.');
  const r = await unpublishFromWiki(session.workspace_id, p.note);
  setPublished(sessionId, name, { ...p, status: r.status, deleted_at: new Date().toISOString() });
  return r;
}
