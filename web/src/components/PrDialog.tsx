import { useEffect, useState } from 'react';
import { api } from '../api';
import { insertIntoPrompt, useServerEvents } from '../events';
import type { PrDraft, PrJob, PrStep, PullRequest, Session } from '../types';

const STEP_LABEL: Record<PrStep['name'], string> = { commit: '커밋', check: '빌드·테스트', push: '푸시', pr: 'PR 생성' };
const STEP_STATUS: Record<PrStep['status'], string> = { pending: '대기', running: '진행 중', done: '완료', failed: '실패', skipped: '건너뜀', ignored: '실패 무시' };

type Props = { session: Session; onClose: () => void; onOpenCleanup: () => void };

type Draft = PrDraft & { include: boolean };

/** 푸시하고 PR 만들기. 진행 중이거나 끝난 작업이 있으면 그 진행 상황부터 보여 준다. */
export default function PrDialog({ session, onClose, onOpenCleanup }: Props) {
  const [job, setJob] = useState<PrJob | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'loading' | 'edit' | 'progress'>('loading');
  const [ignoreChecks, setIgnoreChecks] = useState(false);

  const reload = () => api.pr(session.id).then((r) => { setJob(r.job); setPrs(r.prs); return r; });

  useEffect(() => {
    reload().then((r) => {
      if (r.job?.status === 'running') setMode('progress');
      else prepare();
    }).catch((e) => setError(e.message));
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useServerEvents((e) => { if (e.type === 'pr.updated' && e.sessionId === session.id) reload().catch(() => {}); });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !preparing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, preparing]);

  async function prepare() {
    setMode('edit');
    setPreparing(true);
    setError(null);
    try {
      const r = await api.preparePr(session.id);
      setDrafts(r.drafts.map((d) => ({ ...d, include: d.has_changes })));
      setAiError(r.ai_error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreparing(false);
    }
  }

  async function submit() {
    if (!drafts) return;
    setError(null);
    try {
      const items = drafts.filter((d) => d.include).map(({ worktree_id, title, body, commit_message }) => ({ worktree_id, title, body, commit_message }));
      setJob(await api.createPr(session.id, items, ignoreChecks));
      setMode('progress');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const edit = (id: number, patch: Partial<Draft>) => setDrafts((ds) => ds?.map((d) => (d.worktree_id === id ? { ...d, ...patch } : d)) ?? null);
  const included = drafts?.filter((d) => d.include) ?? [];

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !preparing) onClose(); }}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="pr-title">
        <div className="dialog-head">
          <h1 id="pr-title">푸시하고 PR 만들기</h1>
          <span className="muted small">{session.ticket} · 리뷰 단계 없이 일반 PR로 엽니다</span>
        </div>

        {mode === 'loading' && <p className="muted">불러오는 중</p>}

        {mode === 'edit' && (
          <>
            {preparing && (
              <div className="pr-preparing" role="status">
                <span className="spinner" aria-hidden="true" />
                변경 내용을 모으고 PR 템플릿에 맞춰 본문을 쓰는 중입니다. 30초쯤 걸립니다.
              </div>
            )}
            {aiError && <p className="banner warn">{aiError}</p>}
            {drafts && drafts.map((d) => (
              <fieldset key={d.worktree_id} className={`box pr-repo${d.include ? '' : ' off'}`}>
                <legend>
                  <label className="start-check">
                    <input type="checkbox" checked={d.include} disabled={!d.has_changes} onChange={(e) => edit(d.worktree_id, { include: e.target.checked })} />
                    <strong>{d.project_name}</strong>
                    <span className={`kind ${d.project_kind}`}>{d.project_kind.toUpperCase()}</span>
                  </label>
                </legend>
                <div className="muted small">
                  <code>{d.branch}</code> → <code>{d.base_branch}</code>
                  {' · '}{d.has_changes ? `커밋 ${d.commits_ahead}개${d.dirty_files.length ? ` + 커밋 안 한 파일 ${d.dirty_files.length}개` : ''}` : '기준 브랜치와 차이가 없어 건너뜁니다'}
                  {d.existing_pr && <> · 이미 열린 <a href={d.existing_pr.url} target="_blank" rel="noreferrer">PR #{d.existing_pr.number}</a>에 푸시합니다</>}
                </div>
                {d.include && (
                  <>
                    {d.dirty_files.length > 0 && (
                      <details className="pr-files">
                        <summary>함께 커밋할 파일 {d.dirty_files.length}개</summary>
                        <ul className="mono small">{d.dirty_files.map((f) => <li key={f}>{f}</li>)}</ul>
                      </details>
                    )}
                    {d.dirty_files.length > 0 && (
                      <label className="field">
                        <span>커밋 메시지 <span className="muted small">
                          {d.commit_template ? `템플릿 ${d.commit_template.path}${d.commit_template.from ? ` (${d.commit_template.from} 것)` : ''} 기준` : '최근 커밋 형식 기준'}
                        </span></span>
                        <textarea className="mono" rows={Math.min(10, Math.max(3, d.commit_message.split('\n').length + 1))} value={d.commit_message} onChange={(e) => edit(d.worktree_id, { commit_message: e.target.value })} />
                      </label>
                    )}
                    <label className="field">
                      <span>PR 제목</span>
                      <input value={d.title} onChange={(e) => edit(d.worktree_id, { title: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>PR 본문 <span className="muted small">
                        {d.style_examples.length
                          ? `최근 PR ${d.style_examples.map((x) => `#${x.number}${x.mine ? '(내 PR)' : ''}`).join(', ')} 형식 기준`
                          : d.template_path ? `템플릿 ${d.template_path} 기준` : '기본 형식'}
                      </span></span>
                      <textarea className="mono pr-body" rows={12} value={d.body} onChange={(e) => edit(d.worktree_id, { body: e.target.value })} />
                    </label>
                    <p className="muted small">
                      PR 전 검사: {d.check_cmd ? <code>{d.check_cmd}</code> : '없음 (설정의 "PR 전 검사"에 넣으면 실패 시 멈춥니다)'}
                    </p>
                  </>
                )}
              </fieldset>
            ))}
            {included.length > 1 && <p className="muted small">BE와 FE PR은 본문 끝에 서로를 관련 PR로 연결합니다.</p>}
            {included.some((d) => d.check_cmd) && (
              <label className="start-check small">
                <input type="checkbox" checked={ignoreChecks} onChange={(e) => setIgnoreChecks(e.target.checked)} />
                검사가 실패해도 PR 만들기 <span className="muted">(실패하면 PR 본문 끝에 실패한 채 올렸다고 남깁니다)</span>
              </label>
            )}
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" onClick={onClose} disabled={preparing}>취소</button>
              {job && <button type="button" onClick={() => setMode('progress')}>지난 진행 보기</button>}
              <button type="button" className="primary" disabled={preparing || included.length === 0} onClick={submit}>검사하고 PR 만들기</button>
            </div>
          </>
        )}

        {mode === 'progress' && job && (
          <>
            {job.repos.map((r) => (
              <section key={r.worktree_id} className="pr-progress">
                <h2>{r.project_name}</h2>
                <ol className="steps">
                  {r.steps.map((s) => (
                    <li key={s.name} className={`step ${s.status}`}>
                      <span className="step-dot" aria-hidden="true" />
                      <span className="step-name">{STEP_LABEL[s.name]}</span>
                      <span className="muted small">{STEP_STATUS[s.status]}{s.started_at && s.ended_at ? ` · ${seconds(s.ended_at - s.started_at)}` : ''}</span>
                      {s.detail && <span className="step-detail small">{s.name === 'pr' && s.detail.startsWith('http') ? <a href={s.detail} target="_blank" rel="noreferrer">{s.detail}</a> : s.detail}</span>}
                      {s.status === 'failed' && s.output && (
                        <div className="step-fail">
                          <pre className="log-box">{s.output}</pre>
                          <button type="button" onClick={() => {
                            insertIntoPrompt(`${r.project_name} PR 전 검사(${STEP_LABEL[s.name]})가 실패했어. 원인을 찾아서 고쳐줘.\n\`\`\`\n${s.output!.split('\n').slice(-60).join('\n')}\n\`\`\``);
                            onClose();
                          }}>로그를 Claude에게 넘기기</button>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            {job.status === 'running' && <p className="muted small" role="status"><span className="spinner" aria-hidden="true" /> 진행 중입니다. 창을 닫아도 계속됩니다.</p>}
            {job.status === 'failed' && <p className="banner error" role="alert">{job.error}</p>}
            {job.status === 'failed' && job.repos.some((r) => r.steps.some((s) => s.name === 'check' && s.status === 'failed')) && (
              <div className="pr-continue">
                <span className="small">빌드·테스트 실패가 이번 작업과 상관없거나 나중에 고칠 거라면, 실패를 무시하고 푸시와 PR을 이어서 할 수 있습니다. 이미 돌린 검사는 다시 돌리지 않습니다.</span>
                <button type="button" className="primary" onClick={async () => {
                  setError(null);
                  try { setJob(await api.continuePr(session.id)); } catch (e) { setError((e as Error).message); }
                }}>검사 실패 무시하고 진행</button>
              </div>
            )}
            {job.status === 'done' && (
              <div className="banner ok" role="status">
                PR을 만들었습니다.{job.servers_stopped ? ' 이 세션의 서버를 끄고 포트를 반납했습니다.' : ''} 머지되면 <button className="link" onClick={onOpenCleanup}>리소스 정리</button>에서 워크트리와 브랜치를 지울 수 있습니다.
              </div>
            )}
            {prs.length > 0 && <PrList prs={prs} onChanged={reload} onError={setError} />}
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="dialog-actions">
              {job.status !== 'running' && <button type="button" onClick={prepare}>다시 만들기</button>}
              <button type="button" className="primary" onClick={onClose}>닫기</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PrList({ prs, onChanged, onError }: { prs: PullRequest[]; onChanged: () => void; onError: (m: string) => void }) {
  return (
    <ul className="pr-list">
      {prs.map((p) => (
        <li key={p.id}>
          <span className={`pill ${p.state === 'OPEN' ? 'ok' : p.state === 'MERGED' ? 'accent' : ''}`}>{p.state === 'OPEN' ? '열림' : p.state === 'MERGED' ? '머지됨' : '닫힘'}</span>
          <a href={p.url} target="_blank" rel="noreferrer">#{p.number} {p.title}</a>
          <span className="spacer" />
          <a className="btn-link" href={p.url} target="_blank" rel="noreferrer">PR 열기</a>
          {p.state === 'OPEN' && (
            <button className="small-btn danger" onClick={async () => {
              if (!confirm(`PR #${p.number}을 닫을까요? 브랜치와 커밋은 남습니다.`)) return;
              try { await api.closePr(p.id); onChanged(); } catch (e) { onError((e as Error).message); }
            }}>PR 닫기</button>
          )}
        </li>
      ))}
    </ul>
  );
}

function seconds(ms: number) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}
