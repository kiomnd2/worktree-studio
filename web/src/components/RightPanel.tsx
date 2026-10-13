import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, missingFrom } from '../api';
import { attachToPrompt, insertIntoPrompt, openInPreview, useServerEvents } from '../events';
import type { Account, LogLine, ScreenCheck, ScreenState, ServerView, Session, WorktreeChanges } from '../types';
import StartServersDialog from './StartServersDialog';

const STATUS_LABEL: Record<string, string> = {
  idle: '꺼짐', starting: '시작 중', running: '실행 중', unhealthy: '응답 없음', failed: '멈춤', stopped: '꺼짐',
};

type Props = { session: Session; onOpenEnv: (message?: string) => void; onOpenChanges: () => void; onClosed: () => void };

export default function RightPanel({ session, onOpenEnv, onOpenChanges, onClosed }: Props) {
  const [servers, setServers] = useState<ServerView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'start' | 'restart'; worktreeIds?: number[] } | null>(null);

  const reload = useCallback(() => {
    api.servers(session.id).then(setServers).catch((e) => setError(e.message));
  }, [session.id]);
  useEffect(reload, [reload]);
  useServerEvents((e) => { if (e.type === 'server.updated' && e.sessionId === session.id) reload(); });

  async function act(kind: 'start' | 'stop' | 'restart', worktreeIds?: number[], commands?: Record<number, string>) {
    setBusy(true);
    setError(null);
    try {
      const fn = kind === 'start' ? api.startServers : kind === 'stop' ? api.stopServers : api.restartServers;
      setServers(await fn(session.id, worktreeIds, commands));
    } catch (e) {
      const missing = missingFrom(e);
      if (missing) onOpenEnv(`필수 값이 비어 있습니다: ${missing.map((m) => `${m.project} ${m.keys.join(', ')}`).join(' / ')}`);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // 실행과 재시작은 어떤 명령이 나가는지 먼저 보여 준다.
  const confirmTargets = confirm
    ? servers.filter((s) => s.can_start && (confirm.worktreeIds ? confirm.worktreeIds.includes(s.worktree_id) : !isLive(s)))
    : [];

  const anyRunning = servers.some(isLive);
  const fe = servers.find((s) => s.project_kind !== 'be' && s.url);
  const be = servers.find((s) => s.project_kind === 'be' && s.url);

  return (
    <>
    <PanelResizer />
    <section className="panel" aria-label="서버, 미리보기, 로그">
      <div className="panel-block">
        <div className="block-head">
          <h2>서버</h2>
          <div className="row">
            <button className="small-btn" onClick={() => onOpenEnv()}>환경값</button>
            {anyRunning
              ? <button className="small-btn" disabled={busy} onClick={() => act('stop')}>모두 끄기</button>
              : <button className="small-btn primary" disabled={busy || servers.every((s) => !s.can_start)} onClick={() => setConfirm({ kind: 'start' })}>모두 실행</button>}
          </div>
        </div>
        <ul className="server-list">
          {servers.map((s) => {
            const live = isLive(s);
            return (
              <li key={s.worktree_id}>
                <span className={`srv-dot ${s.status}`} aria-hidden="true" />
                <span className="srv-name">{s.project_name}</span>
                <span className="muted small">{STATUS_LABEL[s.status]}{s.port && live ? ` :${s.port}` : ''}{s.status === 'failed' && s.exit_code !== null ? ` (코드 ${s.exit_code})` : ''}</span>
                <span className="spacer" />
                {!s.can_start ? (
                  <span className="muted small">실행 명령 없음</span>
                ) : live ? (
                  <>
                    <button className="small-btn" disabled={busy} onClick={() => setConfirm({ kind: 'restart', worktreeIds: [s.worktree_id] })}>재시작</button>
                    <button className="small-btn" disabled={busy} onClick={() => act('stop', [s.worktree_id])}>끄기</button>
                  </>
                ) : (
                  <button className="small-btn" disabled={busy} onClick={() => setConfirm({ kind: 'start', worktreeIds: [s.worktree_id] })}>실행</button>
                )}
                {s.failure && <FailureBox server={s} sessionId={session.id} onChanged={setServers} onError={setError} />}
              </li>
            );
          })}
        </ul>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>

      <ChangesBlock session={session} onOpen={onOpenChanges} />

      <ScreensBlock session={session} />

      {fe ? <Preview key={fe.url} sessionId={session.id} baseUrl={fe.url!} ready={fe.status === 'running'} /> : (
        <div className="placeholder">
          <strong>미리보기</strong>
          <p>{be ? <>FE 서버가 없습니다. BE는 <a href={be.url!} target="_blank" rel="noreferrer">{be.url}</a>에서 실행 중입니다.</> : 'FE 서버를 실행하면 여기에 화면이 나옵니다.'}</p>
        </div>
      )}

      <Logs servers={servers} />

      <AccountBlock session={session} />

      <CloseBlock session={session} anyRunning={anyRunning} onClosed={onClosed} />

      {confirm && confirmTargets.length > 0 && (
        <StartServersDialog
          targets={confirmTargets}
          restart={confirm.kind === 'restart'}
          onCancel={() => setConfirm(null)}
          onConfirm={async (commands) => {
            setConfirm(null);
            await act(confirm.kind, confirm.worktreeIds, commands);
          }}
        />
      )}
    </section>
    </>
  );
}

/** 서버가 멈췄거나 응답이 없을 때 오류 요약을 보여 준다. 고칠지는 사용자가 정한다. */
function FailureBox({ server: s, sessionId, onChanged, onError }: {
  server: ServerView; sessionId: number; onChanged: (list: ServerView[]) => void; onError: (m: string | null) => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const f = s.failure!;
  return (
    <div className="failure-box err" role="alert">
      <div className="failure-title">{f.kind === 'exit' ? '서버가 멈췄습니다' : '서버가 응답하지 않습니다'}</div>
      <code className="failure-summary">{f.summary}</code>
      <div className="failure-actions">
        <button className="small-btn" onClick={() => setShowLog((v) => !v)}>{showLog ? '로그 접기' : '오류 로그'}</button>
        <button className="small-btn" onClick={() => insertIntoPrompt(`${s.project_name} 서버가 실행 중에 실패했어.\n실행 명령: ${f.command}\n\`\`\`\n${f.excerpt.split('\n').slice(-80).join('\n')}\n\`\`\``)}>프롬프트에 넣기</button>
        <button className="small-btn" onClick={async () => {
          onError(null);
          try { onChanged(await api.dismissFailure(sessionId, s.worktree_id)); } catch (e) { onError((e as Error).message); }
        }}>닫기</button>
      </div>
      {showLog && <pre className="log-box failure-log">{f.excerpt}</pre>}
    </div>
  );
}

const PANEL_W_KEY = 'wts:panel-width';
const PREVIEW_H_KEY = 'wts:preview-height';
const PREVIEW_FIT_KEY = 'wts:preview-fit';
/** 화면 맞춤에서 페이지를 그리는 폭. 일반적인 데스크톱 화면 폭. */
const DESKTOP_WIDTH = 1440;

function readNumber(key: string, fallback: number) {
  try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : fallback; } catch { return fallback; }
}
function writeNumber(key: string, v: number) {
  try { localStorage.setItem(key, String(v)); } catch { /* 사생활 보호 모드 등 */ }
}

/**
 * 대화창과 오른쪽 패널 사이 경계. 끌어서 패널 폭을 바꾸고, 두 번 누르면 기본 폭으로 돌린다.
 * 폭은 CSS 변수 --panel-w로 넘겨 좁은 화면 규칙(패널이 아래로 쌓임)은 그대로 둔다.
 */
function PanelResizer() {
  useEffect(() => {
    const saved = readNumber(PANEL_W_KEY, 0);
    if (saved) document.documentElement.style.setProperty('--panel-w', `${saved}px`);
  }, []);
  const clamp = (w: number) => Math.max(360, Math.min(w, window.innerWidth - 480));
  const set = (w: number) => {
    document.documentElement.style.setProperty('--panel-w', `${w}px`);
    writeNumber(PANEL_W_KEY, w);
  };
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="오른쪽 패널 폭 조절 (끌거나 화살표 키, 두 번 누르면 기본 폭)"
      tabIndex={0}
      onDoubleClick={() => { document.documentElement.style.removeProperty('--panel-w'); try { localStorage.removeItem(PANEL_W_KEY); } catch { /* */ } }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const cur = document.querySelector('.panel')?.getBoundingClientRect().width ?? 480;
        set(clamp(cur + (e.key === 'ArrowLeft' ? 40 : -40)));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        // 끄는 동안 미리보기 iframe이 마우스를 가로채지 않게 막는다.
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => set(clamp(window.innerWidth - ev.clientX));
        const up = () => {
          document.body.classList.remove('resizing');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    >
      <span className="grip" aria-hidden="true" />
    </div>
  );
}

function isLive(s: ServerView) {
  return s.status === 'starting' || s.status === 'running' || s.status === 'unhealthy';
}

/** 기준 브랜치와 달라진 파일 수 요약. 자세한 비교는 변경 파일 화면에서 한다. */
function ChangesBlock({ session, onOpen }: { session: Session; onOpen: () => void }) {
  const [data, setData] = useState<WorktreeChanges[] | null>(null);
  const reload = useCallback(() => { api.changes(session.id, 'base').then(setData).catch(() => setData(null)); }, [session.id]);
  useEffect(reload, [reload]);
  // Claude 작업이 끝나면(세션 상태가 바뀌면) 다시 센다.
  useServerEvents((e) => { if (e.type === 'session.updated' && e.sessionId === session.id) reload(); });
  const total = data?.reduce((n, w) => n + w.files.length, 0) ?? 0;
  return (
    <div className="panel-block">
      <div className="block-head">
        <h2>변경 파일 {data && <span className="muted small">{total}개</span>}</h2>
        <button className="small-btn primary" disabled={!data || total === 0} onClick={onOpen}>비교 보기</button>
      </div>
      {data && (
        <ul className="changes-summary">
          {data.map((w) => {
            const add = w.files.reduce((n, f) => n + (f.additions ?? 0), 0);
            const del = w.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
            return (
              <li key={w.worktree_id}>
                <span>{w.project_name}</span>
                <span className="muted small">{w.files.length ? <>{w.files.length}개 <span className="plus">+{add}</span> <span className="minus">−{del}</span></> : '변경 없음'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 영향받는 화면 체크리스트. Claude가 바뀐 파일에서 경로를 찾고, 사용자가 미리보기로 열어 보고 확인 표시를 한다.
 */
function ScreensBlock({ session }: { session: Session }) {
  const [state, setState] = useState<ScreenState | null>(null);
  const [route, setRoute] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { api.screens(session.id).then(setState).catch(() => setState(null)); }, [session.id]);
  useEffect(reload, [reload]);
  useServerEvents((e) => { if (e.type === 'screens.updated' && e.sessionId === session.id) reload(); });
  if (!state?.fe_project) return null;
  const direct = state.checks.filter((c) => c.kind === 'direct' || c.manual);
  const indirect = state.checks.filter((c) => c.kind === 'indirect' && !c.manual);
  const done = direct.filter((c) => c.checked).length;
  const run = (fn: () => Promise<unknown>) => { setError(null); fn().then(reload).catch((e) => setError(e.message)); };
  const item = (c: ScreenCheck) => (
    <li key={c.id}>
      <input type="checkbox" aria-label={`${c.route} 확인함`} checked={c.checked} onChange={(e) => run(() => api.checkScreen(c.id, e.target.checked))} />
      <div className="screen-entry">
        <button className="link mono route" title={state.preview_url ? '미리보기에서 열기' : 'FE 서버를 실행하면 미리보기에서 열 수 있습니다'} disabled={!state.preview_url} onClick={() => openInPreview(c.route)}>{c.route}</button>
        <span className="muted small">{c.reason}</span>
        {c.also_routes.length > 0 && (
          <span className="small also-routes">같은 화면:{' '}
            {c.also_routes.map((r) => <button key={r} className="link mono" disabled={!state.preview_url} onClick={() => openInPreview(r)}>{r}</button>)}
          </span>
        )}
      </div>
      <button className="icon" aria-label={`${c.route} 목록에서 빼기`} onClick={() => run(() => api.removeScreen(c.id))}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </li>
  );
  return (
    <div className="panel-block">
      <div className="block-head">
        <h2>영향받는 화면 {direct.length > 0 && <span className="muted small">확인 {done} / {direct.length}</span>}</h2>
        <button className="small-btn" disabled={state.detecting} onClick={() => run(() => api.detectScreens(session.id))}>
          {state.detecting ? '찾는 중' : state.checks.length ? '다시 찾기' : '영향 화면 찾기'}
        </button>
      </div>
      {state.checks.length === 0 && (
        <p className="muted small">{state.detecting ? 'Claude가 바뀐 내용을 보고 실제로 달라지는 화면을 고르는 중입니다. 1~2분 걸립니다.' : '바뀐 내용을 보고 직접 열어 확인해야 할 화면을 고릅니다.'}</p>
      )}
      {direct.length > 0 && <ul className="screen-checklist">{direct.map(item)}</ul>}
      {direct.length === 0 && indirect.length > 0 && <p className="muted small">보이는 게 확실히 바뀌는 화면은 없습니다.</p>}
      {indirect.length > 0 && (
        <details className="indirect">
          <summary className="small">간접 영향 {indirect.length}개 <span className="muted">(바뀐 코드를 쓰지만 보이는 변화는 확실하지 않음)</span></summary>
          <ul className="screen-checklist">{indirect.map(item)}</ul>
        </details>
      )}
      <form className="add-route" onSubmit={(e) => { e.preventDefault(); if (route.trim()) run(async () => { await api.addScreen(session.id, route); setRoute(''); }); }}>
        <label className="sr-only" htmlFor={`add-route-${session.id}`}>화면 경로 추가</label>
        <input id={`add-route-${session.id}`} className="mono" placeholder="/resources/12" value={route} onChange={(e) => setRoute(e.target.value)} />
        <button type="submit" className="small-btn" disabled={!route.trim()}>추가</button>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}

function Preview({ sessionId, baseUrl, ready }: { sessionId: number; baseUrl: string; ready: boolean }) {
  const [path, setPath] = useState('/');
  const [src, setSrc] = useState(`${baseUrl}/`);
  const [capturing, setCapturing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [expanded, setExpanded] = useExpand();
  const block = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  // 미리보기 높이는 오른쪽 아래 손잡이로 늘이고 줄인다. 다음에 열어도 같은 높이로.
  const frameWrap = useRef<HTMLDivElement>(null);
  const [frameHeight] = useState(() => readNumber(PREVIEW_H_KEY, 420));
  // 화면 맞춤: 데스크톱 폭으로 그린 페이지를 패널 폭에 맞게 줄여 전체 배치를 본다. 끄면 실제 크기.
  const [fit, setFit] = useState(() => readNumber(PREVIEW_FIT_KEY, 1) === 1);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = frameWrap.current;
    if (!el || !fit) { setScale(1); return; }
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / DESKTOP_WIDTH)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, ready]);
  useEffect(() => {
    const el = frameWrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (!expanded) writeNumber(PREVIEW_H_KEY, Math.round(el.getBoundingClientRect().height)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready, expanded]);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const p = (e as CustomEvent<string>).detail;
      setPath(p);
      setSrc(`${baseUrl}${p.startsWith('/') ? p : `/${p}`}`);
      // 체크리스트보다 아래에 있어 화면 밖일 수 있다. 미리보기로 스크롤하고 잠깐 강조해 바뀐 걸 알 수 있게 한다.
      block.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
    };
    window.addEventListener('wts:preview-open', onOpen);
    return () => window.removeEventListener('wts:preview-open', onOpen);
  }, [baseUrl]);
  const go = () => setSrc(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  return (
    <div ref={block} className={`panel-block preview${expanded ? ' expanded' : ''}${flash ? ' flash' : ''}`}>
      <div className="block-head">
        <h2>미리보기</h2>
        <div className="row">
          {!ready && <span className="muted small">서버가 응답하기를 기다리는 중</span>}
          <ExpandButton expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        </div>
      </div>
      <form className="url-bar" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <span className="mono small muted">{baseUrl.replace('http://', '')}</span>
        <label className="sr-only" htmlFor="preview-path">경로</label>
        <input id="preview-path" className="mono" value={path} onChange={(e) => setPath(e.target.value)} />
        <button type="button" className="icon bordered" aria-label="새로고침" onClick={() => { const f = frame.current; if (f) f.src = src; }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 5.3M20 4v7h-7" /></svg>
        </button>
        <a className="btn-link" href={src} target="_blank" rel="noreferrer">새 창</a>
      </form>
      <div className="row">
        <button type="button" className="small-btn" disabled={!ready || capturing} onClick={async () => {
          setCapturing(true); setNote(null);
          try {
            // 미리보기 안에서 옮겨 다녔으면 그 주소를 찍는다. 다른 출처라 못 읽으면 입력한 경로를 쓴다.
            let url = src;
            try { url = frame.current?.contentWindow?.location.href ?? src; } catch { /* cross-origin */ }
            const r = await api.capturePreview(sessionId, url);
            const pagePath = new URL(url).pathname;
            const base = pagePath.replace(/^\/+|\/+$/g, '').replace(/\//g, '_');
            attachToPrompt({ mediaType: 'image/png', data: r.data, name: `화면${base ? `_${base}` : ''}.png` });
            insertIntoPrompt(`${pagePath} 화면`);
            setNote(r.warning ?? '이 페이지를 프롬프트에 첨부했습니다.');
            // 크게 보기 중이면 닫아서 바로 입력창을 보이게 한다.
            setExpanded(false);
          } catch (e) { setNote((e as Error).message); } finally { setCapturing(false); }
        }}>{capturing ? '화면 찍는 중' : '프롬프트에 전달'}</button>
        <label className="start-check small" title={`페이지를 ${DESKTOP_WIDTH}px 폭으로 그려 패널에 맞게 줄입니다`}>
          <input type="checkbox" checked={fit} onChange={(e) => { setFit(e.target.checked); writeNumber(PREVIEW_FIT_KEY, e.target.checked ? 1 : 2); }} /> 화면 맞춤
        </label>
        {note && <span className="muted small">{note}</span>}
      </div>
      {ready ? (
        <div className={`frame-wrap${fit ? ' fit' : ''}`} ref={frameWrap} style={{ height: frameHeight }}>
          <iframe
            ref={frame}
            title="FE 미리보기"
            src={src}
            style={fit ? { width: DESKTOP_WIDTH, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: '0 0' } : undefined}
          />
        </div>
      ) : <div className="frame-wait">시작 중</div>}
      <p className="muted small">로그인 쿠키가 미리보기 안에서 안 붙으면 새 창으로 여세요.</p>
    </div>
  );
}

function Logs({ servers }: { servers: ServerView[] }) {
  const [tab, setTab] = useState<number | null>(null);
  const [lines, setLines] = useState<Record<number, LogLine[]>>({});
  const [filter, setFilter] = useState<'all' | 'warn'>('all');
  const [search, setSearch] = useState('');
  const box = useRef<HTMLDivElement>(null);
  // 스크롤이 맨 아래에 붙어 있으면 새 줄을 따라 내려간다. 위로 올려 보는 중이면 그대로 둔다.
  const stick = useRef(true);
  const [expanded, setExpanded] = useExpand();
  const active = tab ?? servers.find((s) => s.project_kind === 'be')?.worktree_id ?? servers[0]?.worktree_id ?? null;
  const runKey = servers.map((s) => `${s.worktree_id}:${s.started_at ?? ''}`).join(',');

  useEffect(() => {
    let cancelled = false;
    Promise.all(servers.map(async (s) => [s.worktree_id, await api.logs(s.worktree_id).catch(() => [])] as const))
      .then((entries) => { if (!cancelled) setLines(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [runKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useServerEvents((e) => {
    if (e.type !== 'log') return;
    if (!servers.some((s) => s.worktree_id === e.worktreeId)) return;
    setLines((prev) => {
      const cur = prev[e.worktreeId] ?? [];
      const last = cur[cur.length - 1]?.seq ?? 0;
      const add = e.lines.filter((l) => l.seq > last || l.seq === 1);
      const restarted = add[0]?.seq === 1;
      const next = (restarted ? add : [...cur, ...add]).slice(-3000);
      return { ...prev, [e.worktreeId]: next };
    });
  });

  const shown = useMemo(() => {
    const list = active ? lines[active] ?? [] : [];
    const q = search.trim().toLowerCase();
    return list.filter((l) => (filter === 'all' || l.level !== 'info') && (!q || l.text.toLowerCase().includes(q)));
  }, [lines, active, filter, search]);

  // 탭을 바꾸면 그 로그의 맨 아래부터 본다. 아래 효과보다 먼저 돌아야 해서 같은 layout effect로 둔다.
  useLayoutEffect(() => { stick.current = true; }, [active]);

  // 줄 수가 3000에서 멈춰도 내용은 바뀌므로 shown 자체를 본다. 그리기 전에 맞춰야 화면이 튀지 않는다.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown, expanded]);

  if (servers.length === 0) return null;
  const project = servers.find((s) => s.worktree_id === active)?.project_name ?? '';

  return (
    <div className={`panel-block logs${expanded ? ' expanded' : ''}`}>
      <div className="block-head">
        <div role="tablist" className="tabs">
          {servers.map((s) => (
            <button key={s.worktree_id} role="tab" aria-selected={s.worktree_id === active} className={s.worktree_id === active ? 'active' : ''} onClick={() => setTab(s.worktree_id)}>
              {s.project_name} 로그
            </button>
          ))}
        </div>
        <div className="row">
          <button className={`chip-btn${filter === 'all' ? ' on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>전체</button>
          <button className={`chip-btn${filter === 'warn' ? ' on' : ''}`} aria-pressed={filter === 'warn'} onClick={() => setFilter('warn')}>WARN 이상</button>
          <ExpandButton expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        </div>
      </div>
      <label className="sr-only" htmlFor="log-search">로그 검색</label>
      <input id="log-search" className="mono log-search" placeholder="로그 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div
        className="log-box"
        ref={box}
        role="log"
        aria-live="off"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      >
        {shown.length === 0 && <div className="log-empty">{lines[active ?? -1]?.length ? '조건에 맞는 줄이 없습니다.' : '로그가 없습니다.'}</div>}
        {shown.map((l) => (
          <div key={`${l.seq}-${l.t}`} className={`log-line ${l.level} ${l.stream}`}>
            <span className="log-time">{clock(l.t)}</span>
            <span className="log-text">{l.text}</span>
            {l.level !== 'info' && (
              <button className="log-send" onClick={() => insertIntoPrompt(`${project} 서버 로그에서 이 오류가 났어. 원인 찾아서 고쳐줘.\n\`\`\`\n${contextAround(lines[active!] ?? [], l)}\n\`\`\``)}>
                Claude에게 보내기
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 미리보기나 로그를 화면 가득 키운다. Esc로 원래 크기로 돌아온다. */
function useExpand() {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);
  return [expanded, setExpanded] as const;
}

function ExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="icon bordered expand-btn" aria-pressed={expanded} aria-label={expanded ? '원래 크기로' : '크게 보기'} title={expanded ? '원래 크기로 (Esc)' : '크게 보기'} onClick={onToggle}>
      {expanded ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
      )}
    </button>
  );
}

function clock(t: number) {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 오류 줄 앞뒤를 조금 붙여 보낸다. 스택 트레이스가 이어지는 경우가 많다. */
function contextAround(all: LogLine[], target: LogLine): string {
  const i = all.findIndex((l) => l.seq === target.seq);
  if (i < 0) return target.text;
  return all.slice(Math.max(0, i - 3), i + 15).map((l) => l.text).join('\n');
}

/** 세션 계정 목록. 역할이 다른 계정(사업자, 지자체, 관리자 등)을 여러 개 쓸 수 있다. */
function AccountBlock({ session }: { session: Session }) {
  const [free, setFree] = useState<Account[]>([]);
  const [pick, setPick] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  const loadFree = useCallback(() => {
    api.accounts().then((r) => setFree(r.accounts.filter((a) => !a.session_id))).catch(() => setFree([]));
  }, []);
  useEffect(loadFree, [loadFree, session.accounts.length]);

  const add = async () => {
    if (pick === '') return;
    setError(null);
    try { await api.assignAccount(session.id, pick); setPick(''); loadFree(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="panel-block account">
      <div className="block-head">
        <h2>테스트 계정 {session.accounts.length > 0 && <span className="muted small">{session.accounts.length}개</span>}</h2>
        <span className="muted small">이 세션 전용</span>
      </div>
      {session.accounts.length === 0 && <p className="muted small">배정된 계정이 없습니다.</p>}
      <ul className="account-list">
        {session.accounts.map((a) => <AccountRow key={a.id} session={session} account={a} onError={setError} onReleased={loadFree} />)}
      </ul>
      {free.length > 0 ? (
        <div className="account-add">
          <label className="sr-only" htmlFor={`acc-add-${session.id}`}>추가할 계정</label>
          <select id={`acc-add-${session.id}`} value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')}>
            <option value="">계정 추가 (남은 {free.length}개)</option>
            {free.map((a) => <option key={a.id} value={a.id}>{a.login}{a.note ? ` · ${a.note}` : ''}</option>)}
          </select>
          <button className="small-btn" disabled={pick === ''} onClick={add}>추가</button>
        </div>
      ) : (
        <p className="muted small">남은 계정이 없습니다. 설정의 테스트 계정 풀에서 추가하세요.</p>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}

function AccountRow({ session, account, onError, onReleased }: {
  session: Session; account: Session['accounts'][number]; onError: (m: string) => void; onReleased: () => void;
}) {
  const [password, setPassword] = useState<string | null>(null);
  return (
    <li className="account-row">
      <div className="account-id">
        <code>{account.login}</code>
        {account.note && <span className="muted small">{account.note}</span>}
      </div>
      <code className="account-pw">{password ?? '••••••••'}</code>
      <span className="spacer" />
      <button className="small-btn" onClick={async () => {
        if (password) { setPassword(null); return; }
        try { setPassword((await api.accountPassword(account.id)).password); } catch (e) { onError((e as Error).message); }
      }}>{password ? '가리기' : '보기'}</button>
      <button className="small-btn" onClick={async () => {
        try { const p = password ?? (await api.accountPassword(account.id)).password; await navigator.clipboard.writeText(p); } catch (e) { onError((e as Error).message); }
      }}>비밀번호 복사</button>
      <button className="small-btn" onClick={async () => {
        if (!confirm(`${account.login} 계정을 풀에 돌려줄까요?`)) return;
        try { await api.releaseAccount(session.id, account.id); onReleased(); } catch (e) { onError((e as Error).message); }
      }}>반납</button>
    </li>
  );
}

function CloseBlock({ session, anyRunning, onClosed }: { session: Session; anyRunning: boolean; onClosed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function close(removeWorktrees: boolean) {
    const msg = removeWorktrees
      ? '세션을 닫고 워크트리 폴더도 지울까요? 커밋하지 않은 변경은 사라집니다.'
      : '세션을 닫을까요? 서버는 끄고 계정은 반납하며, 워크트리 폴더는 남겨 둡니다.';
    if (!confirm(msg)) return;
    setBusy(true);
    try { await api.closeSession(session.id, removeWorktrees); onClosed(); } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <details className="panel-block worktree-info">
      <summary>워크트리와 세션 닫기</summary>
      <ul className="worktrees">
        {session.worktrees.map((w) => (
          <li key={w.id}>
            <div className="wt-head"><strong>{w.project_name}</strong><span className={`kind ${w.project_kind}`}>{w.project_kind.toUpperCase()}</span></div>
            <code className="path">{w.path}</code>
            <div className="muted small">{w.branch} · {w.base_branch}에서 분기</div>
          </li>
        ))}
      </ul>
      {anyRunning && <p className="muted small">세션을 닫으면 실행 중인 서버도 꺼집니다.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="row">
        <button disabled={busy || session.status === 'running'} onClick={() => close(false)}>세션 닫기</button>
        <button className="danger" disabled={busy || session.status === 'running'} onClick={() => close(true)}>닫고 워크트리 삭제</button>
      </div>
    </details>
  );
}
