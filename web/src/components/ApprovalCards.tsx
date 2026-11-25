import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { openDoc, useServerEvents } from '../events';
import { DOC_KIND } from './DocsPage';
import NewSessionDialog from './NewSessionDialog';
import type { Approval, Session, WikiPublishDoc } from '../types';

/** Claude가 프롬프트 중에 요청한 환경값, 계획 승인, 질문, 테스트 데이터. 사용자가 확인해야 적용되고, 그동안 Claude는 기다린다. */
/** chatId를 주면 그 대화가 낸 요청만 보여 준다(only를 주면 대화와 상관없이 그 종류만). */
export default function ApprovalCards({ session, only, chatId }: { session: Pick<Session, 'id'>; only?: Approval['request']['kind']; chatId?: number }) {
  const [list, setList] = useState<Approval[]>([]);
  // 위키 게시처럼 Claude가 기다리지 않는 요청은 처리 결과를 여기 남긴다(카드는 처리하면 사라진다).
  const [result, setResult] = useState<string | null>(null);
  const reload = useCallback(() => { api.approvals(session.id).then(setList).catch(() => setList([])); }, [session.id]);
  useEffect(reload, [reload]);
  useServerEvents((e) => { if (e.type === 'approvals.updated' && e.sessionId === session.id) reload(); });
  const shown = only ? list.filter((a) => a.request.kind === only) : chatId !== undefined ? list.filter((a) => a.chat_id === chatId) : list;
  if (shown.length === 0 && !result) return null;
  return (
    <section className="approvals" aria-label="확인이 필요한 요청">
      {result && (
        <p className="banner ok row" role="status">
          <span>{result}</span><span className="spacer" />
          <button className="small-btn" onClick={() => setResult(null)}>닫기</button>
        </p>
      )}
      {shown.map((a) => (a.request.kind === 'env' ? <EnvCard key={a.id} approval={a} />
        : a.request.kind === 'wikipublish' ? <WikiPublishCard key={a.id} approval={a} onResult={setResult} />
        : a.request.kind === 'testdata' ? <TestDataCard key={a.id} approval={a} />
        : a.request.kind === 'plan' ? <PlanCard key={a.id} approval={a} />
        : a.request.kind === 'dbwrite' ? <DbWriteCard key={a.id} approval={a} />
        : a.request.kind === 'session' ? <SessionCard key={a.id} approval={a} />
        : <QuestionCard key={a.id} approval={a} />))}
    </section>
  );
}

