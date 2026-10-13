import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Account, PermissionMode, Project, ProjectKind, Settings, Workspace } from '../types';

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

export default function SettingsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [gh, setGh] = useState<{ installed: boolean; loggedIn: boolean; account: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([api.projects(), api.workspaces(), api.settings(), api.accounts()])
      .then(([p, w, s, a]) => { setProjects(p); setWorkspaces(w); setSettings(s); setAccounts(a.accounts); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => { api.githubStatus().then(setGh).catch(() => setGh(null)); }, []);

  const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
    setError(null); setNotice(null);
    try { await fn(); if (ok) setNotice(ok); reload(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="settings">
      <div className="page-head">
        <h1>프로젝트와 설정</h1>
        {gh && (
          <span className="chip-status">
            <span className={`srv-dot ${gh.loggedIn ? 'running' : 'failed'}`} aria-hidden="true" />
            {!gh.installed ? 'gh CLI가 없습니다 (PR 생성에 필요)' : gh.loggedIn ? `gh 로그인됨${gh.account ? ` (${gh.account})` : ''} · PR 생성에만 사용` : 'gh 로그인 필요: 터미널에서 gh auth login'}
          </span>
        )}
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {notice && <p className="banner ok" role="status">{notice}</p>}
      <ProjectsSection projects={projects} run={run} />
      <WorkspacesSection projects={projects} workspaces={workspaces} run={run} />
      <AccountsSection accounts={accounts} run={run} />
      {settings && <PreferencesSection settings={settings} setSettings={setSettings} run={run} />}
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => () => Promise<void>;

function ProjectsSection({ projects, run }: { projects: Project[]; run: Run }) {
  const [path, setPath] = useState('');
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>프로젝트</h2>
          <p className="muted small">로컬에 클론해 둔 폴더를 등록합니다. 브랜치와 원격 주소는 폴더의 git 정보에서 읽습니다.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="projects-table">
          <thead><tr><th>로컬 폴더</th><th>종류</th><th>명령 <span className="muted">({'{port}'} 자리에 포트)</span></th><th>변수와 헬스체크</th><th>미리보기 로그인 <span className="muted">(FE)</span></th><th><span className="sr-only">저장, 삭제</span></th></tr></thead>
          <tbody>
            {projects.length === 0 && <tr><td colSpan={6} className="muted">등록된 프로젝트가 없습니다. 아래에 클론 폴더 경로를 넣으세요.</td></tr>}
            {projects.map((p) => <ProjectRow key={p.id} p={p} run={run} />)}
          </tbody>
        </table>
      </div>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.addProject(path); setPath(''); }, '프로젝트를 추가했습니다.')(); }}>
        <label className="field grow">
          <span>로컬 폴더 추가</span>
          <input className="mono" value={path} placeholder="~/IdeaProjects/be-drms" onChange={(e) => setPath(e.target.value)} />
        </label>
        <button type="submit" className="dark" disabled={!path.trim()}>폴더 분석 후 추가</button>
      </form>
    </section>
  );
}

