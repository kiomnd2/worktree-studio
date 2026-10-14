import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { setFocusedSession, useServerEvents } from './events';
import type { Session } from './types';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import NewSessionDialog from './components/NewSessionDialog';
import SettingsPage from './components/SettingsPage';
import RightPanel from './components/RightPanel';
import EnvPage from './components/EnvPage';
import PrDialog from './components/PrDialog';
import CleanupPage from './components/CleanupPage';
import ChangesPage from './components/ChangesPage';
import TestsPage from './components/TestsPage';
import DocsPage from './components/DocsPage';
import ArchivePage from './components/ArchivePage';
import type { PullRequest, ServerView } from './types';

type View =
  | { kind: 'session'; id: number | null }
  | { kind: 'settings' }
  | { kind: 'cleanup' }
  | { kind: 'env'; id: number; message?: string }
  | { kind: 'changes'; id: number }
  | { kind: 'tests'; id: number }
  | { kind: 'docs'; id: number; name: string | null }
  | { kind: 'archive' }
  | { kind: 'archive-docs'; id: number; ticket: string; name: string | null };

function initialView(): View {
  // Jira 로그인 뒤 설정 화면으로 돌아온다(?view=settings&jira=connected).
  if (new URLSearchParams(location.search).get('view') === 'settings') return { kind: 'settings' };
  const id = Number(new URLSearchParams(location.search).get('session'));
  return { kind: 'session', id: Number.isFinite(id) && id > 0 ? id : null };
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [view, setView] = useState<View>(initialView);
  const [creating, setCreating] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [cleanupCount, setCleanupCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.sessions().then(setSessions).catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const selectedId = view.kind === 'session' || view.kind === 'env' || view.kind === 'changes' || view.kind === 'tests' || view.kind === 'docs' ? view.id : null;
  const [servers, setServers] = useState<ServerView[]>([]);
  const reloadServers = useCallback(() => {
    if (selectedId) api.servers(selectedId).then(setServers).catch(() => setServers([]));
    else setServers([]);
  }, [selectedId]);
  useEffect(reloadServers, [reloadServers]);
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  const reloadPrs = useCallback(() => {
    if (selectedId) api.pr(selectedId).then((r) => setPrs(r.prs)).catch(() => setPrs([]));
    else setPrs([]);
  }, [selectedId]);
  useEffect(reloadPrs, [reloadPrs]);
  // GitHub에서 머지하고 돌아오면 PR 상태를 다시 확인한다.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reloadPrs(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [reloadPrs]);

  const reloadCleanup = useCallback(() => {
    api.cleanup().then((r) => setCleanupCount(r.rows.filter((x) => x.state === 'ready').length)).catch(() => {});
  }, []);
  useEffect(reloadCleanup, [reloadCleanup]);

  useEffect(() => {
    if (view.kind === 'session' && view.id === null && sessions.length > 0) setView({ kind: 'session', id: sessions[0].id });
  }, [sessions, view]);

  useEffect(() => {
    setFocusedSession(selectedId);
    const url = new URL(location.href);
    if (selectedId) url.searchParams.set('session', String(selectedId));
    else url.searchParams.delete('session');
    history.replaceState(null, '', url);
  }, [selectedId]);

  // 보고 있는 세션의 새 결과 표시는 바로 지운다.
  useEffect(() => {
    if (selected?.unread && document.visibilityState === 'visible') api.markRead(selected.id).catch(() => {});
  }, [selected?.id, selected?.unread]);

  useEffect(() => {
    const unread = sessions.filter((s) => s.unread && s.id !== selectedId).length;
    document.title = unread ? `(${unread}) Worktree Studio` : 'Worktree Studio';
  }, [sessions, selectedId]);

  // 대화나 승인 카드에서 문서를 열면 그 세션의 문서 화면으로 간다.
  useEffect(() => {
    const onOpen = (e: Event) => { if (selectedId) setView({ kind: 'docs', id: selectedId, name: (e as CustomEvent<string | null>).detail }); };
    window.addEventListener('wts:open-doc', onOpen);
    return () => window.removeEventListener('wts:open-doc', onOpen);
  }, [selectedId]);

  useServerEvents((e) => {
    if (e.type === 'sessions.changed' || e.type === 'session.updated') reload();
    if (e.type === 'server.updated' && e.sessionId === selectedId) reloadServers();
    if (e.type === 'pr.updated' && e.sessionId === selectedId) reloadPrs();
    if (e.type === 'cleanup.changed' || e.type === 'sessions.changed') reloadCleanup();
  });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M18 11c0 4-6 3-12 6" />
          </svg>
          Worktree Studio
        </div>
        {selected && view.kind !== 'settings' && view.kind !== 'cleanup' && view.kind !== 'archive' && view.kind !== 'archive-docs' && (
          <>
            <div className="topbar-session">
              <strong>{selected.ticket}</strong> <span>{selected.summary}</span>
              {selected.worktrees[0] && <code className="branch">{selected.worktrees[0].branch}</code>}
            </div>
            <div className="topbar-chips">
              {servers.map((s) => (
                <span key={s.worktree_id} className="chip-status">
                  <span className={`srv-dot ${s.status}`} aria-hidden="true" />
                  {s.project_kind === 'fe' ? 'FE' : s.project_kind === 'be' ? 'BE' : s.project_name}
                  {s.port && s.url ? ` :${s.port}` : ' 꺼짐'}
                </span>
              ))}
              {selected.accounts.length > 0 && (
                <span className="chip-status" title={selected.accounts.map((a) => `${a.login}${a.note ? ` (${a.note})` : ''}`).join('\n')}>
                  {selected.accounts.length === 1 ? `계정 ${selected.accounts[0].login}` : `계정 ${selected.accounts.length}개`}
                </span>
              )}
              {prs.map((p) => (
                <a key={p.id} className="chip-status" href={p.url} target="_blank" rel="noreferrer">
                  <span className={`srv-dot ${p.state === 'OPEN' ? 'running' : p.state === 'MERGED' ? 'merged' : 'idle'}`} aria-hidden="true" />
                  PR #{p.number} {p.state === 'OPEN' ? '열림' : p.state === 'MERGED' ? '머지됨' : '닫힘'}
                </a>
              ))}
              <button className="small-btn primary" disabled={selected.status === 'running'} title={selected.status === 'running' ? 'Claude 작업이 끝난 뒤에 만들 수 있습니다' : undefined} onClick={() => setPrOpen(true)}>
                푸시하고 PR 만들기
              </button>
            </div>
          </>
        )}
      </header>
      {error && (
        <div className="banner error" role="alert">
          {error} <button className="link" onClick={() => setError(null)}>닫기</button>
        </div>
      )}
      <div className="layout">
        <Sidebar
          sessions={sessions}
          selectedId={selectedId}
          settingsOpen={view.kind === 'settings'}
          cleanupOpen={view.kind === 'cleanup'}
          archiveOpen={view.kind === 'archive' || view.kind === 'archive-docs'}
          cleanupCount={cleanupCount}
          onSelect={(id) => setView({ kind: 'session', id })}
          onNew={() => setCreating(true)}
          onSettings={() => setView({ kind: 'settings' })}
          onCleanup={() => setView({ kind: 'cleanup' })}
          onArchive={() => setView({ kind: 'archive' })}
        />
        {view.kind === 'settings' ? (
          <main className="main scroll"><SettingsPage /></main>
        ) : view.kind === 'cleanup' ? (
          <CleanupPage onOpenSession={(id) => setView({ kind: 'session', id })} />
        ) : view.kind === 'archive' ? (
          <ArchivePage onOpen={(e, name) => setView({ kind: 'archive-docs', id: e.session_id, ticket: e.ticket, name: name ?? null })} />
        ) : view.kind === 'archive-docs' ? (
          <DocsPage key={`a-${view.id}`} sessionId={view.id} ticket={view.ticket} initial={view.name} backLabel="보관함으로" onBack={() => setView({ kind: 'archive' })} />
        ) : view.kind === 'docs' && selected ? (
          <DocsPage key={selected.id} sessionId={selected.id} ticket={selected.ticket} live initial={view.name} backLabel="세션 화면으로" onBack={() => setView({ kind: 'session', id: selected.id })} />
        ) : view.kind === 'tests' && selected ? (
          <TestsPage key={selected.id} session={selected} onBack={() => setView({ kind: 'session', id: selected.id })} />
        ) : view.kind === 'changes' && selected ? (
          <ChangesPage key={selected.id} session={selected} onBack={() => setView({ kind: 'session', id: selected.id })} />
        ) : view.kind === 'env' && selected ? (
          <EnvPage
            key={`${selected.id}-${view.message ?? ''}`}
            session={selected}
            message={view.message}
            onBack={() => setView({ kind: 'session', id: selected.id })}
            onStarted={() => setView({ kind: 'session', id: selected.id })}
          />
        ) : selected ? (
          <>
            <ChatView key={selected.id} session={selected} />
            <RightPanel
              key={`panel-${selected.id}`}
              session={selected}
              onOpenEnv={(message) => setView({ kind: 'env', id: selected.id, message })}
              onOpenChanges={() => setView({ kind: 'changes', id: selected.id })}
              onOpenTests={() => setView({ kind: 'tests', id: selected.id })}
              onOpenDocs={(name) => setView({ kind: 'docs', id: selected.id, name: name ?? null })}
              onClosed={() => { setView({ kind: 'session', id: null }); reload(); }}
            />
          </>
        ) : (
          <main className="main empty">
            <div>
              <h1>세션이 없습니다</h1>
              <p>프로젝트를 등록하고 워크스페이스를 만든 뒤, 티켓 하나로 세션을 시작하세요.</p>
              <div className="row">
                <button className="primary" onClick={() => setCreating(true)}>새 세션</button>
                <button onClick={() => setView({ kind: 'settings' })}>프로젝트 등록</button>
              </div>
            </div>
          </main>
        )}
      </div>
      {prOpen && selected && (
        <PrDialog
          session={selected}
          onClose={() => setPrOpen(false)}
          onOpenCleanup={() => { setPrOpen(false); setView({ kind: 'cleanup' }); }}
        />
      )}
      {creating && (
        <NewSessionDialog
          onClose={() => setCreating(false)}
          onCreated={(s) => { setCreating(false); reload(); setView({ kind: 'session', id: s.id }); }}
        />
      )}
    </div>
  );
}
