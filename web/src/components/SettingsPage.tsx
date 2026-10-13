import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { PermissionMode, Project, ProjectKind, Settings, Workspace } from '../types';

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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([api.projects(), api.workspaces(), api.settings()])
      .then(([p, w, s]) => { setProjects(p); setWorkspaces(w); setSettings(s); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
    setError(null); setNotice(null);
    try { await fn(); if (ok) setNotice(ok); reload(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="settings">
      <h1>프로젝트와 설정</h1>
      {error && <p className="banner error" role="alert">{error}</p>}
      {notice && <p className="banner ok" role="status">{notice}</p>}
      <ProjectsSection projects={projects} run={run} />
      <WorkspacesSection projects={projects} workspaces={workspaces} run={run} />
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
        <table>
          <thead><tr><th>로컬 폴더</th><th>종류</th><th>실행</th><th>PR 전 검사</th><th>헬스체크</th><th><span className="sr-only">삭제</span></th></tr></thead>
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
  const [draft, setDraft] = useState({ kind: p.kind, start_cmd: p.start_cmd ?? '', check_cmd: p.check_cmd ?? '', health_path: p.health_path ?? '' });
  const dirty = draft.kind !== p.kind || draft.start_cmd !== (p.start_cmd ?? '') || draft.check_cmd !== (p.check_cmd ?? '') || draft.health_path !== (p.health_path ?? '');
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
      <td><input aria-label={`${p.name} 실행 명령`} className="mono" value={draft.start_cmd} onChange={(e) => setDraft({ ...draft, start_cmd: e.target.value })} /></td>
      <td><input aria-label={`${p.name} 검사 명령`} className="mono" value={draft.check_cmd} onChange={(e) => setDraft({ ...draft, check_cmd: e.target.value })} /></td>
      <td><input aria-label={`${p.name} 헬스체크 경로`} className="mono narrow" value={draft.health_path} onChange={(e) => setDraft({ ...draft, health_path: e.target.value })} /></td>
      <td className="actions">
        {dirty && <button onClick={run(() => api.updateProject(p.id, { ...draft, start_cmd: draft.start_cmd || null, check_cmd: draft.check_cmd || null, health_path: draft.health_path || null }), '저장했습니다.')}>저장</button>}
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
