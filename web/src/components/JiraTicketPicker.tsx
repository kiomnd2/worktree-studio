import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { JiraIssue, JiraRequiredField, JiraStatus, Workspace } from '../types';

export type TicketChoice =
  | { mode: 'existing'; issue: JiraIssue | null }
  /** prompt: 하려는 일을 자유롭게 적은 것. 이걸로 제목·설명을 제안받는다. drafted: 제안을 받았거나 직접 쓰기로 했는지 */
  /** fields: 프로젝트가 필수로 요구하는 칸(스프린트 등)의 값. 키는 Jira 필드 키 */
  | { mode: 'new'; prompt: string; drafted: boolean; summary: string; description: string; issuetype_id: string; fields: Record<string, string> }
  | { mode: 'manual'; key: string };

type Props = { workspace: Workspace; jira: JiraStatus | null; value: TicketChoice; onChange: (v: TicketChoice) => void; onDrafting?: (drafting: boolean) => void };

/**
 * 세션의 출발점인 Jira 티켓. 워크스페이스의 Jira 프로젝트에서 이미 있는 티켓을 고르거나 새로 만든다.
 * Jira가 연결되지 않았거나 프로젝트 키가 없으면 티켓 번호를 직접 넣는다.
 */
export default function JiraTicketPicker({ workspace, jira, value, onChange, onDrafting }: Props) {
  const ready = Boolean(jira?.connected && workspace.jira_project);
  const [q, setQ] = useState('');
  const [issues, setIssues] = useState<JiraIssue[] | null>(null);
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  // 제안을 받는 동안 바깥(워크스페이스 고르기 등)을 막을 수 있게 알린다.
  useEffect(() => { onDrafting?.(drafting); }, [drafting]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [required, setRequired] = useState<JiraRequiredField[]>([]);
  const [requiredError, setRequiredError] = useState<string | null>(null);
  const issuetypeId = value.mode === 'new' ? value.issuetype_id : '';
  const latest = useRef(value);
  latest.current = value;

  // 유형마다 필수 칸이 다르다. 유형이 정해지면 받아 오고, 비어 있는 칸은 기본값(진행 중 스프린트 등)으로 채운다.
  useEffect(() => {
    if (!ready || !issuetypeId) { setRequired([]); return; }
    let alive = true;
    setRequiredError(null);
    api.jiraRequiredFields(workspace.id, issuetypeId).then((fs) => {
      if (!alive) return;
      setRequired(fs);
      const cur = latest.current;
      if (cur.mode !== 'new') return;
      const fields: Record<string, string> = {};
      for (const f of fs) fields[f.key] = cur.fields[f.key] ?? f.default_id ?? '';
      onChange({ ...cur, fields });
    }).catch((e) => { if (alive) { setRequired([]); setRequiredError(e.message); } });
    return () => { alive = false; };
  }, [ready, workspace.id, issuetypeId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 적은 내용으로 제목·유형·설명을 제안받아 채운다. 채운 뒤에도 고칠 수 있다. */
  async function propose() {
    if (value.mode !== 'new' || !value.prompt.trim() || drafting) return;
    setDrafting(true); setError(null); setDraftNote(null);
    try {
      const d = await api.draftJiraIssue(workspace.id, value.prompt);
      onChange({ ...value, drafted: true, summary: d.title, description: d.description, issuetype_id: d.issuetype_id || value.issuetype_id });
      setDraftNote(d.examples.length ? `${d.examples_mine ? '내가' : '팀이'} 쓴 최근 티켓 ${d.examples.join(', ')} 형식으로 제안했습니다. 확인하고 고치세요.` : '코드를 보고 제안했습니다. 확인하고 고치세요.');
    } catch (e) { setError((e as Error).message); } finally { setDrafting(false); }
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 방식을 오가도 적던 내용이 사라지지 않게 방식마다 마지막 상태를 기억해 두고 돌아오면 되살린다.
  const kept = useRef<Partial<Record<'existing' | 'new', TicketChoice>>>({});
  function switchMode(mode: 'existing' | 'new') {
    if (value.mode === mode) return;
    if (value.mode === 'existing' || value.mode === 'new') kept.current[value.mode] = value;
    onChange(kept.current[mode] ?? (mode === 'existing'
      ? { mode: 'existing', issue: null }
      : { mode: 'new', prompt: '', drafted: false, summary: '', description: '', fields: {}, issuetype_id: (types.find((x) => x.name === '작업') ?? types[0])?.id ?? '' }));
  }

  // 검색어가 바뀌면 잠깐 기다렸다가 찾는다. 비우면 내게 배정된 진행 중 티켓.
  useEffect(() => {
    if (!ready || value.mode !== 'existing') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setError(null);
      api.jiraIssues(workspace.id, q).then(setIssues).catch((e) => { setIssues([]); setError(e.message); });
    }, q ? 300 : 0);
    return () => clearTimeout(timer.current);
  }, [ready, workspace.id, q, value.mode]);

  useEffect(() => {
    if (!ready) return;
    api.jiraIssueTypes(workspace.id).then((t) => {
      setTypes(t);
      // 새 티켓의 기본 유형은 "작업"(없으면 Task, 그것도 없으면 첫 번째). 응답을 기다리는 동안 적은 내용을 덮지 않게 최신 값에 얹는다.
      const cur = latest.current;
      if (cur.mode === 'new' && !cur.issuetype_id) {
        const def = t.find((x) => x.name === '작업') ?? t.find((x) => /task/i.test(x.name)) ?? t[0];
        if (def) onChange({ ...cur, issuetype_id: def.id });
      }
    }).catch(() => setTypes([]));
  }, [ready, workspace.id, value.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return (
      <fieldset className="box jira-picker">
        <legend>Jira 티켓</legend>
        <label className="field">
          <span>티켓 번호</span>
          <input autoFocus placeholder={workspace.jira_project ? `${workspace.jira_project}-424` : 'DRMS-424'} value={value.mode === 'manual' ? value.key : ''} onChange={(e) => onChange({ mode: 'manual', key: e.target.value })} />
        </label>
        <p className="muted small">
          {!jira?.connected
            ? `Jira가 연결되지 않아 티켓 번호를 직접 넣습니다.${jira?.error ? ` (${jira.error})` : ''} 설정에서 "Jira로 로그인"을 누르면 티켓을 고르거나 바로 만들 수 있습니다.`
            : `${workspace.name} 워크스페이스에 Jira 프로젝트 키가 없어 티켓 번호를 직접 넣습니다. 설정의 워크스페이스에서 키(예: KERE)를 넣으면 고르거나 만들 수 있습니다.`}
        </p>
      </fieldset>
    );
  }

  return (
    <fieldset className="box jira-picker">
      <legend>Jira 티켓 <span className="muted small">{workspace.jira_project} 프로젝트</span></legend>
      <div className="segmented" role="group" aria-label="티켓 고르기 방식">
        <button type="button" aria-pressed={value.mode === 'existing'} className={value.mode === 'existing' ? 'on' : ''} disabled={drafting} onClick={() => switchMode('existing')}>이미 있는 티켓</button>
        <button type="button" aria-pressed={value.mode === 'new'} className={value.mode === 'new' ? 'on' : ''} disabled={drafting} onClick={() => switchMode('new')}>새로 만들기</button>
      </div>

      {value.mode === 'existing' && (
        <>
          <label className="sr-only" htmlFor="jira-search">티켓 검색</label>
          <input id="jira-search" autoFocus placeholder={`키(${workspace.jira_project}-123, 123)나 제목으로 검색. 비우면 내게 배정된 진행 중 티켓`} value={q} onChange={(e) => setQ(e.target.value)} />
          {error && <p className="error-text">{error}</p>}
          <ul className="jira-list" role="listbox" aria-label="티켓">
            {issues === null && <li className="muted small">불러오는 중</li>}
            {issues?.length === 0 && <li className="muted small">{q ? '찾는 티켓이 없습니다.' : '내게 배정된 진행 중 티켓이 없습니다. 검색하거나 새로 만드세요.'}</li>}
            {issues?.map((it) => {
              const on = value.issue?.key === it.key;
              return (
                <li key={it.key}>
                  <button type="button" role="option" aria-selected={on} className={`jira-item${on ? ' on' : ''}`} onClick={() => onChange({ mode: 'existing', issue: it })}>
                    <span className="mono strong">{it.key}</span>
                    <span className="jira-summary">{it.summary}</span>
                    <span className="muted small">{it.type} · {it.status}{it.assignee ? ` · ${it.assignee}` : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {value.mode === 'new' && (
        <div className="jira-new">
          <label className="field">
            <span>하려는 일</span>
            <textarea autoFocus rows={3} value={value.prompt} disabled={drafting}
              placeholder="예: REGO 발급 신청 창에서 지자체 몫이 광역인지 기초인지 구분해서 보여줘"
              onChange={(e) => onChange({ ...value, prompt: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); propose(); } }} />
          </label>
          <div className="jira-ai">
            <button type="button" className="small-btn primary" disabled={drafting || !value.prompt.trim()} onClick={propose}>
              {drafting ? <><span className="spinner" aria-hidden="true" /> 코드를 살펴보고 쓰는 중 (30초~1분)</> : value.drafted ? '다시 제안 받기' : '제목·내용 제안 받기'}
            </button>
            {!value.drafted && !drafting && <button type="button" className="link small" onClick={() => onChange({ ...value, drafted: true, summary: value.summary || value.prompt.split('\n')[0].slice(0, 80) })}>제안 없이 직접 쓰기</button>}
            {draftNote && <span className="muted small">{draftNote}</span>}
          </div>
          {error && <p className="error-text">{error}</p>}
          {value.drafted && (
            <>
              <div className="grid2">
                <label className="field">
                  <span>제목</span>
                  <input value={value.summary} disabled={drafting} onChange={(e) => onChange({ ...value, summary: e.target.value })} />
                </label>
                <label className="field">
                  <span>유형</span>
                  <select value={value.issuetype_id} disabled={drafting} onChange={(e) => onChange({ ...value, issuetype_id: e.target.value })}>
                    {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
              </div>
              {required.length > 0 && (
                <div className="grid2">
                  {required.map((f) => (
                    <label key={f.key} className="field">
                      <span>{f.name} <span className="muted small">(필수)</span></span>
                      {f.options.length || f.kind === 'sprint' ? (
                        <select value={value.fields[f.key] ?? ''} disabled={drafting} onChange={(e) => onChange({ ...value, fields: { ...value.fields, [f.key]: e.target.value } })}>
                          <option value="">{f.options.length ? '고르세요' : '열린 스프린트가 없습니다'}</option>
                          {f.options.map((o) => <option key={o.id} value={o.id}>{o.name}{o.hint ? ` (${o.hint})` : ''}</option>)}
                        </select>
                      ) : (
                        <input type={f.kind === 'number' ? 'number' : 'text'} value={value.fields[f.key] ?? ''} disabled={drafting} onChange={(e) => onChange({ ...value, fields: { ...value.fields, [f.key]: e.target.value } })} />
                      )}
                    </label>
                  ))}
                </div>
              )}
              {requiredError && <p className="error-text">필수 항목을 불러오지 못했습니다: {requiredError}</p>}
              <label className="field">
                <span>설명 <span className="muted small">(Markdown)</span></span>
                <textarea rows={value.description ? 12 : 4} value={value.description} disabled={drafting} onChange={(e) => onChange({ ...value, description: e.target.value })} />
              </label>
            </>
          )}
          <p className="muted small">세션을 만들 때 {workspace.jira_project} 프로젝트에 티켓을 만들고 나({jira?.user})에게 배정합니다.</p>
        </div>
      )}
    </fieldset>
  );
}
