import type { Session } from '../types';

type Props = {
  sessions: Session[];
  selectedId: number | null;
  settingsOpen: boolean;
  cleanupOpen: boolean;
  archiveOpen: boolean;
  cleanupCount: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onSettings: () => void;
  onCleanup: () => void;
  onArchive: () => void;
};

function statusOf(s: Session) {
  if (s.busy) return { label: s.chats.length && s.status !== 'running' ? '추가 대화 작업 중' : '작업 중', cls: 'running' };
  if (s.unread || s.chats.some((c) => c.unread)) return { label: '작업 완료 · 새 결과', cls: 'unread' };
  return { label: '대기', cls: 'idle' };
}

export default function Sidebar({ sessions, selectedId, settingsOpen, cleanupOpen, archiveOpen, cleanupCount, onSelect, onNew, onSettings, onCleanup, onArchive }: Props) {
  const elsewhere = settingsOpen || cleanupOpen || archiveOpen;
  const groups = new Map<string, Session[]>();
  for (const s of sessions) groups.set(s.workspace_name, [...(groups.get(s.workspace_name) ?? []), s]);

  return (
    <aside className="sidebar">
      <button className="new-session" onClick={onNew}>+ 새 세션</button>
      <nav aria-label="세션" className="session-list">
        {[...groups].map(([ws, list]) => (
          <div key={ws}>
            <div className="group-label">{ws}</div>
            {list.map((s) => {
              const st = statusOf(s);
              return (
                <button
                  key={s.id}
                  className={`session-item${s.id === selectedId && !elsewhere ? ' active' : ''}`}
                  aria-current={s.id === selectedId && !elsewhere ? 'true' : undefined}
                  onClick={() => onSelect(s.id)}
                >
                  <span className="ticket">{s.ticket}</span>
                  <span className="summary">{s.summary || '요약 없음'}</span>
                  <span className={`status ${st.cls}`}><span className="dot" aria-hidden="true" />{st.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button className={`link-row${archiveOpen ? ' active' : ''}`} onClick={onArchive}>산출물 보관함</button>
        <button className={`link-row${cleanupOpen ? ' active' : ''}`} onClick={onCleanup}>
          리소스 정리{cleanupCount > 0 && <span className="count-badge">대기 {cleanupCount}</span>}
        </button>
        <button className={`link-row${settingsOpen ? ' active' : ''}`} onClick={onSettings}>프로젝트와 설정</button>
      </div>
    </aside>
  );
}
