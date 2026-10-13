import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, missingFrom } from '../api';
import { insertIntoPrompt, useServerEvents } from '../events';
import type { LogLine, ServerView, Session } from '../types';

const STATUS_LABEL: Record<string, string> = {
  idle: '꺼짐', starting: '시작 중', running: '실행 중', unhealthy: '응답 없음', failed: '멈춤', stopped: '꺼짐',
};

type Props = { session: Session; onOpenEnv: (message?: string) => void; onClosed: () => void };

export default function RightPanel({ session, onOpenEnv, onClosed }: Props) {
  const [servers, setServers] = useState<ServerView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.servers(session.id).then(setServers).catch((e) => setError(e.message));
  }, [session.id]);
  useEffect(reload, [reload]);
  useServerEvents((e) => { if (e.type === 'server.updated' && e.sessionId === session.id) reload(); });

  async function act(kind: 'start' | 'stop' | 'restart', worktreeIds?: number[]) {
    setBusy(true);
    setError(null);
    try {
      const fn = kind === 'start' ? api.startServers : kind === 'stop' ? api.stopServers : api.restartServers;
      setServers(await fn(session.id, worktreeIds));
    } catch (e) {
      const missing = missingFrom(e);
      if (missing) onOpenEnv(`필수 값이 비어 있습니다: ${missing.map((m) => `${m.project} ${m.keys.join(', ')}`).join(' / ')}`);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const anyRunning = servers.some((s) => s.status === 'starting' || s.status === 'running' || s.status === 'unhealthy');
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
              : <button className="small-btn primary" disabled={busy || servers.every((s) => !s.can_start)} onClick={() => act('start')}>모두 실행</button>}
          </div>
        </div>
        <ul className="server-list">
          {servers.map((s) => {
            const live = s.status === 'starting' || s.status === 'running' || s.status === 'unhealthy';
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
                    <button className="small-btn" disabled={busy} onClick={() => act('restart', [s.worktree_id])}>재시작</button>
                    <button className="small-btn" disabled={busy} onClick={() => act('stop', [s.worktree_id])}>끄기</button>
                  </>
                ) : (
                  <button className="small-btn" disabled={busy} onClick={() => act('start', [s.worktree_id])}>실행</button>
                )}
              </li>
            );
          })}
        </ul>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>

      {fe ? <Preview key={fe.url} baseUrl={fe.url!} ready={fe.status === 'running'} /> : (
        <div className="placeholder">
          <strong>미리보기</strong>
          <p>{be ? <>FE 서버가 없습니다. BE는 <a href={be.url!} target="_blank" rel="noreferrer">{be.url}</a>에서 실행 중입니다.</> : 'FE 서버를 실행하면 여기에 화면이 나옵니다.'}</p>
        </div>
      )}

      <Logs servers={servers} />

      <AccountBlock session={session} />

      <CloseBlock session={session} anyRunning={anyRunning} onClosed={onClosed} />
    </section>
  );
}

function Preview({ baseUrl, ready }: { baseUrl: string; ready: boolean }) {
  const [path, setPath] = useState('/');
  const [src, setSrc] = useState(`${baseUrl}/`);
  const frame = useRef<HTMLIFrameElement>(null);
  const go = () => setSrc(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  return (
    <div className="panel-block preview">
      <div className="block-head">
        <h2>미리보기</h2>
        {!ready && <span className="muted small">서버가 응답하기를 기다리는 중</span>}
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

  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  if (servers.length === 0) return null;
  const project = servers.find((s) => s.worktree_id === active)?.project_name ?? '';

  return (
    <div className="panel-block logs">
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
        </div>
      </div>
      <label className="sr-only" htmlFor="log-search">로그 검색</label>
      <input id="log-search" className="mono log-search" placeholder="로그 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="log-box" ref={box} role="log" aria-live="off">
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
