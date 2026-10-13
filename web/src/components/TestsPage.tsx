import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { attachToPrompt, insertIntoPrompt, useServerEvents } from '../events';
import { usableIn, type Account, type Session, type TestCase, type TestState } from '../types';

const STATUS: Record<TestCase['status'], { label: string; cls: string }> = {
  draft: { label: '실행 전', cls: '' },
  queued: { label: '대기', cls: 'accent' },
  running: { label: '실행 중', cls: 'accent' },
  pass: { label: '통과', cls: 'ok' },
  fail: { label: '실패', cls: 'err' },
  blocked: { label: '확인 불가', cls: 'warn' },
  error: { label: '오류', cls: 'err' },
};

const shotUrl = (c: TestCase, file: string) => `/api/tests/file/${c.session_id}/${c.id}/${encodeURIComponent(file)}`;

/**
 * 화면 테스트: 바뀐 내용으로 케이스를 만들고, 역할별 계정을 확인받고, 브라우저로 돌려 화면을 찍는다.
 */
export default function TestsPage({ session, onBack }: { session: Session; onBack: () => void }) {
  const [state, setState] = useState<TestState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<TestCase | 'new' | null>(null);
  const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);

  const reload = useCallback(() => api.tests(session.id).then(setState).catch((e) => setError(e.message)), [session.id]);
  useEffect(() => { reload(); }, [reload]);
  useServerEvents((e) => {
    if ((e.type === 'tests.updated' || e.type === 'server.updated' || e.type === 'session.updated') && e.sessionId === session.id) reload();
  });

  const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
    setError(null); setNotice(null);
    try { await fn(); if (ok) setNotice(ok); } catch (e) { setError((e as Error).message); } finally { reload(); }
  };

  if (!state) return <main className="main scroll"><div className="settings">{error ? <p className="banner error">{error}</p> : <p className="muted">불러오는 중</p>}</div></main>;

  const cases = state.cases;
  const unconfirmed = state.roles.filter((r) => !r.account);
  const busy = state.generating || state.running;
  const counts = { pass: cases.filter((c) => c.status === 'pass').length, bad: cases.filter((c) => ['fail', 'blocked', 'error'].includes(c.status)).length };

  return (
    <main className="main scroll">
      <div className="settings tests">
        <div className="page-head">
          <div>
            <p className="muted small">{session.ticket} · 화면 테스트</p>
            <h1>테스트 케이스</h1>
          </div>
          <div className="row">
            {cases.some((c) => c.ran_at) && <span className="pill accent">통과 {counts.pass} · 실패·확인 불가 {counts.bad}</span>}
            <button onClick={onBack}>세션 화면으로</button>
          </div>
        </div>

        <div className="card tests-head">
          <p className="muted small">
            바뀐 내용과 대화를 보고 Claude가 케이스를 만들고, 실행하면 Claude가 브라우저(Chrome)로 <code>{state.app_url ?? 'FE 서버'}</code>를 열어
            단계를 따라가며 화면을 찍고 통과·실패를 판정합니다. 케이스 하나에 30초~2분쯤 걸립니다.
          </p>
          <div className="row">
            <button disabled={busy} onClick={run(async () => { const r = await api.generateTests(session.id); setNotice(`테스트 케이스 ${r.count}개를 만들었습니다. 계정을 확인한 뒤 실행하세요.`); })}>
              {state.generating ? '케이스 만드는 중 (1~2분)' : cases.length ? '케이스 다시 만들기' : '테스트 케이스 만들기'}
            </button>
            <button disabled={busy} onClick={() => setEditing('new')}>케이스 직접 추가</button>
            <span className="spacer" />
            {state.running ? (
              <button className="danger" onClick={run(() => api.stopTests(session.id))}>중지</button>
            ) : (
              <button className="primary" disabled={busy || cases.length === 0 || unconfirmed.length > 0 || !state.app_url}
                title={!state.app_url ? 'FE 서버를 먼저 실행하세요' : unconfirmed.length ? '역할별 계정을 먼저 확인하세요' : undefined}
                onClick={run(() => api.runTests(session.id), '테스트를 시작했습니다.')}>
                전체 실행
              </button>
            )}
          </div>
          {!state.app_url && <p className="warn-text small">FE 서버가 꺼져 있습니다. 세션 화면에서 서버를 실행한 뒤 테스트하세요.</p>}
        </div>

        {state.roles.length > 0 && <RoleAccounts session={session} state={state} onError={setError} onDone={reload} />}

        {error && <p className="banner error" role="alert">{error}</p>}
        {notice && <p className="banner ok" role="status">{notice}</p>}

        {cases.length === 0 && !state.generating && (
          <p className="placeholder">아직 케이스가 없습니다. "테스트 케이스 만들기"를 누르면 이번 변경을 확인하는 케이스를 만듭니다.</p>
        )}

        <div className="test-list">
          {cases.map((c, i) => (
            <article key={c.id} className={`card test-case ${c.status}`}>
              <header className="test-case-head">
                <div>
                  <h2>{i + 1}. {c.title}</h2>
                  <p className="muted small">
                    <code>{c.start_path}</code>
                    {' · '}{c.role ? <>역할 <strong>{c.role}</strong>{c.account_id && state.roles.find((r) => r.role === c.role)?.account ? ` (${state.roles.find((r) => r.role === c.role)!.account!.login})` : ' (계정 확인 필요)'}</> : '로그인 없이'}
                    {c.ran_at && ` · ${c.ran_at} 실행`}
                  </p>
                </div>
                <div className="row">
                  <span className={`pill ${STATUS[c.status].cls}`}>{c.status === 'running' && <span className="spinner" aria-hidden="true" />} {STATUS[c.status].label}</span>
                  <button className="small-btn" disabled={busy || (!!c.role && !state.roles.find((r) => r.role === c.role)?.account) || !state.app_url} onClick={run(() => api.runTests(session.id, [c.id]))}>이것만 실행</button>
                  <button className="small-btn" disabled={busy} onClick={() => setEditing(c)}>고치기</button>
                  <button className="small-btn danger" disabled={busy} onClick={() => { if (confirm(`"${c.title}" 케이스를 지울까요?`)) run(() => api.deleteTest(session.id, c.id))(); }}>삭제</button>
                </div>
              </header>
              <div className="test-case-body">
                <div>
                  <h3 className="small">단계</h3>
                  <ol className="small">{c.steps.map((s, j) => {
                    const r = c.results[j];
                    return <li key={j} className={r ? (r.ok ? 'ok' : 'bad') : ''}>{s}{r && <span className="muted"> — {r.note}</span>}</li>;
                  })}</ol>
                </div>
                <div>
                  <h3 className="small">기대 결과</h3>
                  <ul className="small">{c.expected.map((s, j) => <li key={j}>{s}</li>)}</ul>
                </div>
              </div>
              {c.summary && <p className={`test-summary ${c.status}`}>{c.summary}</p>}
              {c.shots.length > 0 && (
                <div className="test-shots">
                  {c.shots.map((s) => (
                    <button key={s.file} className="shot-thumb" onClick={() => setZoom({ src: shotUrl(c, s.file), caption: s.caption || s.file })}>
                      <img src={shotUrl(c, s.file)} alt={s.caption || s.file} loading="lazy" />
                      <span className="small muted">{s.caption || s.file}</span>
                    </button>
                  ))}
                </div>
              )}
              {['fail', 'blocked', 'error'].includes(c.status) && (
                <div className="row">
                  <button className="small-btn" onClick={() => sendToPrompt(c)}>프롬프트에 넣기</button>
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
      {editing && <CaseEditor session={session} value={editing === 'new' ? null : editing} roles={state.roles.map((r) => r.role)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {zoom && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setZoom(null); }}>
          <figure className="dialog shot-zoom" role="dialog" aria-modal="true" aria-label={zoom.caption}>
            <img src={zoom.src} alt={zoom.caption} />
            <figcaption className="row"><span className="small">{zoom.caption}</span><span className="spacer" /><button onClick={() => setZoom(null)}>닫기</button></figcaption>
          </figure>
        </div>
      )}
    </main>
  );
}

/** 실패한 케이스를 마지막 스크린샷과 판정 내용으로 프롬프트에 넣는다. */
async function sendToPrompt(c: TestCase) {
  const last = c.shots[c.shots.length - 1];
  if (last) {
    const blob = await fetch(shotUrl(c, last.file)).then((r) => r.blob());
    const data = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
    attachToPrompt({ mediaType: blob.type || 'image/png', data, name: `테스트_${c.id}_${last.file}` });
  }
  const failed = c.results.filter((r) => !r.ok).map((r) => `- ${r.step}: ${r.note}`).join('\n');
  insertIntoPrompt([
    `화면 테스트 "${c.title}"가 ${STATUS[c.status].label}했어. 원인을 찾아서 고쳐줘.`,
    `시작 화면: ${c.start_path}${c.role ? ` (역할: ${c.role})` : ''}`,
    `판정: ${c.summary ?? ''}`,
    failed ? `문제 단계:\n${failed}` : '',
    `기대 결과:\n${c.expected.map((e) => `- ${e}`).join('\n')}`,
  ].filter(Boolean).join('\n'));
}

/** 역할마다 쓸 계정을 사용자가 고른다. 고르기 전에는 그 역할의 케이스를 실행하지 않는다. */
function RoleAccounts({ session, state, onError, onDone }: { session: Session; state: TestState; onError: (m: string) => void; onDone: () => void }) {
  const [free, setFree] = useState<Account[]>([]);
  useEffect(() => { api.accounts().then((r) => setFree(r.accounts.filter((a) => usableIn(a, session.workspace_id)))).catch(() => setFree([])); }, [session.accounts.length, session.workspace_id]);
  const unconfirmed = state.roles.filter((r) => !r.account).length;
  return (
    <section className={`card role-accounts${unconfirmed ? ' needs' : ''}`}>
      <div className="card-head">
        <div>
          <h2>테스트에 쓸 계정 {unconfirmed > 0 && <span className="pill warn">확인 필요 {unconfirmed}</span>}</h2>
          <p className="muted small">케이스마다 필요한 역할의 계정을 고르세요. 고른 계정으로 로그인해서 테스트하고, 남은 계정을 고르면 이 세션에 배정합니다.</p>
        </div>
      </div>
      <ul className="role-list">
        {state.roles.map((r) => (
          <li key={r.role}>
            <strong>{r.role}</strong>
            <span className="muted small">{state.cases.filter((c) => c.role === r.role).length}개 케이스</span>
            <select
              aria-label={`${r.role} 역할에 쓸 계정`}
              value={r.account?.id ?? ''}
              onChange={async (e) => {
                if (!e.target.value) return;
                try { await api.confirmTestAccount(session.id, r.role, Number(e.target.value)); onDone(); } catch (err) { onError((err as Error).message); }
              }}
            >
              <option value="">계정을 고르세요</option>
              {session.accounts.length > 0 && (
                <optgroup label="이 세션 계정">
                  {session.accounts.map((a) => <option key={a.id} value={a.id}>{a.login}{a.note ? ` · ${a.note}` : ''}</option>)}
                </optgroup>
              )}
              {free.length > 0 && (
                <optgroup label="남은 계정 (고르면 이 세션에 배정)">
                  {free.map((a) => <option key={a.id} value={a.id}>{a.login}{a.note ? ` · ${a.note}` : ''}</option>)}
                </optgroup>
              )}
            </select>
            {r.account ? <span className="pill ok">확인됨</span> : <span className="pill warn">확인 필요</span>}
          </li>
        ))}
      </ul>
      {session.accounts.length === 0 && free.length === 0 && <p className="muted small" style={{ padding: '0 20px 14px' }}>고를 계정이 없습니다. 설정의 테스트 계정 풀에 계정을 추가하세요.</p>}
    </section>
  );
}

function CaseEditor({ session, value, roles, onClose, onSaved }: { session: Session; value: TestCase | null; roles: string[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(value?.title ?? '');
  const [role, setRole] = useState(value?.role ?? '');
  const [startPath, setStartPath] = useState(value?.start_path ?? '/');
  const [steps, setSteps] = useState((value?.steps ?? []).join('\n'));
  const [expected, setExpected] = useState((value?.expected ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="case-editor-title" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.saveTest(session.id, { id: value?.id, title, role, start_path: startPath, steps: steps.split('\n'), expected: expected.split('\n') });
          onSaved();
        } catch (err) { setError((err as Error).message); }
      }}>
        <h1 id="case-editor-title">{value ? '케이스 고치기' : '케이스 추가'}</h1>
        <label className="field"><span>제목</span><input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="grid2">
          <label className="field">
            <span>역할 <span className="muted small">(로그인 없이 보면 비움)</span></span>
            <input list="test-roles" value={role} placeholder="관리자" onChange={(e) => setRole(e.target.value)} />
            <datalist id="test-roles">{roles.map((r) => <option key={r} value={r} />)}</datalist>
          </label>
          <label className="field"><span>시작 화면</span><input className="mono" value={startPath} onChange={(e) => setStartPath(e.target.value)} /></label>
        </div>
        <label className="field"><span>단계 <span className="muted small">(한 줄에 하나)</span></span><textarea rows={6} value={steps} onChange={(e) => setSteps(e.target.value)} /></label>
        <label className="field"><span>기대 결과 <span className="muted small">(한 줄에 하나)</span></span><textarea rows={4} value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>취소</button>
          <button type="submit" className="primary">저장</button>
        </div>
      </form>
    </div>
  );
}
