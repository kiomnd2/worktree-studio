import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, missingFrom } from '../api';
import { attachToPrompt, insertIntoPrompt, useServerEvents } from '../events';
import type { LogLine, ScreenState, ServerView, Session } from '../types';
import StartServersDialog from './StartServersDialog';

const STATUS_LABEL: Record<string, string> = {
  idle: '꺼짐', starting: '시작 중', running: '실행 중', unhealthy: '응답 없음', failed: '멈춤', stopped: '꺼짐',
};

type Props = { session: Session; onOpenEnv: (message?: string) => void; onOpenScreens: () => void; onClosed: () => void };

export default function RightPanel({ session, onOpenEnv, onOpenScreens, onClosed }: Props) {
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
              </li>
            );
          })}
        </ul>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>

      <ScreensBlock session={session} onOpen={onOpenScreens} />

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
  );
}

function isLive(s: ServerView) {
  return s.status === 'starting' || s.status === 'running' || s.status === 'unhealthy';
}

const SCREEN_LABEL: Record<string, string> = { pending: '안 찍음', capturing: '찍는 중', changed: '차이', same: '같음', failed: '실패', accepted: '의도한 변경' };

/** 영향받는 화면 체크리스트. 자세한 비교는 전후 비교 화면에서 한다. */
function ScreensBlock({ session, onOpen }: { session: Session; onOpen: () => void }) {
  const [state, setState] = useState<ScreenState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { api.screens(session.id).then(setState).catch(() => setState(null)); }, [session.id]);
  useEffect(reload, [reload]);
  useServerEvents((e) => { if (e.type === 'screens.updated' && e.sessionId === session.id) reload(); });
  if (!state?.fe_project) return null;
  const checks = state.checks;
  const done = checks.filter((c) => c.status === 'same' || c.status === 'accepted').length;
  return (
    <div className="panel-block">
      <div className="block-head">
        <h2>영향받는 화면 {checks.length > 0 && <span className="muted small">확인 {done} / {checks.length}</span>}</h2>
        <div className="row">
          <button className="small-btn" disabled={state.detecting} onClick={() => { setError(null); api.detectScreens(session.id).catch((e) => setError(e.message)); }}>
            {state.detecting ? '찾는 중' : checks.length ? '다시 찾기' : '영향 화면 찾기'}
          </button>
          <button className="small-btn primary" onClick={onOpen}>전후 비교 보기</button>
        </div>
      </div>
      {checks.length === 0 ? (
        <p className="muted small">{state.detecting ? 'Claude가 바뀐 파일에서 라우터와 import를 따라가는 중입니다. 1~2분 걸립니다.' : '바뀐 파일을 보고 영향받는 화면을 찾아 기준 브랜치와 비교합니다.'}</p>
      ) : (
        <ul className="screen-checklist">
          {checks.slice(0, 8).map((c) => (
            <li key={c.id}>
              <span className={`check-mark ${c.status}`} aria-hidden="true" />
              <span className="mono small route">{c.route}</span>
              <span className="muted small">{SCREEN_LABEL[c.status]}{c.status === 'changed' && c.diff_ratio !== null ? ` ${(c.diff_ratio * 100).toFixed(1)}%` : ''}</span>
            </li>
          ))}
          {checks.length > 8 && <li className="muted small">외 {checks.length - 8}개</li>}
        </ul>
      )}
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
  const go = () => setSrc(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  return (
    <div className={`panel-block preview${expanded ? ' expanded' : ''}`}>
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
            attachToPrompt({ mediaType: 'image/png', data: r.data, name: `미리보기 ${new URL(url).pathname}.png` });
            setNote(r.warning ?? '프롬프트에 첨부했습니다.');
          } catch (e) { setNote((e as Error).message); } finally { setCapturing(false); }
        }}>{capturing ? '찍는 중' : '캡처해서 첨부'}</button>
        {note && <span className="muted small">{note}</span>}
      </div>
      {ready ? <iframe ref={frame} title="FE 미리보기" src={src} /> : <div className="frame-wait">시작 중</div>}
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

function AccountBlock({ session }: { session: Session }) {
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPassword(null), [session.account?.id]);
  if (!session.account) {
    return (
      <div className="panel-block account">
        <div className="block-head"><h2>테스트 계정</h2></div>
        <p className="muted small">배정된 계정이 없습니다. 설정에서 계정 풀에 계정을 추가하세요.</p>
        <button className="small-btn" onClick={() => api.assignAccount(session.id).catch((e) => setError(e.message))}>남은 계정 배정</button>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }
  const acc = session.account;
  return (
    <div className="panel-block account">
      <div className="block-head"><h2>테스트 계정</h2><span className="muted small">이 세션 전용</span></div>
      <div className="account-row">
        <code>{acc.login}</code>
        <code>{password ?? '••••••••'}</code>
        <span className="spacer" />
        <button className="small-btn" onClick={async () => {
          if (password) { setPassword(null); return; }
          try { setPassword((await api.accountPassword(acc.id)).password); } catch (e) { setError((e as Error).message); }
        }}>{password ? '가리기' : '보기'}</button>
        <button className="small-btn" onClick={async () => {
          try { const p = password ?? (await api.accountPassword(acc.id)).password; await navigator.clipboard.writeText(p); } catch (e) { setError((e as Error).message); }
        }}>비밀번호 복사</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
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
