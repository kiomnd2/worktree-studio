import type { Session } from '../types';

type Props = {
  sessions: Session[];
  selectedId: number | null;
  settingsOpen: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
  onSettings: () => void;
};

function statusOf(s: Session) {
  if (s.status === 'running') return { label: '작업 중', cls: 'running' };
  if (s.unread) return { label: '작업 완료 · 새 결과', cls: 'unread' };
  return { label: '대기', cls: 'idle' };
}

export default function Sidebar({ sessions, selectedId, settingsOpen, onSelect, onNew, onSettings }: Props) {
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
                  className={`session-item${s.id === selectedId && !settingsOpen ? ' active' : ''}`}
                  aria-current={s.id === selectedId && !settingsOpen ? 'true' : undefined}
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
        <button className={`link-row${settingsOpen ? ' active' : ''}`} onClick={onSettings}>프로젝트와 설정</button>
      </div>
    </aside>
  );
}
