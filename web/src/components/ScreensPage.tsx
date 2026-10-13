import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useServerEvents } from '../events';
import type { Box, ScreenCheck, ScreenState, Session } from '../types';

const STATUS: Record<ScreenCheck['status'], { label: string; cls: string }> = {
  pending: { label: '안 찍음', cls: '' },
  capturing: { label: '찍는 중', cls: 'accent' },
  changed: { label: '차이', cls: 'warn' },
  same: { label: '같음', cls: 'ok' },
  failed: { label: '찍기 실패', cls: 'err' },
  accepted: { label: '의도한 변경', cls: 'ok' },
};

type Mode = 'side' | 'overlay' | 'diff';

export default function ScreensPage({ session, onBack }: { session: Session; onBack: () => void }) {
  const [state, setState] = useState<ScreenState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('side');
  const [route, setRoute] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => api.screens(session.id).then(setState).catch((e) => setError(e.message)), [session.id]);
  useEffect(() => { reload(); }, [reload]);
  useServerEvents((e) => {
    if ((e.type === 'screens.updated' || e.type === 'server.updated') && e.sessionId === session.id) reload();
  });

  const checks = state?.checks ?? [];
  const current = checks.find((c) => c.id === selected) ?? checks.find((c) => c.status === 'changed') ?? checks[0] ?? null;
  const confirmed = checks.filter((c) => c.status === 'same' || c.status === 'accepted').length;

  const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
    setError(null); setNotice(null);
    try { await fn(); if (ok) setNotice(ok); } catch (e) { setError((e as Error).message); } finally { reload(); }
  };

  const capture = (ids?: number[]) => run(async () => {
    const r = await api.captureScreens(session.id, ids);
    if (r.warnings.length) setNotice(r.warnings.join(' '));
  });

  if (!state) return <main className="main scroll"><div className="settings">{error ? <p className="banner error">{error}</p> : <p className="muted">불러오는 중</p>}</div></main>;

  return (
    <main className="main scroll">
      <div className="settings screens">
        <div className="page-head">
          <div>
            <p className="muted small">{session.ticket} · 영향받는 화면</p>
            <h1>전후 비교</h1>
          </div>
          <div className="row">
            <span className="pill accent">확인 {confirmed} / {checks.length}</span>
            <button onClick={onBack}>세션 화면으로</button>
          </div>
        </div>

        <div className="card screens-head">
          <dl className="screens-meta">
            <div><dt>기준</dt><dd>{state.baseline_url ? <code>{state.baseline_url}</code> : <span className="warn-text">없음 · 설정의 {state.fe_project?.name ?? 'FE'} 프로젝트에 기준 서버 주소를 넣으세요</span>}</dd></div>
            <div><dt>작업</dt><dd>{state.after_url ? <code>{state.after_url}</code> : <span className="warn-text">FE 서버가 꺼져 있습니다</span>}</dd></div>
            <div><dt>촬영</dt><dd>{state.account ? `${state.account}${state.login_path ? ` (${state.login_path}에서 로그인)` : ' (로그인 경로 없음, 로그인 없이 찍음)'}` : '계정 없음'} · {state.viewport.width}×{state.viewport.height}</dd></div>
          </dl>
          <div className="row">
            <div className="segmented" role="group" aria-label="보기 방식">
              {(['side', 'overlay', 'diff'] as Mode[]).map((m) => (
                <button key={m} aria-pressed={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {m === 'side' ? '나란히' : m === 'overlay' ? '겹쳐 보기' : '차이만'}
                </button>
              ))}
            </div>
            <span className="spacer" />
            <button disabled={state.detecting} onClick={run(async () => { const r = await api.detectScreens(session.id); setNotice(`영향 화면 ${r.found}개를 찾았습니다.`); })}>
              {state.detecting ? '찾는 중 (1~2분)' : '영향 화면 다시 찾기'}
            </button>
            <button className="primary" disabled={state.capturing || checks.length === 0} onClick={capture()}>{state.capturing ? '찍는 중' : '전체 다시 찍기'}</button>
          </div>
        </div>

        {error && <p className="banner error" role="alert">{error}</p>}
        {notice && <p className="banner ok" role="status">{notice}</p>}

        <div className="screens-body">
          <aside className="card screens-list">
            <ul>
              {checks.length === 0 && <li className="muted small">아직 화면이 없습니다. "영향 화면 다시 찾기"로 Claude에게 찾게 하거나 아래에 직접 넣으세요.</li>}
              {checks.map((c) => (
                <li key={c.id}>
                  <button className={`screen-item${current?.id === c.id ? ' active' : ''}`} aria-current={current?.id === c.id ? 'true' : undefined} onClick={() => setSelected(c.id)}>
                    <span className="mono route">{c.route}</span>
                    <span className={`pill ${STATUS[c.status].cls}`}>{STATUS[c.status].label}{c.status === 'changed' && c.diff_ratio !== null ? ` ${pct(c.diff_ratio)}` : ''}</span>
                    <span className="muted small reason">{c.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
            <form className="add-route" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.addScreen(session.id, route); setRoute(''); })(); }}>
              <label className="sr-only" htmlFor="add-route">화면 경로</label>
              <input id="add-route" className="mono" placeholder="/resources/12" value={route} onChange={(e) => setRoute(e.target.value)} />
              <button type="submit" disabled={!route.trim()}>화면 추가</button>
            </form>
          </aside>

          <section className="card compare" aria-label="비교 영역">
            {!current ? <p className="muted">왼쪽에서 화면을 고르세요.</p> : (
              <>
                <div className="compare-head">
                  <div>
                    <h2 className="mono">{current.route}</h2>
                    <p className="muted small">{current.reason}{current.captured_at ? ` · ${current.captured_at} 촬영` : ''}</p>
                  </div>
                  <div className="row">
                    <button className="small-btn" disabled={state.capturing} onClick={capture([current.id])}>이 화면 다시 찍기</button>
                    <button className="small-btn danger" onClick={run(() => api.removeScreen(current.id))}>목록에서 빼기</button>
                  </div>
                </div>
                {current.status === 'failed' && <p className="banner error">{current.error}</p>}
                {current.before_file && current.after_file ? (
                  <CompareView check={current} mode={mode} />
                ) : (
                  <p className="placeholder">{current.status === 'capturing' ? '찍는 중입니다.' : '아직 찍지 않았습니다. "이 화면 다시 찍기"를 누르세요.'}</p>
                )}
                {current.boxes.length > 0 && current.status !== 'same' && (
                  <ol className="box-list small">
                    {current.boxes.map((b, i) => <li key={i}>차이 {i + 1}: x {b.x}, y {b.y} · {b.w}×{b.h}</li>)}
                  </ol>
                )}
                {current.before_file && (
                  <div className="compare-actions">
                    <label className="field grow">
                      <span>Claude에게 보낼 말 <span className="muted small">(비우면 의도하지 않은 변경인지 보고 고쳐 달라고 보냅니다)</span></span>
                      <input value={note} placeholder="표 헤더 간격이 넓어졌어. 원래대로 돌려줘." onChange={(e) => setNote(e.target.value)} />
                    </label>
                    <div className="row">
                      <button
                        className={current.status === 'accepted' ? 'on' : ''}
                        aria-pressed={current.status === 'accepted'}
                        onClick={run(() => api.acceptScreen(current.id, current.status !== 'accepted'))}
                      >{current.status === 'accepted' ? '의도한 변경 표시 취소' : '의도한 변경으로 표시'}</button>
                      <button className="primary" disabled={session.status === 'running'} onClick={run(async () => { await api.askScreen(current.id, note); setNote(''); }, '전후 이미지와 함께 Claude에게 보냈습니다. 세션 화면에서 진행을 볼 수 있습니다.')}>
                        전후 이미지로 수정 요청
                      </button>
                      {state.after_url && <a className="btn-link" href={new URL(current.route, state.after_url).toString()} target="_blank" rel="noreferrer">미리보기에서 열기</a>}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function pct(r: number) {
  return `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`;
}

const fileUrl = (c: ScreenCheck, f: string) => `/api/screens/file/${c.session_id}/${f}`;

function CompareView({ check, mode }: { check: ScreenCheck; mode: Mode }) {
  const [opacity, setOpacity] = useState(50);
  if (mode === 'diff') return <Shot src={fileUrl(check, check.diff_file!)} label="차이 (빨간 부분)" boxes={check.boxes} />;
  if (mode === 'overlay') {
    return (
      <div className="overlay-view">
        <label className="inline small">기준 ← <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="작업 화면 비율" /> → 작업</label>
        <div className="stack">
          <img src={fileUrl(check, check.before_file!)} alt={`${check.route} 기준 화면`} />
          <img src={fileUrl(check, check.after_file!)} alt={`${check.route} 작업 화면`} style={{ opacity: opacity / 100 }} />
        </div>
      </div>
    );
  }
  return (
    <div className="side-by-side">
      <Shot src={fileUrl(check, check.before_file!)} label="변경 전 (기준)" boxes={check.boxes} />
      <Shot src={fileUrl(check, check.after_file!)} label="변경 후 (작업)" boxes={check.boxes} />
    </div>
  );
}

/** 스크린샷 위에 번호 붙은 차이 상자를 이미지 크기 비율로 얹는다. */
function Shot({ src, label, boxes }: { src: string; label: string; boxes: Box[] }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <figure className="shot">
      <figcaption className="muted small">{label}</figcaption>
      <div className="shot-frame">
        <img src={src} alt={label} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {size && boxes.map((b, i) => (
          <span
            key={i}
            className="diff-box"
            style={{ left: `${(b.x / size.w) * 100}%`, top: `${(b.y / size.h) * 100}%`, width: `${(b.w / size.w) * 100}%`, height: `${(b.h / size.h) * 100}%` }}
          ><span className="diff-num">{i + 1}</span></span>
        ))}
      </div>
    </figure>
  );
}
