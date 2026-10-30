import { useEffect, useState } from 'react';
import { api } from '../api';
import { openChat } from '../events';
import type { ConflictProposal, Session, WorktreeConflict } from '../types';

const STRATEGY: Record<ConflictProposal['files'][number]['strategy'], { label: string; cls: string }> = {
  ours: { label: '이 브랜치 것', cls: 'accent' },
  theirs: { label: '기준 브랜치 것', cls: 'accent' },
  both: { label: '두 쪽 합치기', cls: 'ok' },
  manual: { label: '직접 정해야 함', cls: 'warn' },
};

/**
 * 기준 브랜치(develop 등)와의 머지 충돌. 충돌 파일과 원인 커밋을 보여 주고,
 * Claude의 해결 방법 제안을 사용자가 확인(고쳐서)·승인하면 새 대화에서 머지하고 충돌을 푼다.
 */
export default function ConflictDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [list, setList] = useState<WorktreeConflict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => { setError(null); api.conflicts(session.id).then(setList).catch((e) => setError(e.message)); };
  useEffect(reload, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <div className="dialog-head">
          <h1 id="conflict-title">기준 브랜치와 충돌 확인</h1>
          <span className="muted small">{session.ticket} · 확인만으로는 워크트리를 바꾸지 않습니다</span>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}
        {!list && !error && <p className="muted" role="status"><span className="spinner" aria-hidden="true" /> 기준 브랜치를 가져와 머지해 보는 중</p>}
        {list?.map((c) => <WorktreeCard key={c.worktree_id} session={session} c={c} onChanged={reload} onStarted={(id) => { openChat(id); onClose(); }} />)}
        <div className="dialog-actions">
          <button onClick={reload} disabled={!list && !error}>다시 확인</button>
          <button className="primary" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

