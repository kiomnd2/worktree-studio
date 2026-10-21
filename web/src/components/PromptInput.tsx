import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { takeNewChatPending } from '../events';
import type { Session } from '../types';
import type { Thread } from './ChatView';
import AnnotateDialog from './AnnotateDialog';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** 확장자로 문서 형식을 정한다(.md 같은 파일은 브라우저가 형식을 비워 두는 경우가 많다). */
const DOC_TYPES: Record<string, string> = {
  pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html',
  txt: 'text/plain', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  yaml: 'application/yaml', yml: 'application/yaml', xml: 'application/xml', sql: 'application/sql', sh: 'application/x-sh',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  java: 'text/plain', kt: 'text/plain', kts: 'text/plain', gradle: 'text/plain', py: 'text/plain', go: 'text/plain',
  properties: 'text/plain', toml: 'text/plain', ini: 'text/plain', svg: 'text/plain',
};
const ACCEPT = [...IMAGE_TYPES, ...Object.keys(DOC_TYPES).map((e) => `.${e}`)];
const LIMIT = (type: string) => (IMAGE_TYPES.includes(type) ? 5 : type === 'application/pdf' ? 20 : 1) * 1024 * 1024;

function typeOf(f: File): string | null {
  if (IMAGE_TYPES.includes(f.type)) return f.type;
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  return DOC_TYPES[ext] ?? (f.type.startsWith('text/') ? f.type : null);
}

/** preview는 이미지일 때만 있다. */
type Attachment = { id: string; name: string; mediaType: string; data: string; preview: string; size: number };

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    r.readAsDataURL(file);
  });
}