function useDecide(id: number, onResult?: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (body: Parameters<typeof api.decideApproval>[1]) => {
    setBusy(true); setError(null);
    try { const r = await api.decideApproval(id, body); if (r.message) onResult?.(r.message); } catch (e) { setError((e as Error).message); setBusy(false); }
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

/** Claude가 DB 데이터를 바꾸려는 SQL. 사용자가 보고(고쳐서) 승인하면 실행하고 결과를 Claude에게 돌려준다. */
function DbWriteCard({ approval }: { approval: Approval }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'dbwrite' }>;
  const [sql, setSql] = useState(req.sql);
  const [feedback, setFeedback] = useState('');
  const { busy, error, decide } = useDecide(approval.id);
  return (
    <div className="approval-card" role="alertdialog" aria-label="DB 변경 승인">
      <div className="approval-head">
        <strong>Claude가 {req.connection_name} DB의 데이터를 바꾸려고 합니다</strong>
        <span className="muted small">{req.target}</span>
      </div>
      {approval.reason && <p className="small approval-reason">{approval.reason}</p>}
      <label className="field">
        <span>실행할 SQL <span className="muted small">(고칠 수 있음)</span></span>
        <textarea className="mono db-sql" rows={Math.min(12, Math.max(3, sql.split('\n').length + 1))} value={sql} disabled={busy} spellCheck={false} onChange={(e) => setSql(e.target.value)} />
      </label>
      <input className="plan-feedback" placeholder="실행하지 않을 때 Claude에게 남길 말 (선택)" aria-label="실행하지 않는 이유" value={feedback} disabled={busy} onChange={(e) => setFeedback(e.target.value)} />
      <p className="warn-text small">승인하면 이 DB에 바로 반영되고 되돌리지 않습니다.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="small-btn" disabled={busy} onClick={() => decide({ approve: false, feedback: feedback.trim() || undefined })}>실행 안 함</button>
        <button className="small-btn primary" disabled={busy || !sql.trim()} onClick={() => decide({ approve: true, sql })}>{busy ? '실행 중…' : '승인하고 실행'}</button>
      </div>
    </div>
  );
}

/** 곁가지 작업을 새 세션으로 떼어 내자는 제안. 새 세션 창을 초안으로 열고, 사용자가 Jira 이슈를 정해 만들면 승인으로 본다. */
function SessionCard({ approval }: { approval: Approval }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'session' }>;
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const { busy, error, decide } = useDecide(approval.id);
  return (
    <div className="approval-card" role="alertdialog" aria-label="새 세션 제안">
      <div className="approval-head">
        <strong>Claude가 새 세션을 제안했습니다</strong>
        <span className="muted small">{req.workspace_name} · {req.jira_key ? `Jira ${req.jira_key}` : '새 Jira 이슈'} · 만들기 전까지 Claude가 기다립니다</span>
      </div>
      {approval.reason && <p className="small approval-reason">{approval.reason}</p>}
      <p className="strong">{req.jira_key && <span className="mono">{req.jira_key} </span>}{req.summary}</p>
      {req.description && <div className="small approval-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{req.description}</ReactMarkdown></div>}
      {req.first_prompt && <p className="muted small">첫 프롬프트: {req.first_prompt}</p>}
      <input className="plan-feedback" placeholder="만들지 않을 때 Claude에게 남길 말 (선택)" aria-label="만들지 않는 이유" value={feedback} disabled={busy} onChange={(e) => setFeedback(e.target.value)} />
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="small-btn" disabled={busy} onClick={() => decide({ approve: false, feedback: feedback.trim() || undefined })}>만들지 않음</button>
        <button className="small-btn primary" disabled={busy} onClick={() => setOpen(true)}>세션 만들기…</button>
      </div>
      {open && (
        <NewSessionDialog
          draft={{ workspaceId: req.workspace_id, jiraKey: req.jira_key, summary: req.summary, description: req.description, firstPrompt: req.first_prompt }}
          onClose={() => setOpen(false)}
          onCreated={(s) => { setOpen(false); decide({ approve: true, session: { id: s.id, ticket: s.ticket } }); }}
        />
      )}
    </div>
  );
}

// Guide Manager 2차 검사와 같은 규칙(server/src/wikipublish.ts SENSITIVE). 게시본을 고치는 동안 바로 보여 주고, 남아 있으면 승인하지 못하게 한다.
const SENSITIVE: [string, RegExp][] = [
  ['개인 키', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS 키', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub 토큰', /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['API 토큰', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bgmp_[A-Za-z0-9_-]{20,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['접속 정보', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['접속 정보', /\bjdbc:[^\s]*[/:@][^\s/:@]+\/[^\s@]+@/i],
  ['비밀값', /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|비밀번호)\b["']?\s*[:=]\s*["']?(?!«|\*{3}|<|\$\{|…|-|xxx)[^\s"'`|]{6,}/i],
  ['이메일', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['사설 IP', /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['로컬 경로', /(^|[\s`(])\/(Users|home)\/[^\s/`]+\//],
];
function precheck(md: string) {
  const out: { line: number; kind: string }[] = [];
  md.split('\n').forEach((l, i) => {
    for (const [kind, re] of SENSITIVE) if (re.test(l)) { out.push({ line: i + 1, kind }); break; }
  });
  return out;
}

const TRIGGER: Record<'plan' | 'report' | 'manual', string> = { plan: '계획 승인 직후', report: '완료 보고서 저장 직후', manual: '산출물 화면에서' };

/**
 * Project-Wiki 게시 승인. 원문(보관함)과 가린 게시본을 나란히 보여 주고, 사용자가 고르고 고친 게시본만 보낸다.
 * Claude는 기다리지 않는다. 실패한 문서는 서버가 새 카드로 다시 올린다.
 */
function WikiPublishCard({ approval, onResult }: { approval: Approval; onResult: (message: string) => void }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'wikipublish' }>;
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(req.docs.map((d) => [d.name, d.markdown])));
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(req.docs.map((d) => [d.name, !d.blocked])));
  const [active, setActive] = useState(req.docs.find((d) => !d.blocked)?.name ?? req.docs[0]?.name);
  const [reverted, setReverted] = useState<Record<string, Set<number>>>({});
  const [showMasked, setShowMasked] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const { busy, error, decide } = useDecide(approval.id, onResult);
  const doc = req.docs.find((d) => d.name === active);
  const hits = useMemo(() => Object.fromEntries(req.docs.map((d) => [d.name, precheck(texts[d.name] ?? '')])), [req.docs, texts]);
  const chosen = req.docs.filter((d) => on[d.name] && !d.blocked);
  const stuck = chosen.filter((d) => hits[d.name].length > 0 || !(texts[d.name] ?? '').trim());

  /** 게시본 textarea에서 그 줄을 고른다 */
  function goLine(line: number) {
    const el = area.current;
    if (!el) return;
    const lines = el.value.split('\n');
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    el.scrollTop = Math.max(0, (line - 3) * 18);
  }

  /** 가린 것 하나를 원래 값으로 되돌린다. 그 줄에서 먼저 찾고, 줄이 바뀌었으면 본문 전체에서 찾는다. */
  function revert(d: WikiPublishDoc, i: number) {
    const m = d.masked[i];
    const text = texts[d.name] ?? '';
    const lines = text.split('\n');
    let next = text;
    if (lines[m.line - 1]?.includes(m.after)) { lines[m.line - 1] = lines[m.line - 1].replace(m.after, m.before); next = lines.join('\n'); }
    else if (text.includes(m.after)) next = text.replace(m.after, m.before);
    else return;
    setTexts({ ...texts, [d.name]: next });
    setReverted({ ...reverted, [d.name]: new Set([...(reverted[d.name] ?? []), i]) });
  }

  const counts = doc ? Object.entries(doc.masked.reduce<Record<string, number>>((a, m) => ({ ...a, [m.kind]: (a[m.kind] ?? 0) + 1 }), {})) : [];
  return (
    <div className="approval-card wiki-card" role="alertdialog" aria-label="Project-Wiki 게시">
      <div className="approval-head">
        <strong>Project-Wiki에 게시할까요?</strong>
        <span className="muted small">{TRIGGER[req.trigger]} · 승인하기 전에는 아무것도 보내지 않습니다</span>
      </div>
      <p className="small">
        대상 <b>{req.target.project_name}</b> · 보낸 곳 <span className="pill">worktree-studio</span> · 게시자 <span className="mono">{req.target.author_email}</span>
      </p>
      <ul className="wiki-docs" aria-label="게시할 문서">
        {req.docs.map((d) => (
          <li key={d.name} className={d.name === active ? 'active' : undefined}>
            <label>
              <input type="checkbox" disabled={busy || Boolean(d.blocked)} checked={Boolean(on[d.name]) && !d.blocked} onChange={(e) => setOn({ ...on, [d.name]: e.target.checked })} />
              {DOC_KIND[d.kind]} · {d.title} <span className="muted small">{d.version}판</span>
            </label>
            <span className="mono small muted">{d.note}</span>
            <span className={`pill${d.update ? ' warn' : ''}`}>{d.update ? (d.published_version ? `갱신 (위키 ${d.published_version}판)` : '다시 게시') : '새로 만듦'}</span>
            {!d.blocked && d.name !== active && <button className="small-btn" onClick={() => setActive(d.name)}>내용 보기</button>}
            {hits[d.name]?.length > 0 && <span className="pill err">남은 민감 정보 {hits[d.name].length}</span>}
            {d.blocked && <span className="error-text small">{d.blocked}</span>}
            {d.error && <p className="error-text small">지난 시도 실패: {d.error}</p>}
          </li>
        ))}
      </ul>
      <p className="muted small">화면설계서·테스트 결과서는 게시하지 않습니다.</p>

      {doc && !doc.blocked && (
        <>
          <div className="row small wiki-masked-head">
            <span>가린 항목 {doc.masked.length}건</span>
            {counts.map(([k, n]) => <span key={k} className="pill">{k} {n}</span>)}
            {doc.masked.length > 0 && <button className="small-btn" onClick={() => setShowMasked(!showMasked)}>{showMasked ? '접기' : '모두 보기'}</button>}
          </div>
          {showMasked && (
            <ul className="wiki-masked small">
              {doc.masked.map((m, i) => (
                <li key={i}>
                  <button className="link" onClick={() => goLine(m.line)}>{m.line}행</button> {m.kind}
                  <span className="mono wiki-del"> {m.before}</span> → <span className="mono wiki-mask">{m.after}</span>
                  {m.kind !== '그림' && m.kind !== '개인 키' && (
                    reverted[doc.name]?.has(i) ? <span className="muted"> (되돌림)</span>
                      : <button className="small-btn" disabled={busy} onClick={() => revert(doc, i)}>되돌리기</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="wiki-compare">
            <div>
              <span className="small strong">원문 (로컬 보관함)</span>
              <pre className="mono">{doc.original}</pre>
            </div>
            <div>
              <label className="small strong" htmlFor={`wiki-md-${approval.id}`}>게시본 (직접 고칠 수 있음)</label>
              <textarea id={`wiki-md-${approval.id}`} ref={area} className="mono" spellCheck={false} disabled={busy}
                value={texts[doc.name] ?? ''} onChange={(e) => setTexts({ ...texts, [doc.name]: e.target.value })} />
            </div>
          </div>
          {hits[doc.name].length > 0 && (
            <p className="error-text small" role="alert">
              민감 정보로 보이는 내용이 남아 있어 게시할 수 없습니다:{' '}
              {hits[doc.name].map((h) => <button key={h.line} className="link" onClick={() => goLine(h.line)}>{h.line}행 {h.kind}</button>)}
            </p>
          )}
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="small-btn" disabled={busy} onClick={() => decide({ approve: false })}>건너뛰기</button>
        <button className="small-btn primary" disabled={busy || chosen.length === 0 || stuck.length > 0}
          title={stuck.length ? `${stuck.map((d) => d.title).join(', ')}의 게시본을 먼저 고치세요` : undefined}
          onClick={() => decide({ approve: true, docs: chosen.map((d) => ({ name: d.name, markdown: texts[d.name] ?? '' })) })}>
          {busy ? `게시 중… (${chosen.length}건)` : '승인하고 게시'}
        </button>
      </div>
    </div>
  );
}
