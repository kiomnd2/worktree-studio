import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { insertIntoPrompt, useServerEvents } from '../events';
import type { BaselineStatus, ColumnDraft, DictBaseline, DictDomain, DictFinding, DictGroup, DictIssue, DictKind, DictReport, DictUsage, TermUsage, DictRequest, DictSearch, ErdPayload, Resolution, Session, TermPayload, WordPayload } from '../types';

/**
 * erd-vibe 용어사전 화면. 소스의 컬럼 이름 검사, 사전 관리(단어·용어·도메인 찾기·추가·수정·삭제), Claude 요청 승인을 한 곳에서 한다.
 * 표준 이름은 용어의 약어명(없으면 물리명)이다. ERD 다이어그램은 ErdPage에서 본다.
 */

type Tab = 'check' | 'manage' | 'requests';
/** 사전 관리의 보기: 종류별 목록, 또는 겹치는 용어·단어 */
type ManageView = DictKind | 'overlap';
/** 사전 추가·수정 창에 넣을 값. id가 있으면 수정. */
type Editing = { kind: DictKind; id?: string; values: Record<string, string> };
const ISSUE: Record<DictIssue, { label: string; tone: 'err' | 'warn' | '' }> = {
  variant: { label: '비표준 표기', tone: 'err' },
  unregistered_term: { label: '미등록 용어', tone: 'warn' },
  unknown_word: { label: '미등록 단어', tone: 'warn' },
  domain_mismatch: { label: '도메인 불일치', tone: 'err' },
  not_in_erd: { label: 'ERD에 없음', tone: '' },
  no_term_link: { label: '용어 연결 없음', tone: '' },
};
const VERDICT: Record<Resolution['verdict'], string> = { standard: '표준', variant: '비표준 표기', unregistered_term: '미등록 용어', unknown_word: '미등록 단어' };

function hint(r: Resolution): string {
  if (r.term && r.verdict === 'variant') return `표준 ${r.term.standard} · ${r.term.logical_name}`;
  if (r.term) return `${r.term.logical_name} · 도메인 ${r.term.domain_name ?? '-'} ${r.term.domain_type ?? ''}`;
  if (r.draft) return `${r.draft.words.join(' + ')} → 사전에 없는 용어 "${r.draft.logical_name}" (${r.draft.physical_abbr_name})`;
  if (r.missing.length) return `단어사전에 없는 토큰 ${r.missing.join(', ')}${r.similar.length ? ` · 비슷한 용어 ${r.similar.map((t) => `${t.standard}(${t.logical_name})`).join(', ')}` : ''}`;
  return '';
}

function findingPrompt(fs: DictFinding[]): string {
  const lines = fs.map((f) => {
    const o = f.occurrences[0];
    return `- ${f.name} [${f.issues.map((i) => ISSUE[i].label).join(', ')}] ${hint(f.resolution)}${f.domain ? ` · 도메인 ${f.domain.expected}인데 ${f.domain.actual.join(', ')}` : ''} · ${f.project_name}/${o.file}:${o.line}${f.occurrence_count > 1 ? ` 외 ${f.occurrence_count - 1}곳` : ''}`;
  });
  return `용어 검사에서 용어사전과 맞지 않는 컬럼 이름이 나왔어. dict_lookup으로 표준 이름과 도메인을 확인해서 고치고, 사전에 없는 용어는 dict_request_term으로 등록을 요청해줘.\n${lines.join('\n')}`;
}

export default function DictPage({ session, onBack, onOpenErd }: { session: Session; onBack: () => void; onOpenErd: (table?: string) => void }) {
  const [tab, setTab] = useState<Tab>('check');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [manageQuery, setManageQuery] = useState<{ kind: ManageView; q: string } | null>(null);
  const [pending, setPending] = useState(0);
  const [domains, setDomains] = useState<DictDomain[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reloadCount = useCallback(() => { api.dictRequests(session.id).then((r) => setPending(r.filter((x) => x.status === 'pending').length)).catch(() => {}); }, [session.id]);
  useEffect(reloadCount, [reloadCount]);
  useEffect(() => { api.dictSearch(session.id, '').then((r) => setDomains(r.domains)).catch((e) => setError(e.message)); }, [session.id]);
  useServerEvents((e) => { if (e.type === 'dict.requests' && e.sessionId === session.id) reloadCount(); });

  // 검사 화면의 "용어 등록"은 요청을 거치지 않고 초안을 채운 추가 창을 연다(사용자가 직접 하는 일).
  const register = (r: Resolution) => {
    if (r.draft) setEditing({ kind: 'term', values: { logical_name: r.draft.logical_name, physical_abbr_name: r.draft.physical_abbr_name, physical_name: r.draft.physical_name, domain_name: '', description: '' } });
    else if (r.missing.length) setEditing({ kind: 'word', values: { name: '', abbreviation: r.missing[0], english_name: r.missing[0], definition: '' } });
  };
  const showInManage = (kind: ManageView, q: string) => { setManageQuery({ kind, q }); setTab('manage'); };

  return (
    <main className="main scroll">
      <div className="settings dict">
        <div className="page-head">
          <div>
            <p className="muted small">{session.ticket} · erd-vibe 용어사전</p>
            <h1>용어·도메인 검사</h1>
          </div>
          <div className="row"><button onClick={() => onOpenErd()}>ERD 화면</button><button onClick={onBack}>세션 화면으로</button></div>
        </div>
        <nav className="tabs" role="tablist" aria-label="용어사전 메뉴">
          {([['check', '소스 검사'], ['manage', '사전 관리'], ['requests', '요청']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label}{k === 'requests' && pending > 0 && <span className="panel-menu-count bad">{pending}</span>}
            </button>
          ))}
        </nav>
        {error && <p className="banner error" role="alert">{error}</p>}
        <datalist id="dict-domains">{domains.map((d) => <option key={d.id} value={d.name}>{d.type_for_dbms ?? d.data_type_default ?? ''}</option>)}</datalist>
        {tab === 'check' && <CheckTab session={session} onRegister={register} onOpenErd={onOpenErd} onShowInManage={showInManage} />}
        {tab === 'manage' && <ManageTab key={manageQuery ? `${manageQuery.kind}:${manageQuery.q}` : ''} session={session} initial={manageQuery} onEdit={setEditing} />}
        {tab === 'requests' && <RequestsTab session={session} domains={domains} onOpenErd={onOpenErd} />}
        {editing && <DictEditor session={session} editing={editing} domains={domains} onClose={() => setEditing(null)} />}
      </div>
    </main>
  );
}

type StatusFilter = 'todo' | 'new' | 'hold' | 'accepted' | 'all';
const STATUS_LABEL: Record<BaselineStatus | 'new', string> = { todo: '할 일', hold: '보류', accepted: '허용', new: '새로 생김' };
const GROUP_LABEL: Record<DictGroup['kind'], string> = { word: '미등록 단어', domain: '도메인 불일치', variant: '비표준 표기', term: '미등록 용어', not_in_erd: 'ERD에 없음' };

/** 기준선 대조로 본 위반 하나의 상태. 위반 종류 중 하나라도 새로 생겼으면 새로 생김, 아니면 가장 손볼 일이 많은 쪽 */
function findingStatus(b: DictBaseline | null, f: DictFinding): BaselineStatus | 'new' | null {
  if (!b) return null;
  const ss = f.issues.map((i): BaselineStatus | 'new' => b.status[`${f.name}|${i}`] ?? 'new');
  return ss.includes('new') ? 'new' : ss.includes('todo') ? 'todo' : ss.includes('hold') ? 'hold' : 'accepted';
}

