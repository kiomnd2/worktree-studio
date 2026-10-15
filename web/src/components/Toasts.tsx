import { useEffect, useState } from 'react';
import { useServerEvents } from '../events';
import type { ServerEvent } from '../types';

type TestResult = Extract<ServerEvent, { type: 'test.result' }>;
type Toast = TestResult & { key: number };

const LABEL: Record<string, { text: string; cls: string }> = {
  pass: { text: '통과', cls: 'ok' },
  fail: { text: '실패', cls: 'err' },
  blocked: { text: '확인 불가', cls: 'warn' },
  error: { text: '오류', cls: 'err' },
};

let seq = 0;

/** 화면 테스트 케이스가 끝날 때마다 오른쪽 아래에 알린다. 통과는 잠깐, 실패·오류는 닫을 때까지 남긴다. */
export default function Toasts({ onOpenTests }: { onOpenTests: (sessionId: number) => void }) {
  const [list, setList] = useState<Toast[]>([]);
  useServerEvents((e) => {
    if (e.type !== 'test.result') return;
    setList((prev) => [...prev, { ...e, key: ++seq }].slice(-5));
  });
  // 통과 알림은 6초 뒤에 사라진다.
  useEffect(() => {
    const passes = list.filter((t) => t.status === 'pass');
    if (!passes.length) return;
    const timer = setTimeout(() => setList((prev) => prev.filter((t) => t.key !== passes[0].key)), 6000);
    return () => clearTimeout(timer);
  }, [list]);
  const close = (key: number) => setList((prev) => prev.filter((t) => t.key !== key));
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => {
        const l = LABEL[t.status] ?? LABEL.error;
        return (
          <div key={t.key} className={`toast ${l.cls}`}>
            <button className="toast-body" onClick={() => { onOpenTests(t.sessionId); close(t.key); }} title="화면 테스트에서 보기">
              <span className="toast-head"><span className={`toast-badge ${l.cls}`}>{l.text}</span><span className="muted small">{t.ticket} · 화면 테스트 {t.index}/{t.total}</span></span>
              <strong className="toast-title">{t.title}</strong>
              {t.status !== 'pass' && t.summary && <span className="toast-summary small">{t.summary}</span>}
            </button>
            <button className="icon toast-close" aria-label="알림 닫기" onClick={() => close(t.key)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
