import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useServerEvents } from '../events';
import type { Account, Approval, Session } from '../types';

/** Claude가 프롬프트 중에 요청한 환경값·테스트 계정. 사용자가 확인해야 적용되고, 그동안 Claude는 기다린다. */
export default function ApprovalCards({ session }: { session: Session }) {
  const [list, setList] = useState<Approval[]>([]);
  const reload = useCallback(() => { api.approvals(session.id).then(setList).catch(() => setList([])); }, [session.id]);
  useEffect(reload, [reload]);
  useServerEvents((e) => { if (e.type === 'approvals.updated' && e.sessionId === session.id) reload(); });
  if (list.length === 0) return null;
  return (
    <section className="approvals" aria-label="확인이 필요한 요청">
      {list.map((a) => (a.request.kind === 'env' ? <EnvCard key={a.id} approval={a} /> : <AccountCard key={a.id} approval={a} />))}
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

function AccountCard({ approval }: { approval: Approval }) {
  const req = approval.request as Extract<Approval['request'], { kind: 'account' }>;
  const [free, setFree] = useState<Account[]>([]);
  const [pick, setPick] = useState<number | ''>('');
  const { busy, error, decide } = useDecide(approval.id);
  useEffect(() => {
    api.accounts().then((r) => {
      // 메모가 요청한 역할과 맞는 계정을 앞에 두고 먼저 고른다.
      const words = req.role.toLowerCase().split(/[\s,()/]+/).filter(Boolean);
      const score = (a: Account) => words.filter((w) => a.note.toLowerCase().includes(w) || a.login.toLowerCase().includes(w)).length;
      const list = r.accounts.filter((a) => !a.session_id).sort((a, b) => score(b) - score(a));
      setFree(list);
      if (list[0] && score(list[0]) > 0) setPick(list[0].id);
    }).catch(() => setFree([]));
  }, [req.role]);
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
