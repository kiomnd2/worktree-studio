import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Session, Workspace } from '../types';

type Row = { projectId: number; name: string; branches: string[]; base: string; branch: string; touched: boolean };

const defaultBranch = (ticket: string) => (ticket.trim() ? `feature/${ticket.trim()}` : '');

export default function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Session) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [ticket, setTicket] = useState('');
  const [summary, setSummary] = useState('');
  const [firstPrompt, setFirstPrompt] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.workspaces().then((ws) => { setWorkspaces(ws); if (ws[0]) setWorkspaceId(ws[0].id); }).catch((e) => setError(e.message));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const workspace = useMemo(() => workspaces?.find((w) => w.id === workspaceId) ?? null, [workspaces, workspaceId]);

  useEffect(() => {
    if (!workspace) { setRows([]); return; }
    let cancelled = false;
    Promise.all(workspace.projects.map(async (p) => {
      const branches = await api.branches(p.id).catch(() => [] as string[]);
      return { projectId: p.id, name: p.name, branches, base: branches[0] ?? 'develop', branch: '', touched: false };
    })).then((r) => { if (!cancelled) setRows(r); });
    return () => { cancelled = true; };
  }, [workspace]);

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId) { setError('워크스페이스를 고르세요.'); return; }
    if (!ticket.trim()) { setError('티켓 번호를 넣어 주세요.'); return; }
    setBusy(true);
    setError(null);
    try {
      const s = await api.createSession({
        workspaceId,
        ticket,
        summary,
        firstPrompt: firstPrompt.trim() || undefined,
        branches: rows.map((r) => ({ projectId: r.projectId, base: r.base, branch: r.touched ? r.branch : defaultBranch(ticket) })),
      });
      onCreated(s);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onSubmit={submit}>
        <h1 id="new-session-title">새 세션 만들기</h1>
        {workspaces && workspaces.length === 0 ? (
          <p>워크스페이스가 없습니다. 프로젝트와 설정에서 로컬 폴더를 등록하고 워크스페이스를 만드세요.</p>
        ) : (
          <>
            <div className="grid2">
              <label className="field">
                <span>워크스페이스</span>
                <select value={workspaceId ?? ''} onChange={(e) => setWorkspaceId(Number(e.target.value))}>
                  {workspaces?.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.projects.map((p) => p.name).join(' + ')})</option>)}
                </select>
              </label>
              <label className="field">
                <span>티켓 번호</span>
                <input value={ticket} autoFocus placeholder="DRMS-424" onChange={(e) => setTicket(e.target.value)} />
              </label>
            </div>
            <label className="field">
              <span>작업 요약</span>
              <input value={summary} placeholder="자원 상세에 KPX 자원명 입력" onChange={(e) => setSummary(e.target.value)} />
            </label>
            <fieldset className="box">
              <legend>브랜치</legend>
              <div className="branch-grid">
                <span className="muted small">프로젝트</span><span className="muted small">기준 브랜치</span><span className="muted small">새 브랜치</span>
                {rows.map((r, i) => (
                  <div key={r.projectId} className="branch-row">
                    <strong>{r.name}</strong>
                    <select aria-label={`${r.name} 기준 브랜치`} value={r.base} onChange={(e) => update(i, { base: e.target.value })}>
                      {(r.branches.length ? r.branches : [r.base]).map((b) => <option key={b}>{b}</option>)}
                    </select>
                    <input
                      aria-label={`${r.name} 새 브랜치`}
                      className="mono"
                      value={r.touched ? r.branch : defaultBranch(ticket)}
                      placeholder="feature/..."
                      onChange={(e) => update(i, { branch: e.target.value, touched: true })}
                    />
                  </div>
                ))}
              </div>
              <p className="muted small">워크트리는 각 클론 폴더 옆에 <code>폴더이름-티켓번호</code>로 만들어집니다.</p>
            </fieldset>
            <label className="field">
              <span>첫 프롬프트 <span className="muted">(선택)</span></span>
              <textarea rows={3} value={firstPrompt} placeholder="비워 두면 워크트리만 만들고 대기합니다." onChange={(e) => setFirstPrompt(e.target.value)} />
            </label>
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>취소</button>
          <button type="submit" className="primary" disabled={busy || !workspace}>{busy ? '워크트리 만드는 중' : '세션 만들기'}</button>
        </div>
      </form>
    </div>
  );
}
