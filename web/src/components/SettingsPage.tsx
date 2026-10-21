import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Account, AnalyzeField, JiraConfig, JiraStatus, PermissionMode, Project, ProjectAnalysis, ProjectKind, Settings, Workspace } from '../types';

const KINDS: { value: ProjectKind; label: string }[] = [
  { value: 'be', label: 'BE' }, { value: 'fe', label: 'FE' }, { value: 'full', label: '통합' }, { value: 'unknown', label: '미정' },
];
const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'auto', label: 'auto (분류기가 승인 판단)' },
  { value: 'acceptEdits', label: 'acceptEdits (파일 수정만 자동)' },
  { value: 'bypassPermissions', label: 'bypassPermissions (모두 자동)' },
  { value: 'default', label: 'default' },
  { value: 'plan', label: 'plan (계획만)' },
];

type Tab = 'projects' | 'jira' | 'accounts' | 'prefs';
const TABS: { key: Tab; label: string }[] = [
  { key: 'projects', label: '워크스페이스·프로젝트' },
  { key: 'jira', label: 'Jira' },
  { key: 'accounts', label: '테스트 계정' },
  { key: 'prefs', label: 'Claude와 알림' },
];
const TAB_KEY = 'wts:settings-tab';

export default function SettingsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [gh, setGh] = useState<{ installed: boolean; loggedIn: boolean; account: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 보던 탭을 기억한다. Jira 로그인에서 돌아오면(?jira=) Jira 탭을 연다.
  const [tab, setTabRaw] = useState<Tab>(() => {
    if (new URLSearchParams(location.search).has('jira')) return 'jira';
    try { const t = localStorage.getItem(TAB_KEY) as Tab | null; return t && TABS.some((x) => x.key === t) ? t : 'projects'; } catch { return 'projects'; }
  });
  const setTab = (t: Tab) => { setTabRaw(t); setError(null); setNotice(null); try { localStorage.setItem(TAB_KEY, t); } catch { /* 사생활 보호 모드 등 */ } };

  const reload = useCallback(() => {
    Promise.all([api.projects(), api.workspaces(), api.settings(), api.accounts()])
      .then(([p, w, s, a]) => { setProjects(p); setWorkspaces(w); setSettings(s); setAccounts(a.accounts); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => { api.githubStatus().then(setGh).catch(() => setGh(null)); }, []);

  const run = (fn: () => Promise<unknown>, ok?: string | ((result: unknown) => string)) => async () => {
    setError(null); setNotice(null);
    try { const r = await fn(); if (ok) setNotice(typeof ok === 'function' ? ok(r) : ok); reload(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="settings">
      <div className="page-head">
        <h1>설정</h1>
        {gh && (
          <span className="chip-status">
            <span className={`srv-dot ${gh.loggedIn ? 'running' : 'failed'}`} aria-hidden="true" />
            {!gh.installed ? 'gh CLI가 없습니다 (PR 생성에 필요)' : gh.loggedIn ? `gh 로그인됨${gh.account ? ` (${gh.account})` : ''} · PR 생성에만 사용` : 'gh 로그인 필요: 터미널에서 gh auth login'}
          </span>
        )}
      </div>
      <nav className="settings-tabs" role="tablist" aria-label="설정 분류">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`settings-tab${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'accounts' && accounts.length > 0 && <span className="panel-menu-count">{accounts.length}</span>}
          </button>
        ))}
      </nav>
      {error && <p className="banner error" role="alert">{error}</p>}
      {notice && <p className="banner ok" role="status">{notice}</p>}
      {tab === 'projects' && <WorkspaceArea projects={projects} workspaces={workspaces} run={run} />}
      {tab === 'jira' && <JiraSection run={run} />}
      {tab === 'accounts' && <AccountsSection accounts={accounts} workspaces={workspaces} run={run} />}
      {tab === 'prefs' && settings && <PreferencesSection settings={settings} setSettings={setSettings} run={run} />}
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string | ((result: unknown) => string)) => () => Promise<void>;
type AnalysisState = { analyses: Record<number, Analysis>; analyze: (p: { id: number; name: string }) => Promise<void>; close: (id: number) => void };

/** 등록 결과 문구. 모노레포면 앱마다 등록되고, 실행 명령을 바꾼 이유(note)를 붙인다. */
function addedText(added: (Project & { note?: string | null })[], where: string) {
  const notes = added.flatMap((p) => (p.note ? [` ${p.name}: ${p.note}`] : [])).join('');
  return (added.length > 1
    ? `한 저장소에서 앱 ${added.length}개를 찾아 ${where}에 등록했습니다: ${added.map((p) => p.name).join(', ')}. 세션에서는 워크트리 하나를 같이 씁니다.`
    : `${added[0]?.name ?? '프로젝트'}를 ${where}에 추가했습니다.`) + notes + ' Claude가 실행 방법을 더 살펴보는 중입니다.';
}

/**
 * 워크스페이스마다 카드 하나에 그 프로젝트를 담는다. 프로젝트는 한 줄 요약으로 보이고, 자세한 설정은 "설정"을 눌러 연다.
 * 워크스페이스에 넣지 않은 프로젝트는 맨 아래에 따로 모은다.
 */
function WorkspaceArea({ projects, workspaces, run }: { projects: Project[]; workspaces: Workspace[]; run: Run }) {
  // Claude가 실행 설정을 살펴본 결과. 프로젝트마다 하나, 그 프로젝트 줄 아래에 보여 준다.
  const [analyses, setAnalyses] = useState<Record<number, Analysis>>({});
  const analyze = async (p: { id: number; name: string }) => {
    setAnalyses((a) => ({ ...a, [p.id]: { name: p.name, status: 'running' } }));
    try {
      const data = await api.analyzeProject(p.id);
      setAnalyses((a) => ({ ...a, [p.id]: { name: p.name, status: 'done', data } }));
    } catch (e) {
      setAnalyses((a) => ({ ...a, [p.id]: { name: p.name, status: 'error', error: (e as Error).message } }));
    }
  };
  const close = (id: number) => setAnalyses((x) => { const n = { ...x }; delete n[id]; return n; });
  const state: AnalysisState = { analyses, analyze, close };
  const [name, setName] = useState('');
  const byId = new Map(projects.map((p) => [p.id, p]));
  const assigned = new Set(workspaces.flatMap((w) => w.projects.map((p) => p.id)));
  const loose = projects.filter((p) => !assigned.has(p.id));

  return (
    <>
      <p className="muted small settings-intro">
        워크스페이스는 세션을 만들 때 함께 여는 프로젝트 묶음입니다. 세션을 만들면 프로젝트마다 워크트리가 생기고(같은 저장소의 앱은 하나를 같이 씀), 맨 위 프로젝트가 Claude의 작업 위치가 됩니다.
        한 프로젝트를 여러 워크스페이스에 넣을 수 있습니다.
      </p>
      {workspaces.map((w) => (
        <WorkspaceCard key={w.id} w={w} items={w.projects.map((x) => byId.get(x.id)).filter((x): x is Project => Boolean(x))} all={projects} run={run} state={state} />
      ))}
      <form className="card ws-new" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.createWorkspace(name, []); setName(''); }, `워크스페이스 ${name.trim()}을(를) 만들었습니다. 프로젝트 폴더를 추가하세요.`)(); }}>
        <label className="field grow">
          <span>새 워크스페이스</span>
          <input value={name} placeholder="예: DRMS, RE100" onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="dark" disabled={!name.trim()}>만들기</button>
      </form>
      {(loose.length > 0 || workspaces.length === 0) && (
        <section className="card ws-card">
          <div className="ws-head">
            <h2>워크스페이스에 없는 프로젝트</h2>
            <span className="muted small">세션에 쓰려면 워크스페이스에 넣으세요</span>
          </div>
          <ul className="ws-projects">
            {loose.map((p) => (
              <li key={p.id}>
                <ProjectItem p={p} run={run} state={state} extra={workspaces.length > 0 && (
                  <select className="small-select" aria-label={`${p.name} 넣을 워크스페이스`} value="" onChange={(e) => {
                    const w = workspaces.find((x) => x.id === Number(e.target.value));
                    if (w) run(() => api.setWorkspaceProjects(w.id, [...w.projects.map((x) => x.id), p.id]), `${p.name}을(를) ${w.name}에 넣었습니다.`)();
                  }}>
                    <option value="">워크스페이스에 넣기…</option>
                    {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                )} />
              </li>
            ))}
          </ul>
          <AddFolder run={run} state={state} />
        </section>
      )}
    </>
  );
}

function WorkspaceCard({ w, items, all, run, state }: { w: Workspace; items: Project[]; all: Project[]; run: Run; state: AnalysisState }) {
  const ids = items.map((p) => p.id);
  const others = all.filter((p) => !ids.includes(p.id));
  const [name, setName] = useState(w.name);
  useEffect(() => setName(w.name), [w.name]);
  const saveName = () => { if (name.trim() && name.trim() !== w.name) run(() => api.updateWorkspace(w.id, { name: name.trim() }), '이름을 바꿨습니다.')(); };
  const move = (i: number, d: number) => {
    const n = [...ids];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    run(() => api.setWorkspaceProjects(w.id, n))();
  };
  return (
    <section className="card ws-card" aria-label={`${w.name} 워크스페이스`}>
      <div className="ws-head">
        <input className="ws-name" aria-label="워크스페이스 이름" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveName(); } }} />
        <span className="muted small">프로젝트 {items.length}개</span>
        <div className="spacer" />
        <JiraKeyInput workspace={w} run={run} />
        <button className="danger small-btn" onClick={() => { if (confirm(`${w.name} 워크스페이스를 지울까요? 프로젝트 등록은 남습니다.`)) run(() => api.deleteWorkspace(w.id))(); }}>삭제</button>
      </div>
      <ul className="ws-projects">
        {items.map((p, i) => (
          <li key={p.id}>
            <ProjectItem p={p} run={run} state={state} first={i === 0} extra={(
              <>
                <button className="icon bordered" aria-label={`${p.name} 위로`} title="위로 (맨 위가 Claude 작업 위치)" disabled={i === 0} onClick={() => move(i, -1)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                </button>
                <button className="icon bordered" aria-label={`${p.name} 아래로`} title="아래로" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                <button className="small-btn" title="이 워크스페이스에서만 뺍니다. 프로젝트 등록은 남습니다" onClick={() => run(() => api.setWorkspaceProjects(w.id, ids.filter((x) => x !== p.id)), `${p.name}을(를) ${w.name}에서 뺐습니다.`)()}>빼기</button>
              </>
            )} />
          </li>
        ))}
        {items.length === 0 && <li className="muted small ws-empty">아직 프로젝트가 없습니다. 아래에 클론해 둔 폴더를 추가하세요.</li>}
      </ul>
      <div className="ws-add">
        <AddFolder run={run} state={state} workspace={w} />
        {others.length > 0 && (
          <select className="small-select" aria-label={`${w.name}에 등록된 프로젝트 넣기`} value="" onChange={(e) => {
            const id = Number(e.target.value);
            if (id) run(() => api.setWorkspaceProjects(w.id, [...ids, id]), `${all.find((p) => p.id === id)?.name}을(를) ${w.name}에 넣었습니다.`)();
          }}>
            <option value="">등록된 프로젝트 넣기…</option>
            {others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
    </section>
  );
}

/** 로컬 클론 폴더를 분석해 등록한다. 워크스페이스 카드에서 쓰면 바로 그 워크스페이스에 넣는다. 결과는 칸 바로 아래에 보여 준다. */
function AddFolder({ run, state, workspace }: { run: Run; state: AnalysisState; workspace?: Workspace }) {
  const [path, setPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="add-folder">
      <form className="add-row" onSubmit={async (e) => {
        e.preventDefault();
        if (adding) return;
        setAdding(true); setResult(null);
        try {
          const added = await api.addProject(path, workspace?.id);
          setPath('');
          setResult({ ok: true, text: addedText(added, workspace ? workspace.name : '프로젝트 목록') });
          await run(async () => {})();
          // 등록하자마자 Claude가 실행 방법을 더 꼼꼼히 살펴본다(차례로, 하나에 1분쯤). 제안은 그 프로젝트 줄 아래에 뜬다.
          (async () => { for (const p of added) await state.analyze(p); })();
        } catch (err) {
          setResult({ ok: false, text: (err as Error).message });
        } finally {
          setAdding(false);
        }
      }}>
        <label className="field grow">
          <span className="sr-only">클론 폴더 경로</span>
          <input className="mono" value={path} placeholder="클론 폴더 경로 (예: ~/IdeaProjects/be-drms)" onChange={(e) => setPath(e.target.value)} />
        </label>
        <button type="submit" className="dark" disabled={!path.trim() || adding}>{adding ? '분석하는 중' : '폴더 분석 후 추가'}</button>
      </form>
      {result && <p className={`banner ${result.ok ? 'ok' : 'error'}`} role={result.ok ? 'status' : 'alert'}>{result.text}</p>}
    </div>
  );
}

const KIND_LABEL: Record<ProjectKind, string> = { be: 'BE', fe: 'FE', full: '통합', unknown: '미정' };

/** 프로젝트 한 줄 요약. "설정"으로 자세한 설정을 펼치고, Claude 분석 제안은 이 줄 아래에 뜬다. */
function ProjectItem({ p, run, state, first, extra }: { p: Project; run: Run; state: AnalysisState; first?: boolean; extra?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const analysis = state.analyses[p.id];
  return (
    <div className="pj">
      <div className="pj-row">
        <span className={`kind ${p.kind}`}>{KIND_LABEL[p.kind]}</span>
        <div className="pj-main">
          <div className="pj-title">
            <strong>{p.name}</strong>
            {first && <span className="pill accent" title="세션에서 Claude가 이 폴더에서 작업합니다">Claude 작업 위치</span>}
            {p.missing && <span className="pill warn">폴더 없음</span>}
          </div>
          <div className="muted small mono pj-path">{p.local_path}</div>
          <div className="small pj-cmd"><span className="muted">실행</span> <code>{p.start_cmd || '없음 (설정에서 넣으세요)'}</code>{p.app_url && <> <span className="muted">· {p.app_url}</span></>}</div>
        </div>
        <div className="pj-actions">
          {extra}
          <button className="small-btn" disabled={analysis?.status === 'running'} title="Claude가 저장소를 읽고 로그인 없이 바로 뜨는 실행 방법을 제안합니다" onClick={() => state.analyze(p)}>
            {analysis?.status === 'running' ? '분석 중' : '다시 분석'}
          </button>
          <button className="small-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '접기' : '설정'}</button>
          <button className="small-btn danger" title="프로젝트 등록을 지웁니다. 폴더는 지우지 않습니다"
            onClick={() => { if (confirm(`${p.name} 등록을 지울까요? 폴더는 지우지 않고, 모든 워크스페이스에서 빠집니다.`)) run(() => api.deleteProject(p.id), `${p.name} 등록을 지웠습니다.`)(); }}>삭제</button>
        </div>
      </div>
      {analysis && (
        <AnalysisCard projectId={p.id} analysis={analysis} onClose={() => state.close(p.id)}
          onApplied={(text) => { state.close(p.id); run(async () => {}, text)(); }} />
      )}
      {open && <ProjectEditor p={p} run={run} />}
    </div>
  );
}

type Analysis = { name: string; status: 'running' | 'done' | 'error'; data?: ProjectAnalysis; error?: string };

const FIELD_LABEL: Record<AnalyzeField, string> = {
  start_cmd: '실행', setup_cmd: '설치', check_cmd: 'PR 전 검사', health_path: '헬스체크',
  port_env: '포트 변수', api_env_key: 'BE 주소 변수', app_url: '접속 주소', login_path: '로그인 경로',
};

/** Claude의 실행 설정 제안. 고른 항목만 프로젝트 설정에 넣고, 필요한 환경값 키는 기본 프로필에 필수로 더한다. */
function AnalysisCard({ projectId, analysis, onClose, onApplied }: { projectId: number; analysis: Analysis; onClose: () => void; onApplied: (text: string) => void }) {
  const [rows, setRows] = useState<{ field: AnalyzeField; value: string; current: string | null; reason: string; on: boolean }[]>([]);
  const [keys, setKeys] = useState<{ key: string; reason: string; on: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!analysis.data) return;
    setRows(analysis.data.suggestions.map((s) => ({ ...s, on: true })));
    setKeys(analysis.data.env_keys.map((k) => ({ ...k, on: true })));
  }, [analysis.data]);
  const chosen = rows.filter((r) => r.on);
  const chosenKeys = keys.filter((k) => k.on);
  return (
    <div className="analysis-card" aria-live="polite">
      <div className="analysis-head">
        <strong>{analysis.name}</strong>
        <span className="muted small">
          {analysis.status === 'running' ? 'Claude가 README·스크립트·설정 파일을 읽고 로그인 없이 바로 뜨는 실행 방법을 찾는 중 (1분쯤)'
            : analysis.status === 'error' ? '살펴보지 못했습니다'
            : rows.length || keys.length ? '실행 설정 제안. 고른 것만 적용합니다' : '지금 설정 그대로 실행할 수 있어 보입니다'}
        </span>
        {analysis.status === 'running' && <span className="spinner" aria-hidden="true" />}
        <div className="spacer" />
        {analysis.status !== 'running' && <button className="small-btn" onClick={onClose}>닫기</button>}
      </div>
      {analysis.status === 'error' && <p className="error-text small">{analysis.error}</p>}
      {rows.length > 0 && (
        <table className="analysis-table">
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.field}>
                <td><input type="checkbox" aria-label={`${FIELD_LABEL[r.field]} 적용`} checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /></td>
                <td className="analysis-field">{FIELD_LABEL[r.field]}</td>
                <td>
                  <input className="mono" aria-label={`${FIELD_LABEL[r.field]} 값`} value={r.value} disabled={!r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <div className="muted small">{r.reason}{r.current ? ` · 지금: ${r.current}` : ''}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {keys.length > 0 && (
        <div className="analysis-keys">
          <span className="small strong">바로 실행할 때 넣어야 할 환경값</span>
          {keys.map((k, i) => (
            <label key={k.key} className="small">
              <input type="checkbox" checked={k.on} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
              <code>{k.key}</code> <span className="muted">{k.reason}</span>
            </label>
          ))}
          <span className="muted small">고른 키는 기본 환경값 프로필에 필수 항목(값 비움)으로 더해, 세션에서 서버를 띄우기 전에 값을 넣게 합니다.</span>
        </div>
      )}
      {analysis.data && analysis.data.notes.length > 0 && <ul className="analysis-notes small">{analysis.data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {error && <p className="error-text small" role="alert">{error}</p>}
      {(chosen.length > 0 || chosenKeys.length > 0) && (
        <div className="row">
          <button className="primary" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.applyAnalysis(projectId, Object.fromEntries(chosen.map((x) => [x.field, x.value])), chosenKeys.map(({ key, reason }) => ({ key, reason })));
              onApplied(`${analysis.name}: 설정 ${chosen.length}개를 적용했습니다${r.env_keys_added ? `, 필요한 환경값 키 ${r.env_keys_added}개를 더했습니다` : ''}.`);
            } catch (e) { setError((e as Error).message); setBusy(false); }
          }}>{busy ? '적용 중' : `고른 ${chosen.length + chosenKeys.length}개 적용`}</button>
        </div>
      )}
    </div>
  );
}

/** 프로젝트 자세한 설정. 바뀐 것이 있으면 저장 버튼이 생긴다. */
function ProjectEditor({ p, run }: { p: Project; run: Run }) {
  const initial = {
    kind: p.kind, start_cmd: p.start_cmd ?? '', check_cmd: p.check_cmd ?? '', health_path: p.health_path ?? '',
    port_env: p.port_env ?? '', api_env_key: p.api_env_key ?? '',
    login_path: p.login_path ?? '', setup_cmd: p.setup_cmd ?? '', commit_template: p.commit_template ?? '', app_url: p.app_url ?? '',
  };
  const [draft, setDraft] = useState(initial);
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some((k) => draft[k] !== initial[k]);
  const field = (key: keyof typeof initial, label: string, placeholder: string, title?: string) => (
    <label className="field">
      <span>{label}</span>
      <input className="mono" aria-label={`${p.name} ${label}`} placeholder={placeholder} title={title} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </label>
  );
  return (
    <div className="pj-editor">
      <div className="muted small">
        {p.missing ? '폴더를 찾을 수 없음' : `현재 ${p.current_branch ?? '분리된 HEAD'} · 워크트리 ${p.worktrees}개${p.origin ? ` · ${p.origin.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1')}` : ''}`}
      </div>
      <div className="pj-grid">
        <label className="field">
          <span>종류</span>
          <select aria-label={`${p.name} 종류`} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ProjectKind })}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
        {field('start_cmd', '실행 명령', 'npm run dev -- -p {port}', '{port} 자리에 세션마다 배정한 포트가 들어갑니다')}
        {field('setup_cmd', '설치 명령', 'npm ci, uv sync', '새 워크트리에서 처음 실행할 때 한 번 돌립니다')}
        {field('check_cmd', 'PR 전 검사', './gradlew build')}
        {field('port_env', '포트 변수', 'PORT')}
        {field('health_path', '헬스체크 경로', '/')}
        {field('app_url', '접속 주소', 'http://localhost:{port}', 'HTTPS 개발 서버면 https://localhost:{port}, 인증서 도메인으로 열어야 하면 https://local.example.com:{port}')}
        {p.kind !== 'be' && field('api_env_key', 'BE 주소 변수', 'VITE_API_URL')}
        {p.kind !== 'be' && field('login_path', '로그인 경로 (미리보기)', '/login')}
        {field('commit_template', '커밋 템플릿', '자동 (저장소에서 찾음)', '저장소 기준 상대 경로나 절대 경로. 비우면 저장소에서 찾습니다')}
      </div>
      <div className="row">
        {dirty && <button className="primary" onClick={run(() => api.updateProject(p.id, { ...draft, start_cmd: draft.start_cmd || null, check_cmd: draft.check_cmd || null, health_path: draft.health_path || null, port_env: draft.port_env || null, api_env_key: draft.api_env_key || null, login_path: draft.login_path.trim() || null, setup_cmd: draft.setup_cmd.trim() || null, commit_template: draft.commit_template.trim() || null, app_url: draft.app_url.trim() || null }), `${p.name} 설정을 저장했습니다.`)}>저장</button>}
      </div>
    </div>
  );
}

/** 워크스페이스의 Jira 프로젝트 키. 바꾸고 나가거나 Enter를 누르면 저장한다. */
function JiraKeyInput({ workspace, run }: { workspace: Workspace; run: Run }) {
  const [key, setKey] = useState(workspace.jira_project ?? '');
  useEffect(() => setKey(workspace.jira_project ?? ''), [workspace.jira_project]);
  const save = () => { if ((workspace.jira_project ?? '') !== key.trim().toUpperCase()) run(() => api.updateWorkspace(workspace.id, { jira_project: key.trim() || null }), 'Jira 프로젝트 키를 저장했습니다.')(); };
  return (
    <label className="jira-key">
      <span className="muted small">Jira 프로젝트</span>
      <input className="mono" aria-label={`${workspace.name} Jira 프로젝트 키`} placeholder="예: KERE" value={key}
        onChange={(e) => setKey(e.target.value.toUpperCase())} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
    </label>
  );
}

/**
 * Jira 연결: Atlassian 공식 MCP 서버의 OAuth로 로그인한다. 키나 앱 등록 없이 버튼 하나로 끝난다.
 */
function JiraSection({ run }: { run: Run }) {
  const [cfg, setCfg] = useState<JiraConfig | null>(null);
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => {
    api.jiraConfig().then(setCfg).catch(() => {});
    api.jiraStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    reload();
    // 로그인에서 돌아왔으면 주소의 표시를 지운다.
    const url = new URL(location.href);
    if (url.searchParams.has('jira') || url.searchParams.get('view') === 'settings') {
      url.searchParams.delete('jira'); url.searchParams.delete('view');
      history.replaceState(null, '', url);
    }
  }, [reload]);
  if (!cfg) return null;
  return (
    <section className="card">
      <div className="card-head split">
        <div>
          <h2>Jira</h2>
          <p className="muted small">세션을 만들 때 워크스페이스의 Jira 프로젝트에서 티켓을 고르거나 새로 만듭니다. Atlassian 계정으로 로그인만 하면 되고, 로그인 정보는 암호화해 저장하며 만료되면 자동으로 이어집니다.</p>
        </div>
        <span className="chip-status">
          <span className={`srv-dot ${status?.connected ? 'running' : cfg.logged_in ? 'failed' : 'idle'}`} aria-hidden="true" />
          {status?.connected ? `연결됨 · ${status.user}` : status?.error ?? '로그인 필요'}
        </span>
      </div>
      <div className="jira-login">
        {cfg.logged_in && cfg.sites.length > 1 && (
          <label className="field">
            <span>Jira 사이트</span>
            <select value={cfg.site?.id ?? ''} onChange={(e) => run(async () => { setStatus(await api.jiraChooseSite(e.target.value)); reload(); }, 'Jira 사이트를 바꿨습니다.')()}>
              {cfg.sites.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.url.replace('https://', '')})</option>)}
            </select>
          </label>
        )}
        {cfg.logged_in && cfg.sites.length <= 1 && cfg.site && <span className="small muted">사이트 <code>{cfg.site.url.replace('https://', '')}</code></span>}
        <span className="spacer" />
        {cfg.logged_in && <button type="button" onClick={run(async () => { await api.jiraLogout(); reload(); }, 'Jira에서 로그아웃했습니다.')}>로그아웃</button>}
        <button type="button" className="primary" disabled={busy} onClick={async () => {
          setBusy(true);
          await run(async () => { location.href = (await api.jiraLoginUrl(location.origin)).url; })();
          setBusy(false);
        }}>{busy ? 'Atlassian으로 이동 중' : cfg.logged_in ? '다시 로그인' : 'Jira로 로그인'}</button>
      </div>
    </section>
  );
}

// 빈 값 = Claude Code 기본 모델(보조 작업에 따로 정하지 않음).
const HELPER_MODEL_OPTIONS = [
  { value: '', label: '기본 모델' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
];
// 서버 models.ts HELPER_PURPOSES와 같은 목록. hint는 토큰·속도를 줄이고 싶을 때의 권장 모델이다.
export const HELPER_TASKS = [
  { key: 'pr_draft', label: 'PR 문안', hint: 'Haiku' },
  { key: 'ticket_draft', label: 'Jira 티켓 초안', hint: 'Haiku' },
  { key: 'screens', label: '영향 화면 찾기', hint: 'Sonnet' },
  { key: 'test_cases', label: '화면 테스트 케이스 만들기', hint: 'Sonnet' },
  { key: 'test_run', label: '화면 테스트 실행', hint: 'Sonnet' },
  { key: 'env_scan', label: '환경값 AI 분석', hint: 'Sonnet' },
  { key: 'env_suggest', label: '서버 설정 제안', hint: 'Sonnet' },
  { key: 'project_analyze', label: '프로젝트 분석', hint: 'Sonnet' },
  { key: 'conflict', label: '머지 충돌 해결안', hint: '기본 모델' },
];

function PreferencesSection({ settings, setSettings, run }: { settings: Settings; setSettings: (s: Settings) => void; run: Run }) {
  const n = settings.notify;
  const setN = (patch: Partial<Settings['notify']>) => setSettings({ ...settings, notify: { ...n, ...patch } });
  const hm = settings.helperModels ?? {};
  const setHm = (key: string, value: string) => setSettings({ ...settings, helperModels: { ...hm, [key]: value } });
  return (
    <section className="card">
      <div className="card-head"><div><h2>Claude와 알림</h2><p className="muted small">알림은 로컬 서버가 OS 알림으로 보내므로 브라우저 탭을 닫아도 옵니다.</p></div></div>
      <div className="prefs">
        <label className="field">
          <span>권한 모드</span>
          <select value={settings.permissionMode} onChange={(e) => setSettings({ ...settings, permissionMode: e.target.value as PermissionMode })}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <fieldset className="checks column helper-models">
          <legend>보조 작업 모델</legend>
          <p className="muted small">대화 밖에서 Studio가 Claude를 따로 부르는 작업입니다. 기본 모델은 Claude Code 설정을 따릅니다. 가벼운 모델일수록 빠르고 토큰이 적지만 결과가 덜 정확할 수 있습니다.</p>
          {HELPER_TASKS.map((t) => (
            <label key={t.key} className="inline">
              <span className="helper-label">{t.label}</span>
              <select id={`helper-model-${t.key}`} value={hm[t.key] ?? ''} onChange={(e) => setHm(t.key, e.target.value)}>
                {HELPER_MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="muted small">권장 {t.hint}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="checks column">
          <legend>알릴 일</legend>
          <label><input type="checkbox" checked={n.onComplete} onChange={(e) => setN({ onComplete: e.target.checked })} /> 프롬프트 작업이 끝났을 때</label>
          <label><input type="checkbox" checked={n.onError} onChange={(e) => setN({ onError: e.target.checked })} /> 작업이 오류로 멈췄을 때</label>
          <label><input type="checkbox" checked={n.onServerFail} onChange={(e) => setN({ onServerFail: e.target.checked })} /> 서버가 예기치 않게 멈췄을 때</label>
          <label><input type="checkbox" checked={n.onPr} onChange={(e) => setN({ onPr: e.target.checked })} /> PR을 만들었거나 검사가 실패했을 때</label>
          <label><input type="checkbox" checked={n.onCleanup} onChange={(e) => setN({ onCleanup: e.target.checked })} /> PR이 머지·닫혀 정리할 수 있을 때, 오래 쉰 세션</label>
        </fieldset>
        <fieldset className="checks column">
          <legend>알리는 방법</legend>
          <label><input type="checkbox" checked={n.os} onChange={(e) => setN({ os: e.target.checked })} /> OS 알림</label>
          <label><input type="checkbox" checked={n.sound} onChange={(e) => setN({ sound: e.target.checked })} /> 소리</label>
          <label><input type="checkbox" checked={n.skipWhenViewing} onChange={(e) => setN({ skipWhenViewing: e.target.checked })} /> 이 세션을 보고 있을 때는 알리지 않기</label>
          <label className="inline">
            이보다 오래 걸린 작업만 알리기
            <input type="number" min={0} max={3600} value={n.minSeconds} onChange={(e) => setN({ minSeconds: Math.max(0, Number(e.target.value) || 0) })} />초
          </label>
        </fieldset>
      </div>
      <div className="row">
        <button className="primary" onClick={run(() => api.saveSettings(settings), '설정을 저장했습니다.')}>설정 저장</button>
        <button onClick={run(() => api.testNotify(), '테스트 알림을 보냈습니다.')}>테스트 알림 보내기</button>
      </div>
    </section>
  );
}

function AccountsSection({ accounts, workspaces, run }: { accounts: Account[]; workspaces: Workspace[]; run: Run }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  // 새 계정은 기본으로 첫 워크스페이스 것. ''는 공용.
  const [wsId, setWsId] = useState<number | ''>('');
  useEffect(() => { if (wsId === '' && workspaces[0] && accounts.length === 0) setWsId(workspaces[0].id); }, [workspaces]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>테스트 계정 풀 <span className="muted small">{accounts.length}개</span></h2>
          <p className="muted small">세션은 자기 워크스페이스 계정과 공용 계정을 모두 쓸 수 있고, 여러 세션이 같은 계정을 같이 씁니다. 메모에 역할(사업자, 지자체, 관리자 등)을 적어 두면 Claude와 화면 테스트에서 골라 씁니다. 비밀번호는 암호화해 저장합니다.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>워크스페이스</th><th>계정</th><th>메모</th><th><span className="sr-only">작업</span></th></tr></thead>
          <tbody>
            {accounts.length === 0 && <tr><td colSpan={4} className="muted">등록된 계정이 없습니다.</td></tr>}
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  <select aria-label={`${a.login} 워크스페이스`} value={a.workspace_id ?? ''} onChange={(e) => run(() => api.updateAccount(a.id, { workspace_id: e.target.value ? Number(e.target.value) : null }), '워크스페이스를 바꿨습니다.')()}>
                    {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    <option value="">공용 (모든 워크스페이스)</option>
                  </select>
                </td>
                <td className="mono">{a.login}</td>
                <td className="muted">{a.note}</td>
                <td className="actions">
                  <button className="danger" onClick={() => { if (confirm(`${a.login} 계정을 풀에서 지울까요?`)) run(() => api.deleteAccount(a.id))(); }}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.addAccount(login, password, note, wsId === '' ? null : wsId); setLogin(''); setPassword(''); setNote(''); }, '계정을 추가했습니다.')(); }}>
        <label className="field"><span>워크스페이스</span>
          <select value={wsId} onChange={(e) => setWsId(e.target.value ? Number(e.target.value) : '')}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            <option value="">공용</option>
          </select>
        </label>
        <label className="field"><span>계정</span><input className="mono" autoComplete="off" value={login} placeholder="qa-03@60hz.io" onChange={(e) => setLogin(e.target.value)} /></label>
        <label className="field"><span>비밀번호</span><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label className="field grow"><span>메모 <span className="muted">(선택)</span></span><input value={note} placeholder="역할 예: 사업자, 지자체(광역), 관리자" onChange={(e) => setNote(e.target.value)} /></label>
        <button type="submit" className="dark" disabled={!login.trim() || !password}>계정 추가</button>
      </form>
    </section>
  );
}
