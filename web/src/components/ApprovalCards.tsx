import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { openDoc, useServerEvents } from '../events';
import { DOC_KIND } from './DocsPage';
import { usableIn, type Account, type Approval, type Session } from '../types';

/** Claude가 프롬프트 중에 요청한 환경값·테스트 계정. 사용자가 확인해야 적용되고, 그동안 Claude는 기다린다. */
export default function ApprovalCards({ session, only }: { session: Session; only?: Approval['request']['kind'] }) {
  const [list, setList] = useState<Approval[]>([]);
  const reload = useCallback(() => { api.approvals(session.id).then(setList).catch(() => setList([])); }, [session.id]);
  useEffect(reload, [reload]);
  useServerEvents((e) => { if (e.type === 'approvals.updated' && e.sessionId === session.id) reload(); });
  const shown = only ? list.filter((a) => a.request.kind === only) : list;
  if (shown.length === 0) return null;
  return (
    <section className="approvals" aria-label="확인이 필요한 요청">
      {shown.map((a) => (a.request.kind === 'env' ? <EnvCard key={a.id} approval={a} />
        : a.request.kind === 'testdata' ? <TestDataCard key={a.id} approval={a} />
        : a.request.kind === 'plan' ? <PlanCard key={a.id} approval={a} />
        : a.request.kind === 'question' ? <QuestionCard key={a.id} approval={a} />
        : <AccountCard key={a.id} approval={a} workspaceId={session.workspace_id} />))}
    </section>
  );
}

function useDecide(id: number) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (body: Parameters<typeof api.decideApproval>[1]) => {
    setBusy(true); setError(null);
    try { await api.decideApproval(id, body); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return { busy, error, decide };
}

function EnvCard({ approval }: { approval: Approval }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'env' }>;
  const [rows, setRows] = useState(() => req.vars.map((v) => ({ ...v, on: true })));
  const [target, setTarget] = useState<'session' | 'profile'>('session');
  const { busy, error, decide } = useDecide(approval.id);
  const chosen = rows.filter((r) => r.on);
  const empty = chosen.some((r) => !r.value.trim());
  return (
    <div className="approval-card" role="alertdialog" aria-label="환경값 요청">
      <div className="approval-head">
        <strong>Claude가 {req.project_name} 환경값을 요청했습니다</strong>
        <span className="muted small">확인하기 전까지 Claude가 기다립니다</span>
      </div>
      {approval.reason && <p className="small approval-reason">{approval.reason}</p>}
      <table className="approval-env">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key}>
              <td><input type="checkbox" aria-label={`${r.key} 적용`} checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /></td>
              <td>
                <code>{r.key}</code>
                <div className="muted small">{r.reason}{r.current !== null && ` · 지금 값 ${r.secret ? '(설정됨)' : r.current || '(빈 값)'}`}</div>
              </td>
              <td>
                <input
                  className="mono"
                  type={r.secret ? 'password' : 'text'}
                  aria-label={`${r.key} 값`}
                  placeholder="값을 넣으세요"
                  value={r.value}
                  disabled={!r.on}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset className="checks">
        <legend className="sr-only">저장 위치</legend>
        <label><input type="radio" checked={target === 'session'} onChange={() => setTarget('session')} /> 이번 세션에만</label>
        <label><input type="radio" checked={target === 'profile'} onChange={() => setTarget('profile')} /> 프로필 {req.profile_name}에 저장</label>
      </fieldset>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="small-btn" disabled={busy} onClick={() => decide({ approve: false })}>거절</button>
        <button className="small-btn primary" disabled={busy || chosen.length === 0 || empty} title={empty ? '고른 키에 값을 모두 넣어 주세요' : undefined}
          onClick={() => decide({ approve: true, target, vars: chosen.map((r) => ({ key: r.key, value: r.value })) })}>
          {chosen.length}개 승인
        </button>
      </div>
    </div>
  );
}

