import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useServerEvents } from '../events';
import type { CleanResult, CleanupRow, CleanupState, Settings, StartupReport } from '../types';

const STATE: Record<CleanupState, { label: string; cls: string }> = {
  ready: { label: '정리 대기', cls: 'warn' },
  protected: { label: '보호됨', cls: 'err' },
  waiting_merge: { label: '머지 대기', cls: 'accent' },
  running: { label: '작업 중', cls: 'ok' },
  active: { label: '진행 중', cls: '' },
};

/** 작업 중(Claude 실행)과 머지 대기는 고를 수 없다. */
const selectable = (r: CleanupRow) => r.state !== 'running' && r.state !== 'waiting_merge';

function kb(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024) return `${Math.round(n / 1024)} MB`;
  return `${n} KB`;
}

export default function CleanupPage({ onOpenSession }: { onOpenSession: (id: number) => void }) {
  const [rows, setRows] = useState<CleanupRow[] | null>(null);
  const [startup, setStartup] = useState<StartupReport | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<CleanResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.cleanup().then((r) => { setRows(r.rows); setStartup(r.startup); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { reload(); api.settings().then((s) => { setSettings(s); setDeleteRemote(s.cleanup.deleteRemoteBranch); }).catch(() => {}); }, [reload]);
  useServerEvents((e) => { if (e.type === 'cleanup.changed' || e.type === 'sessions.changed') reload(); });

  const ready = rows?.filter((r) => r.state === 'ready') ?? [];
  const pickedRows = rows?.filter((r) => picked.has(r.session_id)) ?? [];
  const freeable = (list: CleanupRow[]) => list.reduce((n, r) => n + r.screens_kb + r.worktrees.reduce((m, w) => m + (w.size_kb ?? 0), 0), 0);

  function toggle(id: number) {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function clean() {
    const dirty = pickedRows.filter((r) => r.state === 'protected');
    const msg = dirty.length
      ? `${dirty.map((r) => r.ticket).join(', ')}에는 커밋하지 않은 변경이 있습니다. 변경을 버리고 ${pickedRows.length}개 세션을 정리할까요?`
      : `${pickedRows.length}개 세션의 서버를 끄고 워크트리, 로컬 브랜치${deleteRemote ? ', 원격 브랜치' : ''}, 스크린샷을 지울까요? 되돌릴 수 없습니다.`;
    if (!confirm(msg)) return;
    setBusy('clean'); setError(null); setNotice(null);
    try {
      const r = await api.clean(pickedRows.map((x) => x.session_id), deleteRemote, dirty.length > 0);
      setResults(r);
      setPicked(new Set());
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); reload(); }
  }

  async function saveRules(next: Settings) {
    setSettings(next);
    try { await api.saveSettings(next); setNotice('자동 정리 규칙을 저장했습니다.'); } catch (e) { setError((e as Error).message); }
  }

  if (!rows) return <main className="main scroll"><div className="settings">{error ? <p className="banner error">{error}</p> : <p className="muted">세션과 워크트리를 살펴보는 중</p>}</div></main>;

  return (
    <main className="main scroll">
      <div className="settings">
        <div className="page-head">
          <div>
            <h1>리소스 정리</h1>
            <p className="muted small">정리할 수 있는 세션 {ready.length}개 · 확보할 수 있는 용량 약 {kb(freeable(ready))}</p>
          </div>
          <div className="row">
            <button disabled={busy !== null} onClick={async () => {
              setBusy('refresh');
              try { const r = await api.refreshPrs(); setNotice(r.changed ? `PR ${r.changed}개 상태가 바뀌었습니다.` : 'PR 상태가 그대로입니다.'); } catch (e) { setError((e as Error).message); }
              setBusy(null); reload();
            }}>{busy === 'refresh' ? '확인 중' : 'PR 상태 지금 확인'}</button>
            <button disabled={ready.length === 0} onClick={() => setPicked(new Set(ready.map((r) => r.session_id)))}>정리 대기 모두 고르기</button>
          </div>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}
        {notice && <p className="banner ok" role="status">{notice}</p>}

        <section className="card">
          <div className="table-wrap">
            <table className="cleanup-table">
              <thead><tr><th><span className="sr-only">선택</span></th><th>세션</th><th>PR</th><th>서버</th><th>워크트리</th><th>계정</th><th>상태</th></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="muted">정리할 세션이 없습니다.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.session_id} className={picked.has(r.session_id) ? 'picked' : ''}>
                    <td>
                      <input type="checkbox" aria-label={`${r.ticket} 선택`} disabled={!selectable(r)} checked={picked.has(r.session_id)} onChange={() => toggle(r.session_id)} />
                    </td>
                    <td>
                      {r.closed ? <strong>{r.ticket}</strong> : <button className="link strong" onClick={() => onOpenSession(r.session_id)}>{r.ticket}</button>}
                      <div className="muted small">{r.summary || '요약 없음'} · {r.workspace_name}{r.closed ? ' · 닫힘' : ''} · {r.idle_days === 0 ? '오늘 활동' : `${r.idle_days}일 전 활동`}</div>
                    </td>
                    <td>
                      {r.prs.length === 0 ? <span className="muted">없음</span> : r.prs.map((p) => (
                        <div key={p.id}><a href={p.url} target="_blank" rel="noreferrer">#{p.number}</a> <span className="muted small">{p.state === 'OPEN' ? '열림' : p.state === 'MERGED' ? '머지됨' : '닫힘'}</span></div>
                      ))}
                    </td>
                    <td>{r.servers ? `${r.servers}개 실행 중` : <span className="muted">꺼짐</span>}</td>
                    <td>
                      {r.worktrees.map((w) => (
                        <div key={w.id} className="small">
                          {w.project_name} · {w.exists ? (w.size_kb === null ? '용량 모름' : kb(w.size_kb)) : <span className="muted">폴더 없음</span>}
                          {w.dirty > 0 && <span className="warn-text"> · 미커밋 {w.dirty}</span>}
                        </div>
                      ))}
                      {r.screens_kb > 0 && <div className="muted small">스크린샷 {kb(r.screens_kb)}</div>}
                    </td>
                    <td><span className={`pill ${STATE[r.state].cls}`}>{STATE[r.state].label}</span><div className="muted small">{r.reason}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cleanup-bar">
            <p className="muted small">
              순서: 서버 종료 → 워크트리 삭제 → 로컬 브랜치 삭제{deleteRemote ? ' → 원격 브랜치 삭제' : ''} → 스크린샷 삭제 → 세션 기록 보관.
              대화 기록은 지우지 않습니다.
            </p>
            <label className="start-check"><input type="checkbox" checked={deleteRemote} onChange={(e) => setDeleteRemote(e.target.checked)} /> 원격 브랜치도 삭제 (PR이 있는 세션만)</label>
            <button className="primary" disabled={pickedRows.length === 0 || busy !== null} onClick={clean}>
              {busy === 'clean' ? '정리하는 중' : `선택한 ${pickedRows.length}개 정리${pickedRows.length ? ` (약 ${kb(freeable(pickedRows))})` : ''}`}
            </button>
          </div>
        </section>

        {results.length > 0 && (
          <section className="card">
            <div className="card-head"><h2>정리 결과</h2></div>
            <ul className="clean-results">
              {results.map((r) => (
                <li key={r.session_id}>
                  <strong>{rows.find((x) => x.session_id === r.session_id)?.ticket ?? `세션 ${r.session_id}`}</strong>
                  {r.error ? <p className="error-text">{r.error}</p> : (
                    <ul className="small">
                      {r.steps.map((s, i) => <li key={i} className={s.ok ? '' : 'error-text'}>{s.ok ? '완료' : '실패'} · {s.name}{s.detail ? ` (${s.detail})` : ''}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {settings && (
          <section className="card">
            <div className="card-head"><div><h2>자동 정리 규칙</h2><p className="muted small">미커밋 변경이 있는 워크트리는 어떤 설정에서도 자동으로 지우지 않습니다.</p></div></div>
            <div className="prefs">
              <fieldset className="checks column">
                <legend className="sr-only">규칙</legend>
                <label><input type="checkbox" checked={settings.cleanup.stopServersOnPr} onChange={(e) => saveRules({ ...settings, cleanup: { ...settings.cleanup, stopServersOnPr: e.target.checked } })} /> PR을 만들면 서버 끄기</label>
                <label><input type="checkbox" checked={settings.cleanup.autoCleanMerged} onChange={(e) => saveRules({ ...settings, cleanup: { ...settings.cleanup, autoCleanMerged: e.target.checked } })} /> PR이 머지·닫히면 확인 없이 정리</label>
                <label><input type="checkbox" checked={settings.cleanup.deleteRemoteBranch} onChange={(e) => saveRules({ ...settings, cleanup: { ...settings.cleanup, deleteRemoteBranch: e.target.checked } })} /> 자동 정리 때 원격 브랜치도 삭제</label>
              </fieldset>
              <fieldset className="checks column">
                <legend className="sr-only">주기</legend>
                <label className="inline">PR 상태 확인 간격
                  <input type="number" min={1} max={1440} value={settings.cleanup.pollMinutes} onChange={(e) => setSettings({ ...settings, cleanup: { ...settings.cleanup, pollMinutes: Math.max(1, Number(e.target.value) || 1) } })} onBlur={() => saveRules(settings)} />분
                </label>
                <label className="inline">활동 없는 세션 알림
                  <input type="number" min={0} max={365} value={settings.cleanup.staleDays} onChange={(e) => setSettings({ ...settings, cleanup: { ...settings.cleanup, staleDays: Math.max(0, Number(e.target.value) || 0) } })} onBlur={() => saveRules(settings)} />일 (0이면 안 함)
                </label>
              </fieldset>
            </div>
          </section>
        )}

        {startup && (
          <section className="card">
            <div className="card-head"><div><h2>시작할 때 정리한 것</h2><p className="muted small">{new Date(startup.at).toLocaleString()}</p></div></div>
            <ul className="startup-list small">
              <li>주인 없는 서버 프로세스 종료: {startup.orphans_killed}개</li>
              <li>폴더 없는 워크트리 기록 정리(git worktree prune): {startup.pruned.length ? startup.pruned.map((p) => `${p.project} ${p.lines.length}건`).join(', ') : '없음'}</li>
              {startup.missing_worktrees > 0 && <li className="warn-text">열린 세션 중 워크트리 폴더가 사라진 것: {startup.missing_worktrees}개 (정리하면 기록이 지워집니다)</li>}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
