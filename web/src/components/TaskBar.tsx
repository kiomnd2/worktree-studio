import { useEffect, useState } from 'react';
import { api } from '../api';
import { useServerEvents } from '../events';
import type { TaskList } from '../types';

const ICON = { todo: '○', doing: '◐', done: '●', skipped: '–' } as const;
const LABEL = { todo: '할 일', doing: '하는 중', done: '끝남', skipped: '안 함' } as const;

/**
 * 계획에서 나온 작업 목록. 대화 위에 늘 붙어 있고, Claude가 진행하면서 상태를 바꾼다.
 * Claude가 멈췄는데 남은 항목이 있으면 다음 항목을 보내는 버튼을 보여 준다. 누를 때만 진행한다.
 */
export default function TaskBar({ sessionId, running, queued, onNext }: { sessionId: number; running: boolean; queued: boolean; onNext: (prompt: string) => void }) {
  const [list, setList] = useState<TaskList | null>(null);
  const key = `wts.tasks.open.${sessionId}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } });
  const reload = () => { api.tasks(sessionId).then(setList).catch(() => setList(null)); };
  useEffect(reload, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { setOpen(localStorage.getItem(key) !== '0'); } catch { /* 저장 못 해도 펼친 채로 */ } }, [key]);
  useServerEvents((e) => { if (e.type === 'tasks.updated' && e.sessionId === sessionId) reload(); });
  if (!list || list.tasks.length === 0) return null;

  const done = list.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  const doing = list.tasks.find((t) => t.status === 'doing');
  // 하는 중인 항목이 없으면 다음 할 일을 흐리게 보여 준다.
  const nextTodo = doing ? undefined : list.tasks.find((t) => t.status === 'todo');
  // 중단돼 하는 중으로 남은 항목이 있으면 그것부터 잇는다.
  const next = doing ?? nextTodo;
  const canNext = Boolean(next) && !running && !queued;
  const sendNext = () => {
    if (!next) return;
    onNext(doing
      ? `작업 목록의 "${next.title}" 항목을 이어서 진행해 줘. 이 항목을 끝내면 멈추고 결과를 알려 줘.`
      : `작업 목록의 다음 항목 "${next.title}"을 진행해 줘. 이 항목을 끝내면 멈추고 결과를 알려 줘.`);
  };
  const toggle = () => { const v = !open; setOpen(v); try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* 무시 */ } };
  const clear = () => { if (confirm('작업 목록을 지울까요? Claude도 더는 이 목록을 보지 않습니다.')) api.clearTasks(sessionId).then(reload).catch(() => {}); };

  return (
    <section className={`taskbar${open ? ' open' : ''}`} aria-label="작업 목록">
      <div className="taskbar-head">
        <button type="button" className="taskbar-toggle" aria-expanded={open} onClick={toggle}>
          <span className="taskbar-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <strong>작업 목록</strong>
          {list.title && <span className="taskbar-title">{list.title}</span>}
        </button>
        <span className="taskbar-count">{done}/{list.tasks.length}</span>
        <span className="taskbar-progress" aria-hidden="true"><span style={{ width: `${(done / list.tasks.length) * 100}%` }} /></span>
        <span className="taskbar-now">
          {doing
            ? <>{running && <span className="spinner" aria-hidden="true" />}<span className="taskbar-now-label">지금</span><span className="taskbar-now-text">{doing.title}</span></>
            : nextTodo ? <span className="taskbar-now-text muted">다음: {nextTodo.title}</span>
            : <span className="taskbar-now-text muted">모두 끝남</span>}
        </span>
        {canNext && <button type="button" className="small-btn primary" title={next!.title} onClick={sendNext}>{doing ? '이어서 진행' : '다음 작업 진행'}</button>}
        <button type="button" className="small-btn" aria-expanded={open} onClick={toggle}>{open ? '접기' : '펼치기'}</button>
        <button type="button" className="link small" onClick={clear}>지우기</button>
      </div>
      {open && (
        <ol className="taskbar-list">
          {list.tasks.map((t, i) => (
            <li key={i} className={`task ${t.status}`}>
              <span className="task-icon" title={LABEL[t.status]} aria-label={LABEL[t.status]}>{ICON[t.status]}</span>
              <span className="task-title">{t.title}{t.note && <span className="muted small"> — {t.note}</span>}</span>
              {t.status === 'doing' && <span className="task-badge">{running && <span className="spinner" aria-hidden="true" />}하는 중</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