function CheckTab({ session, onRegister, onOpenErd, onShowInManage }: {
  session: Session; onRegister: (r: Resolution) => void; onOpenErd: (table?: string) => void; onShowInManage: (kind: ManageView, q: string) => void;
}) {
  const [scope, setScope] = useState<'changed' | 'all'>('changed');
  const [report, setReport] = useState<DictReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'new' | 'all'>('new');
  const [view, setView] = useState<'cause' | 'name'>(() => (localStorage.getItem('dict.check.view') === 'name' ? 'name' : 'cause'));
  const [status, setStatus] = useState<StatusFilter>('todo');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showSingles, setShowSingles] = useState(false);
  const [excludes, setExcludes] = useState<string[] | null>(null);
  const [editExcludes, setEditExcludes] = useState<string | null>(null);
  const run = useCallback(async (sc: 'changed' | 'all') => {
    setBusy(true); setError(null);
    try { setReport(await api.dictCheck(session.id, sc)); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [session.id]);
  useEffect(() => { run('changed'); }, [run]);
  useEffect(() => { api.dictExcludes(session.id).then(setExcludes).catch(() => setExcludes([])); }, [session.id]);
  useEffect(() => { localStorage.setItem('dict.check.view', view); }, [view]);
  const [stale, setStale] = useState(false);
  useEffect(() => setStale(false), [report]);
  useServerEvents((e) => { if (e.type === 'dict.updated' || e.type === 'erd.updated') setStale(true); });
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); setBusy(false); return; }
    await run(scope);
  };
  const ignore = async (names: string[]) => {
    const reason = prompt(names.length === 1 ? `${names[0]}을(를) 이 워크스페이스의 용어 검사에서 뺄까요? 이유를 적어 주세요.` : `이름 ${names.length}개를 이 워크스페이스의 용어 검사에서 뺄까요? 이유를 적어 주세요.`, '');
    if (reason === null) return;
    await act(async () => { for (const n of names) await api.setDictIgnore(session.id, n, reason); });
  };
  const setState = async (keys: { name: string; issue: string }[], st: BaselineStatus) => {
    const note = st === 'todo' ? '' : prompt(`${keys.length}건을 ${STATUS_LABEL[st]}(으)로 둡니다. 이유를 적어 주세요.`, '');
    if (note === null || (st !== 'todo' && !note.trim())) return;
    await act(() => api.setBaselineStatus(session.id, keys, st, note));
  };
  const snapshot = async () => {
    if (report?.baseline && !confirm('지금 위반을 기준선에 더합니다. 이미 있는 항목의 상태와 메모는 그대로 둡니다.')) return;
    setBusy(true); setError(null);
    try { setReport(await api.dictBaseline(session.id)); setStatus('todo'); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const clearBaseline = async () => {
    if (!confirm('기준선을 지울까요? 상태와 메모도 함께 지워집니다.')) return;
    await act(() => api.clearDictBaseline(session.id));
  };

  const baseline = report?.baseline ?? null;
  const blocking = report?.findings.filter((f) => f.blocking) ?? [];
  const shown = !report ? [] : report.findings.filter((f) => {
    if (filter === 'new' && !f.added) return false;
    if (!baseline || status === 'all') return true;
    const st = findingStatus(baseline, f);
    return status === 'todo' ? st === 'todo' || st === 'new' : st === status;
  });
  const byName = new Map(shown.map((f) => [f.name, f]));
  const groups = (report?.groups ?? [])
    .map((g) => ({ ...g, names: g.names.filter((n) => byName.has(n)) }))
    .filter((g) => g.names.length > 0);
  const groupFindings = (g: DictGroup) => g.names.map((n) => byName.get(n)!);
  const prompt30 = (fs: DictFinding[]) => insertIntoPrompt(findingPrompt(fs.slice(0, 30)) + (fs.length > 30 ? `\n(외 ${fs.length - 30}개는 위를 고친 뒤 다시 검사해서 볼게)` : ''));
  const toggleOpen = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const item = (f: DictFinding) => (
    <li key={`${f.project_name}:${f.name}`} className={f.blocking ? 'blocking' : ''}>
      <div className="row">
        <code className="dict-name">{f.name}</code>
        {f.issues.map((i) => <span key={i} className={`pill ${ISSUE[i].tone}`}>{ISSUE[i].label}</span>)}
        {f.blocking && <span className="pill err">PR 막힘</span>}
        {(() => { const st = findingStatus(baseline, f); return st && st !== 'todo' ? <span className={`pill ${st === 'new' ? 'err' : st === 'hold' ? 'warn' : ''}`} title={f.issues.map((i) => baseline?.notes[`${f.name}|${i}`]).filter(Boolean).join(' · ')}>{STATUS_LABEL[st]}</span> : null; })()}
        <span className="spacer" />
        <button className="small-btn" onClick={() => insertIntoPrompt(findingPrompt([f]))}>프롬프트에 넣기</button>
        {(f.resolution.draft || f.resolution.missing.length > 0) && (
          <button className="small-btn" onClick={() => onRegister(f.resolution)}>{f.resolution.draft ? '용어 등록' : '단어 등록'}</button>
        )}
        <button className="small-btn" onClick={() => ignore([f.name])}>무시</button>
      </div>
      <p className="small">{hint(f.resolution)}{f.domain && <> · 도메인 <code>{f.domain.expected}</code>인데 <code>{f.domain.actual.join(', ')}</code></>}</p>
      <ul className="dict-occ">
        {f.occurrences.slice(0, 5).map((o, i) => (
          <li key={i} className="small">
            <span className="mono">{f.project_name}/{o.file}:{o.line}</span>{o.added && <span className="pill accent">추가</span>}
            {o.type && <span className="muted"> {o.type}</span>}
            <span className="muted mono"> {o.text}</span>
          </li>
        ))}
        {f.occurrence_count > 5 && <li className="muted small">외 {f.occurrence_count - 5}곳</li>}
      </ul>
    </li>
  );

  return (
    <>
      <div className="card">
        <div className="row">
          <div className="seg" role="group" aria-label="검사 범위">
            <button className={`chip-btn${scope === 'changed' ? ' on' : ''}`} onClick={() => { setScope('changed'); run('changed'); }}>이번 변경</button>
            <button className={`chip-btn${scope === 'all' ? ' on' : ''}`} onClick={() => { setScope('all'); setFilter('all'); run('all'); }}>워크트리 전체</button>
          </div>
          <button disabled={busy} onClick={() => run(scope)}>{busy ? <><span className="spinner" aria-hidden="true" /> 검사 중</> : '다시 검사'}</button>
          <button onClick={() => setEditExcludes('')}>제외 경로{excludes && excludes.length > 0 ? ` ${excludes.length}` : ''}</button>
          <span className="spacer" />
          {blocking.length > 0 && <button className="primary" onClick={() => insertIntoPrompt(findingPrompt(blocking))}>새 위반 {blocking.length}건 Claude에게 고치게 하기</button>}
        </div>
        <p className="muted small">
          MyBatis 매퍼의 SQL·resultMap, .sql DDL, Liquibase, JPA @Column의 컬럼 이름을 용어사전과 연결한 ERD에 맞대어 봅니다.
          이번 변경에서 추가한 줄의 위반(ERD에 없음 제외)은 PR 전 검사에서 막힙니다.
        </p>
        {report && (
          <div className="row">
            <span className={`pill ${blocking.length ? 'err' : 'ok'}`}>새 위반 {blocking.length}</span>
            <span className="pill">전체 {report.findings.length}</span>
            {report.mixed.length > 0 && <span className="pill warn">혼용 {report.mixed.length}</span>}
            <span className="pill">파일 {report.scanned_files}</span>
            {report.excluded_files > 0 && <span className="pill">제외 파일 {report.excluded_files}</span>}
            <span className="pill accent">{report.erd_project ? `ERD ${report.erd_project.name} · ${report.dbms}` : `ERD 연결 없음 · ${report.dbms}`}</span>
            {report.ignored > 0 && <span className="muted small">무시 {report.ignored}곳</span>}
          </div>
        )}
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {stale && <p className="banner">사전이나 ERD가 바뀌었습니다. <button className="small-btn" onClick={() => run(scope)}>다시 검사</button></p>}
      {report?.error && <p className="banner error">ERD를 받지 못해 사전만으로 검사했습니다: {report.error}</p>}
      {report && !report.erd_project && <p className="banner">설정 &gt; erd-vibe 용어사전에서 워크스페이스에 ERD를 연결하면 ERD에 없는 컬럼과 ERD 쪽 위반도 봅니다.</p>}

      {report && report.scope === 'all' && (
        <section className="card dict-baseline">
          {!baseline ? (
            <div className="row">
              <span className="small">기존 위반이 많으면 지금 상태를 기준선으로 찍어 두고, 남은 수와 새로 생긴 것만 따라가세요.</span>
              <span className="spacer" />
              <button className="primary" disabled={busy || report.findings.length === 0} onClick={snapshot}>지금 위반 {report.findings.length}건을 기준선으로 찍기</button>
            </div>
          ) : (
            <div className="row">
              <b>기준선</b><span className="muted small">{baseline.created_at.slice(0, 10)} · {baseline.total}건</span>
              <div className="dict-progress" title={`해결 ${baseline.resolved} / ${baseline.total}`}><i style={{ width: `${baseline.total ? (baseline.resolved / baseline.total) * 100 : 0}%` }} /></div>
              <span className="pill ok">해결 {baseline.resolved}</span>
              <span className="pill">남음 {baseline.remaining}</span>
              {baseline.new_count > 0 && <span className="pill err">새로 생김 {baseline.new_count}</span>}
              {baseline.hold > 0 && <span className="pill warn">보류 {baseline.hold}</span>}
              {baseline.accepted > 0 && <span className="pill">허용 {baseline.accepted}</span>}
              {baseline.remaining === 0 && <span className="pill ok">기준선 정리 완료</span>}
              <span className="spacer" />
              <button className="small-btn" disabled={busy} onClick={snapshot}>기준선 다시 찍기</button>
              <button className="small-btn" disabled={busy} onClick={clearBaseline}>지우기</button>
            </div>
          )}
          <p className="muted small">해결은 다시 검사했을 때 안 나온 것(고침·무시·제외 경로 포함)입니다. 기준선은 정리용이고 PR 막힘에는 영향이 없습니다.</p>
        </section>
      )}

      {report && report.mixed.length > 0 && (
        <section className="card">
          <h2>같은 용어를 여러 표기로 씀</h2>
          <ul className="dict-list">
            {report.mixed.map((m) => (
              <li key={m.logical_name}>
                <b>{m.logical_name}</b> → <code>{m.standard}</code>로 통일 ·{' '}
                {m.spellings.map((s) => <span key={s.name} className={`pill ${s.standard ? 'ok' : 'err'}`}>{s.name} ×{s.count}</span>)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report && (
        <section className="card">
          <div className="block-head">
            <h2>소스 위반 <span className="muted small">{shown.length}건{view === 'cause' ? ` · 묶음 ${groups.length}` : ''}</span></h2>
            <div className="row">
              <div className="seg" role="group" aria-label="보기 방식">
                <button className={`chip-btn${view === 'cause' ? ' on' : ''}`} onClick={() => setView('cause')}>원인별</button>
                <button className={`chip-btn${view === 'name' ? ' on' : ''}`} onClick={() => setView('name')}>이름별</button>
              </div>
              <div className="seg" role="group" aria-label="보기">
                <button className={`chip-btn${filter === 'new' ? ' on' : ''}`} onClick={() => setFilter('new')}>이번 변경에 나온 것</button>
                <button className={`chip-btn${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>기존 코드 포함</button>
              </div>
              {baseline && (
                <div className="seg" role="group" aria-label="기준선 상태">
                  {(['todo', 'new', 'hold', 'accepted', 'all'] as StatusFilter[]).map((k) => (
                    <button key={k} className={`chip-btn${status === k ? ' on' : ''}`} onClick={() => setStatus(k)}>{k === 'all' ? '전체' : STATUS_LABEL[k]}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {shown.length === 0 ? <p className="muted">위반이 없습니다.</p> : view === 'name' ? (
            <ul className="dict-findings">{shown.map(item)}</ul>
          ) : (
            <ul className="dict-groups">
              {/* 이름 하나뿐인 묶음은 이름별과 다를 게 없어 뒤로 접어 둔다. 미등록 용어처럼 원래 하나로 묶인 것은 그대로 */}
              {groups.filter((g) => showSingles || g.names.length > 1 || g.kind === 'term' || g.kind === 'not_in_erd').map((g) => {
                const fs = groupFindings(g);
                const occ = fs.reduce((n, f) => n + f.occurrence_count, 0);
                const keys = g.names.map((name) => ({ name, issue: g.issue }));
                const isOpen = open.has(g.key);
                return (
                  <li key={g.key} className={fs.some((f) => f.blocking) ? 'blocking' : ''}>
                    <div className="row">
                      <span className={`pill ${ISSUE[g.issue].tone}`}>{GROUP_LABEL[g.kind]}</span>
                      {g.title && <code className="dict-name">{g.title}</code>}
                      {g.detail && <span className="small">{g.detail}</span>}
                      <span className="muted small">이름 {g.names.length}개 · {occ}곳 · {g.names.slice(0, 3).join(', ')}{g.names.length > 3 ? ' …' : ''}</span>
                      <span className="spacer" />
                      {g.kind === 'word' && <button className="small-btn" onClick={() => onRegister({ ...fs[0].resolution, draft: null, missing: [g.title] })}>{g.title} 단어 등록</button>}
                      {g.kind === 'variant' && <button className="small-btn" onClick={() => onShowInManage('term', g.title)}>용어 보기</button>}
                      {baseline && (
                        <select className="small-select" value="" aria-label="상태 바꾸기" onChange={(e) => { if (e.target.value) setState(keys, e.target.value as BaselineStatus); }}>
                          <option value="">상태 ▾</option>
                          {(['todo', 'hold', 'accepted'] as BaselineStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select>
                      )}
                      <button className="small-btn" onClick={() => ignore(g.names)}>묶음 무시</button>
                      <button className="small-btn" onClick={() => prompt30(fs)}>Claude에게</button>
                      <button className="small-btn" aria-expanded={isOpen} onClick={() => toggleOpen(g.key)}>{isOpen ? '접기' : '펼치기'}</button>
                    </div>
                    {isOpen && <ul className="dict-findings">{fs.map(item)}</ul>}
                  </li>
                );
              })}
              {!showSingles && groups.some((g) => g.names.length === 1 && g.kind !== 'term' && g.kind !== 'not_in_erd') && (
                <li><button className="small-btn" onClick={() => setShowSingles(true)}>이름 하나짜리 묶음 {groups.filter((g) => g.names.length === 1 && g.kind !== 'term' && g.kind !== 'not_in_erd').length}개 더 보기</button></li>
              )}
            </ul>
          )}
        </section>
      )}

      {report && view === 'cause' && report.hot_files.length > 0 && filter === 'all' && (
        <section className="card">
          <h2>위반이 많이 나온 파일</h2>
          <p className="muted small">용어사전과 상관없는 프로젝트·문서라면 검사에서 빼세요.</p>
          <ul className="dict-list">{report.hot_files.map((h) => (
            <li key={`${h.project_name}/${h.file}`}>
              <span className="mono">{h.project_name}/{h.file}</span> <span className="muted small">이름 {h.names}개 · {h.occurrences}곳</span>{' '}
              <button className="small-btn" onClick={() => setEditExcludes(h.file.includes('/') ? `${h.file.slice(0, h.file.lastIndexOf('/'))}/**` : h.file)}>이 경로 제외</button>
            </li>
          ))}</ul>
        </section>
      )}

      {report && report.erd_findings.length > 0 && (
        <section className="card">
          <h2>ERD 컬럼 위반 <span className="muted small">{report.erd_findings.length}건</span></h2>
          <ErdFindingTable findings={report.erd_findings} onOpenErd={onOpenErd} />
        </section>
      )}
      {report && report.dictionary_duplicates.length > 0 && (
        <p className="banner">
          사전에서 논리명이 겹치는 용어 {report.dictionary_duplicates.length}건이 있습니다. 소스가 어느 쪽을 써도 맞게 보입니다.{' '}
          <button className="small-btn" onClick={() => onShowInManage('overlap', '')}>사전 관리 › 겹침에서 보기</button>
        </p>
      )}
      {editExcludes !== null && excludes && (
        <ExcludesDialog initial={excludes} draft={editExcludes} onClose={() => setEditExcludes(null)}
          onSave={async (ps) => { const saved = await api.setDictExcludes(session.id, ps); setExcludes(saved); setEditExcludes(null); await run(scope); }} />
      )}
    </>
  );
}

function ExcludesDialog({ initial, draft, onClose, onSave }: { initial: string[]; draft: string; onClose: () => void; onSave: (patterns: string[]) => Promise<void> }) {
  const [list, setList] = useState(initial);
  const [input, setInput] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const p = input.trim();
    if (!p) return;
    if (list.includes(p)) { setError('이미 있는 패턴입니다.'); return; }
    setList((l) => [...l, p]); setInput(''); setError(null);
  };
  const save = async () => {
    const all = input.trim() && !list.includes(input.trim()) ? [...list, input.trim()] : list;
    setBusy(true); setError(null);
    try { await onSave(all); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dict-excludes-title" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
        <h1 id="dict-excludes-title">검사에서 뺄 경로</h1>
        <p className="muted small">워크스페이스 공통입니다. 앱 안의 경로나 "앱이름/경로"에 맞추며, <code>**</code>는 여러 폴더, <code>*</code>는 이름 일부입니다. 예: <code>erd-vibe/**</code>, <code>**/docs/**</code></p>
        {list.length === 0 ? <p className="muted">뺀 경로가 없습니다.</p> : (
          <ul className="dict-list">{list.map((p) => (
            <li key={p}><code>{p}</code> <button className="small-btn" onClick={() => setList((l) => l.filter((x) => x !== p))}>빼기</button></li>
          ))}</ul>
        )}
        <div className="row">
          <input className="mono grow" value={input} placeholder="예: infra-vibe/**" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} autoFocus aria-label="제외 패턴" />
          <button onClick={add}>추가</button>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button disabled={busy} onClick={onClose}>닫기</button>
          <button className="primary" disabled={busy} onClick={save}>{busy ? '저장 중' : '저장하고 다시 검사'}</button>
        </div>
      </div>
    </div>
  );
}

function ErdFindingTable({ findings, onOpenErd }: { findings: DictReport['erd_findings']; onOpenErd: (table?: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="dict-table">
        <thead><tr><th>테이블</th><th>컬럼</th><th>논리명</th><th>타입</th><th>판정</th><th>제안</th><th /></tr></thead>
        <tbody>
          {findings.map((e, idx) => (
            // ERD에 같은 이름의 테이블이 둘 있을 수 있어 순번을 붙인다.
            <tr key={`${e.table}.${e.column}.${idx}`}>
              <td className="mono">{e.table}</td><td className="mono">{e.column}</td><td>{e.logical_name}</td><td className="mono nowrap">{e.type ?? ''}</td>
              <td>{e.issues.map((i) => <span key={i} className={`pill ${ISSUE[i].tone}`}>{ISSUE[i].label}</span>)}</td>
              <td className="small">{hint(e.resolution)}</td>
              <td><button className="small-btn" onClick={() => onOpenErd(e.table)}>ERD에서 보기</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KIND_LABEL: Record<DictKind, string> = { term: '용어', word: '단어', domain: '도메인' };
const FIELDS: Record<DictKind, { key: string; label: string; placeholder?: string; required?: boolean; mono?: boolean; list?: string }[]> = {
  term: [
    { key: 'logical_name', label: '논리명', placeholder: '거래취소일자', required: true },
    { key: 'physical_abbr_name', label: '약어명 (표준 이름)', placeholder: 'TR_CNCL_DT', mono: true },
    { key: 'physical_name', label: '물리명', placeholder: 'TRADE_CANCEL_DATE', required: true, mono: true },
    { key: 'domain_name', label: '도메인', placeholder: '도메인사전에서 고르기', list: 'dict-domains' },
    { key: 'description', label: '설명', required: true },
  ],
  word: [
    { key: 'name', label: '단어', placeholder: '취소', required: true },
    { key: 'abbreviation', label: '약어', placeholder: 'CNCL', mono: true },
    { key: 'english_name', label: '영문명', placeholder: 'CANCEL', required: true, mono: true },
    { key: 'definition', label: '정의', required: true },
  ],
  domain: [
    { key: 'name', label: '도메인명', placeholder: '일자', required: true },
    { key: 'data_type_default', label: '기본 타입', placeholder: 'VARCHAR(8)', required: true, mono: true },
    { key: 'data_type_oracle', label: 'Oracle 타입', placeholder: 'VARCHAR2(8)', mono: true },
    { key: 'data_type_mysql', label: 'MySQL 타입', mono: true },
    { key: 'data_type_postgresql', label: 'PostgreSQL 타입', mono: true },
    { key: 'description', label: '설명' },
  ],
};
const UPPER = new Set(['physical_name', 'physical_abbr_name', 'english_name', 'abbreviation']);

function ManageTab({ session, initial, onEdit }: { session: Session; initial: { kind: ManageView; q: string } | null; onEdit: (e: Editing) => void }) {
  const [view, setView] = useState<ManageView>(initial?.kind ?? 'term');
  const kind: DictKind = view === 'overlap' ? 'term' : view;
  // 소스·ERD 사용량. 소스를 다 훑어야 해서 용어·겹침을 볼 때만 받는다.
  const [usage, setUsage] = useState<DictUsage | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [useFilter, setUseFilter] = useState<'all' | 'used' | 'unused'>('all');
  const [q, setQ] = useState(initial?.q ?? '');
  const [limit, setLimit] = useState(50);
  const [res, setRes] = useState<DictSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // 쓰는 것/안 쓰는 것으로 거르면 화면에서 거르므로 전부 받는다.
    const n = useFilter !== 'all' && kind === 'term' ? 2000 : q.trim() ? limit : Math.max(limit, 100);
    const t = setTimeout(() => { api.dictSearch(session.id, q, n).then((r) => { setRes(r); setError(null); }).catch((e) => setError(e.message)); }, 250);
    return () => clearTimeout(t);
  }, [q, limit, session.id, tick, useFilter, kind]);
  useEffect(() => { setPicked(new Set()); setLimit(50); }, [kind, q]);
  const loadUsage = useCallback(async (refresh: boolean) => {
    setUsageBusy(true); setUsageError(null);
    try { setUsage(await api.dictUsage(session.id, refresh)); } catch (e) { setUsageError((e as Error).message); }
    setUsageBusy(false);
  }, [session.id]);
  const needUsage = view === 'overlap' || view === 'term';
  useEffect(() => { if (needUsage) loadUsage(false); }, [needUsage, loadUsage, tick]);
  useServerEvents((e) => { if (e.type === 'dict.updated') setTick((t) => t + 1); });
  const refresh = async () => { setBusy(true); try { await api.refreshDictionary(); setTick((t) => t + 1); } catch (e) { setError((e as Error).message); } setBusy(false); };
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const removePicked = async () => {
    if (!res) return;
    const used = kind === 'term' ? [...picked].reduce((n, id) => n + (res.erd_usage[id] ?? 0), 0)
      : kind === 'domain' ? res.domains.filter((d) => picked.has(d.id)).reduce((n, d) => n + (res.domain_usage[d.name] ?? 0), 0) : 0;
    const warn = used ? `\n${kind === 'term' ? `ERD 컬럼 ${used}개가 이 용어를 씁니다.` : `용어 ${used}개가 이 도메인을 씁니다.`}` : '';
    if (!confirm(`${KIND_LABEL[kind]} ${picked.size}건을 erd-vibe 공유 사전에서 지울까요?${warn}`)) return;
    setBusy(true);
    try { await api.dictDelete(kind, [...picked]); setPicked(new Set()); setTick((t) => t + 1); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const r = res?.resolution;
  const terms = !res ? [] : useFilter === 'all' || !usage ? res.terms : res.terms.filter((t) => (termUsed(usage.terms[t.id]) > 0) === (useFilter === 'used'));
  const rows = !res ? [] : kind === 'term' ? terms : kind === 'word' ? res.words : res.domains;
  const total = !res ? 0 : kind === 'term' && useFilter !== 'all' && usage ? terms.length : res.total[kind === 'term' ? 'terms' : kind === 'word' ? 'words' : 'domains'];
  const check = (id: string) => <td><input type="checkbox" checked={picked.has(id)} onChange={() => toggle(id)} aria-label="선택" /></td>;
  return (
    <>
      <div className="card">
        <div className="row">
          <div className="seg" role="group" aria-label="사전 종류">
            {(['term', 'word', 'domain'] as DictKind[]).map((k) => (
              <button key={k} className={`chip-btn${view === k ? ' on' : ''}`} onClick={() => setView(k)}>
                {KIND_LABEL[k]}{res && <span className="muted"> {(k === 'term' ? res.total.terms : k === 'word' ? res.total.words : res.total.domains).toLocaleString()}</span>}
              </button>
            ))}
            <button className={`chip-btn${view === 'overlap' ? ' on' : ''}`} onClick={() => setView('overlap')}>
              겹침{usage && <span className="muted"> {usage.term_overlaps.length + usage.word_overlaps.length}</span>}
            </button>
          </div>
          <input className="dict-search grow" placeholder="논리명(거래일자), 물리명(TR_DT, TRADE_DATE), camelCase(trDt), 단어(거래)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="사전 찾기" />
          <button disabled={busy} onClick={refresh} title="캐시를 비우고 erd-vibe에서 다시 받기">↻</button>
          {view !== 'overlap' && <button className="primary" onClick={() => onEdit({ kind, values: {} })}>＋ {KIND_LABEL[kind]} 추가</button>}
        </div>
        {needUsage && (
          <div className="row muted small">
            {usageBusy ? <><span className="spinner" aria-hidden="true" /> 소스를 세는 중</> : usage ? <>사용량: 소스 {new Date(usage.scanned_at).toLocaleString()}에 셈 · {usage.erd_project ? `ERD ${usage.erd_project.name}` : 'ERD 연결 없음'}</> : null}
            <button className="small-btn" disabled={usageBusy} onClick={() => loadUsage(true)}>다시 세기</button>
          </div>
        )}
        {view !== 'overlap' && r && (
          <div className="row dict-verdict">
            <code className="dict-name">{r.name}</code>
            <span className={`pill ${r.verdict === 'standard' ? 'ok' : r.verdict === 'variant' ? 'err' : 'warn'}`}>{VERDICT[r.verdict]}</span>
            <span className="small">{hint(r)}</span>
            {r.tokens.length > 1 && <span className="muted small">({r.tokens.map((t) => `${t.token}=${t.word ?? '?'}`).join(' · ')})</span>}
            <span className="spacer" />
            {r.draft && <button className="small-btn" onClick={() => onEdit({ kind: 'term', values: { logical_name: r.draft!.logical_name, physical_abbr_name: r.draft!.physical_abbr_name, physical_name: r.draft!.physical_name } })}>이 이름으로 용어 추가</button>}
            {!r.draft && r.missing.length > 0 && <button className="small-btn" onClick={() => onEdit({ kind: 'word', values: { abbreviation: r.missing[0], english_name: r.missing[0] } })}>{r.missing[0]} 단어 추가</button>}
          </div>
        )}
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {usageError && needUsage && <p className="banner error" role="alert">소스를 세지 못했습니다: {usageError} <button className="small-btn" onClick={() => loadUsage(true)}>다시 세기</button></p>}
      {view === 'overlap' && <OverlapView usage={usage} q={q} onEdit={onEdit} onDeleted={() => { setTick((t) => t + 1); }} onError={setError} />}
      {view !== 'overlap' && res && (
        <section className="card">
          <div className="block-head">
            <h2>{KIND_LABEL[kind]} <span className="muted small">{total.toLocaleString()}건{total > rows.length ? ` 중 ${rows.length}` : ''} · {res.dbms} 타입</span></h2>
            {kind === 'term' && (
              <div className="seg" role="group" aria-label="사용 여부">
                {([['all', '전체'], ['used', '쓰는 것'], ['unused', '안 쓰는 것']] as const).map(([k, label]) => (
                  <button key={k} className={`chip-btn${useFilter === k ? ' on' : ''}`} disabled={!usage && k !== 'all'} onClick={() => setUseFilter(k)}>{label}</button>
                ))}
              </div>
            )}
            {picked.size > 0 && <button className="danger" disabled={busy} onClick={removePicked}>선택 삭제 ({picked.size})</button>}
          </div>
          <div className="table-wrap"><table className="dict-table">
            {kind === 'term' && <>
              <thead><tr><th /><th>논리명</th><th>표준(약어명)</th><th>물리명</th><th>도메인</th><th>타입</th><th>ERD 사용</th><th>소스 사용</th><th>설명</th><th /></tr></thead>
              <tbody>{terms.map((t) => (
                <tr key={t.id}>{check(t.id)}<td>{t.logical_name}</td><td className="mono"><b>{t.standard}</b></td><td className="mono">{t.physical_name}</td><td>{t.domain_name ?? ''}</td><td className="mono nowrap">{t.domain_type ?? ''}</td>
                  <td>{res.erd_usage[t.id] ?? 0}</td><td>{usage?.terms[t.id]?.source ?? '–'}</td><td className="small">{t.description}</td>
                  <td><button className="small-btn" onClick={() => onEdit({ kind: 'term', id: t.id, values: { logical_name: t.logical_name, physical_abbr_name: t.physical_abbr_name ?? '', physical_name: t.physical_name, domain_name: t.domain_name ?? '', description: t.description } })}>수정</button></td></tr>
              ))}</tbody>
            </>}
            {kind === 'word' && <>
              <thead><tr><th /><th>단어</th><th>약어</th><th>영문명</th><th>정의</th><th /></tr></thead>
              <tbody>{res.words.map((w) => (
                <tr key={w.id}>{check(w.id)}<td>{w.name}</td><td className="mono">{w.abbreviation ?? ''}</td><td className="mono">{w.english_name}</td><td className="small">{w.definition}</td>
                  <td><button className="small-btn" onClick={() => onEdit({ kind: 'word', id: w.id, values: { name: w.name, abbreviation: w.abbreviation ?? '', english_name: w.english_name, definition: w.definition } })}>수정</button></td></tr>
              ))}</tbody>
            </>}
            {kind === 'domain' && <>
              <thead><tr><th /><th>도메인명</th><th>기본 타입</th><th>Oracle</th><th>MySQL</th><th>PostgreSQL</th><th>{res.dbms}</th><th>쓰는 용어</th><th>설명</th><th /></tr></thead>
              <tbody>{res.domains.map((d) => (
                <tr key={d.id}>{check(d.id)}<td>{d.name}</td><td className="mono nowrap">{d.data_type_default ?? ''}</td><td className="mono nowrap">{d.data_type_oracle ?? ''}</td><td className="mono nowrap">{d.data_type_mysql ?? ''}</td><td className="mono nowrap">{d.data_type_postgresql ?? ''}</td>
                  <td className="mono">{d.type_for_dbms ?? ''}</td><td>{res.domain_usage[d.name] ?? 0}</td><td className="small">{d.description ?? ''}</td>
                  <td><button className="small-btn" onClick={() => onEdit({ kind: 'domain', id: d.id, values: Object.fromEntries(FIELDS.domain.map((f) => [f.key, String((d as Record<string, unknown>)[f.key] ?? '')])) })}>수정</button></td></tr>
              ))}</tbody>
            </>}
          </table></div>
          {rows.length === 0 && <p className="muted">찾은 {KIND_LABEL[kind]}이(가) 없습니다.</p>}
          {kind !== 'domain' && total > rows.length && <div className="row"><button onClick={() => setLimit((l) => l + 50)}>50건 더 보기</button></div>}
        </section>
      )}
    </>
  );
}

/** 단어사전으로 논리명을 풀어 약어명·물리명을 추천한다. 긴 단어부터 맞춘다. 다 못 풀면 null. */
/** 소스·ERD 어디서든 쓰이는 정도. 0이면 안 씀 */
const termUsed = (u: TermUsage | undefined) => (u ? u.source + u.erd_link + u.erd_name : 0);

type OverlapFilter = 'all' | 'one' | 'both' | 'none';

/** 논리명이 같은 용어, 약어가 같은 단어를 실제 사용량과 함께 보여 주고 안 쓰는 쪽을 정리하게 한다. */
function OverlapView({ usage, q, onEdit, onDeleted, onError }: {
  usage: DictUsage | null; q: string; onEdit: (e: Editing) => void; onDeleted: () => void; onError: (m: string) => void;
}) {
  const [filter, setFilter] = useState<OverlapFilter>('all');
  const [busy, setBusy] = useState(false);
  if (!usage) return null;
  const qs = q.replace(/\s+/g, '').toUpperCase();
  const hit = (...v: (string | null | undefined)[]) => !qs || v.some((x) => (x ?? '').replace(/\s+/g, '').toUpperCase().includes(qs));
  const groups = usage.term_overlaps
    .filter((g) => hit(g.logical_name, ...g.terms.flatMap((t) => [t.standard, t.physical_name])))
    .filter((g) => {
      const n = g.terms.filter((t) => termUsed(t.usage) > 0).length;
      return filter === 'all' || (filter === 'none' ? n === 0 : filter === 'both' ? n > 1 : n === 1);
    });
  const words = usage.word_overlaps.filter((w) => hit(w.abbreviation, ...w.words.map((x) => x.name)));
  const remove = async (t: DictUsage['term_overlaps'][number]['terms'][number]) => {
    const n = termUsed(t.usage);
    const msg = n
      ? `${t.standard}(${t.logical_name})는 소스 ${t.usage.source}곳 · ERD 연결 ${t.usage.erd_link}개 · ERD 같은 이름 ${t.usage.erd_name}개에서 씁니다.\n그래도 erd-vibe 공유 사전에서 지울까요?`
      : `${t.standard}(${t.logical_name})는 소스·ERD 어디서도 쓰지 않습니다. erd-vibe 공유 사전에서 지울까요?`;
    if (!confirm(msg)) return;
    setBusy(true);
    try { await api.dictDelete('term', [t.id]); onDeleted(); } catch (e) { onError((e as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <section className="card">
        <div className="block-head">
          <h2>논리명이 겹치는 용어 <span className="muted small">{usage.term_overlaps.length}건</span></h2>
          <div className="seg" role="group" aria-label="겹침 거르기">
            {([['all', '전체'], ['one', '한쪽만 씀'], ['both', '둘 다 씀'], ['none', '둘 다 안 씀']] as [OverlapFilter, string][]).map(([k, label]) => (
              <button key={k} className={`chip-btn${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
        </div>
        <p className="muted small">같은 논리명에 표준 이름이 여럿이면 소스가 어느 쪽을 써도 맞게 보입니다. 한쪽만 쓰면 안 쓰는 쪽을 지우고, 둘 다 쓰면 소스를 하나로 통일한 뒤 지우세요.</p>
        {groups.length === 0 ? <p className="muted">겹치는 용어가 없습니다.</p> : (
          <div className="table-wrap"><table className="dict-table">
            <thead><tr><th>논리명</th><th>표준(약어명)</th><th>물리명</th><th>도메인</th><th>소스</th><th>ERD 연결</th><th>ERD 같은 이름</th><th>판정</th><th /></tr></thead>
            <tbody>{groups.map((g) => g.terms.map((t, i) => {
              const n = termUsed(t.usage);
              const keep = i === 0 && n > 0;
              return (
                <tr key={t.id} className={i === 0 ? 'group-first' : ''}>
                  {i === 0 && <td rowSpan={g.terms.length}><b>{g.logical_name}</b></td>}
                  <td className="mono"><b>{t.standard}</b></td><td className="mono">{t.physical_name}</td><td>{t.domain_name ?? ''}</td>
                  <td>{t.usage.source ? `${t.usage.source}곳 · ${t.usage.files}파일` : 0}</td>
                  <td>{usage.erd_project ? t.usage.erd_link : '–'}</td><td>{usage.erd_project ? t.usage.erd_name : '–'}</td>
                  <td>{n > 0 ? <span className="pill ok">사용 중</span> : <span className="pill">안 씀</span>}{keep && <span className="pill accent">남길 후보</span>}</td>
                  <td className="nowrap">
                    <button className="small-btn" onClick={() => onEdit({ kind: 'term', id: t.id, values: { logical_name: t.logical_name, physical_abbr_name: t.physical_abbr_name ?? '', physical_name: t.physical_name, domain_name: t.domain_name ?? '', description: t.description } })}>수정</button>
                    {g.terms.length > 1 && <button className="small-btn danger" disabled={busy} onClick={() => remove(t)}>삭제</button>}
                  </td>
                </tr>
              );
            }))}</tbody>
          </table></div>
        )}
      </section>
      <section className="card">
        <h2>약어가 겹치는 단어 <span className="muted small">{usage.word_overlaps.length}건</span></h2>
        <p className="muted small">같은 약어가 뜻이 다른 단어에 쓰였습니다. 소스 이름만으로는 어느 뜻인지 알 수 없어, 그 약어가 들어간 이름을 보고 사람이 고릅니다.</p>
        {words.length === 0 ? <p className="muted">겹치는 단어가 없습니다.</p> : (
          <div className="table-wrap"><table className="dict-table">
            <thead><tr><th>약어</th><th>단어</th><th>영문명</th><th>정의</th><th>이 약어가 들어간 소스 이름</th><th /></tr></thead>
            <tbody>{words.map((g) => g.words.map((w, i) => (
              <tr key={`${g.abbreviation}:${w.id}`} className={i === 0 ? 'group-first' : ''}>
                {i === 0 && <td rowSpan={g.words.length} className="mono"><b>{g.abbreviation}</b></td>}
                <td>{w.name}</td><td className="mono">{w.english_name}</td><td className="small">{w.definition}</td>
                {i === 0 && <td rowSpan={g.words.length} className="small">{g.examples.length ? g.examples.map((e) => <span key={e.name} className="mono">{e.name}({e.count}) </span>) : <span className="muted">소스에 없음</span>}</td>}
                <td><button className="small-btn" onClick={() => onEdit({ kind: 'word', id: w.id, values: { name: w.name, abbreviation: w.abbreviation ?? '', english_name: w.english_name, definition: w.definition } })}>수정</button></td>
              </tr>
            )))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}

function suggestFromWords(logical: string, words: { name: string; english_name: string; abbreviation: string | null }[]): { abbr: string; physical: string; parts: string[] } | null {
  const text = logical.replace(/\s+/g, '');
  if (!text) return null;
  const sorted = [...words].filter((w) => w.name).sort((a, b) => b.name.length - a.name.length);
  const parts: typeof words = [];
  let i = 0;
  while (i < text.length) {
    const w = sorted.find((x) => text.startsWith(x.name, i));
    if (!w) return null;
    parts.push(w);
    i += w.name.length;
  }
  return { abbr: parts.map((w) => w.abbreviation || w.english_name).join('_').toUpperCase(), physical: parts.map((w) => w.english_name).join('_').toUpperCase(), parts: parts.map((w) => `${w.name}(${w.abbreviation || w.english_name})`) };
}

function DictEditor({ session, editing, domains, onClose }: { session: Session; editing: Editing; domains: DictDomain[]; onClose: () => void }) {
  const { kind, id } = editing;
  const [values, setValues] = useState<Record<string, string>>(editing.values);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState<DictSearch['words']>([]);
  const [usage, setUsage] = useState(0);
  useEffect(() => {
    if (kind !== 'term') return;
    api.dictSearch(session.id, '', 2000).then((r) => { setWords(r.words); if (id) setUsage(r.erd_usage[id] ?? 0); }).catch(() => {});
  }, [kind, id, session.id]);
  const suggestion = kind === 'term' ? suggestFromWords(values.logical_name ?? '', words) : null;
  const domain = kind === 'term' ? domains.find((d) => d.name === values.domain_name) : undefined;
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: UPPER.has(k) ? v.toUpperCase() : v }));
  const missing = FIELDS[kind].filter((f) => f.required && !(values[f.key] ?? '').trim()).map((f) => f.label);
  const save = async () => {
    if (missing.length) { setError(`${missing.join(', ')}을(를) 채워 주세요.`); return; }
    setBusy(true); setError(null);
    const body = Object.fromEntries(FIELDS[kind].map((f) => [f.key, (values[f.key] ?? '').trim() || null]));
    try { if (id) await api.dictUpdate(kind, id, body); else await api.dictCreate(kind, body); onClose(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const remove = async () => {
    if (!id || !confirm(`이 ${KIND_LABEL[kind]}을(를) erd-vibe 공유 사전에서 지울까요?${usage ? `\nERD 컬럼 ${usage}개가 이 용어를 씁니다.` : ''}`)) return;
    setBusy(true);
    try { await api.dictDelete(kind, [id]); onClose(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dict-editor-title" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
        <h1 id="dict-editor-title">{KIND_LABEL[kind]} {id ? '수정' : '추가'}</h1>
        <div className="grid2">
          {FIELDS[kind].map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}{f.required && ' *'}{f.key === 'domain_name' && domain ? ` · ${domain.type_for_dbms ?? domain.data_type_default ?? ''}` : ''}</span>
              <input className={f.mono ? 'mono' : ''} list={f.list} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} autoFocus={f === FIELDS[kind][0]} />
            </label>
          ))}
        </div>
        {kind === 'term' && (suggestion || values.logical_name || id) && (
          <p className="small">
            {suggestion ? <>단어 풀이: {suggestion.parts.join(' + ')} → <code>{suggestion.abbr}</code> / <code>{suggestion.physical}</code>{' '}
              {(values.physical_abbr_name !== suggestion.abbr || values.physical_name !== suggestion.physical) && <button className="small-btn" onClick={() => setValues((s) => ({ ...s, physical_abbr_name: suggestion.abbr, physical_name: suggestion.physical }))}>추천으로 채우기</button>}</>
              : values.logical_name ? <span className="muted">단어사전으로 논리명을 다 풀지 못했습니다. 없는 단어는 먼저 단어로 등록하세요.</span> : null}
            {id && <span className="muted"> · 이 용어를 쓰는 ERD 컬럼 {usage}개(이름은 바뀌지 않음)</span>}
          </p>
        )}
        <p className="muted small">저장하면 erd-vibe 공유 사전에 바로 반영되어 팀 모두가 씁니다.</p>
        {error && <p className="banner error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {id && <button className="danger" disabled={busy} onClick={remove}>삭제</button>}
          <span className="spacer" />
          <button disabled={busy} onClick={onClose}>취소</button>
          <button className="primary" disabled={busy} onClick={save}>{busy ? '저장 중' : '저장'}</button>
        </div>
      </div>
    </div>
  );
}

/** 요청 한 줄 이름. 서버 dictrequests.ts requestLabel과 같은 규칙. */
export function requestLabel(r: DictRequest): string {
  if (r.kind === 'term') return `용어 ${r.payload.logical_name || '(빈 용어)'}`;
  if (r.kind === 'word') return `단어 ${r.payload.name || r.payload.english_name}`;
  const p = r.payload;
  if (p.action === 'add_table') return `ERD 테이블 추가 ${p.table.physical_name}`;
  if (p.action === 'add_column') return `ERD 컬럼 추가 ${p.table}.${p.column.physical_name}`;
  if (p.action === 'update_column') return `ERD 컬럼 변경 ${p.table}.${p.column}`;
  return `ERD 컬럼 삭제 ${p.table}.${p.column}`;
}

type TermLite = { standard: string; physical_name: string; logical_name: string };
const ERD_ACTION: Record<ErdPayload['action'], string> = { add_table: '테이블 추가', add_column: '컬럼 추가', update_column: '컬럼 변경', drop_column: '컬럼 삭제' };

function RequestsTab({ session, domains, onOpenErd }: { session: Session; domains: DictDomain[]; onOpenErd: (table?: string) => void }) {
  const [list, setList] = useState<DictRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'pending' | 'all'>('pending');
  const [terms, setTerms] = useState<TermLite[]>([]);
  const reload = useCallback(() => { api.dictRequests(session.id).then(setList).catch((e) => setError(e.message)); }, [session.id]);
  const reloadTerms = useCallback(() => { api.dictSearch(session.id, '', 2000).then((r) => setTerms(r.terms)).catch(() => {}); }, [session.id]);
  useEffect(reload, [reload]);
  useEffect(reloadTerms, [reloadTerms]);
  useServerEvents((e) => {
    if (e.type === 'dict.requests' && e.sessionId === session.id) reload();
    if (e.type === 'dict.updated') reloadTerms();
  });
  const [bulk, setBulk] = useState<string | null>(null);
  if (!list) return error ? <p className="banner error">{error}</p> : <p className="muted">불러오는 중</p>;
  const open = (r: DictRequest) => r.status === 'pending' || r.status === 'failed';
  const shown = (view === 'pending' ? list.filter(open) : list).sort((a, b) => Number(open(b)) - Number(open(a)) || b.id - a.id);
  // 일괄 승인은 승인 대기 중인 ERD 요청만. 테이블 추가 뒤에 그 테이블의 컬럼 요청이 오도록 먼저 만든 요청부터 반영한다.
  const erdPending = list.filter((r) => r.kind === 'erd' && r.status === 'pending').sort((a, b) => a.id - b.id);
  const approveAllErd = async () => {
    const drops = erdPending.filter((r) => (r.payload as ErdPayload).action === 'drop_column').length;
    const msg = `승인 대기 중인 ERD 변경 요청 ${erdPending.length}건을 저장된 초안 그대로 ERD에 반영합니다.`
      + (drops ? `\n컬럼 삭제 ${drops}건이 들어 있습니다. 삭제한 컬럼에 걸린 관계도 함께 지워집니다.` : '')
      + '\n카드에서 고친 내용은 반영되지 않습니다. 계속할까요?';
    if (!confirm(msg)) return;
    setError(null);
    const failed: string[] = [];
    for (const [i, r] of erdPending.entries()) {
      setBulk(`${i + 1}/${erdPending.length}`);
      try {
        const res = await api.approveDictRequest(r.id, r.payload as ErdPayload);
        if (res.status !== 'done') failed.push(`#${r.id} ${res.error ?? ''}`);
      } catch (e) { failed.push(`#${r.id} ${(e as Error).message}`); }
    }
    setBulk(null);
    if (failed.length) setError(`${erdPending.length}건 중 ${failed.length}건을 반영하지 못했습니다.\n${failed.join('\n')}`);
    reload();
  };
  return (
    <>
      <div className="card">
        <p className="muted small">Claude가 만든 용어·단어 등록, ERD 변경 초안입니다. 고쳐서 승인하면 erd-vibe에 들어가 팀 모두가 씁니다. 승인하기 전에는 아무것도 바뀌지 않습니다.</p>
        <div className="row">
          <div className="seg" role="group" aria-label="보기">
            <button className={`chip-btn${view === 'pending' ? ' on' : ''}`} onClick={() => setView('pending')}>대기 {list.filter(open).length}</button>
            <button className={`chip-btn${view === 'all' ? ' on' : ''}`} onClick={() => setView('all')}>전체 {list.length}</button>
          </div>
          <span className="spacer" />
          {erdPending.length > 0 && (
            <button className="primary" disabled={bulk !== null} onClick={approveAllErd}>
              {bulk ? `반영 중 ${bulk}` : `ERD 요청 ${erdPending.length}건 일괄 승인`}
            </button>
          )}
        </div>
      </div>
      {error && <p className="banner error" role="alert" style={{ whiteSpace: 'pre-line' }}>{error}</p>}
      {shown.length === 0 && <p className="muted">{view === 'pending' ? '승인을 기다리는 요청이 없습니다.' : '요청이 없습니다.'}</p>}
      {shown.map((r) => <RequestCard key={r.id} r={r} domains={domains} terms={terms} onDone={reload} onOpenErd={onOpenErd} />)}
    </>
  );
}

function RequestCard({ r, domains, terms, onDone, onOpenErd }: { r: DictRequest; domains: DictDomain[]; terms: TermLite[]; onDone: () => void; onOpenErd: (table?: string) => void }) {
  const [draft, setDraft] = useState<DictRequest['payload']>(r.payload);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(r.payload), [r.payload]);
  const open = r.status === 'pending' || r.status === 'failed';
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: UPPER.has(k) ? v.toUpperCase() : v }));
  const field = (k: string, label: string, placeholder = '', list?: string) => (
    <label className="field">
      <span>{label}</span>
      <input className={UPPER.has(k) ? 'mono' : ''} list={list} disabled={!open}
        value={(draft as Record<string, string | null>)[k] ?? ''} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  const domain = r.kind === 'term' ? domains.find((d) => d.name === (draft as TermPayload).domain_name) : undefined;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); onDone(); } catch (e) { setError((e as Error).message); } setBusy(false); };
  const approve = () => {
    if (r.kind === 'erd' && (draft as ErdPayload).action === 'drop_column') {
      const p = draft as Extract<ErdPayload, { action: 'drop_column' }>;
      if (!confirm(`ERD에서 ${p.table}.${p.column} 컬럼을 지웁니다. 이 컬럼에 걸린 관계도 함께 지워집니다. 계속할까요?`)) return;
    }
    act(() => api.approveDictRequest(r.id, draft as TermPayload | WordPayload | ErdPayload));
  };
  const title = r.kind === 'term' ? '용어 등록 요청' : r.kind === 'word' ? '단어 등록 요청' : `ERD 변경 요청 · ${ERD_ACTION[(r.payload as ErdPayload).action]}`;
  return (
    <section className="card">
      <div className="block-head">
        <h2>{title} #{r.id}</h2>
        <span className={`pill ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'err' : r.status === 'pending' ? 'warn' : ''}`}>
          {{ pending: '승인 대기', done: r.kind === 'erd' ? '반영함' : '등록함', rejected: '거절', failed: r.kind === 'erd' ? '반영 실패' : '등록 실패' }[r.status]}
        </span>
      </div>
      <p className="muted small">{r.source === 'claude' ? 'Claude 요청' : '직접'} · {r.reason}</p>
      {r.kind === 'term' && (
        <div className="grid2">
          {field('logical_name', '논리명', '거래취소일자')}
          {field('physical_abbr_name', '약어명 (표준 이름)', 'TR_CNCL_DT')}
          {field('physical_name', '물리명', 'TRADE_CANCEL_DATE')}
          {field('domain_name', `도메인${domain ? ` · ${domain.type_for_dbms ?? domain.data_type_default ?? ''}` : ''}`, '도메인사전에서 고르기', 'dict-domains')}
          {field('description', '설명')}
        </div>
      )}
      {r.kind === 'word' && (
        <div className="grid2">
          {field('name', '단어', '취소')}
          {field('abbreviation', '약어', 'CNCL')}
          {field('english_name', '영문명', 'CANCEL')}
          {field('definition', '정의')}
        </div>
      )}
      {r.kind === 'erd' && <ErdRequestTable p={draft as ErdPayload} terms={terms} warn={open} />}
      {(error || r.error) && <p className="banner error">{error ?? r.error}</p>}
      {open && (
        <div className="row">
          {r.kind === 'erd' && <button onClick={() => onOpenErd((r.payload as ErdPayload).action === 'add_table' ? undefined : (r.payload as Exclude<ErdPayload, { action: 'add_table' }>).table)}>ERD 화면에서 보기</button>}
          <span className="spacer" />
          <button disabled={busy} onClick={() => act(() => api.rejectDictRequest(r.id))}>거절</button>
          <button className={r.kind === 'erd' && (draft as ErdPayload).action === 'drop_column' ? 'primary danger' : 'primary'} disabled={busy} onClick={approve}>
            {busy ? '반영 중' : r.kind === 'erd' ? '승인하고 ERD에 반영' : '승인하고 erd-vibe에 등록'}
          </button>
        </div>
      )}
    </section>
  );
}

/** ERD 변경 초안을 표로. 컬럼마다 용어사전에 있는 이름인지 표시한다(없어도 반영은 된다). */
function ErdRequestTable({ p, terms, warn }: { p: ErdPayload; terms: TermLite[]; warn: boolean }) {
  const termOf = (name: string | null | undefined) => {
    const n = (name ?? '').toUpperCase();
    return n ? terms.find((t) => t.standard === n || t.physical_name.toUpperCase() === n) : undefined;
  };
  const termCell = (c: Partial<ColumnDraft>) => {
    if (!terms.length) return null;
    const t = termOf(c.term ?? c.physical_name);
    return t ? <span className="pill ok">{t.logical_name} ✓</span> : <span className="pill warn">미등록</span>;
  };
  const cols: { table: string; c: Partial<ColumnDraft> & { physical_name: string } }[] =
    p.action === 'add_table' ? p.table.columns.map((c) => ({ table: p.table.physical_name, c }))
      : p.action === 'add_column' ? [{ table: p.table, c: p.column }]
        : p.action === 'update_column' ? [{ table: p.table, c: { ...p.patch, physical_name: p.patch.physical_name ? `${p.column} → ${p.patch.physical_name}` : p.column } }]
          : [{ table: p.table, c: { physical_name: p.column } }];
  const unregistered = warn && p.action !== 'drop_column' && terms.length > 0 && cols.some(({ c }) => !termOf(c.term ?? (p.action === 'update_column' ? p.patch.physical_name ?? p.column : c.physical_name)));
  return (
    <>
      {p.action === 'add_table' && <p className="small"><span className="mono"><b>{p.table.physical_name}</b></span> {p.table.logical_name}{p.table.description ? ` · ${p.table.description}` : ''}</p>}
      <div className="table-wrap"><table className="dict-table">
        <thead><tr><th>테이블</th><th>컬럼</th><th>논리명</th><th>타입</th><th>PK</th><th>NULL</th><th>용어</th></tr></thead>
        <tbody>{cols.map(({ table, c }, i) => (
          <tr key={i} className={p.action === 'drop_column' ? 'removed' : ''}>
            <td className="mono">{table}</td><td className="mono">{c.physical_name}</td><td>{c.logical_name ?? ''}</td><td className="mono">{c.data_type ?? ''}</td>
            <td>{c.is_primary_key ? 'PK' : ''}</td><td>{c.is_nullable === undefined ? '' : c.is_nullable ? 'Y' : 'N'}</td>
            <td>{p.action === 'drop_column' ? <span className="pill err">삭제</span> : termCell(c)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {unregistered && <p className="banner">용어사전에 없는 컬럼이 있습니다. 먼저 용어를 등록하면 용어 연결까지 채워집니다(이대로 반영할 수도 있음).</p>}
    </>
  );
}
