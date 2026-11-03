import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { insertIntoPrompt, useServerEvents } from '../events';
import type { DictDraft, DraftInput, DraftResult, ErdApplyResult, Session, SyncAction, SyncIssue, SyncItem, SyncReport, SyncSide, SyncStatus } from '../types';

/**
 * 소스 · ERD · 용어사전 전체 동기화. 컬럼(TABLE.COLUMN)마다 R1~R5를 맞춰 보고
 * ① 사전 등록 → ② ERD 반영 → ③ 소스 수정(Claude에게) 순서로 정리한다.
 * R1(소스↔ERD 차이)만 건마다 기준을 고르고, R2~R5는 사전이 기준이다.
 */

type Rule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
const RULE_OF: Record<SyncIssue, Rule> = {
  table_source_only: 'R1', table_erd_only: 'R1', source_only: 'R1', erd_only: 'R1', type_diff: 'R1', logical_diff: 'R1',
  unregistered_term: 'R2', unknown_word: 'R2',
  same_logical: 'R3', variant: 'R3', overlap_blocked: 'R3',
  logical_dup: 'R4',
  domain_source: 'R5', domain_erd: 'R5', no_term_link: 'R5',
};
const RULE_LABEL: Record<Rule, string> = { R1: 'R1 소스↔ERD', R2: 'R2 미등록', R3: 'R3 표준명', R4: 'R4 논리명 중복', R5: 'R5 도메인' };
const ISSUE_LABEL: Record<SyncIssue, string> = {
  table_source_only: '테이블 소스에만', table_erd_only: '테이블 ERD에만', source_only: '소스에만', erd_only: 'ERD에만',
  type_diff: '타입 다름', logical_diff: '논리명 다름', variant: '비표준 표기', same_logical: '같은 논리명 용어 있음',
  overlap_blocked: '사전 겹침', unregistered_term: '미등록 용어', unknown_word: '미등록 단어',
  domain_source: '소스 도메인', domain_erd: 'ERD 도메인', no_term_link: '용어 연결 없음', logical_dup: '논리명 중복',
};
const KIND_LABEL: Record<string, string> = {
  add_table: '테이블 추가', add_column: '컬럼 추가', rename_column: '이름 바꾸기', set_logical: '논리명', set_type: '타입',
  link_term: '용어 연결', delete_column: '컬럼 삭제', delete_table: '테이블 삭제',
  modify_type: '타입 바꾸기', set_remarks: '코멘트', drop_column: '컬럼 삭제', drop_table: '테이블 삭제',
};
const DELETE_KINDS = new Set(['delete_column', 'delete_table']);
const MAX_RUN = 500;
const CHUNK = 30;

type View = 'todo' | 'decide' | 'hold' | 'ok' | 'all';
const VIEW_LABEL: Record<View, string> = { todo: '할 일', decide: '결정 필요', hold: '보류', ok: '확인됨', all: '전체' };

const actionsOf = (it: SyncItem): SyncAction[] => [...it.actions.common, ...(it.side ? it.actions[it.side] : [])];
const isOk = (it: SyncItem) => it.issues.length === 0;
const matchView = (it: SyncItem, v: View) => {
  if (v === 'all') return true;
  if (v === 'ok') return isOk(it);
  if (v === 'hold') return it.status !== 'todo';
  if (isOk(it) || it.status !== 'todo') return false;
  return v === 'decide' ? it.needs_side : true;
};

function actionText(a: SyncAction): string {
  switch (a.kind) {
    case 'add_table': return a.target === 'erd' ? `${a.table} (${a.logical_name})` : `${a.table} (${a.logical_name}) 컬럼 ${a.columns.length}개`;
    case 'add_column': return a.target === 'erd' ? `${a.table}.${a.physical_name} ${a.data_type ?? ''} (${a.logical_name})` : `${a.table}.${a.column} ${a.data_type ?? ''} (${a.logical_name})`;
    case 'rename_column': return `${a.before} → ${a.after}`;
    case 'set_logical': return `${a.before || '(없음)'} → ${a.after}`;
    case 'set_type': case 'modify_type': return `${a.before ?? '?'} → ${a.after}`;
    case 'link_term': return `→ ${a.term_name}`;
    case 'set_remarks': return `"${a.after}"`;
    case 'delete_column': return a.physical_name;
    case 'delete_table': return a.physical_name;
    case 'drop_column': return `${a.table}.${a.column}`;
    case 'drop_table': return a.table;
  }
}

