import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createDictRequest, pendingDictRequests, requestLabel } from './dictrequests.js';
import { checkSession, findingLine, issueLabel, sessionErdId, sessionIndex, type DictReport } from './dictscan.js';
import { ISSUES, SOURCE_KINDS, type Finding, type SourceKind } from './dict/extract.js';
import { docsDir } from './docs.js';
import { searchDictionary, type DictSearchResult } from './dictsearch.js';
import { cachedErdProject, erdConfigured } from './erdvibe.js';
import { getSession } from './sessions.js';
import { schemaCheck, type SchemaFilter, type SchemaReport } from './schemasync.js';
import type { SchemaFinding } from './dict/srcrefs.js';

/** Claude에게 주는 용어사전 도구의 글 모양과, 시스템 프롬프트·tool_context에 붙일 줄. */

export const DICT_RULE = 'Every time you write or change a DB name during development (table columns, DDL, SQL aliases, resultMap column, @Column, etc.), first check the erd-vibe dictionary with mcp__studio__dict_lookup and act on the verdict. '
  + 'If it is standard, use it as is; if it is a non-standard spelling, switch to the standard name (abbreviated name) it gives. Never write the same term with different spellings (e.g. TR_DATE and TR_DT). '
  + 'When a new term is needed, do not ask the user; request registration right away following the existing rules: '
  + '(1) For each unregistered word, look up similar words with dict_lookup to see how their abbreviations are formed, then request the word first with mcp__studio__dict_request_term(kind "word"). The English name is uppercase with underscores (REFERENCE_AMOUNT); the abbreviation is a shortened uppercase form of the English name with letters/digits (CANCEL → CNCL) and must not collide with another word\'s abbreviation. '
  + '(2) A term is built from words: the logical name joins the words (거래+취소+일자 → 거래취소일자), the physical name joins the words\' English names with underscores, and the abbreviated name (the standard name) joins the words\' abbreviations with underscores (TR_CNCL_DT). If the verdict provides a registration draft, use it as is. '
  + '(3) The domain follows existing terms that end with the same word (…일자 → 일자, …여부 → 여부). '
  + 'Requests that break the rules come back with a reason; fix them and request again. After requesting, keep developing with that standard name, and when you finish, report (in Korean) the word/term requests you made (they enter the dictionary only after the user approves them in the dictionary check screen). '
  + 'When you need a table definition, look at the ERD with mcp__studio__erd_table. If the ERD and the source differ, first decide which one is standard: if the ERD already uses the standard name, leave the ERD and fix the source (mappers, Liquibase, entities) to match it. Only when a new table/column is needed or the ERD itself is wrong, request the change with mcp__studio__erd_request_change instead of editing the ERD (applied after user approval). For update_column, always put the values to change (new physical name, etc.) in columns. Before finishing, check this change for violations with mcp__studio__dict_check and fix them (the pre-PR check blocks them too). '
  + 'In apps that use Liquibase, when tables/columns change, never edit an applied changeset; add a new changeset, and confirm with mcp__studio__schema_check that mappers/JPA match the final schema (old names, missing columns). '
  + 'For long check results, narrow the scope with tables/exclude_paths/kinds and page with section/offset/limit/detail/export. If a dictionary edit you just made is not visible, use refresh or mcp__studio__dict_reload. '
  + 'Request existing violations you will not fix as exceptions with mcp__studio__dict_request_exception (reason required), a starting point for cleaning up existing violations with mcp__studio__dict_request_baseline, and term/word/domain edits with mcp__studio__dict_request_edit (all applied after user approval; never call the erd-vibe REST API directly).';

export function dictContextLines(sessionId: number): string[] {
  if (!erdConfigured()) return [];
  const s = getSession(sessionId);
  if (!s) return [];
  const erdId = sessionErdId(s);
  const erd = erdId ? cachedErdProject(erdId) : null;
  const pending = pendingDictRequests(sessionId);
  return [
    `Dictionary: erd-vibe connected · ERD project ${erdId ? (erd ? `"${erd.name}" (${erd.dbms_type}, ${erd.tables.length} tables)` : `linked (${erdId})`) : 'not linked (the user picks one per workspace in Settings > erd-vibe dictionary)'}`,
    ...(pending.length ? [`Requests awaiting user approval: ${pending.map(requestLabel).join(', ')}`] : []),
  ];
}