function ProjectRow({ p, run }: { p: Project; run: Run }) {
  const initial = {
    kind: p.kind, start_cmd: p.start_cmd ?? '', check_cmd: p.check_cmd ?? '', health_path: p.health_path ?? '',
    port_env: p.port_env ?? '', api_env_key: p.api_env_key ?? '',
    login_path: p.login_path ?? '', setup_cmd: p.setup_cmd ?? '', commit_template: p.commit_template ?? '',
  };
  const [draft, setDraft] = useState(initial);
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some((k) => draft[k] !== initial[k]);
  return (
    <tr>
      <td>
        <div className="mono strong">{p.local_path}</div>
        <div className="muted small">
          {p.missing ? '폴더를 찾을 수 없음' : `현재 ${p.current_branch ?? '분리된 HEAD'} · 워크트리 ${p.worktrees}개${p.origin ? ` · ${p.origin.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1')}` : ''}`}
        </div>
      </td>
      <td>
        <select aria-label={`${p.name} 종류`} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ProjectKind })}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </td>
      <td>
        <div className="stacked">
          <label className="mini"><span>설치</span><input aria-label={`${p.name} 설치 명령`} className="mono" placeholder="uv sync, npm ci" title="새 워크트리에서 처음 실행할 때 한 번 돌립니다" value={draft.setup_cmd} onChange={(e) => setDraft({ ...draft, setup_cmd: e.target.value })} /></label>
          <label className="mini"><span>실행</span><input aria-label={`${p.name} 실행 명령`} className="mono" value={draft.start_cmd} onChange={(e) => setDraft({ ...draft, start_cmd: e.target.value })} /></label>
          <label className="mini"><span>커밋 템플릿</span><input aria-label={`${p.name} 커밋 메시지 템플릿 경로`} className="mono" placeholder="자동 (저장소에서 찾음)" title="저장소 기준 상대 경로나 절대 경로. 비우면 commit_template*.md, .gitmessage, git config commit.template 순으로 찾고, 없으면 같은 세션의 다른 저장소 것을 씁니다." value={draft.commit_template} onChange={(e) => setDraft({ ...draft, commit_template: e.target.value })} /></label>
          <label className="mini"><span>PR 전 검사</span><input aria-label={`${p.name} 검사 명령`} className="mono" placeholder="./gradlew build" value={draft.check_cmd} onChange={(e) => setDraft({ ...draft, check_cmd: e.target.value })} /></label>
        </div>
      </td>
      <td>
        <div className="stacked">
          <label className="mini"><span>포트 변수</span><input aria-label={`${p.name} 포트 변수`} className="mono" placeholder="PORT" value={draft.port_env} onChange={(e) => setDraft({ ...draft, port_env: e.target.value })} /></label>
          {p.kind !== 'be' && <label className="mini"><span>BE 주소 변수</span><input aria-label={`${p.name} BE 주소 변수`} className="mono" placeholder="VITE_API_URL" value={draft.api_env_key} onChange={(e) => setDraft({ ...draft, api_env_key: e.target.value })} /></label>}
          <label className="mini"><span>헬스체크</span><input aria-label={`${p.name} 헬스체크 경로`} className="mono" placeholder="/" value={draft.health_path} onChange={(e) => setDraft({ ...draft, health_path: e.target.value })} /></label>
        </div>
      </td>
      <td>
        {p.kind === 'be' ? <span className="muted small">BE는 해당 없음</span> : (
          <div className="stacked">
            <label className="mini"><span>로그인 경로</span><input aria-label={`${p.name} 로그인 경로`} className="mono" placeholder="/login (선택)" value={draft.login_path} onChange={(e) => setDraft({ ...draft, login_path: e.target.value })} /></label>
          </div>
        )}
      </td>
      <td className="actions">
        {dirty && <button onClick={run(() => api.updateProject(p.id, { ...draft, start_cmd: draft.start_cmd || null, check_cmd: draft.check_cmd || null, health_path: draft.health_path || null, port_env: draft.port_env || null, api_env_key: draft.api_env_key || null, login_path: draft.login_path.trim() || null, setup_cmd: draft.setup_cmd.trim() || null, commit_template: draft.commit_template.trim() || null }), '저장했습니다.')}>저장</button>}
        <button className="danger" onClick={() => { if (confirm(`${p.name} 등록을 지울까요? 폴더는 지우지 않습니다.`)) run(() => api.deleteProject(p.id))(); }}>삭제</button>
      </td>
    </tr>
  );
}