export default function SyncTab({ session, onOpenErd, onShowOverlap }: { session: Session; onOpenErd: (table?: string) => void; onShowOverlap: () => void }) {
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [view, setView] = useState<View>('todo');
  const [rule, setRule] = useState<Rule | 'all'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [tableLimit, setTableLimit] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'dict' | 'erd' | null>(null);
  const [sent, setSent] = useState(0);

  const run = useCallback(async () => {
    setBusy(true); setError(null);
    try { setReport(await api.syncCheck(session.id)); setStale(false); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [session.id]);
  useEffect(() => { run(); }, [run]);
  useServerEvents((e) => { if (e.type === 'dict.updated' || e.type === 'erd.updated') setStale(true); });

  const items = report?.items ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return items.filter((it) => matchView(it, view)
      && (rule === 'all' || it.issues.some((i) => RULE_OF[i] === rule))
      && (!needle || it.key.includes(needle) || (it.logical ?? '').toUpperCase().includes(needle)));
  }, [items, view, rule, q]);
  const tables = useMemo(() => {
    const m = new Map<string, SyncItem[]>();
    for (const it of shown) { const l = m.get(it.table) ?? []; l.push(it); m.set(it.table, l); }
    return [...m.entries()];
  }, [shown]);
  useEffect(() => { setSelected(new Set()); setTableLimit(50); }, [view, rule, q]);

  const counts = useMemo(() => ({
    decide: items.filter((it) => matchView(it, 'decide')).length,
    hold: items.filter((it) => it.status !== 'todo').length,
    todo: items.filter((it) => matchView(it, 'todo')).length,
    ok: items.filter(isOk).length,
  }), [items]);
  const overlap = report?.summary.issues.overlap_blocked ?? 0;
  const draftCount = report?.drafts.length ?? 0;
  const todoItems = items.filter((it) => matchView(it, 'todo'));
  const erdCount = todoItems.reduce((n, it) => n + actionsOf(it).filter((a) => a.target === 'erd').length, 0);
  const sourceItems = todoItems.filter((it) => actionsOf(it).some((a) => a.target === 'source'));

  const decide = async (keys: string[], patch: { side?: SyncSide | null; status?: SyncStatus; note?: string }) => {
    if (!keys.length) return;
    setBusy(true); setError(null);
    try { await api.setSyncDecisions(session.id, keys, patch); await run(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const hold = (keys: string[]) => {
    const note = prompt(`${keys.length}건을 보류합니다. 이유를 적어 주세요.`, '');
    if (note === null || !note.trim()) return;
    decide(keys, { status: 'hold', note });
  };
  const sendSource = async (keys: string[]) => {
    const chunk = keys.slice(0, CHUNK);
    if (!chunk.length) return;
    setBusy(true); setError(null);
    try {
      const r = await api.syncSourceTodo(session.id, chunk);
      insertIntoPrompt(r.text + (keys.length > CHUNK ? `\n\n(소스 할 일 ${keys.length - CHUNK}건이 더 있습니다. 위를 고친 뒤 동기화 탭에서 다시 보낼게요)` : ''));
      setSent((n) => n + chunk.length);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const toggle = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  const selKeys = [...selected];
  const erdTargets = (selKeys.length ? items.filter((it) => selected.has(it.key)) : shown).filter((it) => it.status === 'todo' && actionsOf(it).some((a) => a.target === 'erd'));

  return (
    <>
      <div className="card">
        <div className="row">
          <button disabled={busy} onClick={run}>{busy ? <><span className="spinner" aria-hidden="true" /> 확인 중</> : '다시 확인'}</button>
          {report?.erd_project && <span className="pill accent">ERD {report.erd_project.name}</span>}
          {report?.apps.filter((a) => a.kind !== 'none').map((a) => <span key={a.project_name} className="pill">{a.project_name} · {a.kind === 'liquibase' ? 'Liquibase' : 'DDL'} 테이블 {a.tables}</span>)}
        </div>
        <p className="muted small">
          소스(Liquibase 최종 스키마, 없으면 .sql DDL)와 ERD의 컬럼을 용어사전에 맞춰 봅니다. 소스와 ERD가 다르면(R1) 건마다 기준을 고르고, 기본은 소스입니다.
          미등록 용어(R2), 표준명(R3), ERD 논리명 중복(R4), 도메인(R5)은 사전이 기준입니다.
        </p>
        {report && !report.error && (
          <div className="row">
            <span className="pill">컬럼 {report.summary.columns}</span>
            <span className="pill ok">확인됨 {counts.ok}</span>
            <span className={`pill ${counts.todo ? 'warn' : 'ok'}`}>할 일 {counts.todo}</span>
            {counts.decide > 0 && <span className="pill err">결정 필요 {counts.decide}</span>}
            {counts.hold > 0 && <span className="pill">보류 {counts.hold}</span>}
            {report.summary.logical_dups > 0 && <span className="pill err">논리명 중복 {report.summary.logical_dups}</span>}
            {overlap > 0 && <span className="pill err">사전 겹침 먼저 {overlap}</span>}
          </div>
        )}
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {report?.error && <p className="banner error">{report.error}</p>}
      {stale && <p className="banner">사전이나 ERD가 바뀌었습니다. <button className="small-btn" onClick={run}>다시 확인</button></p>}
      {overlap > 0 && (
        <p className="banner">
          사전에서 같은 논리명을 가진 용어가 여럿이라 {overlap}건은 어느 용어로 맞출지 정할 수 없습니다. 사전의 겹침을 먼저 정리하세요.{' '}
          <button className="small-btn" onClick={onShowOverlap}>사전 관리 › 겹침</button>
        </p>
      )}

      {report && !report.error && (
        <div className="sync-steps">
          <section className="card sync-step">
            <h2>① 사전 등록</h2>
            <p className="small">단어·도메인·용어 초안 <b>{draftCount}</b>건</p>
            <p className="muted small">같은 논리명·이름이 이미 있으면 등록 직전에 다시 보고 건너뜁니다.</p>
            <button className={draftCount ? 'primary' : ''} disabled={busy || !draftCount} onClick={() => setDialog('dict')}>초안 보고 등록</button>
          </section>
          <section className="card sync-step">
            <h2>② ERD 반영 {draftCount > 0 && <span className="pill warn">① 먼저</span>}</h2>
            <p className="small">ERD 할 일 <b>{erdCount}</b>건{selected.size > 0 && <> · 고른 컬럼 {selected.size}개</>}</p>
            <p className="muted small">미리보기에서 종류를 골라 한 번에 {MAX_RUN}건까지 반영하고, 되돌릴 수 있습니다.</p>
            <button disabled={busy || !erdTargets.length} onClick={() => setDialog('erd')}>{selected.size ? '고른 것 미리보기' : '보이는 것 미리보기'}</button>
          </section>
          <section className="card sync-step">
            <h2>③ 소스 수정 {(draftCount > 0 || erdCount > 0) && <span className="pill warn">{draftCount > 0 ? '① 먼저' : '② 먼저'}</span>}</h2>
            <p className="small">소스 할 일 컬럼 <b>{sourceItems.length}</b>개{sent > 0 && <span className="muted"> · 이번에 보냄 {sent}</span>}</p>
            <p className="muted small">새 changeset과 매퍼·JPA 수정을 Claude에게 {CHUNK}건씩 보냅니다.</p>
            <button disabled={busy || !sourceItems.length} onClick={() => sendSource((selected.size ? sourceItems.filter((it) => selected.has(it.key)) : sourceItems).map((it) => it.key))}>
              Claude에게 보내기 ({Math.min(CHUNK, selected.size ? sourceItems.filter((it) => selected.has(it.key)).length : sourceItems.length)}건)
            </button>
          </section>
        </div>
      )}

      {report && report.runs.length > 0 && (
        <section className="card">
          <h2>ERD 반영 기록</h2>
          <ul className="dict-list">{report.runs.map((r) => (
            <li key={r.id}>
              <span className="mono small">{r.created_at}</span> {r.summary} <span className="muted small">되돌릴 것 {r.count}건</span>{' '}
              {r.undone_at ? <span className="pill">되돌림 {r.undone_at}</span> : (
                <button className="small-btn" disabled={busy} onClick={async () => {
                  if (!confirm(`이 반영(${r.summary})을 되돌릴까요?`)) return;
                  setBusy(true); setError(null);
                  try { const u = await api.undoSyncRun(session.id, r.id); if (u.failed.length) setError(`되돌리기 ${u.undone}건, 실패 ${u.failed.length}건: ${u.failed.slice(0, 3).join(' / ')}`); } catch (e) { setError((e as Error).message); }
                  await run();
                }}>되돌리기</button>
              )}
            </li>
          ))}</ul>
        </section>
      )}

      {report && !report.error && (
        <section className="card">
          <div className="block-head">
            <h2>컬럼 <span className="muted small">{shown.length}건 · 테이블 {tables.length}</span></h2>
            <div className="row">
              <div className="seg" role="group" aria-label="상태">
                {(['todo', 'decide', 'hold', 'ok', 'all'] as View[]).map((k) => (
                  <button key={k} className={`chip-btn${view === k ? ' on' : ''}`} onClick={() => setView(k)}>{VIEW_LABEL[k]}</button>
                ))}
              </div>
              <select className="small-select" value={rule} aria-label="규칙" onChange={(e) => setRule(e.target.value as Rule | 'all')}>
                <option value="all">규칙 전체</option>
                {(Object.keys(RULE_LABEL) as Rule[]).map((r) => <option key={r} value={r}>{RULE_LABEL[r]}</option>)}
              </select>
              <input className="mono" value={q} placeholder="테이블·컬럼·논리명" aria-label="찾기" onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          {selected.size > 0 && (
            <div className="row sync-bulk">
              <b>{selected.size}개 고름</b>
              <button className="small-btn" disabled={busy} onClick={() => decide(selKeys.filter((k) => items.find((it) => it.key === k)?.needs_side), { side: 'source' })}>기준 소스</button>
              <button className="small-btn" disabled={busy} onClick={() => decide(selKeys.filter((k) => items.find((it) => it.key === k)?.needs_side), { side: 'erd' })}>기준 ERD</button>
              <button className="small-btn" disabled={busy} onClick={() => hold(selKeys)}>보류</button>
              <button className="small-btn" disabled={busy} onClick={() => decide(selKeys, { status: 'todo', note: '' })}>할 일로</button>
              <button className="small-btn" onClick={() => setSelected(new Set())}>고르기 풀기</button>
            </div>
          )}
          {tables.length === 0 ? <p className="muted">해당하는 컬럼이 없습니다.</p> : (
            <ul className="dict-groups sync-groups">
              {tables.slice(0, tableLimit).map(([table, its]) => {
                const isOpen = open.has(table);
                const rules = [...new Set(its.flatMap((it) => it.issues.map((i) => RULE_OF[i])))].sort();
                const allSel = its.every((it) => selected.has(it.key));
                return (
                  <li key={table}>
                    <div className="row">
                      <input type="checkbox" checked={allSel} aria-label={`${table} 모두 고르기`} onChange={() => setSelected((s) => { const n = new Set(s); for (const it of its) { if (allSel) n.delete(it.key); else n.add(it.key); } return n; })} />
                      <code className="dict-name">{table}</code>
                      <span className="muted small">컬럼 {its.length}</span>
                      {rules.map((r) => <span key={r} className={`pill ${r === 'R1' || r === 'R4' ? 'err' : 'warn'}`}>{r}</span>)}
                      <span className="spacer" />
                      <button className="small-btn" onClick={() => onOpenErd(table)}>ERD에서 보기</button>
                      <button className="small-btn" aria-expanded={isOpen} onClick={() => setOpen((s) => toggle(s, table))}>{isOpen ? '접기' : '펼치기'}</button>
                    </div>
                    {isOpen && <SyncRows items={its} selected={selected} busy={busy} onSelect={(k) => setSelected((s) => toggle(s, k))} onSide={(k, side) => decide([k], { side })} onHold={(k) => hold([k])} onTodo={(k) => decide([k], { status: 'todo', note: '' })} />}
                  </li>
                );
              })}
              {tables.length > tableLimit && <li><button className="small-btn" onClick={() => setTableLimit((n) => n + 100)}>테이블 {tables.length - tableLimit}개 더 보기</button></li>}
            </ul>
          )}
        </section>
      )}

      {dialog === 'dict' && report && <DraftDialog session={session} drafts={report.drafts} onClose={() => setDialog(null)} onDone={run} />}
      {dialog === 'erd' && <ErdDialog session={session} items={erdTargets} onClose={() => setDialog(null)} onDone={run} />}
    </>
  );
}

function SyncRows({ items, selected, busy, onSelect, onSide, onHold, onTodo }: {
  items: SyncItem[]; selected: Set<string>; busy: boolean;
  onSelect: (key: string) => void; onSide: (key: string, side: SyncSide) => void; onHold: (key: string) => void; onTodo: (key: string) => void;
}) {
  return (
    <div className="table-wrap"><table className="dict-table sync-table">
      <thead><tr><th /><th>컬럼</th><th>논리명</th><th>소스 타입</th><th>ERD</th><th>용어·도메인</th><th>규칙</th><th>기준</th><th>할 일</th><th /></tr></thead>
      <tbody>{items.map((it) => {
        const acts = actionsOf(it);
        return (
          <tr key={it.key} className={it.status !== 'todo' ? 'muted' : ''}>
            <td><input type="checkbox" checked={selected.has(it.key)} aria-label={`${it.key} 고르기`} onChange={() => onSelect(it.key)} /></td>
            <td className="mono">
              {it.column ?? '(테이블)'}
              {it.target_name && it.column && it.target_name !== it.column && <div className="small">→ {it.target_name}</div>}
              {it.source && <div className="muted small sync-file" title={`${it.source.change.file}:${it.source.change.line} ${it.source.change.changeset}`}>{it.source.change.file}:{it.source.change.line}</div>}
            </td>
            <td>{it.logical ?? <span className="muted">-</span>}{it.logical_from && <div className="muted small">{it.logical_from === 'source' ? '소스 코멘트' : it.logical_from === 'erd' ? 'ERD' : it.logical_from === 'term' ? '용어' : '초안'}</div>}</td>
            <td className="mono small nowrap">{it.source ? it.source.type ?? '?' : <span className="muted">없음</span>}</td>
            <td className="mono small nowrap">{it.erd ? <>{it.erd.name !== it.column && <div>{it.erd.name}</div>}{it.erd.type ?? '?'}{it.erd.logical_name && <div className="muted">{it.erd.logical_name}</div>}</> : <span className="muted">없음</span>}</td>
            <td className="small">{it.term ? <><code>{it.term.standard}</code> {it.term.domain_name ?? '-'} <span className="muted mono">{it.term.domain_type ?? ''}</span></> : it.drafts.length ? <span className="pill warn">초안 {it.drafts.length}</span> : <span className="muted">-</span>}
              {it.target_type && <div className="muted mono">→ {it.target_type}</div>}
            </td>
            <td>{it.issues.length ? it.issues.map((i) => <span key={i} className={`pill ${RULE_OF[i] === 'R1' || RULE_OF[i] === 'R4' || i === 'overlap_blocked' ? 'err' : 'warn'}`} title={RULE_LABEL[RULE_OF[i]]}>{ISSUE_LABEL[i]}</span>) : <span className="pill ok">맞음</span>}</td>
            <td>
              {it.needs_side ? (
                <div className="seg" role="group" aria-label="기준">
                  <button className={`chip-btn${it.side === 'source' ? ' on' : ''}`} disabled={busy} onClick={() => onSide(it.key, 'source')}>소스</button>
                  <button className={`chip-btn${it.side === 'erd' ? ' on' : ''}`} disabled={busy} onClick={() => onSide(it.key, 'erd')}>ERD</button>
                </div>
              ) : it.issues.length ? <span className="muted small">사전</span> : null}
            </td>
            <td className="small">
              {acts.length === 0 ? <span className="muted">{it.needs_side && !it.side ? '기준을 고르세요' : '-'}</span> : (
                <ul className="sync-acts">{acts.map((a, i) => (
                  <li key={i}><span className={`pill ${a.target === 'erd' ? 'accent' : ''}`}>{a.target === 'erd' ? 'ERD' : '소스'} {KIND_LABEL[a.kind]}</span> <span className="mono">{actionText(a)}</span></li>
                ))}</ul>
              )}
              {it.note && <div className="muted">보류: {it.note}</div>}
            </td>
            <td>{it.status === 'todo' ? <button className="small-btn" disabled={busy} onClick={() => onHold(it.key)}>보류</button> : <button className="small-btn" disabled={busy} onClick={() => onTodo(it.key)}>할 일로</button>}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

type DraftRow = { on: boolean; values: Record<string, string> };
const DRAFT_FIELDS: Record<DictDraft['kind'], [string, string][]> = {
  word: [['abbreviation', '약어'], ['name', '단어명'], ['english_name', '영문명']],
  domain: [['name', '도메인명'], ['data_type', '타입']],
  term: [['logical_name', '논리명'], ['physical_abbr_name', '약어명'], ['physical_name', '물리명'], ['domain_name', '도메인']],
};
const KIND_TITLE: Record<DictDraft['kind'], string> = { word: '단어', domain: '도메인', term: '용어' };

function draftValues(d: DictDraft): Record<string, string> {
  if (d.kind === 'word') return { abbreviation: d.abbreviation, name: d.name, english_name: d.english_name };
  if (d.kind === 'domain') return { name: d.name, data_type: d.data_type };
  return { logical_name: d.logical_name, physical_abbr_name: d.physical_abbr_name, physical_name: d.physical_name, domain_name: d.domain_name ?? '' };
}
function draftProblem(kind: DictDraft['kind'], v: Record<string, string>): string | null {
  if (kind === 'word') return !v.name.trim() || !v.english_name.trim() || !v.abbreviation.trim() ? '단어명·영문명·약어가 필요합니다' : null;
  if (kind === 'domain') return !v.name.trim() || !v.data_type.trim() ? '이름·타입이 필요합니다' : null;
  return !v.logical_name.trim() || !v.physical_name.trim() || !v.physical_abbr_name.trim() ? '논리명·물리명·약어명이 필요합니다' : null;
}
function toInput(d: DictDraft, v: Record<string, string>): DraftInput {
  if (d.kind === 'word') return { kind: 'word', key: d.key, name: v.name.trim(), english_name: v.english_name.trim(), abbreviation: v.abbreviation.trim().toUpperCase() };
  if (d.kind === 'domain') return { kind: 'domain', key: d.key, name: v.name.trim(), data_type: v.data_type.trim() };
  return { kind: 'term', key: d.key, logical_name: v.logical_name.trim(), physical_name: v.physical_name.trim(), physical_abbr_name: v.physical_abbr_name.trim().toUpperCase(), domain_name: v.domain_name.trim() || null };
}

function DraftDialog({ session, drafts, onClose, onDone }: { session: Session; drafts: DictDraft[]; onClose: () => void; onDone: () => Promise<void> }) {
  // 단어는 단어명·영문명을 채워야 고르고, 용어는 먼저 필요한 단어 초안이 없을 때만 기본으로 고른다
  const [rows, setRows] = useState<Record<string, DraftRow>>(() => Object.fromEntries(drafts.map((d) => [d.key, {
    on: d.kind === 'word' ? !!d.name.trim() && !!d.english_name.trim() : d.kind === 'term' ? !d.needs.some((n) => n.startsWith('word:')) : true,
    values: draftValues(d),
  }])));
  const byKey = useMemo(() => new Map(drafts.map((d) => [d.key, d])), [drafts]);
  /** 고른 용어가 기대는 단어·도메인 초안 중 안 고른 것 */
  const missingNeeds = (d: DictDraft) => (d.kind === 'term' ? d.needs.filter((n) => byKey.has(n) && !rows[n]?.on) : []);
  const [kind, setKind] = useState<DictDraft['kind']>('word');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DraftResult[] | null>(null);
  const of = (k: DictDraft['kind']) => drafts.filter((d) => d.kind === k);
  const picked = drafts.filter((d) => rows[d.key].on);
  const problems = picked.filter((d) => draftProblem(d.kind, rows[d.key].values) || missingNeeds(d).length > 0);
  const set = (key: string, patch: Partial<DraftRow> & { field?: [string, string] }) => setRows((r) => {
    const cur = r[key];
    const values = patch.field ? { ...cur.values, [patch.field[0]]: patch.field[1] } : cur.values;
    const filled = byKey.get(key)?.kind === 'word' && patch.field && !cur.on && values.name.trim() && values.english_name.trim();
    return { ...r, [key]: { on: patch.on ?? (filled ? true : cur.on), values } };
  });
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.applySyncDict(session.id, picked.map((d) => toInput(d, rows[d.key].values)));
      setResults(r.results);
      await onDone();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const list = of(kind);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="sync-dict-title" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
        <h1 id="sync-dict-title">① 사전 등록</h1>
        <p className="muted small">단어 → 도메인 → 용어 순서로 등록합니다. 단어는 단어명(한글)과 영문명을 채워야 합니다. 이미 같은 논리명·이름이 있으면 건너뜁니다.</p>
        {results ? (
          <>
            <div className="row">
              <span className="pill ok">등록 {results.filter((r) => r.ok && !r.skipped).length}</span>
              <span className="pill">건너뜀 {results.filter((r) => r.skipped).length}</span>
              {results.some((r) => !r.ok) && <span className="pill err">실패 {results.filter((r) => !r.ok).length}</span>}
            </div>
            <ul className="dict-list small">{results.filter((r) => !r.ok || r.skipped).slice(0, 50).map((r) => <li key={r.key}><code>{r.key}</code> {r.skipped ?? r.error}</li>)}</ul>
            <div className="dialog-actions"><button className="primary" onClick={onClose}>닫기</button></div>
          </>
        ) : (
          <>
            <div className="seg" role="group" aria-label="종류">
              {(['word', 'domain', 'term'] as DictDraft['kind'][]).map((k) => (
                <button key={k} className={`chip-btn${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{KIND_TITLE[k]} {of(k).filter((d) => rows[d.key].on).length}/{of(k).length}</button>
              ))}
            </div>
            <div className="table-wrap sync-scroll"><table className="dict-table">
              <thead><tr>
                <th><input type="checkbox" aria-label="모두" checked={list.length > 0 && list.every((d) => rows[d.key].on)} onChange={(e) => setRows((r) => { const n = { ...r }; for (const d of list) n[d.key] = { ...n[d.key], on: e.target.checked }; return n; })} /></th>
                {DRAFT_FIELDS[kind].map(([, label]) => <th key={label}>{label}</th>)}<th>쓰는 곳</th>
              </tr></thead>
              <tbody>{list.map((d) => {
                const row = rows[d.key];
                const bad = row.on && (draftProblem(d.kind, row.values) || missingNeeds(d).length > 0);
                return (
                  <tr key={d.key} className={bad ? 'sync-bad' : ''}>
                    <td><input type="checkbox" checked={row.on} aria-label={`${d.key} 등록`} onChange={(e) => set(d.key, { on: e.target.checked })} /></td>
                    {DRAFT_FIELDS[kind].map(([f, label]) => (
                      <td key={f}><input className="mono" value={row.values[f]} aria-label={label} list={f === 'domain_name' ? 'dict-domains' : undefined} onChange={(e) => set(d.key, { field: [f, e.target.value] })} /></td>
                    ))}
                    <td className="small muted">{d.used_by.slice(0, 3).join(', ')}{d.used_by.length > 3 ? ` 외 ${d.used_by.length - 3}` : ''}{d.kind === 'term' && d.needs.length > 0 && <div className={missingNeeds(d).length ? 'sync-need' : ''}>먼저 필요: {d.needs.map((n) => n.replace(/^(word|domain):/, '')).join(', ')}</div>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
            {problems.length > 0 && <p className="banner">고른 것 중 {problems.length}건은 값이 비었거나 먼저 필요한 단어·도메인을 고르지 않았습니다: {problems.slice(0, 5).map((d) => d.key).join(', ')}{problems.length > 5 ? ' …' : ''}</p>}
            {error && <p className="banner error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button disabled={busy} onClick={onClose}>닫기</button>
              <button className="primary" disabled={busy || !picked.length || problems.length > 0} onClick={apply}>{busy ? '등록 중' : `${picked.length}건 사전에 등록`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ErdDialog({ session, items, onClose, onDone }: { session: Session; items: SyncItem[]; onClose: () => void; onDone: () => Promise<void> }) {
  const rows = useMemo(() => items.flatMap((it) => actionsOf(it).filter((a): a is Extract<SyncAction, { target: 'erd' }> => a.target === 'erd').map((a) => ({ key: it.key, a }))), [items]);
  const kinds = useMemo(() => [...new Set(rows.map((r) => r.a.kind))], [rows]);
  const [on, setOn] = useState<Set<string>>(() => new Set(kinds.filter((k) => !DELETE_KINDS.has(k))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ErdApplyResult | null>(null);
  const picked = rows.filter((r) => on.has(r.a.kind));
  const keys = [...new Set(picked.map((r) => r.key))];
  const apply = async () => {
    if (picked.some((r) => DELETE_KINDS.has(r.a.kind)) && !confirm(`삭제 ${picked.filter((r) => DELETE_KINDS.has(r.a.kind)).length}건이 들어 있습니다. 진행할까요?`)) return;
    setBusy(true); setError(null);
    try { setResult(await api.applySyncErd(session.id, keys, [...on])); await onDone(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const undo = async () => {
    if (!result?.run_id) return;
    setBusy(true); setError(null);
    try { const u = await api.undoSyncRun(session.id, result.run_id); setError(u.failed.length ? `되돌리기 ${u.undone}건, 실패 ${u.failed.length}건` : null); setResult(null); await onDone(); onClose(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="sync-erd-title" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
        <h1 id="sync-erd-title">② ERD 반영 미리보기</h1>
        {result ? (
          <>
            <div className="row">
              <span className="pill ok">반영 {result.applied}</span>
              {result.failed.length > 0 && <span className="pill err">실패 {result.failed.length}</span>}
              {result.skipped > 0 && <span className="pill">다음으로 미룸 {result.skipped}</span>}
            </div>
            {result.failed.length > 0 && <ul className="dict-list small">{result.failed.slice(0, 30).map((f, i) => <li key={i}><code>{f.key}</code> {f.action}: {f.error}</li>)}</ul>}
            {result.skipped > 0 && <p className="muted small">한 번에 {MAX_RUN}건까지 반영합니다. 남은 것은 다시 미리보기에서 반영하세요.</p>}
            {error && <p className="banner error" role="alert">{error}</p>}
            <div className="dialog-actions">
              {result.run_id && <button disabled={busy} onClick={undo}>방금 적용한 것 되돌리기</button>}
              <button className="primary" disabled={busy} onClick={onClose}>닫기</button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">지금 판정으로 다시 만들어 반영합니다. 삭제는 기본으로 빠져 있습니다. 한 번에 {MAX_RUN}건까지입니다.</p>
            <div className="row">
              {kinds.map((k) => (
                <button key={k} className={`chip-btn${on.has(k) ? ' on' : ''}${DELETE_KINDS.has(k) ? ' danger' : ''}`} onClick={() => setOn((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>
                  {KIND_LABEL[k]} {rows.filter((r) => r.a.kind === k).length}
                </button>
              ))}
            </div>
            <div className="table-wrap sync-scroll"><table className="dict-table">
              <thead><tr><th>컬럼</th><th>종류</th><th>바꾸기 전 → 후</th></tr></thead>
              <tbody>{picked.slice(0, 300).map((r, i) => (
                <tr key={i}><td className="mono">{r.key}</td><td><span className={`pill ${DELETE_KINDS.has(r.a.kind) ? 'err' : 'accent'}`}>{KIND_LABEL[r.a.kind]}</span></td><td className="mono small">{actionText(r.a)}</td></tr>
              ))}</tbody>
            </table></div>
            {picked.length > 300 && <p className="muted small">외 {picked.length - 300}건</p>}
            {picked.length > MAX_RUN && <p className="banner">{picked.length}건 중 {MAX_RUN}건만 이번에 반영합니다.</p>}
            {error && <p className="banner error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button disabled={busy} onClick={onClose}>닫기</button>
              <button className="primary" disabled={busy || !picked.length} onClick={apply}>{busy ? '반영 중' : `${Math.min(picked.length, MAX_RUN)}건 ERD에 반영`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
