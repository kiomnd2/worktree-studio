import { useCallback, useEffect, useRef, useState } from 'react';

type Pt = { x: number; y: number };
type Shape =
  | { type: 'pen'; color: string; width: number; points: Pt[] }
  | { type: 'rect'; color: string; width: number; a: Pt; b: Pt }
  | { type: 'arrow'; color: string; width: number; a: Pt; b: Pt }
  | { type: 'text'; color: string; size: number; at: Pt; text: string };
type Tool = 'pen' | 'rect' | 'arrow' | 'text';

const COLORS = [
  { value: '#E5243B', label: '빨강' },
  { value: '#F2B705', label: '노랑' },
  { value: '#2F6FED', label: '파랑' },
  { value: '#1E9E5A', label: '초록' },
  { value: '#1B2230', label: '검정' },
];
const TOOLS: { value: Tool; label: string; key: string }[] = [
  { value: 'pen', label: '펜', key: 'P' },
  { value: 'rect', label: '네모', key: 'R' },
  { value: 'arrow', label: '화살표', key: 'A' },
  { value: 'text', label: '글자', key: 'T' },
];

export type AnnotateResult = { data: string; mediaType: 'image/png'; name: string; note: string };

type Props = {
  /** base64 PNG/JPG. 없으면 붙여넣기나 파일로 고르게 한다. */
  image: { data: string; mediaType: string } | null;
  title: string;
  warning?: string | null;
  initialNote?: string;
  onCancel: () => void;
  onDone: (r: AnnotateResult) => void;
};

/**
 * 화면 이미지 위에 펜·네모·화살표·글자로 표시하고 설명을 붙여 프롬프트로 넘긴다.
 * 도형은 원본 이미지 좌표로 저장해 화면 크기와 상관없이 원본 해상도로 내보낸다.
 */
