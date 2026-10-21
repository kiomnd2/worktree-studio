import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { db } from './db.js';
import { broadcast } from './hub.js';
import { getSession, listSessions } from './sessions.js';

/**
 * 개발하면서 나온 산출물(계획서, 화면설계서, 테스트 결과서). 세션마다 보관함 폴더 하나에 HTML 파일로 모은다.
 * 저장소가 아니라 데이터 폴더에 둬서 커밋에 섞이지 않고, 세션을 닫거나 리소스를 정리해도 지우지 않는다.
 * 폴더마다 index.html과 meta.json을 같이 써 둬서 도구 없이 폴더만 열어도 읽을 수 있다.
 * 같은 이름으로 다시 저장하면 새 판이 되고 예전 판은 남는다.
 */
export type DocKind = 'plan' | 'screen' | 'test' | 'other';
export type DocMeta = { name: string; title: string; kind: DocKind; version: number; updated_at: string; path: string };
type Index = Record<string, { title: string; kind: DocKind; version: number; updated_at: string }>;

export const ARCHIVE_DIR = path.join(DATA_DIR, 'artifacts');
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Claude가 쓰는 문서 크기 제한. 스크린샷을 넣는 테스트 결과서는 도구가 직접 만들어 따로 정한다. */
const MAX_BYTES = 2 * 1024 * 1024;
const KIND_ORDER: Record<DocKind, number> = { plan: 0, screen: 1, test: 2, other: 3 };
const KIND_LABEL: Record<DocKind, string> = { plan: '계획서', screen: '화면설계서', test: '테스트 결과서', other: '문서' };

// 예전에는 docs/<세션>에 뒀다. 보관함으로 옮긴다.
{
  const old = path.join(DATA_DIR, 'docs');
  if (fs.existsSync(old)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    for (const id of fs.readdirSync(old)) {
      const to = path.join(ARCHIVE_DIR, id);
      if (!fs.existsSync(to)) fs.renameSync(path.join(old, id), to);
    }
    if (fs.readdirSync(old).length === 0) fs.rmdirSync(old);
  }
}

