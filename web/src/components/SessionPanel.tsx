import { useState } from 'react';
import { api } from '../api';
import type { Session } from '../types';

export default function SessionPanel({ session, onClosed }: { session: Session; onClosed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function close(removeWorktrees: boolean) {
    const msg = removeWorktrees
      ? '세션을 닫고 워크트리 폴더도 지울까요? 커밋하지 않은 변경은 사라집니다.'
      : '세션을 닫을까요? 워크트리 폴더는 남겨 둡니다.';
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await api.closeSession(session.id, removeWorktrees);
      onClosed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="세션 정보">
      <h2>워크트리</h2>
      <ul className="worktrees">
        {session.worktrees.map((w) => (
          <li key={w.id}>
            <div className="wt-head"><strong>{w.project_name}</strong><span className={`kind ${w.project_kind}`}>{w.project_kind.toUpperCase()}</span></div>
            <code className="path">{w.path}</code>
            <div className="muted small">{w.branch} · {w.base_branch}에서 분기</div>
          </li>
        ))}
      </ul>
      <div className="placeholder">
        <strong>서버 실행, 미리보기, 로그</strong>
        <p>Phase 2에서 이 패널에 들어옵니다.</p>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="panel-actions">
        <button disabled={busy || session.status === 'running'} onClick={() => close(false)}>세션 닫기</button>
        <button className="danger" disabled={busy || session.status === 'running'} onClick={() => close(true)}>닫고 워크트리 삭제</button>
      </div>
    </section>
  );
}