/** 작업 중 Claude의 질문. 보기에서 고르거나 직접 적어 답하면 Claude가 그 답으로 이어서 작업한다. */
function QuestionCard({ approval }: { approval: Approval }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'question' }>;
  // 질문마다 고른 보기와 직접 적은 답
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const { busy, error, decide } = useDecide(approval.id);
  const answerOf = (i: number) => [...(picked[i] ?? []), ...(other[i]?.trim() ? [other[i].trim()] : [])].join(', ');
  const allAnswered = req.questions.every((_, i) => answerOf(i));
  const toggle = (i: number, label: string, multi: boolean) => setPicked((p) => {
    const cur = p[i] ?? [];
    return { ...p, [i]: multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] };
  });
  return (
    <div className="approval-card" role="alertdialog" aria-label="Claude의 질문">
      <div className="approval-head">
        <strong>Claude가 묻습니다</strong>
        <span className="muted small">답하기 전까지 Claude가 기다립니다</span>
      </div>
      {req.questions.map((q, i) => (
        <fieldset key={i} className="question">
          <legend>{q.header && <span className="question-chip">{q.header}</span>} {q.question}{q.multiSelect && <span className="muted small"> (여러 개 고를 수 있음)</span>}</legend>
          <div className="question-options">
            {q.options.map((o) => {
              const on = (picked[i] ?? []).includes(o.label);
              return (
                <label key={o.label} className={`question-option${on ? ' on' : ''}`}>
                  <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`q-${approval.id}-${i}`} checked={on}
                    onChange={() => { toggle(i, o.label, q.multiSelect); if (!q.multiSelect) setOther((x) => ({ ...x, [i]: '' })); }} />
                  <span><strong>{o.label}</strong>{o.description && <span className="muted small"> — {o.description}</span>}</span>
                </label>
              );
            })}
            <input className="question-other" placeholder="직접 입력" value={other[i] ?? ''} aria-label={`${q.question} 직접 입력`}
              onChange={(e) => { const v = e.target.value; setOther((x) => ({ ...x, [i]: v })); if (!q.multiSelect && v.trim()) setPicked((p) => ({ ...p, [i]: [] })); }} />
          </div>
        </fieldset>
      ))}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="small-btn" disabled={busy} onClick={() => decide({ approve: false })}>답하지 않기</button>
        <button className="small-btn primary" disabled={busy || !allAnswered} title={allAnswered ? undefined : '모든 질문에 답해 주세요'}
          onClick={() => decide({ approve: true, answers: Object.fromEntries(req.questions.map((q, i) => [q.question, answerOf(i)])) })}>
          답하고 이어서 진행
        </button>
      </div>
    </div>
  );
}

/** 화면 테스트가 진행할 데이터가 없어 막혔다. 만드는 방법을 확인(필요하면 고쳐서)하고 승인하면 만들고 다시 돌린다. */
function TestDataCard({ approval }: { approval: Approval }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'testdata' }>;
  const [plan, setPlan] = useState(req.plan);
  const { busy, error, decide } = useDecide(approval.id);
  return (
    <div className="approval-card" role="alertdialog" aria-label="테스트 데이터 만들기">
      <div className="approval-head">
        <strong>테스트를 진행할 데이터가 없습니다</strong>
        <span className="muted small">정하기 전까지 테스트가 기다립니다</span>
      </div>
      <p className="small approval-reason"><strong>{req.case_title}</strong> — {req.need}</p>
      <label className="field">
        <span>만드는 방법{req.role && <span className="muted small"> · {req.role} 계정으로</span>} <span className="muted small">(고칠 수 있음)</span></span>
        <textarea rows={Math.min(8, Math.max(3, plan.split('\n').length + 1))} value={plan} disabled={busy} onChange={(e) => setPlan(e.target.value)} />
      </label>
      <p className="muted small">승인하면 테스트 서버의 데이터가 실제로 만들어집니다.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="small-btn" disabled={busy} onClick={() => decide({ approve: false })}>만들지 않기</button>
        <button className="small-btn primary" disabled={busy || !plan.trim()} onClick={() => decide({ approve: true, plan })}>만들고 다시 실행</button>
      </div>
    </div>
  );
}