function WorktreeCard({ session, c, onChanged, onStarted }: { session: Session; c: WorktreeConflict; onChanged: () => void; onStarted: (chatId: number) => void }) {
  const [proposal, setProposal] = useState<ConflictProposal | null>(null);
  const [busy, setBusy] = useState<'propose' | 'resolve' | 'abort' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `origin/${c.base_branch}`;
  const run = async (kind: 'propose' | 'resolve' | 'abort', fn: () => Promise<void>) => {
    setBusy(kind); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <section className={`conflict-card ${c.state}`} aria-label={`${c.project_name} 충돌`}>
      <div className="conflict-head">
        <strong>{c.project_name}</strong>
        <code className="small">{c.branch} ← {base}</code>
        {c.pr && <a className="small" href={c.pr.url} target="_blank" rel="noreferrer">PR #{c.pr.number}</a>}
        <span className={`pill ${c.state === 'clean' ? 'ok' : c.state === 'error' ? 'warn' : 'warn'}`}>
          {c.state === 'clean' ? '충돌 없음' : c.state === 'conflict' ? `충돌 ${c.files.length}개 파일` : c.state === 'merging' ? `머지 중 · 남은 충돌 ${c.files.length}개` : '확인 실패'}
        </span>
      </div>

      {c.state === 'error' && <p className="error-text small">{c.error}</p>}
      {c.state === 'clean' && (
        <p className="muted small">
          {c.behind > 0 ? `${base}에 새 커밋 ${c.behind}개가 있지만 충돌 없이 머지됩니다.` : `${base}의 최신 내용을 이미 담고 있습니다.`}
          {c.unpushed > 0 && <> 푸시하지 않은 커밋 {c.unpushed}개가 있습니다. <strong>푸시하고 PR 만들기</strong>로 올리면 PR에 반영됩니다.</>}
        </p>
      )}

      {c.state !== 'clean' && c.state !== 'error' && (
        <>
          {c.state === 'conflict' && (
            <p className="small conflict-how">
              <strong>해결 방법</strong>: 이 브랜치에 {base}를 머지하고, 아래 파일의 충돌을 두 쪽 변경을 살려 푼 뒤 머지 커밋을 만들어 푸시하면 PR이 다시 머지할 수 있는 상태가 됩니다.
              아래 <strong>해결 방법 제안 받기</strong>를 누르면 Claude가 코드를 읽고 파일별로 어떻게 풀지 제안합니다. 승인해야 워크트리에서 머지를 시작합니다.
            </p>
          )}
          {c.state === 'merging' && (
            <p className="small conflict-how">
              {c.files.length ? '워크트리에서 머지를 시작했고 충돌을 푸는 중입니다. 해결 대화가 끝나면 다시 확인하세요.' : '충돌은 모두 풀렸습니다. 머지 커밋을 만들면 끝납니다.'}
              {' '}머지를 그만두려면 <strong>머지 취소</strong>로 머지 전으로 되돌립니다.
            </p>
          )}
          {c.base_commits.length > 0 && (
            <div className="conflict-cause">
              <span className="muted small">충돌 원인: {base}에 먼저 들어간 커밋</span>
              <ul>{c.base_commits.map((b) => <li key={b.sha} className="small"><code>{b.sha}</code> {b.subject} <span className="muted">· {b.author}</span></li>)}</ul>
            </div>
          )}
          <ul className="conflict-files">
            {c.files.map((f) => (
              <li key={f.path}>
                <details>
                  <summary>
                    <code>{f.path}</code>
                    <span className="muted small">{f.note ?? `충돌 ${f.hunks.length}곳`}</span>
                  </summary>
                  {f.hunks.map((h, i) => (
                    <div key={i} className="conflict-hunk">
                      <div className="muted small">#{i + 1} · {h.line}행 근처</div>
                      <div className="conflict-sides">
                        <div><span className="conflict-side-label">이 브랜치 ({c.branch})</span><pre>{h.ours || '(비어 있음)'}</pre></div>
                        <div><span className="conflict-side-label">{base}</span><pre>{h.theirs || '(비어 있음)'}</pre></div>
                      </div>
                    </div>
                  ))}
                </details>
              </li>
            ))}
          </ul>

          {proposal && (
            <div className="conflict-proposal">
              <strong>Claude의 해결 방법 제안</strong>
              <p className="small">{proposal.summary}</p>
              {proposal.files.map((f, i) => (
                <div key={f.path} className="conflict-proposal-file">
                  <div><code>{f.path}</code> <span className={`pill ${STRATEGY[f.strategy].cls}`}>{STRATEGY[f.strategy].label}</span></div>
                  <label className="sr-only" htmlFor={`how-${c.worktree_id}-${i}`}>{f.path} 해결 방법</label>
                  <textarea id={`how-${c.worktree_id}-${i}`} rows={Math.min(6, Math.max(2, Math.ceil(f.how.length / 70)))} value={f.how}
                    onChange={(e) => setProposal({ ...proposal, files: proposal.files.map((x, j) => (j === i ? { ...x, how: e.target.value } : x)) })} />
                  {f.risk && <p className="warn-text small">주의: {f.risk}</p>}
                </div>
              ))}
              {proposal.checks.length > 0 && <p className="muted small">해결 뒤 확인할 것: {proposal.checks.join(' · ')}</p>}
              <p className="muted small">승인하면 워크트리에서 {base} 머지를 시작하고, 새 대화에서 Claude가 위 방법대로 충돌을 풀고 검사한 뒤 머지 커밋을 만듭니다. 푸시는 직접 합니다.</p>
            </div>
          )}

          {error && <p className="error-text small" role="alert">{error}</p>}
          <div className="row">
            {c.state === 'merging' && (
              <button className="danger" disabled={busy !== null || session.busy} title={session.busy ? 'Claude 작업을 먼저 중단하세요' : undefined}
                onClick={() => { if (confirm('머지를 취소하고 머지 전으로 되돌릴까요? 충돌을 풀던 내용은 사라집니다.')) run('abort', async () => { await api.abortMerge(session.id, c.worktree_id); onChanged(); }); }}>
                머지 취소
              </button>
            )}
            {c.files.length > 0 && (
              <button disabled={busy !== null} onClick={() => run('propose', async () => setProposal(await api.proposeConflict(session.id, c.worktree_id)))}>
                {busy === 'propose' ? '제안 만드는 중 (1~2분)' : proposal ? '다시 제안 받기' : '해결 방법 제안 받기'}
              </button>
            )}
            {proposal && (
              <button className="primary" disabled={busy !== null || session.busy || proposal.files.some((f) => !f.how.trim())}
                title={session.busy ? 'Claude 작업이 끝난 뒤에 시작할 수 있습니다(머지는 워크트리 전체를 바꿉니다)' : undefined}
                onClick={() => run('resolve', async () => onStarted((await api.resolveConflict(session.id, c.worktree_id, proposal)).chat_id))}>
                {busy === 'resolve' ? '머지 시작 중' : '이대로 해결 (새 대화)'}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