export function formatLookup(r: DictSearchResult): string {
  const out: string[] = [`DBMS ${r.dbms} 기준`];
  if (r.resolution) {
    const v = r.resolution;
    const label = { standard: '표준', variant: '비표준 표기', unregistered_term: '미등록 용어', unknown_word: '미등록 단어' }[v.verdict];
    out.push(`판정 ${v.name}: ${label}${v.term ? ` · 표준 ${v.term.standard} (${v.term.logical_name}, 도메인 ${v.term.domain_name ?? '-'} ${v.term.domain_type ?? ''})` : ''}`
      + `${v.draft ? ` · 단어 조합 ${v.draft.words.join('+')} → 등록하려면 dict_request_term(logical_name "${v.draft.logical_name}", physical_name "${v.draft.physical_name}", physical_abbr_name "${v.draft.physical_abbr_name}")` : ''}`
      + `${v.missing.length ? ` · 단어사전에 없는 토큰 ${v.missing.join(', ')}` : ''}${v.similar.length ? ` · 비슷한 용어 ${v.similar.map((t) => `${t.standard}(${t.logical_name})`).join(', ')}` : ''}`);
  }
  out.push(`용어 ${r.total.terms}건${r.total.terms > r.terms.length ? ` (앞 ${r.terms.length}건)` : ''}: 논리명 | 표준(약어명) | 물리명 | 도메인 | 타입`);
  out.push(...r.terms.map((t) => `${t.logical_name} | ${t.standard} | ${t.physical_name} | ${t.domain_name ?? '-'} | ${t.domain_type ?? '-'}`));
  out.push(`단어 ${r.total.words}건: 단어 | 약어 | 영문명`);
  out.push(...r.words.slice(0, 20).map((w) => `${w.name} | ${w.abbreviation ?? '-'} | ${w.english_name}`));
  if (r.domains.length) {
    out.push(`도메인 ${r.total.domains}건: 이름 | ${r.dbms} 타입`);
    out.push(...r.domains.slice(0, 20).map((d) => `${d.name} | ${d.type_for_dbms ?? '-'}`));
  }
  return out.join('\n');
}

/** dict_check·schema_check·REST가 같이 쓰는 범위 필터 모양 */
export const checkFilterShape = {
  tables: z.array(z.string().max(200)).max(50).optional().describe('테이블 이름 패턴(glob). 예 ["REGO_*"]. 테이블을 모르는 위치는 빠진다'),
  exclude_paths: z.array(z.string().max(300)).max(50).optional().describe('이번 검사에서만 뺄 경로(glob). 예 ["document/**"]'),
  kinds: z.array(z.enum(SOURCE_KINDS as [SourceKind, ...SourceKind[]])).optional().describe('출처: ddl(.sql DDL), liquibase, mapper(매퍼 XML SQL·resultMap), sql(.sql DML), jpa'),
  issues: z.array(z.enum(ISSUES)).optional().describe('이 위반 종류만'),
};

export type CheckView = { section?: 'all' | 'findings' | 'held' | 'groups' | 'mixed' | 'erd'; offset?: number; limit?: number; detail?: boolean };

/** 목록 한 쪽. 머리줄에 범위와 다음 offset을 적는다 */
function page<T>(title: string, items: T[], line: (x: T) => string, offset: number, limit: number): string[] {
  if (!items.length) return [];
  const part = items.slice(offset, offset + limit);
  const to = offset + part.length;
  const more = to < items.length ? ` · 다음 offset=${to}` : '';
  return [`${title} ${items.length}건${items.length > part.length ? ` (${offset + 1}–${to})${more}` : ''}:`, ...part.map(line)];
}

const filterText = (f: DictReport['filter']) => !f ? '' : [
  f.tables?.length ? `테이블 ${f.tables.join(',')}` : '', f.exclude_paths?.length ? `제외 ${f.exclude_paths.join(',')}` : '',
  f.kinds?.length ? `출처 ${f.kinds.join(',')}` : '', f.issues?.length ? `종류 ${f.issues.join(',')}` : '',
].filter(Boolean).join(' · ');

