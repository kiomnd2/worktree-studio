import { useEffect, useMemo, useState } from 'react';
import { api, missingFrom } from '../api';
import type { EnvSource, EnvVar, ProjectEnvState, ServerView, Session } from '../types';
import StartServersDialog from './StartServersDialog';

const SOURCE: Record<EnvSource | 'session', { label: string; cls: string }> = {
  ai: { label: 'AI 추정', cls: 'ai' },
  detected: { label: '분석', cls: 'ai' },
  clone: { label: '클론 .env', cls: 'clone' },
  profile: { label: '프로필', cls: 'profile' },
  manual: { label: '직접 추가', cls: 'manual' },
  session: { label: '이번 세션', cls: 'auto' },
};

type Row = EnvVar & { rid: string };
const rid = () => Math.random().toString(36).slice(2);
const toRows = (vars: EnvVar[]): Row[] => vars.map((v) => ({ ...v, rid: rid() }));

function parseDotenv(text: string): { key: string; value: string }[] {
  return text.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return [];
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) return [];
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    return [{ key: m[1], value: v }];
  });
}

type Props = { session: Session; message?: string; onBack: () => void; onStarted: () => void };

export default function EnvPage({ session, message, onBack, onStarted }: Props) {
  const [states, setStates] = useState<ProjectEnvState[] | null>(null);
  const [rows, setRows] = useState<Record<number, Row[]>>({});
  const [dirty, setDirty] = useState<Record<number, boolean>>({});
  const [saveMode, setSaveMode] = useState<'profile' | 'new' | 'session'>('profile');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(message ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [startTargets, setStartTargets] = useState<{ targets: ServerView[]; all: ServerView[] } | null>(null);

  function apply(next: ProjectEnvState[]) {
    setStates(next);
    setRows(Object.fromEntries(next.map((s) => [s.projectId, toRows(s.vars)])));
    setDirty({});
  }

  useEffect(() => { api.env(session.id).then(apply).catch((e) => setError(e.message)); }, [session.id]);

  const missingCount = useMemo(() => {
    if (!states) return 0;
    return states.reduce((n, s) => {
      const autoKeys = [...s.auto, ...s.db].map((a) => a.key);
      return n + (rows[s.projectId] ?? []).filter((r) => r.required && !r.value && !autoKeys.includes(r.key)).length;
    }, 0);
  }, [states, rows]);
  const filledCount = useMemo(() => Object.values(rows).flat().filter((r) => r.value).length, [rows]);

  const edit = (pid: number, fn: (rows: Row[]) => Row[]) => {
    setRows((prev) => ({ ...prev, [pid]: fn(prev[pid] ?? []) }));
    setDirty((d) => ({ ...d, [pid]: true }));
  };

  function merge(pid: number, found: EnvVar[], overwrite = false) {
    edit(pid, (cur) => {
      const next = [...cur];
      for (const f of found) {
        const hit = next.find((r) => r.key === f.key);
        if (hit) {
          if ((overwrite || !hit.value) && f.value) hit.value = f.value;
          if (f.source === 'ai') { hit.required = f.required; hit.reason = f.reason; if (hit.source !== 'manual') hit.source = 'ai'; }
          hit.found_in ??= f.found_in;
        } else {
          next.push({ ...f, rid: rid() });
        }
      }
      return next.sort((a, b) => Number(b.required && !b.value) - Number(a.required && !a.value));
    });
  }

  async function analyze(pid: number, ai: boolean) {
    setBusy(`${ai ? 'ai' : 'scan'}-${pid}`);
    setError(null);
    try {
      const found = await api.analyzeEnv(session.id, pid, ai, (rows[pid] ?? []).map((r) => r.key));
      merge(pid, found);
      setNotice(`${found.length}개 항목을 ${ai ? 'AI가 분석했습니다' : '찾았습니다'}. 저장해야 반영됩니다.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function switchProfile(pid: number, profileId: number) {
    if (dirty[pid] && !confirm('저장하지 않은 변경이 있습니다. 버리고 프로필을 바꿀까요?')) return;
    try { apply(await api.selectProfile(session.id, pid, profileId)); } catch (e) { setError((e as Error).message); }
  }

  async function removeProfile(pid: number, profileId: number, name: string) {
    if (!confirm(`${name} 프로필을 지울까요?`)) return;
    try { await api.deleteProfile(profileId); apply(await api.env(session.id)); } catch (e) { setError((e as Error).message); }
  }

  async function saveAll(): Promise<boolean> {
    if (!states) return false;
    if (saveMode === 'new' && !newName.trim()) { setError('새 프로필 이름을 넣어 주세요.'); return false; }
    const targets = states.filter((s) => dirty[s.projectId] || saveMode === 'new');
    let latest: ProjectEnvState[] | null = null;
    for (const s of targets) {
      const vars = (rows[s.projectId] ?? []).filter((r) => r.key.trim()).map(({ rid: _r, overridden: _o, reason: _x, ...v }) => v);
      latest = await api.saveEnv(session.id, { projectId: s.projectId, mode: saveMode, newName: newName.trim() || undefined, vars });
    }
    if (latest) apply(latest);
    if (saveMode === 'new') { setSaveMode('profile'); setNewName(''); }
    return true;
  }

  async function run(fn: () => Promise<void>, label: string) {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); } catch (e) {
      const missing = missingFrom(e);
      setError(missing ? `아직 비어 있는 필수 값: ${missing.map((m) => `${m.project} ${m.keys.join(', ')}`).join(' / ')}` : (e as Error).message);
    } finally { setBusy(null); }
  }

  if (!states) return <main className="main scroll"><div className="settings">{error ? <p className="banner error">{error}</p> : <p className="muted">불러오는 중</p>}</div></main>;

  return (
    <main className="main scroll">
      <div className="settings env">
        <div className="page-head">
          <div>
            <div className="muted small">{session.ticket} · 서버 실행 준비</div>
            <h1>{missingCount ? `값 ${missingCount}개만 더 넣으면 서버를 띄울 수 있습니다` : '환경값이 준비됐습니다'}</h1>
          </div>
          <div className="row">
            <span className="pill ok">채워짐 {filledCount}</span>
            {missingCount > 0 && <span className="pill warn">입력 필요 {missingCount}</span>}
            <button onClick={onBack}>세션 화면으로</button>
          </div>
        </div>
        <p className="muted">워크트리를 분석해 목록을 만들었습니다. 분석 결과는 틀릴 수 있으니 키, 값, 필수 여부를 고치거나 지우고, 빠진 변수는 직접 추가하세요. 포트와 BE 연결 주소는 도구가 정하고, DB 접속값은 설정 › 프로젝트 › 로컬 실행의 DB 연결에서 넣습니다.</p>
        <div className="legend">
          {(['ai', 'clone', 'profile', 'manual', 'session'] as const).map((k) => <span key={k} className={`src ${SOURCE[k].cls}`}>{SOURCE[k].label}</span>)}
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}
        {notice && <p className="banner ok" role="status">{notice}</p>}

        {states.map((s) => (
          <ProjectEnvCard
            key={s.projectId}
            state={s}
            rows={rows[s.projectId] ?? []}
            dirty={Boolean(dirty[s.projectId])}
            busy={busy}
            edit={(fn) => edit(s.projectId, fn)}
            onAnalyze={(ai) => analyze(s.projectId, ai)}
            onPaste={(text) => {
              const parsed = parseDotenv(text);
              merge(s.projectId, parsed.map((p) => ({ key: p.key, value: p.value, required: false, secret: false, source: 'manual', found_in: '붙여넣기' })), true);
              setNotice(`${parsed.length}개 값을 적용했습니다. 저장해야 반영됩니다.`);
            }}
            onSwitch={(id) => switchProfile(s.projectId, id)}
            onRemoveProfile={(id, name) => removeProfile(s.projectId, id, name)}
            onNewProfile={() => {
              setSaveMode('new');
              setNotice('아래 저장 방식에서 새 프로필 이름을 넣고 저장하세요. 지금 표의 값으로 만들어집니다.');
              document.getElementById('new-profile-name')?.focus();
            }}
          />
        ))}

        <div className="card save-bar">
          <fieldset className="checks">
            <legend className="sr-only">저장 방식</legend>
            <label><input type="radio" name="save" checked={saveMode === 'profile'} onChange={() => setSaveMode('profile')} /> 지금 프로필에 덮어쓰기</label>
            <label><input type="radio" name="save" checked={saveMode === 'new'} onChange={() => setSaveMode('new')} /> 새 프로필로 저장</label>
            {saveMode === 'new' && <input id="new-profile-name" autoFocus aria-label="새 프로필 이름" placeholder="local-kpx-mock" value={newName} onChange={(e) => setNewName(e.target.value)} />}
            <label><input type="radio" name="save" checked={saveMode === 'session'} onChange={() => setSaveMode('session')} /> 이번 세션에만 적용</label>
          </fieldset>
          <div className="row">
            <button disabled={Boolean(busy)} onClick={() => run(async () => { if (await saveAll()) setNotice('저장했습니다.'); }, 'save')}>저장</button>
            <button className="primary" disabled={Boolean(busy)} onClick={() => run(async () => {
              if (!(await saveAll())) return;
              const all = await api.servers(session.id);
              const targets = all.filter((s) => s.can_start && (s.status === 'idle' || s.status === 'failed' || s.status === 'stopped'));
              if (targets.length) { setStartTargets({ targets, all }); return; }
              await api.startServers(session.id);
              onStarted();
            }, 'start')}>{busy === 'start' ? '서버 띄우는 중' : '저장하고 서버 실행'}</button>
          </div>
        </div>
      </div>
      {startTargets && (
        <StartServersDialog
          sessionId={session.id}
          targets={startTargets.targets}
          all={startTargets.all}
          onCancel={() => setStartTargets(null)}
          onConfirm={async (commands, ports, docker) => {
            try {
              await api.startServers(session.id, undefined, commands, ports, docker);
            } catch (e) {
              const missing = missingFrom(e);
              if (missing) throw new Error(`아직 비어 있는 필수 값: ${missing.map((m) => `${m.project} ${m.keys.join(', ')}`).join(' / ')}`);
              throw e;
            }
            onStarted();
          }}
        />
      )}
    </main>
  );
}

type CardProps = {
  state: ProjectEnvState;
  rows: Row[];
  dirty: boolean;
  busy: string | null;
  edit: (fn: (rows: Row[]) => Row[]) => void;
  onAnalyze: (ai: boolean) => void;
  onPaste: (text: string) => void;
  onSwitch: (profileId: number) => void;
  onRemoveProfile: (profileId: number, name: string) => void;
  onNewProfile: () => void;
};

function ProjectEnvCard({ state, rows, dirty, busy, edit, onAnalyze, onPaste, onSwitch, onRemoveProfile, onNewProfile }: CardProps) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const autoKeys = state.auto.map((a) => a.key);
  const dbKeys = new Map(state.db.map((d) => [d.key, d.connection]));
  const selected = state.profiles.find((p) => p.id === state.selectedProfileId);
  const update = (r: string, patch: Partial<Row>) => edit((list) => list.map((x) => (x.rid === r ? { ...x, ...patch } : x)));

  return (
    <section className="card">
      <div className="card-head split">
        <h2>{state.project} <span className="mono small muted">{state.path}</span></h2>
        <div className="row profiles" role="group" aria-label={`${state.project} 프로필`}>
          <span className="muted small">프로필</span>
          {state.profiles.map((p) => (
            <button key={p.id} className={`small-btn${p.id === state.selectedProfileId ? ' dark' : ''}`} aria-pressed={p.id === state.selectedProfileId} onClick={() => onSwitch(p.id)}>
              {p.name}
            </button>
          ))}
          <button className="small-btn dashed" onClick={onNewProfile}>+ 새 프로필</button>
          {selected && state.profiles.length > 1 && (
            <button className="small-btn danger" onClick={() => onRemoveProfile(selected.id, selected.name)}>{selected.name} 삭제</button>
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table className="env-table">
          <thead><tr><th>키</th><th>값</th><th>찾은 곳</th><th>필수</th><th>출처</th><th><span className="sr-only">삭제</span></th></tr></thead>
          <tbody>
            {state.auto.map((a) => (
              <tr key={`auto-${a.key}`} className="auto-row">
                <td className="mono">{a.key}</td>
                <td className="mono muted">{a.value}</td>
                <td className="muted small">도구가 정함</td>
                <td />
                <td><span className="src auto">자동</span></td>
                <td />
              </tr>
            ))}
            {state.db.map((d) => (
              <tr key={`db-${d.key}`} className="auto-row">
                <td className="mono">{d.key}</td>
                <td className="mono muted">{d.value}</td>
                <td className="muted small">DB 연결 {d.connection}</td>
                <td />
                <td><span className="src auto">DB 설정</span></td>
                <td />
              </tr>
            ))}
            {rows.map((r) => {
              const needs = r.required && !r.value && !autoKeys.includes(r.key) && !dbKeys.has(r.key);
              const src = r.overridden ? SOURCE.session : SOURCE[r.source];
              return (
                <tr key={r.rid} className={needs ? 'needs' : undefined}>
                  <td><input aria-label="키" className="mono" value={r.key} onChange={(e) => update(r.rid, { key: e.target.value })} /></td>
                  <td>
                    <div className="value-cell">
                      <input
                        aria-label={`${r.key} 값`}
                        className={`mono${needs ? ' warn-input' : ''}`}
                        type={r.secret && !reveal[r.rid] ? 'password' : 'text'}
                        value={r.value}
                        placeholder={r.required ? '값 입력' : '비워도 실행 가능'}
                        onChange={(e) => update(r.rid, { value: e.target.value })}
                      />
                      {r.secret && <button type="button" className="icon" aria-label={reveal[r.rid] ? '값 가리기' : '값 보기'} onClick={() => setReveal((v) => ({ ...v, [r.rid]: !v[r.rid] }))}>{reveal[r.rid] ? '가림' : '보기'}</button>}
                    </div>
                  </td>
                  <td className="small">
                    <span className="mono">{r.found_in ?? '-'}</span>
                    {r.reason && <div className="muted">{r.reason}</div>}
                    {dbKeys.has(r.key) && !r.overridden && <div className="muted">DB 연결 {dbKeys.get(r.key)} 값이 우선합니다</div>}
                  </td>
                  <td><input type="checkbox" aria-label={`${r.key} 필수`} checked={r.required} onChange={(e) => update(r.rid, { required: e.target.checked })} /></td>
                  <td><span className={`src ${src.cls}`}>{src.label}</span></td>
                  <td>
                    <button type="button" className="icon bordered" aria-label={`${r.key || '빈 행'} 삭제`} onClick={() => edit((list) => list.filter((x) => x.rid !== r.rid))}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="add-row">
        <button onClick={() => edit((list) => [...list, { key: '', value: '', required: false, secret: false, source: 'manual', found_in: null, rid: rid() }])}>+ 변수 추가</button>
        <button onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen}>.env 붙여넣기</button>
        <button disabled={Boolean(busy)} onClick={() => onAnalyze(false)}>{busy === `scan-${state.projectId}` ? '찾는 중' : '다시 찾기'}</button>
        <button disabled={Boolean(busy)} onClick={() => onAnalyze(true)}>{busy === `ai-${state.projectId}` ? 'AI가 읽는 중 (1~2분)' : 'AI로 분석'}</button>
        <span className="spacer" />
        {dirty && <span className="muted small">저장하지 않은 변경 있음</span>}
      </div>
      {pasteOpen && (
        <div className="paste-box">
          <label htmlFor={`paste-${state.projectId}`} className="strong">.env 붙여넣기</label>
          <textarea id={`paste-${state.projectId}`} rows={5} className="mono" value={paste} placeholder={'KEY=VALUE\nDB_URL=jdbc:...'} onChange={(e) => setPaste(e.target.value)} />
          <span className="muted small">이미 있는 키는 값만 바뀌고, 새 키는 직접 추가로 들어갑니다.</span>
          <div className="row">
            <button className="dark" disabled={!paste.trim()} onClick={() => { onPaste(paste); setPaste(''); setPasteOpen(false); }}>적용</button>
          </div>
        </div>
      )}
    </section>
  );
}
