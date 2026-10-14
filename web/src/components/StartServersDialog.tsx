import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ServerView } from '../types';

type Props = {
  targets: ServerView[];
  restart?: boolean;
  onCancel: () => void;
  /** 이번 실행에 쓸 워크트리 ID별 명령을 넘긴다. 실패하면 throw해서 창이 오류를 보여 주게 한다. */
  onConfirm: (commands: Record<number, string>) => Promise<void>;
};

/** 서버를 띄우기 전에 어느 폴더에서 어떤 명령이 실행되는지 보여 주고, 이번 실행에 한해 고칠 수 있게 한다. */
export default function StartServersDialog({ targets, restart, onCancel, onConfirm }: Props) {
  // BE를 먼저 띄우는 서버 순서와 맞춘다.
  const ordered = [...targets].sort((a, b) => Number(a.project_kind === 'fe') - Number(b.project_kind === 'fe'));
  const [cmds, setCmds] = useState<Record<number, string>>(() => Object.fromEntries(ordered.map((s) => [s.worktree_id, s.start_cmd ?? ''])));
  const [saveDefault, setSaveDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const changed = ordered.filter((s) => cmds[s.worktree_id].trim() !== (s.start_cmd ?? ''));
  const empty = ordered.some((s) => !cmds[s.worktree_id].trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (saveDefault) {
        for (const s of changed) await api.updateProject(s.project_id, { start_cmd: cmds[s.worktree_id].trim() });
      }
      await onConfirm(Object.fromEntries(changed.map((s) => [s.worktree_id, cmds[s.worktree_id].trim()])));
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
        {changed.length > 0 && (
          <label className="start-check"><input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} /> 바꾼 명령을 프로젝트 기본값으로 저장 (안 하면 이번 실행에만 씁니다)</label>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>취소</button>
          <button type="submit" className="primary" disabled={busy || empty}>{busy ? '띄우는 중' : restart ? '재시작' : '실행'}</button>
        </div>
      </form>
    </div>
  );
}