export function docsDir(sessionId: number): string {
  const dir = path.join(ARCHIVE_DIR, String(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const indexFile = (sessionId: number) => path.join(docsDir(sessionId), 'index.json');
const fileOf = (sessionId: number, name: string, version?: number) => path.join(docsDir(sessionId), version ? `${name}.v${version}.html` : `${name}.html`);

function readIndex(sessionId: number): Index {
  const file = path.join(ARCHIVE_DIR, String(sessionId), 'index.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Index; } catch { return {}; }
}

export function listDocs(sessionId: number): DocMeta[] {
  return Object.entries(readIndex(sessionId))
    .map(([name, d]) => ({ name, ...d, path: fileOf(sessionId, name) }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

export function saveDoc(sessionId: number, input: { name: string; title: string; kind: DocKind; html: string }, opts: { maxBytes?: number } = {}): DocMeta {
  const name = input.name.trim().toLowerCase();
  if (!NAME.test(name)) throw new Error('name은 영문 소문자, 숫자, 하이픈으로 64자 이내여야 합니다. 예: plan, screen-login');
  if (!/<html[\s>]/i.test(input.html)) throw new Error('html은 <html>로 시작하는 완결된 HTML 문서여야 합니다.');
  const max = opts.maxBytes ?? MAX_BYTES;
  if (Buffer.byteLength(input.html) > max) throw new Error(`문서는 ${Math.round(max / 1024 / 1024)}MB까지 저장할 수 있습니다. 이미지는 넣지 말고 HTML/CSS로 그리세요.`);
  const index = readIndex(sessionId);
  const prev = index[name];
  // 지금 판을 예전 판으로 옮겨 두고 새 판을 쓴다.
  if (prev && fs.existsSync(fileOf(sessionId, name))) fs.renameSync(fileOf(sessionId, name), fileOf(sessionId, name, prev.version));
  const version = (prev?.version ?? 0) + 1;
  fs.writeFileSync(fileOf(sessionId, name), input.html);
  index[name] = { title: input.title.trim() || name, kind: input.kind, version, updated_at: new Date().toISOString() };
  fs.writeFileSync(indexFile(sessionId), JSON.stringify(index, null, 2));
  writeFolderIndex(sessionId);
  broadcast({ type: 'docs.updated', sessionId });
  return { name, ...index[name], path: fileOf(sessionId, name) };
}

/** 문서 HTML. version이 없거나 지금 판이면 최신 판. */
export function docHtml(sessionId: number, name: string, version?: number): string {
  const meta = readIndex(sessionId)[name];
  if (!meta) throw Object.assign(new Error('문서가 없습니다.'), { statusCode: 404 });
  const file = !version || version === meta.version ? fileOf(sessionId, name) : fileOf(sessionId, name, version);
  if (!fs.existsSync(file)) throw Object.assign(new Error('그 판의 문서가 없습니다.'), { statusCode: 404 });
  return fs.readFileSync(file, 'utf8');
}

export function deleteDoc(sessionId: number, name: string) {
  const index = readIndex(sessionId);
  const meta = index[name];
  if (!meta) return;
  for (let v = 1; v <= meta.version; v++) fs.rmSync(fileOf(sessionId, name, v === meta.version ? undefined : v), { force: true });
  delete index[name];
  fs.writeFileSync(indexFile(sessionId), JSON.stringify(index, null, 2));
  writeFolderIndex(sessionId);
  broadcast({ type: 'docs.updated', sessionId });
}

type Pr = { number: number; url: string; title: string; state: string };
const prsOf = (sessionId: number) => db.prepare(`SELECT number, url, title, state FROM pull_requests WHERE session_id = ? ORDER BY id`).all(sessionId) as Pr[];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * 폴더만 열어도 무엇이 있는지 알 수 있게 meta.json과 index.html을 다시 쓴다.
 * 세션 정보(티켓, 브랜치, PR)도 같이 남겨 DB가 없어도 어떤 작업의 산출물인지 알 수 있게 한다.
 */
export function writeFolderIndex(sessionId: number) {
  const s = getSession(sessionId);
  const docs = listDocs(sessionId);
  if (!s || docs.length === 0) return;
  const prs = prsOf(sessionId);
  const meta = {
    session_id: s.id, ticket: s.ticket, summary: s.summary, workspace: s.workspace_name, created_at: s.created_at,
    worktrees: s.repos.map((w) => ({ project: w.project_name, branch: w.branch, base: w.base_branch })),
    prs, docs: docs.map(({ path: _p, ...d }) => d),
  };
  fs.writeFileSync(path.join(docsDir(sessionId), 'meta.json'), JSON.stringify(meta, null, 2));
  const rows = docs.map((d) => {
    const older = Array.from({ length: d.version - 1 }, (_, i) => d.version - 1 - i).map((v) => `<a href="${d.name}.v${v}.html">${v}판</a>`).join(' ');
    return `<tr><td>${KIND_LABEL[d.kind]}</td><td><a href="${d.name}.html">${esc(d.title)}</a></td><td>${d.version}판${older ? ` <span class="m">(예전 판: ${older})</span>` : ''}</td><td>${d.updated_at.slice(0, 16).replace('T', ' ')}</td></tr>`;
  }).join('');
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(s.ticket)} 산출물</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:32px;color:#1b2230;max-width:960px}h1{font-size:22px;margin:0 0 4px}.m{color:#6b7280;font-size:13px}table{border-collapse:collapse;width:100%;margin-top:16px}th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;font-size:14px}th{background:#f6f7f9}a{color:#3346d3}</style></head>
<body><h1>${esc(s.ticket)} ${esc(s.summary)}</h1>
<p class="m">${esc(s.workspace_name)} · ${s.repos.map((w) => `${esc(w.project_name)} <code>${esc(w.branch)}</code>`).join(', ')}${prs.length ? ` · PR ${prs.map((p) => `<a href="${esc(p.url)}">#${p.number}</a>`).join(', ')}` : ''}</p>
<table><thead><tr><th>종류</th><th>문서</th><th>판</th><th>저장</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  fs.writeFileSync(path.join(docsDir(sessionId), 'index.html'), html);
}

export type ArchiveEntry = {
  session_id: number; ticket: string; summary: string; workspace_name: string; closed: boolean; updated_at: string;
  branches: string[]; prs: Pr[]; docs: DocMeta[]; dir: string;
};

/** 산출물이 있는 모든 세션(닫은 세션 포함). 최근에 문서를 저장한 순. */
export function listArchive(): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  for (const s of listSessions(true)) {
    const docs = listDocs(s.id);
    if (docs.length === 0) continue;
    // 예전 폴더에서 옮겨 왔거나 지운 index.html은 다시 쓴다.
    if (!fs.existsSync(path.join(ARCHIVE_DIR, String(s.id), 'index.html'))) writeFolderIndex(s.id);
    out.push({
      session_id: s.id, ticket: s.ticket, summary: s.summary, workspace_name: s.workspace_name, closed: Boolean(s.closed),
      updated_at: docs.reduce((a, d) => (d.updated_at > a ? d.updated_at : a), ''),
      branches: [...new Set(s.worktrees.map((w) => w.branch))], prs: prsOf(s.id), docs, dir: path.join(ARCHIVE_DIR, String(s.id)),
    });
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Finder에서 세션의 보관함 폴더(없으면 보관함 전체)를 연다. */
export function revealArchive(sessionId?: number) {
  const dir = sessionId ? path.join(ARCHIVE_DIR, String(sessionId)) : ARCHIVE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  if (sessionId) writeFolderIndex(sessionId);
  execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [dir], () => {});
}