function WorkspacesSection({ projects, workspaces, run }: { projects: Project[]; workspaces: Workspace[]; run: Run }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  return (
    <section className="card">
      <div className="card-head"><div><h2>워크스페이스</h2><p className="muted small">함께 작업할 프로젝트 묶음입니다. 세션을 만들면 묶인 프로젝트마다 워크트리가 생깁니다. 첫 번째 프로젝트가 Claude의 작업 위치가 됩니다.</p></div></div>
      <ul className="ws-list">
        {workspaces.map((w) => (
          <li key={w.id}>
            <strong>{w.name}</strong> <span className="muted">{w.projects.map((p) => p.name).join(' + ')}</span>
            <button className="danger small-btn" onClick={() => { if (confirm(`${w.name} 워크스페이스를 지울까요?`)) run(() => api.deleteWorkspace(w.id))(); }}>삭제</button>
          </li>
        ))}
        {workspaces.length === 0 && <li className="muted">아직 없습니다.</li>}
      </ul>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.createWorkspace(name, picked); setName(''); setPicked([]); }, '워크스페이스를 만들었습니다.')(); }}>
        <label className="field">
          <span>이름</span>
          <input value={name} placeholder="DRMS" onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset className="checks">
          <legend>프로젝트 (고른 순서대로)</legend>
          {projects.map((p) => (
            <label key={p.id}>
              <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
              {p.name}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="dark" disabled={!name.trim() || picked.length === 0}>워크스페이스 만들기</button>
      </form>
    </section>
  );
}

function PreferencesSection({ settings, setSettings, run }: { settings: Settings; setSettings: (s: Settings) => void; run: Run }) {
  const n = settings.notify;
  const setN = (patch: Partial<Settings['notify']>) => setSettings({ ...settings, notify: { ...n, ...patch } });
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

function AccountsSection({ accounts, run }: { accounts: Account[]; run: Run }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const used = accounts.filter((a) => a.session_id).length;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>테스트 계정 풀 <span className="muted small">{accounts.length}개 중 {used}개 사용 중</span></h2>
          <p className="muted small">세션을 만들면 비어 있는 계정이 하나 배정되고, 역할이 다른 계정이 더 필요하면 세션 화면에서 추가합니다. 메모에 역할(사업자, 지자체, 관리자 등)을 적어 두면 Claude와 화면 촬영에서 골라 씁니다. 세션을 닫으면 돌아옵니다. 같은 계정으로 두 곳에 로그인해 세션이 끊기는 일을 막습니다. 비밀번호는 암호화해 저장합니다.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>계정</th><th>메모</th><th>상태</th><th>사용 세션</th><th><span className="sr-only">작업</span></th></tr></thead>
          <tbody>
            {accounts.length === 0 && <tr><td colSpan={5} className="muted">등록된 계정이 없습니다.</td></tr>}
            {accounts.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.login}</td>
                <td className="muted">{a.note}</td>
                <td><span className={`pill ${a.session_id ? 'accent' : 'ok'}`}>{a.session_id ? '사용 중' : '대기'}</span></td>
                <td>{a.ticket ?? <span className="muted">없음</span>}</td>
                <td className="actions">
                  {a.session_id && <button onClick={run(() => api.releaseAccountById(a.id), '계정을 반납했습니다.')}>반납</button>}
                  <button className="danger" onClick={() => { if (confirm(`${a.login} 계정을 풀에서 지울까요?`)) run(() => api.deleteAccount(a.id))(); }}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.addAccount(login, password, note); setLogin(''); setPassword(''); setNote(''); }, '계정을 추가했습니다.')(); }}>
        <label className="field"><span>계정</span><input className="mono" autoComplete="off" value={login} placeholder="qa-03@60hz.io" onChange={(e) => setLogin(e.target.value)} /></label>
        <label className="field"><span>비밀번호</span><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label className="field grow"><span>메모 <span className="muted">(선택)</span></span><input value={note} placeholder="역할 예: 사업자, 지자체(광역), 관리자" onChange={(e) => setNote(e.target.value)} /></label>
        <button type="submit" className="dark" disabled={!login.trim() || !password}>계정 추가</button>
      </form>
    </section>
  );
}