export function formatCheck(r: DictReport, v: CheckView = {}): string {
  const section = v.section ?? 'all';
  const offset = Math.max(0, v.offset ?? 0);
  const limit = Math.min(500, Math.max(1, v.limit ?? (section === 'all' ? 40 : 100)));
  const line = (f: Finding) => findingLine(f, v.detail);
  const held = r.findings.filter((f) => f.baseline === 'hold' || f.baseline === 'accepted');
  const active = r.findings.filter((f) => f.baseline !== 'hold' && f.baseline !== 'accepted');
  const blocking = active.filter((f) => f.blocking);
  const b = r.baseline;
  const out = [
    `용어 검사 (${r.scope === 'changed' ? '이번 변경' : '워크트리 전체'}, 파일 ${r.scanned_files}개, DBMS ${r.dbms}${r.erd_project ? `, ERD "${r.erd_project.name}"` : ', ERD 연결 없음'}${r.filter ? `, 범위 ${filterText(r.filter)}` : ''})`,
    ...(r.error ? [`ERD를 받지 못했습니다: ${r.error}`] : []),
    `판정 단위 (테이블, 컬럼) · 막힘 ${blocking.length} · 위반 ${active.length}${held.length ? ` · 보류·허용 ${held.length}(집계 제외)` : ''}${r.ignored ? ` · 예외로 뺀 위치 ${r.ignored}` : ''}`,
    b ? `기준선 ${b.created_at.slice(0, 10)} ${b.total}건: 해결 ${b.resolved} · 남음 ${b.remaining} · 새로 생김 ${b.new_count} · 늘어남 ${b.increased}(+${b.occ_added}곳) · 줄어듦 ${b.decreased}(−${b.occ_removed}곳) — 기준선에 없는 키만 PR을 막는다`
      : '기준선 없음 — 추가한 줄의 위반(ERD에 없음 제외)이 PR을 막는다. 기존 위반이 많으면 dict_request_baseline으로 기준선 저장을 요청한다',
  ];
  if (section === 'all' || section === 'findings') {
    if (section === 'all') {
      out.push(...page('막히는 위반', blocking, line, 0, Math.max(limit, 60)));
      out.push(...page('그 밖의 위반', active.filter((f) => !f.blocking), line, offset, limit));
    } else out.push(...page('위반', active, line, offset, limit));
  }
  if (section === 'held') out.push(...page('보류·허용(집계 제외)', held, (f) => `${line(f)}${f.issues.map((i) => r.baseline?.notes[`${f.table ?? ''}|${f.name}|${i}`]).filter(Boolean).map((n) => ` · 사유 ${n}`).join('')}`, offset, limit));
  if (section === 'groups') out.push(...page('원인별 묶음', r.groups, (g) => `- [${issueLabel(g.issue)}] ${g.title || '-'}${g.detail ? ` (${g.detail})` : ''} · ${g.names.length}개 · ${g.occurrence_count}곳: ${g.names.join(', ')}`, offset, limit));
  if (section === 'all' || section === 'mixed') {
    out.push(...page('같은 용어를 여러 표기로 쓰는 곳', r.mixed, (m) => `- ${m.logical_name}: ${m.spellings.map((s) => `${s.name}×${s.count}${s.standard ? '(표준)' : ''}`).join(', ')} → ${m.standard}로 통일`, section === 'all' ? 0 : offset, section === 'all' ? 20 : limit));
  }
  if (section === 'all' || section === 'erd') {
    out.push(...page('ERD 컬럼 위반', r.erd_findings, (e) => `- ${e.table}.${e.column} ${e.type ?? ''} [${e.issues.map(issueLabel).join(', ')}]${e.resolution.term && e.resolution.verdict === 'variant' ? ` → ${e.resolution.term.standard}` : ''}${e.issues.includes('domain_mismatch') && e.resolution.term ? ` · 도메인 ${e.resolution.term.domain_type}` : ''}`, section === 'all' ? 0 : offset, section === 'all' ? 20 : limit));
  }
  if (section === 'all') {
    if (r.dictionary_duplicates.length) out.push('사전 자체에서 논리명이 겹치는 용어:', ...r.dictionary_duplicates.slice(0, 10).map((d) => `- ${d.logical_name}: ${d.standards.join(', ')}`));
    out.push('더 보려면 section(findings·held·groups·mixed·erd)과 offset·limit(최대 500), 위치 전부는 detail true, 전체 JSON은 export true.');
  }
  if (!r.findings.length && !r.erd_findings.length) out.push('위반이 없습니다.');
  return out.join('\n');
}

/** 검사 결과 전체를 세션 보관함 폴더에 JSON으로 쓴다. 저장소에는 쓰지 않는다 */
export function exportReport(sessionId: number, name: string, report: unknown): string {
  const dir = docsDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  return file;
}

