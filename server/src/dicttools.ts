import { createDictRequest, pendingDictRequests, requestLabel } from './dictrequests.js';
import { checkSession, findingLine, issueLabel, sessionErdId, sessionIndex, type DictReport } from './dictscan.js';
import { searchDictionary, type DictSearchResult } from './dictsearch.js';
import { cachedErdProject, erdConfigured } from './erdvibe.js';
import { getSession } from './sessions.js';
import { schemaCheck, type SchemaReport } from './schemasync.js';
import { sourceTodo } from './syncstate.js';
import type { SchemaFinding } from './dict/srcrefs.js';

/** Claude에게 주는 용어사전 도구의 글 모양과, 시스템 프롬프트·tool_context에 붙일 줄. */

export const DICT_RULE = '컬럼·DDL·SQL 별칭·resultMap column처럼 DB 이름을 새로 짓거나 바꿀 때는 먼저 mcp__studio__dict_lookup으로 erd-vibe 용어사전의 표준 이름(약어명)과 도메인 타입을 확인하고 그대로 쓴다. '
  + '같은 용어를 다른 표기(TR_DATE와 TR_DT 등)로 쓰지 않는다. 사전에 없는 이름은 지어내지 말고 mcp__studio__dict_request_term으로 등록을 요청한 뒤 사용자 승인을 기다린다. '
  + '테이블 정의가 필요하면 mcp__studio__erd_table로 ERD를 본다. 새 테이블·컬럼이 필요하거나 ERD와 소스가 다르면 ERD를 직접 고치지 말고 mcp__studio__erd_request_change로 변경을 요청한다(사용자가 승인하면 반영). 작업을 마치기 전에 mcp__studio__dict_check로 이번 변경의 위반을 확인하고 고친다(PR 전 검사에서도 막힌다). '
  + 'Liquibase를 쓰는 앱에서 테이블·컬럼을 바꾸면 이미 적용된 changeset은 고치지 말고 새 changeset을 더하고, mcp__studio__schema_check로 매퍼·JPA가 최종 스키마와 맞는지(옛 이름·없는 컬럼) 확인한다.';

export function dictContextLines(sessionId: number): string[] {
  if (!erdConfigured()) return [];
  const s = getSession(sessionId);
  if (!s) return [];
  const erdId = sessionErdId(s);
  const erd = erdId ? cachedErdProject(erdId) : null;
  const pending = pendingDictRequests(sessionId);
  return [
    `용어사전: erd-vibe 연결됨 · ERD 프로젝트 ${erdId ? (erd ? `"${erd.name}" (${erd.dbms_type}, 테이블 ${erd.tables.length}개)` : `연결됨(${erdId})`) : '연결 안 됨(설정 > erd-vibe 용어사전에서 워크스페이스마다 고른다)'}`,
    ...(pending.length ? [`승인 대기 중인 요청: ${pending.map(requestLabel).join(', ')}`] : []),
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

export function formatCheck(r: DictReport): string {
  const blocking = r.findings.filter((f) => f.blocking);
  const out = [
    `용어 검사 (${r.scope === 'changed' ? '이번 변경' : '워크트리 전체'}, 파일 ${r.scanned_files}개, DBMS ${r.dbms}${r.erd_project ? `, ERD "${r.erd_project.name}"` : ', ERD 연결 없음'})`,
    ...(r.error ? [`ERD를 받지 못했습니다: ${r.error}`] : []),
    `이번 변경에서 새로 생긴 위반 ${blocking.length}건 (PR 전 검사에서 막힘):`,
    ...blocking.slice(0, 60).map(findingLine),
  ];
  const rest = r.findings.filter((f) => !f.blocking);
  if (rest.length) out.push(`그 밖의 위반·경고 ${rest.length}건 (기존 코드이거나 ERD에 없음만 해당):`, ...rest.slice(0, 30).map(findingLine));
  if (r.mixed.length) out.push('같은 용어를 여러 표기로 쓰는 곳:', ...r.mixed.map((m) => `- ${m.logical_name}: ${m.spellings.map((s) => `${s.name}×${s.count}${s.standard ? '(표준)' : ''}`).join(', ')} → ${m.standard}로 통일`));
  if (r.erd_findings.length) out.push(`ERD 컬럼 위반 ${r.erd_findings.length}건:`, ...r.erd_findings.slice(0, 30).map((e) => `- ${e.table}.${e.column} [${e.issues.map(issueLabel).join(', ')}]${e.resolution.term && e.resolution.verdict === 'variant' ? ` → ${e.resolution.term.standard}` : ''}`));
  if (r.dictionary_duplicates.length) out.push('사전 자체에서 논리명이 겹치는 용어:', ...r.dictionary_duplicates.slice(0, 10).map((d) => `- ${d.logical_name}: ${d.standards.join(', ')}`));
  if (!r.findings.length && !r.erd_findings.length) out.push('위반이 없습니다.');
  return out.join('\n');
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

export function formatSchema(r: SchemaReport): string {
  const apps = r.apps.map((a) => `${a.project_name}: ${a.kind === 'liquibase' ? `Liquibase ${a.roots.join(', ')} · changeset ${a.changesets}` : a.kind === 'ddl' ? '.sql DDL' : '스키마 정의 없음'} · 테이블 ${a.tables} · 컬럼 ${a.columns}${a.unparsed ? ` · 읽지 못한 변경 ${a.unparsed}` : ''}`);
  const used = r.findings.filter((f) => !f.kind.startsWith('unused_'));
  const blocking = used.filter((f) => f.blocking);
  const out = [
    `스키마 검사 (${r.scope === 'changed' ? '이번 변경' : '워크트리 전체'}, 매퍼·JPA 참조 ${r.refs}건)`, ...apps,
    `이번 변경에서 막히는 것 ${blocking.length}건:`, ...blocking.slice(0, 60).map(schemaLine),
  ];
  const rest = used.filter((f) => !f.blocking);
  if (rest.length) out.push(`그 밖의 불일치 ${rest.length}건(기존 코드):`, ...rest.slice(0, 40).map(schemaLine));
  if (!used.length) out.push('매퍼·JPA가 최종 스키마와 맞습니다.');
  return out.join('\n');
}

export async function schemaCheckText(sessionId: number, scope: 'changed' | 'all') { return formatSchema(await schemaCheck(sessionId, scope)); }
export async function syncTodoText(sessionId: number, limit: number) {
  const r = await sourceTodo(sessionId);
  const more = r.todos.length > limit ? `\n\n(${r.todos.length}건 중 앞 ${limit}건. 다 고친 뒤 다시 부르면 다음 것이 나온다)` : '';
  return (r.todos.length > limit ? (await sourceTodo(sessionId, r.todos.slice(0, limit).map((t) => t.key))).text : r.text) + more;
}

export { checkSession, createDictRequest, searchDictionary };
