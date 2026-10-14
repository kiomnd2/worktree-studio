import { useEffect, useState } from 'react';
import { api } from '../api';
import type { EnvSuggestion, ServerView } from '../types';

type Props = {
  sessionId: number;
  targets: ServerView[];
  restart?: boolean;
  onCancel: () => void;
  /** 이번 실행에 쓸 워크트리 ID별 명령과 미리 정한 포트를 넘긴다. 실패하면 throw해서 창이 오류를 보여 주게 한다. */
  onConfirm: (commands: Record<number, string>, ports: Record<number, number>) => Promise<void>;
};

type Row = EnvSuggestion & { on: boolean };

/**
 * 서버를 띄우기 전에 어느 폴더에서 어떤 명령이 어느 포트로 실행되는지 보여 주고, 이번 실행에 한해 고칠 수 있게 한다.
 * 포트를 미리 정해 두고, 그 포트로 FE·BE가 맞물리려면 바꿔야 할 환경값을 제안받아 골라 적용한다.
 */
export default function StartServersDialog({ sessionId, targets, restart, onCancel, onConfirm }: Props) {
  // BE를 먼저 띄우는 서버 순서와 맞춘다.
  const ordered = [...targets].sort((a, b) => Number(a.project_kind === 'fe') - Number(b.project_kind === 'fe'));
  const [cmds, setCmds] = useState<Record<number, string>>(() => Object.fromEntries(ordered.map((s) => [s.worktree_id, s.start_cmd ?? ''])));
  const [saveDefault, setSaveDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ports, setPorts] = useState<Record<number, number> | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [note, setNote] = useState('');
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // 포트를 정하고, 그 포트를 기준으로 설정 제안을 받는다. 제안을 기다리지 않고 실행해도 된다.
  useEffect(() => {
    let alive = true;
    api.planPorts(sessionId, targets.map((t) => t.worktree_id), restart)
      .then(({ ports: p }) => {
        if (!alive) return;
        setPorts(p);
        return api.suggestServerEnv(sessionId, p).then((r) => {
          if (!alive) return;
          setRows(r.suggestions.map((s) => ({ ...s, on: true })));
          setNote(r.note);
        });
      })
      .catch((e) => { if (alive) { setSuggestError((e as Error).message); setRows([]); } });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const changed = ordered.filter((s) => cmds[s.worktree_id].trim() !== (s.start_cmd ?? ''));
  const empty = ordered.some((s) => !cmds[s.worktree_id].trim());
  const chosen = (rows ?? []).filter((r) => r.on && r.value.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (saveDefault) {
        for (const s of changed) await api.updateProject(s.project_id, { start_cmd: cmds[s.worktree_id].trim() });
      }
      if (chosen.length) await api.applySessionEnv(sessionId, chosen.map((r) => ({ project_id: r.project_id, key: r.key, value: r.value.trim() })));
      await onConfirm(Object.fromEntries(changed.map((s) => [s.worktree_id, cmds[s.worktree_id].trim()])), ports ?? {});
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="start-servers-title" onSubmit={submit}>
        <h1 id="start-servers-title">{restart ? '서버 재시작' : '서버 실행'}</h1>
        <p className="muted small">아래 명령을 각 워크트리 폴더에서 실행합니다. <code>{'{port}'}</code>는 실행할 때 빈 포트 번호로 바뀌고, <code>PORT</code> 환경값도 함께 넘어갑니다.</p>
        <ul className="start-list">
          {ordered.map((s) => (
            <li key={s.worktree_id}>
              <div className="wt-head">
                <strong>{s.project_name}</strong>
                <span className={`kind ${s.project_kind}`}>{s.project_kind.toUpperCase()}</span>
                {ports?.[s.worktree_id] && <span className="muted small">포트 {ports[s.worktree_id]}</span>}
              </div>
              <code className="path" title="실행 폴더">{s.cwd}</code>
              {s.setup_pending && (
                <div className="muted small">이 워크트리에서 처음 실행해 먼저 <code>{s.setup_pending}</code>로 의존성을 설치합니다. 몇 분 걸릴 수 있습니다.</div>
              )}
              <label className="field">
                <span className="sr-only">{s.project_name} 실행 명령</span>
                <input
                  className="mono"
                  value={cmds[s.worktree_id]}
                  placeholder="npm run dev -- --port {port}"
                  onChange={(e) => setCmds((c) => ({ ...c, [s.worktree_id]: e.target.value }))}
                />
              </label>
              <div className="muted small">
                헬스체크 <code>{s.health_path}</code>
                {cmds[s.worktree_id].trim() !== (s.start_cmd ?? '') && ' · 프로젝트 기본 명령과 다릅니다'}
              </div>
            </li>
          ))}
        </ul>
        <section className="env-suggest" aria-label="설정 제안">
          <div className="env-suggest-head">
            <strong>이 포트에 맞춰 바꿀 설정</strong>
            <span className="muted small">이번 세션 환경값에만 넣습니다</span>
          </div>
          {rows === null ? (
            <p className="muted small"><span className="spinner" aria-hidden="true" /> FE·BE 설정을 살펴보는 중 (30초~1분). 기다리지 않고 실행해도 됩니다.</p>
          ) : suggestError ? (
            <p className="muted small">설정을 살펴보지 못했습니다: {suggestError}</p>
          ) : rows.length === 0 ? (
            <p className="muted small">바꿀 설정이 없습니다.{note ? ` ${note}` : ''}</p>
          ) : (
            <>
              <ul className="env-suggest-list">
                {rows.map((r, i) => (
                  <li key={`${r.worktree_id}-${r.key}`}>
                    <input type="checkbox" aria-label={`${r.key} 적용`} checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                    <div className="env-suggest-body">
                      <div className="env-suggest-key">
                        <span className="muted small">{r.project_name}</span> <code>{r.key}</code>
                        {!targets.some((t) => t.worktree_id === r.worktree_id) && <span className="pill warn">이 서버는 다시 띄워야 반영</span>}
                      </div>
                      <input className="mono" aria-label={`${r.key} 값`} value={r.value} disabled={!r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                      <div className="muted small">{r.reason}{r.current !== null && <> · 지금 <code>{r.current || '(빈 값)'}</code></>}</div>
                      <div className="muted small mono">{r.found_in}</div>
                    </div>
                  </li>
                ))}
              </ul>
              {note && <p className="muted small">{note}</p>}
            </>
          )}
        </section>
        {changed.length > 0 && (
          <label className="start-check"><input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} /> 바꾼 명령을 프로젝트 기본값으로 저장 (안 하면 이번 실행에만 씁니다)</label>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>취소</button>
          <button type="submit" className="primary" disabled={busy || empty}>{busy ? '띄우는 중' : `${chosen.length ? `설정 ${chosen.length}개 적용하고 ` : ''}${restart ? '재시작' : '실행'}`}</button>
        </div>
      </form>
    </div>
  );
}