export async function erdTableText(sessionId: number, name: string): Promise<string> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const { erd, erdError, ix } = await sessionIndex(s);
  if (!erd) throw new Error(erdError ?? '이 워크스페이스에 ERD 프로젝트가 연결되지 않았습니다. 사용자에게 설정 > erd-vibe 용어사전에서 워크스페이스의 ERD를 고르도록 부탁한다.');
  const q = name.trim().toUpperCase();
  const hits = erd.tables.filter((t) => t.physical_name.toUpperCase() === q || t.logical_name === name.trim());
  const list = hits.length ? hits : erd.tables.filter((t) => t.physical_name.toUpperCase().includes(q) || t.logical_name.includes(name.trim())).slice(0, 5);
  if (!list.length) return `ERD "${erd.name}"에 ${name} 테이블이 없습니다. 테이블 ${erd.tables.length}개: ${erd.tables.slice(0, 80).map((t) => t.physical_name).join(', ')}`;
  const termById = new Map(ix.dict.terms.map((t) => [t.id, t]));
  return list.map((t) => [
    `${t.physical_name} (${t.logical_name})${t.description ? ` — ${t.description}` : ''}`,
    '컬럼 | 논리명 | 타입 | PK | NULL | 용어',
    ...t.columns.map((c) => `${c.physical_name} | ${c.logical_name} | ${c.data_type ?? ''}${c.data_length && !String(c.data_type ?? '').includes('(') ? `(${c.data_length})` : ''} | ${c.is_primary_key ? 'PK' : ''} | ${c.is_nullable ? 'Y' : 'N'} | ${c.term_dictionary_id ? (termById.get(c.term_dictionary_id)?.logical_name ?? '연결됨') : '없음'}`),
  ].join('\n')).join('\n\n');
}

const SCHEMA_LABEL: Record<SchemaFinding['kind'], string> = {
  missing_table: 'Liquibase에 없는 테이블', missing_column: 'Liquibase에 없는 컬럼', renamed_table: '이름이 바뀐 테이블(옛 이름 사용)',
  renamed_column: '이름이 바뀐 컬럼(옛 이름 사용)', dropped_table: '삭제된 테이블 사용', dropped_column: '삭제된 컬럼 사용',
  type_mismatch: 'JPA columnDefinition 타입 다름', unused_table: '소스에서 안 쓰는 테이블', unused_column: '소스에서 안 쓰는 컬럼',
};
export const schemaLabel = (k: SchemaFinding['kind']) => SCHEMA_LABEL[k];
export const schemaLine = (f: SchemaFinding) => {
  const o = f.occurrences[0];
  return `- ${f.blocking ? '[막힘] ' : ''}${f.table ?? '?'}${f.column ? `.${f.column}` : ''}: ${SCHEMA_LABEL[f.kind]}${f.suggestion ? ` → ${f.suggestion}` : ''}${f.detail ? ` (${f.detail})` : ''}`
    + `${f.change ? ` · changeset ${f.change.changeset} ${f.change.file}:${f.change.line}` : ''}${o ? ` · ${o.file}:${o.line} ${o.text}` : ''}${f.occurrence_count > 1 ? ` 외 ${f.occurrence_count - 1}곳` : ''}`;
};

export function formatSchema(r: SchemaReport, v: { offset?: number; limit?: number; detail?: boolean } = {}): string {
  const offset = Math.max(0, v.offset ?? 0);
  const limit = Math.min(500, Math.max(1, v.limit ?? 60));
  const apps = r.apps.map((a) => `${a.project_name}: ${a.kind === 'liquibase' ? `Liquibase ${a.roots.join(', ')} · changeset ${a.changesets}` : a.kind === 'ddl' ? '.sql DDL' : '스키마 정의 없음'} · 테이블 ${a.tables} · 컬럼 ${a.columns}${a.unparsed ? ` · 읽지 못한 변경 ${a.unparsed}` : ''}`);
  const used = r.findings.filter((f) => !f.kind.startsWith('unused_'));
  const blocking = used.filter((f) => f.blocking);
  const line = (f: SchemaFinding) => v.detail
    ? [schemaLine(f), ...f.occurrences.map((o) => `    ${o.project_name}/${o.file}:${o.line}${o.added ? ' (추가)' : ''} ${o.text}`)].join('\n')
    : schemaLine(f);
  const out = [
    `스키마 검사 (${r.scope === 'changed' ? '이번 변경' : '워크트리 전체'}, 매퍼·JPA 참조 ${r.refs}건)`, ...apps,
    `이번 변경에서 막히는 것 ${blocking.length}건:`, ...blocking.slice(0, 200).map(line),
  ];
  out.push(...page('그 밖의 불일치(기존 코드)', used.filter((f) => !f.blocking), line, offset, limit));
  if (!used.length) out.push('매퍼·JPA가 최종 스키마와 맞습니다.');
  return out.join('\n');
}

export async function schemaCheckText(sessionId: number, scope: 'changed' | 'all', filter: SchemaFilter = {}, v: { offset?: number; limit?: number; detail?: boolean; export?: boolean } = {}) {
  const r = await schemaCheck(sessionId, scope, filter);
  const text = formatSchema(r, v);
  return v.export ? `${text}\n전체 결과 JSON: ${exportReport(sessionId, 'schema-check', r)}` : text;
}
export { checkSession, createDictRequest, searchDictionary };
