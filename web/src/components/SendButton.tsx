import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { setSendTarget, useSendTarget, type SendTarget } from '../events';

const TARGETS: { key: SendTarget; label: string; hint: string }[] = [
  { key: 'main', label: '메인 대화', hint: '메인 대화의 입력창에 넣습니다' },
  { key: 'new', label: '새 대화', hint: '새 대화 탭을 열어 입력창에 넣습니다' },
];

/**
 * 도구 화면에서 대화로 넘기는 버튼. 옆의 ▾로 넘길 곳(메인 대화, 새 대화)을 골라 보내고, 고른 곳은 다음에도 쓴다.
 * label이 없으면 "메인 대화로 보내기"처럼 넘길 곳을 이름에 적는다.
 */
export default function SendButton({ onSend, label, className = 'small-btn', disabled, title }: {
  onSend: () => void; label?: string; className?: string; disabled?: boolean; title?: string;
}) {
  const target = useSendTarget();
  // 로그 상자처럼 스크롤되는 곳 안에서도 잘리지 않게 화면 기준(fixed)으로 띄운다. 아래 자리가 모자라면 위로 연다.
  const [open, setOpen] = useState<CSSProperties | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const current = TARGETS.find((t) => t.key === target)!;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // 띄운 자리가 버튼과 어긋나지 않게 스크롤하거나 창 크기가 바뀌면 닫는다.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = (caret: HTMLElement) => {
    if (open) { setOpen(null); return; }
    const r = caret.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    setOpen(window.innerHeight - r.bottom < 100 ? { right, bottom: window.innerHeight - r.top + 4 } : { right, top: r.bottom + 4 });
  };

  return (
    <span className="send-split" ref={box}>
      <button type="button" className={className} disabled={disabled} title={title ?? current.hint} onClick={onSend}>
        {label ?? `${current.label}로 보내기`}
      </button>
      <button type="button" className={`${className} send-split-caret`} disabled={disabled} aria-label="보낼 곳 고르기" aria-haspopup="menu" aria-expanded={Boolean(open)}
        title={`보낼 곳: ${current.label}`} onClick={(e) => toggle(e.currentTarget)}>▾</button>
      {open && (
        <span className="send-split-menu" role="menu" style={open}>
          {TARGETS.map((t) => (
            <button key={t.key} type="button" role="menuitemradio" aria-checked={t.key === target} title={t.hint}
              onClick={() => { setSendTarget(t.key); setOpen(null); onSend(); }}>
              <span aria-hidden="true">{t.key === target ? '✓' : ''}</span>{t.label}로 보내기
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