/** 문서 칩에 넣을 확장자 표시 */
export function docLabel(name: string) {
  return (name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || 'DOC';
}

function formatSize(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** thread의 대화로 보낸다. 'new'면 보낼 때 새 대화를 열고 onStarted로 그 대화 id를 알린다. */
export default function PromptInput({ session, thread, onStarted }: { session: Session; thread: Thread; onStarted: (chatId: number) => void }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<Attachment | null>(null);
  // 계획 먼저: 코드는 고치지 않고 계획서·화면설계서를 만든 뒤 승인을 기다린다. 세션마다 기억한다.
  const planKey = `wts:plan-first:${session.id}`;
  const [plan, setPlan] = useState(() => { try { return localStorage.getItem(planKey) === '1'; } catch { return false; } });
  const togglePlan = () => {
    const next = !plan;
    setPlan(next);
    try { localStorage.setItem(planKey, next ? '1' : '0'); } catch { /* 사생활 보호 모드 등 */ }
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const running = thread.status === 'running';
  const chat = thread.id === 'new' ? 0 : thread.id;

  useEffect(() => () => attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // 새 대화 입력창은 도구 화면에서 넘긴 텍스트와 이미지를 받는다(나타날 때 기다리던 것과 그 뒤에 오는 것).
  useEffect(() => {
    if (thread.id !== 'new') return;
    const take = () => {
      const items = takeNewChatPending();
      if (!items.length) return;
      const texts = items.flatMap((i) => ('text' in i ? [i.text] : []));
      if (texts.length) setText((prev) => [prev.replace(/\s+$/, ''), ...texts].filter(Boolean).join('\n\n'));
      const files = items.flatMap((i) => {
        if (!('image' in i)) return [];
        const bytes = Uint8Array.from(atob(i.image.data), (c) => c.charCodeAt(0));
        return [new File([bytes], i.image.name, { type: i.image.mediaType })];
      });
      if (files.length) addFiles(files);
      textarea.current?.focus();
    };
    take();
    window.addEventListener('wts:new-chat', take);
    return () => window.removeEventListener('wts:new-chat', take);
  }, [thread.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addFiles(files: FileList | File[]) {
    setError(null);
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      const type = typeOf(f);
      if (!type) { setError(`${f.name || '파일'}: 이미지(PNG, JPG, GIF, WEBP), PDF, 텍스트 문서(md, html, txt, json, csv 등)만 첨부할 수 있습니다.`); continue; }
      if (f.size > LIMIT(type)) { setError(`${f.name || '파일'}: ${LIMIT(type) / 1024 / 1024}MB까지 첨부할 수 있습니다.`); continue; }
      const image = IMAGE_TYPES.includes(type);
      next.push({
        id: crypto.randomUUID(),
        name: f.name || `붙여넣은 이미지.${type.split('/')[1]}`,
        mediaType: type,
        data: await readAsBase64(f),
        preview: image ? URL.createObjectURL(f) : '',
        size: f.size,
      });
    }
    setAttachments((prev) => [...prev, ...next].slice(0, 10));
  }

  function remove(id: string) {
    setAttachments((prev) => {
      const a = prev.find((x) => x.id === id);
      if (a?.preview) URL.revokeObjectURL(a.preview);
      return prev.filter((x) => x.id !== id);
    });
  }

  // 작업 중이거나 앞에 기다리는 프롬프트가 있으면 대기열 끝에 들어간다.
  const willQueue = running || thread.queue.length > 0;

  async function send() {
    if (sending) return;
    if (!text.trim() && attachments.length === 0) { setError('프롬프트를 입력하세요.'); return; }
    setSending(true);
    setError(null);
    try {
      const images = attachments.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
      if (thread.id === 'new') onStarted((await api.startChat(session.id, text, images, plan)).id);
      else await api.prompt(session.id, text, images, plan, thread.id);
      attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      setText('');
      setAttachments([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
    {thread.queue.length > 0 && (
      <section className="prompt-queue" aria-label="대기 중인 프롬프트">
        <div className="queue-head">
          <strong>대기 중 {thread.queue.length}개</strong>
          {thread.queue_paused ? (
            <>
              <span className="warn-text small">{running ? '' : '앞 작업이 중단되거나 오류로 끝나서 멈췄습니다.'}</span>
              <button type="button" className="small-btn primary" disabled={running} onClick={() => api.resumeQueue(session.id, chat).catch((e) => setError(e.message))}>이어서 실행</button>
            </>
          ) : (
            <span className="muted small">{running ? '지금 작업이 끝나면 순서대로 실행합니다.' : '곧 실행합니다.'}</span>
          )}
        </div>
        <ol>
          {thread.queue.map((q) => (
            <li key={q.id}>
              {q.plan && <span className="plan-badge">계획</span>}
              <span className="queue-text">{q.text || '(첨부만)'}</span>
              {q.image_count > 0 && <span className="muted small">첨부 {q.image_count}</span>}
              <button type="button" className="icon" aria-label="대기열에서 빼기" onClick={() => api.removeQueued(session.id, q.id).catch((e) => setError(e.message))}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </li>
          ))}
        </ol>
      </section>
    )}
    <form
      className={`prompt${dragging ? ' dragging' : ''}`}
      onSubmit={(e) => { e.preventDefault(); send(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
    >
      {attachments.length > 0 && (
        <ul className="attachments" aria-label="첨부한 파일">
          {attachments.map((a) => (
            <li key={a.id} className="chip">
              {a.preview ? <img src={a.preview} alt="" /> : <span className="chip-doc" aria-hidden="true">{docLabel(a.name)}</span>}
              <span className="chip-text"><span className="chip-name">{a.name}</span><span className="muted small">{formatSize(a.size)}</span></span>
              {a.preview && (
                <button type="button" className="icon" aria-label={`${a.name}에 표시하기`} title="화면에 표시하기" onClick={() => setEditing(a)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              )}
              <button type="button" className="icon" aria-label={`${a.name} 첨부 빼기`} onClick={() => remove(a.id)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor="prompt-text" className="sr-only">프롬프트</label>
      <textarea
        id="prompt-text"
        ref={textarea}
        rows={3}
        value={text}
        placeholder={willQueue
          ? `${running ? 'Claude가 작업 중입니다' : '대기열이 멈춰 있습니다'}. 지금 보내면 대기열 끝에 넣고 순서대로 실행합니다. (Enter 추가, Shift+Enter 줄바꿈)`
          : thread.id === 'new' ? '새 대화에서 맡길 일을 적어주세요. 메인 대화와 같은 워크트리에서 따로 실행합니다. (Enter 보내기, Shift+Enter 줄바꿈)'
          : '이 워크트리에서 할 일을 적어주세요. 이미지·문서(PDF, md, html 등)는 끌어다 놓거나 붙여넣을 수 있습니다. (Enter 보내기, Shift+Enter 줄바꿈)'}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) { e.preventDefault(); addFiles(files); }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }}
      />
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="prompt-bar">
        <input ref={fileInput} type="file" accept={ACCEPT.join(',')} multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="icon bordered" aria-label="이미지·문서 첨부" title="이미지·문서 첨부" onClick={() => fileInput.current?.click()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7L14 5.5a3.3 3.3 0 0 1 4.7 4.7L10.2 18.7a1.7 1.7 0 0 1-2.4-2.4L15.5 8.6" /></svg>
        </button>
        <button type="button" className={`chip-btn${plan ? ' on' : ''}`} aria-pressed={plan} onClick={togglePlan}
          title="코드를 고치기 전에 계획서와 화면설계서를 HTML로 만들고, 승인한 뒤에 실행합니다">
          계획 먼저
        </button>
        <span className="muted small">{[...new Set(session.worktrees.map((w) => w.path.split('/').pop()))].join(', ')}</span>
        <div className="spacer" />
        {running && <button type="button" onClick={() => api.stop(session.id, chat).catch((e) => setError(e.message))}>중단</button>}
        <button type="submit" className="dark" disabled={sending}>{sending ? '보내는 중' : willQueue ? '대기열에 추가' : plan ? '계획 세우기' : thread.id === 'new' ? '새 대화 시작' : '보내기'}</button>
      </div>
    </form>
    {editing && (
      <AnnotateDialog
        image={{ data: editing.data, mediaType: editing.mediaType }}
        title={editing.name}
        onCancel={() => setEditing(null)}
        onDone={(r) => {
          // 표시한 이미지로 그 첨부를 바꾼다.
          const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: r.mediaType });
          setAttachments((prev) => prev.map((x) => {
            if (x.id !== editing.id) return x;
            URL.revokeObjectURL(x.preview);
            return { ...x, data: r.data, mediaType: r.mediaType, name: x.name.replace(/\.\w+$/, '') + '.png', preview: URL.createObjectURL(blob), size: blob.size };
          }));
          if (r.note) setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${r.note}` : r.note));
          setEditing(null);
        }}
      />
    )}
    </>
  );
}