export default function AnnotateDialog({ image, title, warning, initialNote = '', onCancel, onDone }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraftState] = useState<Shape | null>(null);
  // 포인터 이벤트가 렌더보다 빨리 와도 지금 그리는 도형을 놓치지 않게 ref로도 들고 있는다.
  const draftRef = useRef<Shape | null>(null);
  const setDraft = (d: Shape | null) => { draftRef.current = d; setDraftState(d); };
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState(COLORS[0].value);
  const [textAt, setTextAt] = useState<{ at: Pt; screen: Pt } | null>(null);
  const [textValue, setTextValue] = useState('');
  const [note, setNote] = useState(initialNote);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback((src: string) => {
    const el = new Image();
    el.onload = () => { setImg(el); setShapes([]); setError(null); };
    el.onerror = () => setError('이미지를 열지 못했습니다.');
    el.src = src;
  }, []);
  useEffect(() => { if (image) load(`data:${image.mediaType};base64,${image.data}`); }, [image, load]);

  // 로그인 화면이 찍혔을 때를 위해 직접 찍은 스크린샷도 붙여넣거나 열 수 있다.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      load(URL.createObjectURL(file));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [load]);

  const scale = () => (img && canvas.current ? canvas.current.width / img.naturalWidth : 1);

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const w = wrap.current?.clientWidth ?? img.naturalWidth;
    const s = Math.min(1, w / img.naturalWidth);
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    ctx.save();
    ctx.scale(s, s);
    for (const sh of draft ? [...shapes, draft] : shapes) paint(ctx, sh);
    ctx.restore();
  }, [img, shapes, draft]);
  useEffect(draw, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(draw);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [draw]);

  const toImage = (e: React.PointerEvent): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    const s = scale();
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };

  const commitText = () => {
    if (textAt && textValue.trim()) setShapes((list) => [...list, { type: 'text', color, size: 22, at: textAt.at, text: textValue.trim() }]);
    setTextAt(null);
    setTextValue('');
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!img) return;
    const p = toImage(e);
    if (tool === 'text') {
      commitText();
      const r = canvas.current!.getBoundingClientRect();
      setTextAt({ at: p, screen: { x: e.clientX - r.left, y: e.clientY - r.top } });
      return;
    }
    // 캔버스 밖으로 끌어도 계속 그리게 잡는다. 지원하지 않는 입력 장치면 무시한다.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
    const width = Math.max(3, Math.round(img.naturalWidth / 400));
    setDraft(tool === 'pen' ? { type: 'pen', color, width, points: [p] } : { type: tool, color, width, a: p, b: p });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    if (!draft) return;
    const p = toImage(e);
    setDraft(draft.type === 'pen' ? { ...draft, points: [...draft.points, p] } : draft.type === 'text' ? draft : { ...draft, b: p });
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draftRef.current) onMove(e);
    const draft = draftRef.current;
    if (!draft) return;
    const tiny = draft.type !== 'pen' && draft.type !== 'text' && Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y) < 4;
    if (!tiny) setShapes((list) => [...list, draft]);
    setDraft(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('textarea, input');
      if (e.key === 'Escape') { if (textAt) { setTextAt(null); setTextValue(''); } else onCancel(); return; }
      if (typing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); setShapes((l) => l.slice(0, -1)); return; }
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) setTool(t.value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, textAt]);

  function finish() {
    if (!img) return;
    commitText();
    // 글자 입력 중이던 것도 반영해서 원본 해상도로 내보낸다.
    const pending = textAt && textValue.trim() ? [{ type: 'text' as const, color, size: 22, at: textAt.at, text: textValue.trim() }] : [];
    const out = document.createElement('canvas');
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    for (const sh of [...shapes, ...pending]) paint(ctx, sh);
    const data = out.toDataURL('image/png').split(',')[1];
    if (data.length * 0.75 > 5 * 1024 * 1024) { setError('이미지가 5MB를 넘습니다. 화면을 줄여 다시 찍어 주세요.'); return; }
    // 경로("/rego/x")나 파일 이름("a.png")에서 첨부 이름을 만든다.
    const base = title.replace(/\.\w+$/, '').replace(/^\/+|\/+$/g, '').replace(/[\\/]+/g, '_');
    onDone({ data, mediaType: 'image/png', name: `화면${base ? `_${base}` : ''}.png`, note: note.trim() });
  }

  return (
    <div className="overlay annotate-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dialog annotate" role="dialog" aria-modal="true" aria-labelledby="annotate-title">
        <div className="annotate-head">
          <h1 id="annotate-title">화면에 표시하기</h1>
          <span className="muted small mono">{title}</span>
        </div>
        {warning && <p className="banner warn">{warning} 로그인한 화면을 직접 찍어 Ctrl+V로 붙여넣거나 파일로 열 수 있습니다.</p>}
        <div className="annotate-tools" role="toolbar" aria-label="그리기 도구">
          <div className="segmented" role="group" aria-label="도구">
            {TOOLS.map((t) => (
              <button key={t.value} type="button" aria-pressed={tool === t.value} className={tool === t.value ? 'on' : ''} title={`${t.label} (${t.key})`} onClick={() => setTool(t.value)}>{t.label}</button>
            ))}
          </div>
          <div className="swatches" role="radiogroup" aria-label="색">
            {COLORS.map((c) => (
              <button key={c.value} type="button" role="radio" aria-checked={color === c.value} aria-label={c.label} className={`swatch${color === c.value ? ' on' : ''}`} style={{ background: c.value }} onClick={() => setColor(c.value)} />
            ))}
          </div>
          <button type="button" className="small-btn" disabled={shapes.length === 0} onClick={() => setShapes((l) => l.slice(0, -1))} title="되돌리기 (Ctrl+Z)">되돌리기</button>
          <button type="button" className="small-btn" disabled={shapes.length === 0} onClick={() => setShapes([])}>모두 지우기</button>
          <span className="spacer" />
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(URL.createObjectURL(f)); e.target.value = ''; }} />
          <button type="button" className="small-btn" onClick={() => fileInput.current?.click()}>다른 이미지 열기</button>
        </div>
        <div className="annotate-stage" ref={wrap}>
          {img ? (
            <div className="annotate-canvas">
              <canvas
                ref={canvas}
                className={`tool-${tool}`}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                aria-label="표시할 화면. 끌어서 그리고, 글자 도구는 누른 곳에 글을 씁니다."
              />
              {textAt && (
                <input
                  autoFocus
                  className="annotate-text"
                  style={{ left: textAt.screen.x, top: textAt.screen.y, color }}
                  value={textValue}
                  placeholder="글을 쓰고 Enter"
                  onChange={(e) => setTextValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); commitText(); } }}
                  onBlur={commitText}
                />
              )}
            </div>
          ) : (
            <div className="annotate-empty">
              <p>표시할 화면이 없습니다.</p>
              <p className="muted small">스크린샷을 Ctrl+V로 붙여넣거나 "다른 이미지 열기"로 고르세요.</p>
            </div>
          )}
        </div>
        <label className="field">
          <span>Claude에게 할 말</span>
          <textarea rows={3} value={note} placeholder="빨간 네모 친 표 헤더 간격을 다른 표와 맞춰줘. 화살표 버튼은 오른쪽으로 옮겨줘." onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>취소</button>
          <button type="button" className="primary" disabled={!img} onClick={finish}>프롬프트에 넣기</button>
        </div>
      </div>
    </div>
  );
}

function paint(ctx: CanvasRenderingContext2D, sh: Shape) {
  ctx.strokeStyle = sh.color;
  ctx.fillStyle = sh.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (sh.type === 'pen') {
    ctx.lineWidth = sh.width;
    ctx.beginPath();
    sh.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  } else if (sh.type === 'rect') {
    ctx.lineWidth = sh.width;
    ctx.strokeRect(Math.min(sh.a.x, sh.b.x), Math.min(sh.a.y, sh.b.y), Math.abs(sh.b.x - sh.a.x), Math.abs(sh.b.y - sh.a.y));
  } else if (sh.type === 'arrow') {
    ctx.lineWidth = sh.width;
    const ang = Math.atan2(sh.b.y - sh.a.y, sh.b.x - sh.a.x);
    const head = sh.width * 5;
    ctx.beginPath();
    ctx.moveTo(sh.a.x, sh.a.y);
    ctx.lineTo(sh.b.x, sh.b.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sh.b.x, sh.b.y);
    ctx.lineTo(sh.b.x - head * Math.cos(ang - Math.PI / 7), sh.b.y - head * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(sh.b.x - head * Math.cos(ang + Math.PI / 7), sh.b.y - head * Math.sin(ang + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else {
    // 글자 뒤에 흰 바탕을 깔아 어떤 화면 위에서도 읽히게 한다.
    ctx.font = `600 ${sh.size}px 'IBM Plex Sans KR', 'Apple SD Gothic Neo', sans-serif`;
    ctx.textBaseline = 'top';
    const w = ctx.measureText(sh.text).width;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(sh.at.x - 4, sh.at.y - 3, w + 8, sh.size + 8);
    ctx.fillStyle = sh.color;
    ctx.fillText(sh.text, sh.at.x, sh.at.y);
  }
}
