import { useEffect, useState } from 'react';
import { api } from '../api';
import { useServerEvents } from '../events';
import type { DocMeta, TaskList } from '../types';

const ICON = { todo: '○', doing: '◐', done: '●', skipped: '–' } as const;
const LABEL = { todo: '할 일', doing: '하는 중', done: '끝남', skipped: '안 함' } as const;

/** 완료 보고서를 부탁하는 프롬프트. 쓰는 순서는 시스템 프롬프트에 있다. */
export const reportPrompt = (ticket: string) => `${ticket} 개발이 끝났으니 완료 보고서를 작성해 줘. 코드는 고치지 말고 보고서만 저장해 줘.`;

/** sqlite datetime('now')(UTC, 공백 구분)과 ISO 시각을 같이 비교한다. */
const ms = (t: string) => Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);

/**
 * 계획에서 나온 작업 목록. 대화 위에 늘 붙어 있고, Claude가 진행하면서 상태를 바꾼다.
 * Claude가 멈췄는데 남은 항목이 있으면 다음 항목을 보내는 버튼을 보여 준다. 누를 때만 진행한다.
 * 모두 끝나면 완료 보고서를 쓰게 하는 버튼을, 보고서가 있으면 보는 버튼을 보여 준다.
 */
export default function TaskBar({ sessionId, ticket, running, queued, onNext, onOpenDocs }: {
  sessionId: number; ticket: string; running: boolean; queued: boolean; onNext: (prompt: string) => void; onOpenDocs?: (name: string) => void;
}) {
  const [list, setList] = useState<TaskList | null>(null);
  const [report, setReport] = useState<DocMeta | null>(null);
  const key = `wts.tasks.open.${sessionId}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } });
  const reload = () => { api.tasks(sessionId).then(setList).catch(() => setList(null)); };
  useEffect(reload, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { setOpen(localStorage.getItem(key) !== '0'); } catch { /* 저장 못 해도 펼친 채로 */ } }, [key]);
  const reloadReport = () => { api.docs(sessionId).then((d) => setReport(d.find((x) => x.kind === 'report') ?? null)).catch(() => setReport(null)); };
  useEffect(reloadReport, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useServerEvents((e) => {
    if (e.type === 'tasks.updated' && e.sessionId === sessionId) reload();
    if (e.type === 'docs.updated' && e.sessionId === sessionId) reloadReport();
  });
  if (!list || list.tasks.length === 0) return null;

  const done = list.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  const doing = list.tasks.find((t) => t.status === 'doing');
  // 하는 중인 항목이 없으면 다음 할 일을 흐리게 보여 준다.
  const nextTodo = doing ? undefined : list.tasks.find((t) => t.status === 'todo');
  // 중단돼 하는 중으로 남은 항목이 있으면 그것부터 잇는다.
  const next = doing ?? nextTodo;
  const canNext = Boolean(next) && !running && !queued;
  // 작업 목록이 끝났고 Claude가 쉬고 있으면 보고서 차례다. 목록이 보고서 뒤에 바뀌었으면 다시 쓰자고 한다.
  const allDone = !next;
  const reportFresh = Boolean(report && ms(report.updated_at) >= ms(list.updated_at));
  const canReport = allDone && !running && !queued;
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
        {report && onOpenDocs && allDone && <button type="button" className={`small-btn${reportFresh ? ' primary' : ''}`} onClick={() => onOpenDocs(report.name)}>보고서 보기</button>}
        {canReport && (
          <button type="button" className={`small-btn${reportFresh ? '' : ' primary'}`} title="계획·작업 목록·바뀐 코드·검증 결과를 맞대어 완료 보고서를 씁니다" onClick={() => onNext(reportPrompt(ticket))}>
            {report ? '보고서 다시 작성' : '완료 보고서 작성'}
          </button>
        )}
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