/** 계획 모드를 마친 Claude가 실행해도 되는지 묻는다. 산출물을 열어 보고 승인하거나 고칠 점을 적어 돌려보낸다. */
function PlanCard({ approval }: { approval: Approval }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'plan' }>;
  const [feedback, setFeedback] = useState('');
  const { busy, error, decide } = useDecide(approval.id);
  return (
    <div className="approval-card" role="alertdialog" aria-label="계획 승인">
      <div className="approval-head">
        <strong>Claude가 계획을 마쳤습니다</strong>
        <span className="muted small">승인하면 코드를 고치기 시작합니다</span>
      </div>
      {req.docs.length > 0 ? (
        <ul className="plan-docs" aria-label="계획 문서">
          {req.docs.map((d) => (
            <li key={d.name}><button className="small-btn" onClick={() => openDoc(d.name)}>{DOC_KIND[d.kind]} · {d.title}</button></li>
          ))}
        </ul>
      ) : <p className="warn-text small">저장한 문서가 없습니다. 고칠 점에 "계획서와 화면설계서를 문서로 저장해 줘"라고 적어 돌려보낼 수 있습니다.</p>}
      {req.plan.trim() && (
        <details className="plan-summary">
          <summary className="small">계획 요약</summary>
          <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{req.plan}</ReactMarkdown></div>
        </details>
      )}
      <label className="sr-only" htmlFor={`plan-fb-${approval.id}`}>고칠 점</label>
      <textarea id={`plan-fb-${approval.id}`} className="plan-feedback" placeholder="고칠 점이 있으면 적고 '고쳐 달라고 하기'를 누르세요. 문서를 고쳐 다시 묻습니다." value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="small-btn" disabled={busy} onClick={() => decide({ approve: false })}>실행 안 함</button>
        <button className="small-btn" disabled={busy || !feedback.trim()} onClick={() => decide({ approve: false, feedback })}>고쳐 달라고 하기</button>
        <button className="small-btn primary" disabled={busy || Boolean(feedback.trim())} title={feedback.trim() ? '적은 고칠 점을 보내거나 지운 뒤 승인하세요' : undefined} onClick={() => decide({ approve: true })}>승인하고 실행</button>
      </div>
    </div>
  );
}

function AccountCard({ approval, workspaceId }: { approval: Approval; workspaceId: number }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'account' }>;
  const [free, setFree] = useState<Account[]>([]);
  const [pick, setPick] = useState<number | ''>('');
  const { busy, error, decide } = useDecide(approval.id);
  useEffect(() => {
    api.accounts().then((r) => {
      // 메모가 요청한 역할과 맞는 계정을 앞에 두고 먼저 고른다.
      const words = req.role.toLowerCase().split(/[\s,()/]+/).filter(Boolean);
      const score = (a: Account) => words.filter((w) => a.note.toLowerCase().includes(w) || a.login.toLowerCase().includes(w)).length;
      const list = r.accounts.filter((a) => usableIn(a, workspaceId)).sort((a, b) => score(b) - score(a));
      setFree(list);
      if (list[0] && score(list[0]) > 0) setPick(list[0].id);
    }).catch(() => setFree([]));
  }, [req.role, workspaceId]);
  return (
    <div className="approval-card" role="alertdialog" aria-label="테스트 계정 요청">
      <div className="approval-head">
        <strong>Claude가 테스트 계정을 요청했습니다: {req.role}</strong>
        <span className="muted small">확인하기 전까지 Claude가 기다립니다</span>
      </div>
      {approval.reason && <p className="small approval-reason">{approval.reason}</p>}
      {free.length === 0 ? <p className="muted small">남은 계정이 없습니다. 설정의 테스트 계정 풀에 추가한 뒤 고르거나 거절하세요.</p> : (
        <select value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')} aria-label="배정할 계정">
          <option value="">계정을 고르세요</option>
          {free.map((a) => <option key={a.id} value={a.id}>{a.login}{a.note ? ` · ${a.note}` : ''}</option>)}
        </select>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="small-btn" disabled={busy} onClick={() => decide({ approve: false })}>거절</button>
        <button className="small-btn primary" disabled={busy || pick === ''} onClick={() => decide({ approve: true, account_id: Number(pick) })}>배정하고 알려 주기</button>
      </div>
    </div>
  );
}
