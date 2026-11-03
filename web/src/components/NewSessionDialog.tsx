import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { usableIn, type JiraStatus, type Session, type Workspace } from '../types';
import JiraTicketPicker, { WORK_NAME, type TicketChoice } from './JiraTicketPicker';

/** sharedWith: 같은 저장소의 앞 앱 이름. 그 앱과 워크트리·브랜치를 같이 쓴다(모노레포). current: 원본 폴더에 체크아웃된 브랜치 */
type Row = { projectId: number; name: string; branches: string[]; base: string; branch: string; touched: boolean; repo: string; sharedWith: string | null; current: string | null };

const defaultBranch = (ticket: string) => (ticket.trim() ? `feature/${ticket.trim()}` : '');

export default function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Session) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [choice, setChoice] = useState<TicketChoice>({ mode: 'existing', issue: null });
  const [jira, setJira] = useState<JiraStatus | null>(null);
  const [summaryEdit, setSummaryEdit] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  // 1: 워크스페이스·Jira 티켓 정하기, 2: 정해진 티켓 번호로 브랜치·첫 프롬프트 정하기
  const [step, setStep] = useState<1 | 2>(1);
  const [firstPrompt, setFirstPrompt] = useState('');
  // 첫 프롬프트는 기본으로 계획 먼저: 코드를 고치기 전에 계획서·화면설계서를 만들고 승인을 기다린다.
  const [firstPlan, setFirstPlan] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  // 워크트리를 만들지 않고 원본 클론 폴더에서 지금 브랜치 그대로 작업한다.
  const [inPlace, setInPlace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freeAccounts, setFreeAccounts] = useState<number | null>(null);
  const [drafting, setDrafting] = useState(false);
  // 바깥을 누르거나 Esc를 잘못 눌러 적던 내용(하려는 일, 제안받은 제목·설명, 첫 프롬프트)을 잃지 않게 한 번 묻는다.
  const dirty = step === 2 || Boolean(firstPrompt.trim())
    || (choice.mode === 'new' && Boolean(choice.prompt.trim() || choice.summary.trim() || choice.description.trim()))
    || (choice.mode === 'manual' && Boolean(choice.key.trim())) || (choice.mode === 'none' && Boolean(choice.name.trim()));
  function requestClose() {
    if (busy || drafting) return;
    if (dirty && !confirm('작성 중인 내용이 사라집니다. 창을 닫을까요?')) return;
    onClose();
  }
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;

  useEffect(() => {
    api.workspaces().then((ws) => { setWorkspaces(ws); if (ws[0]) setWorkspaceId(ws[0].id); }).catch((e) => setError(e.message));
    api.jiraStatus().then(setJira).catch(() => setJira(null));

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const workspace = useMemo(() => workspaces?.find((w) => w.id === workspaceId) ?? null, [workspaces, workspaceId]);
  const jiraReady = Boolean(jira?.connected && workspace?.jira_project);
  // Jira를 쓸 수 없으면 직접 입력, 쓸 수 있으면 고르기로 시작한다.
  // 2단계에서 Jira 상태가 잠깐 흔들려도 고른 티켓이 지워지지 않게 1단계에서만 다시 맞춘다.
  useEffect(() => {
    if (step !== 1) return;
    setChoice(jiraReady ? { mode: 'existing', issue: null } : { mode: 'manual', key: '' });
    setSummaryEdit(null);
  }, [jiraReady, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 브랜치 이름과 세션 이름에 쓸 티켓 번호와 요약. 새 티켓은 만들기 전이라 아직 번호가 없다.
  // 티켓 없이 하는 작업은 작업 이름을 그 자리에 쓴다.
  const ticket = choice.mode === 'manual' ? choice.key.trim() : choice.mode === 'existing' ? choice.issue?.key ?? '' : choice.mode === 'none' ? choice.name.trim() : '';
  const summary = summaryEdit ?? (choice.mode === 'existing' ? choice.issue?.summary ?? '' : choice.mode === 'new' ? choice.summary : '');
  // 이 워크스페이스에서 쓸 수 있는 계정 수(워크스페이스 전용 + 공용)
  useEffect(() => {
    if (!workspaceId) return;
    api.accounts().then((a) => setFreeAccounts(a.accounts.filter((x) => usableIn(x, workspaceId)).length)).catch(() => setFreeAccounts(null));
  }, [workspaceId]);

  useEffect(() => {
    if (!workspace) { setRows([]); return; }
    let cancelled = false;
    const projects = api.projects().catch(() => []);
    Promise.all(workspace.projects.map(async (p, i) => {
      const first = workspace.projects.find((x) => x.repo_root === p.repo_root);
      const sharedWith = first && workspace.projects.indexOf(first) < i ? first.name : null;
      const branches = sharedWith ? [] : await api.branches(p.id).catch(() => [] as string[]);
      const current = (await projects).find((x) => x.id === p.id)?.current_branch ?? null;
      return { projectId: p.id, name: p.name, branches, base: branches[0] ?? 'develop', branch: '', touched: false, repo: p.repo_root, sharedWith, current };
    })).then((r) => { if (!cancelled) setRows(r); });
    return () => { cancelled = true; };
  }, [workspace]);

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  /** 1단계 → 2단계. 새 티켓이면 이때 Jira에 만들어 실제 번호를 받는다. */
  async function next() {
    if (!workspaceId) { setError('워크스페이스를 고르세요.'); return; }
    if (choice.mode === 'existing' && !choice.issue) { setError('Jira 티켓을 고르세요.'); return; }
    if (choice.mode === 'new' && !choice.summary.trim()) { setError(choice.drafted ? '새 티켓 제목을 넣어 주세요.' : '"제목·내용 제안 받기"를 누르거나 직접 써 주세요.'); return; }
    if (choice.mode === 'manual' && !choice.key.trim()) { setError('티켓 번호를 넣어 주세요.'); return; }
    if (choice.mode === 'none' && !WORK_NAME.test(choice.name.trim())) { setError(choice.name.trim() ? '작업 이름은 영문으로 시작하고 영문·숫자·하이픈만 쓸 수 있습니다.' : '작업 이름을 넣어 주세요.'); return; }
    setError(null);
    if (choice.mode === 'new') {
      setBusy(true);
      setStage('Jira 티켓 만드는 중');
      try {
        const created = await api.createJiraIssue(workspaceId, { summary: choice.summary, description: choice.description, issuetype_id: choice.issuetype_id, fields: choice.fields });
        // 하려는 일을 적어 뒀으면 첫 프롬프트로 이어서 쓴다.
        if (!firstPrompt.trim() && choice.prompt.trim()) setFirstPrompt(choice.prompt.trim());
        // 이전으로 돌아가도 다시 만들지 않게 만든 티켓을 고른 상태로 바꾼다.
        setChoice({ mode: 'existing', issue: created });
        setSummaryEdit(null);
      } catch (err) {
        setError((err as Error).message);
        return;
      } finally {
        setBusy(false);
        setStage(null);
      }
    }
    // 티켓 번호가 정해졌으니 손대지 않은 브랜치 이름은 그 번호로 다시 채운다.
    setRows((prev) => prev.map((r) => (r.touched ? r : { ...r, branch: '' })));
    setStep(2);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (step === 1) { await next(); return; }
    if (!ticket) { setStep(1); return; }
    const detached = inPlace ? rows.find((r) => !r.sharedWith && !r.current) : undefined;
    if (detached) { setError(`${detached.name}의 원본 폴더가 특정 브랜치에 있지 않습니다. 브랜치를 체크아웃한 뒤 다시 시도하세요.`); return; }
    setBusy(true);
    setError(null);
    setStage(inPlace ? '세션 만드는 중' : '워크트리 만드는 중');
    try {
      const s = await api.createSession({
        workspaceId: workspaceId!,
        ticket,
        summary,
        inPlace,
        firstPrompt: firstPrompt.trim() || undefined,
        firstPromptPlan: firstPlan,
        // 같은 저장소의 앱은 앞 앱의 브랜치를 쓴다(서버도 저장소마다 워크트리를 하나만 만든다).
        branches: rows.map((r) => {
          const owner = rows.find((x) => x.repo === r.repo) ?? r;
          return { projectId: r.projectId, base: owner.base, branch: inPlace ? owner.current ?? '-' : owner.touched ? owner.branch : defaultBranch(ticket) };
        }),
      });
      onCreated(s);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setStage(null);
    }
  }

  const picked = choice.mode === 'existing' ? choice.issue : null;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onSubmit={submit}>
        <div className="wizard-head">
          <h1 id="new-session-title">새 세션 만들기</h1>
          <ol className="wizard-steps" aria-label="단계">
            <li className={step === 1 ? 'on' : 'done'} aria-current={step === 1 ? 'step' : undefined}><span>1</span> 티켓</li>
            <li className={step === 2 ? 'on' : ''} aria-current={step === 2 ? 'step' : undefined}><span>2</span> 세션 설정</li>
          </ol>
        </div>
        {workspaces && workspaces.length === 0 ? (
          <p>워크스페이스가 없습니다. 설정에서 워크스페이스를 만들고 클론 폴더를 추가하세요.</p>
        ) : step === 1 ? (
          <>
            <label className="field">
              <span>워크스페이스</span>
              <select value={workspaceId ?? ''} disabled={busy || drafting} title={drafting ? '티켓 내용을 만드는 중에는 워크스페이스를 바꿀 수 없습니다' : undefined}
                onChange={(e) => {
                  // 워크스페이스를 바꾸면 고른 티켓과 적던 티켓 내용이 지워진다.
                  const filled = (choice.mode === 'new' && Boolean(choice.prompt.trim() || choice.summary.trim() || choice.description.trim()))
                    || (choice.mode === 'existing' && Boolean(choice.issue)) || (choice.mode === 'manual' && Boolean(choice.key.trim()))
                    || (choice.mode === 'none' && Boolean(choice.name.trim()));
                  if (filled && !confirm('워크스페이스를 바꾸면 고른 티켓과 적던 내용이 지워집니다. 바꿀까요?')) return;
                  setWorkspaceId(Number(e.target.value));
                }}>
                {workspaces?.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.projects.map((p) => p.name).join(' + ')}){w.jira_project ? ` · Jira ${w.jira_project}` : ''}</option>)}
              </select>
            </label>
            {workspace && <JiraTicketPicker key={workspace.id} workspace={workspace} jira={jira} value={choice} onChange={(v) => { setChoice(v); setSummaryEdit(null); }} onDrafting={setDrafting} />}
          </>
        ) : (
          <>
            <div className="ticket-card">
              <span className="mono strong">{ticket}</span>
              <span className="ticket-title">{picked?.summary ?? ''}</span>
              {picked && <span className="muted small">{picked.type} · {picked.status}</span>}
              {choice.mode === 'none' && <span className="muted small">Jira 티켓 없음</span>}
              <span className="spacer" />
              {picked?.url && <a className="btn-link" href={picked.url} target="_blank" rel="noreferrer">Jira에서 보기</a>}
            </div>
            <label className="field">
              <span>작업 요약 <span className="muted small">{picked ? '(티켓 제목에서 가져옴, 고칠 수 있음)' : ''}</span></span>
              <input value={summary} autoFocus placeholder="자원 상세에 KPX 자원명 입력" onChange={(e) => setSummaryEdit(e.target.value)} />
            </label>
            <fieldset className="box">
              <legend>브랜치</legend>
              <div className="checks where" role="radiogroup" aria-label="작업 위치">
                <label><input type="radio" name="where" checked={!inPlace} onChange={() => setInPlace(false)} /> 새 워크트리</label>
                <label><input type="radio" name="where" checked={inPlace} onChange={() => setInPlace(true)} /> 원본 폴더에서 바로 작업</label>
              </div>
              <div className="branch-grid">
                <span className="muted small">프로젝트</span><span className="muted small">{inPlace ? '비교 기준 브랜치' : '기준 브랜치'}</span><span className="muted small">{inPlace ? '작업 브랜치(현재)' : '새 브랜치'}</span>
                {rows.map((r, i) => r.sharedWith ? (
                  <div key={r.projectId} className="branch-row">
                    <strong>{r.name}</strong>
                    <span className="muted small branch-shared">{r.sharedWith}와 같은 저장소라 워크트리·브랜치를 같이 씁니다</span>
                  </div>
                ) : (
                  <div key={r.projectId} className="branch-row">
                    <strong>{r.name}</strong>
                    <select aria-label={`${r.name} 기준 브랜치`} value={r.base} onChange={(e) => update(i, { base: e.target.value })}>
                      {(r.branches.length ? r.branches : [r.base]).map((b) => <option key={b}>{b}</option>)}
                    </select>
                    {inPlace ? (
                      <input aria-label={`${r.name} 작업 브랜치`} className="mono" readOnly value={r.current ?? '(브랜치 없음 · detached)'} />
                    ) : (
                      <input
                        aria-label={`${r.name} 새 브랜치`}
                        className="mono"
                        value={r.touched ? r.branch : defaultBranch(ticket)}
                        placeholder="feature/..."
                        onChange={(e) => update(i, { branch: e.target.value, touched: true })}
                      />
                    )}
                  </div>
                ))}
              </div>
              {inPlace ? (
                <p className="muted small">워크트리를 만들지 않고 등록한 클론 폴더에서 지금 체크아웃된 브랜치로 작업합니다. 세션을 닫거나 정리해도 폴더와 브랜치는 지우지 않습니다. 한 폴더는 열린 세션 하나만 쓸 수 있습니다.</p>
              ) : (
                <p className="muted small">워크트리는 각 클론 폴더 옆에 <code>{choice.mode === 'none' ? '폴더이름-작업이름' : '폴더이름-티켓번호'}</code>로 만들어집니다.</p>
              )}
            </fieldset>
            <p className="muted small">
              {freeAccounts === null ? '' : freeAccounts > 0
                ? `이 워크스페이스 테스트 계정 ${freeAccounts}개를 다른 세션과 같이 씁니다.`
                : '이 워크스페이스에 테스트 계정이 없습니다. 나중에 설정에서 추가할 수 있습니다.'}
              {' '}환경값은 프로젝트의 기본 프로필을 쓰고, 세션 화면의 서버 패널에서 바꿀 수 있습니다.
            </p>
            <label className="field">
              <span>첫 프롬프트 <span className="muted">(선택)</span></span>
              <textarea rows={4} value={firstPrompt} placeholder="비워 두면 워크트리만 만들고 대기합니다." onChange={(e) => setFirstPrompt(e.target.value)} />
            </label>
            <label className="first-plan">
              <input type="checkbox" checked={firstPlan} disabled={!firstPrompt.trim()} onChange={(e) => setFirstPlan(e.target.checked)} />
              <span>
                계획 먼저 <span className="muted small">— 코드를 고치기 전에 계획서와 화면설계서를 만들고, 승인한 뒤에 실행합니다</span>
              </span>
            </label>
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          {step === 2
            ? <button type="button" disabled={busy} onClick={() => { setError(null); setStep(1); }}>← 이전</button>
            : <button type="button" disabled={busy || drafting} onClick={requestClose}>취소</button>}
          <button type="submit" className="primary" disabled={busy || drafting || !workspace}>
            {busy ? stage ?? '만드는 중' : step === 1 ? (choice.mode === 'new' ? '티켓 만들고 다음' : '다음') : '세션 만들기'}
          </button>
        </div>
      </form>
    </div>
  );
}
