import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { setFocusedSession, useServerEvents } from './events';
import type { Session } from './types';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import NewSessionDialog from './components/NewSessionDialog';
import SettingsPage from './components/SettingsPage';
import SessionPanel from './components/SessionPanel';

type View = { kind: 'session'; id: number | null } | { kind: 'settings' };

function initialView(): View {
  const id = Number(new URLSearchParams(location.search).get('session'));
  return { kind: 'session', id: Number.isFinite(id) && id > 0 ? id : null };
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [view, setView] = useState<View>(initialView);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.sessions().then(setSessions).catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const selectedId = view.kind === 'session' ? view.id : null;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

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

  useServerEvents((e) => {
    if (e.type === 'sessions.changed' || e.type === 'session.updated') reload();
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
        {selected && view.kind === 'session' && (
          <div className="topbar-session">
            <strong>{selected.ticket}</strong> <span>{selected.summary}</span>
            {selected.worktrees[0] && <code className="branch">{selected.worktrees[0].branch}</code>}
          </div>
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
          onSelect={(id) => setView({ kind: 'session', id })}
          onNew={() => setCreating(true)}
          onSettings={() => setView({ kind: 'settings' })}
        />
        {view.kind === 'settings' ? (
          <main className="main scroll"><SettingsPage /></main>
        ) : selected ? (
          <>
            <ChatView key={selected.id} session={selected} />
            <SessionPanel session={selected} onClosed={() => { setView({ kind: 'session', id: null }); reload(); }} />
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
      {creating && (
        <NewSessionDialog
          onClose={() => setCreating(false)}
          onCreated={(s) => { setCreating(false); reload(); setView({ kind: 'session', id: s.id }); }}
        />
      )}
    </div>
  );
}
