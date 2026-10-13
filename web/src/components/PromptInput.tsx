import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Session } from '../types';

const ACCEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;

type Attachment = { id: string; name: string; mediaType: string; data: string; preview: string; size: number };

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    r.readAsDataURL(file);
  });
}

function formatSize(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export default function PromptInput({ session }: { session: Session }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const running = session.status === 'running';

  useEffect(() => () => attachments.forEach((a) => URL.revokeObjectURL(a.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onInsert = (e: Event) => {
      const add = (e as CustomEvent<string>).detail;
      setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${add}` : add));
      textarea.current?.focus();
    };
    window.addEventListener('wts:insert-prompt', onInsert);
    return () => window.removeEventListener('wts:insert-prompt', onInsert);
  }, []);

  async function addFiles(files: FileList | File[]) {
    setError(null);
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      if (!ACCEPT.includes(f.type)) { setError(`${f.name || '파일'}: PNG, JPG, GIF, WEBP만 첨부할 수 있습니다.`); continue; }
      if (f.size > MAX_BYTES) { setError(`${f.name || '이미지'}: 5MB까지 첨부할 수 있습니다.`); continue; }
      next.push({
        id: crypto.randomUUID(),
        name: f.name || `붙여넣은 이미지.${f.type.split('/')[1]}`,
        mediaType: f.type,
        data: await readAsBase64(f),
        preview: URL.createObjectURL(f),
        size: f.size,
      });
    }
    setAttachments((prev) => [...prev, ...next].slice(0, 10));
  }

  function remove(id: string) {
    setAttachments((prev) => {
      const a = prev.find((x) => x.id === id);
      if (a) URL.revokeObjectURL(a.preview);
      return prev.filter((x) => x.id !== id);
    });
  }

  async function send() {
    if (running || sending) return;
    if (!text.trim() && attachments.length === 0) { setError('프롬프트를 입력하세요.'); return; }
    setSending(true);
    setError(null);
    try {
      await api.prompt(session.id, text, attachments.map(({ mediaType, data, name }) => ({ mediaType, data, name })));
      attachments.forEach((a) => URL.revokeObjectURL(a.preview));
      setText('');
      setAttachments([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className={`prompt${dragging ? ' dragging' : ''}`}
      onSubmit={(e) => { e.preventDefault(); send(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
    >
      {attachments.length > 0 && (
        <ul className="attachments" aria-label="첨부한 이미지">
          {attachments.map((a) => (
            <li key={a.id} className="chip">
              <img src={a.preview} alt="" />
              <span className="chip-text"><span className="chip-name">{a.name}</span><span className="muted small">{formatSize(a.size)}</span></span>
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
        placeholder="이 워크트리에서 할 일을 적어주세요. 이미지는 끌어다 놓거나 붙여넣을 수 있습니다. (Enter 보내기, Shift+Enter 줄바꿈)"
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
        <button type="button" className="icon bordered" aria-label="이미지 첨부" onClick={() => fileInput.current?.click()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7L14 5.5a3.3 3.3 0 0 1 4.7 4.7L10.2 18.7a1.7 1.7 0 0 1-2.4-2.4L15.5 8.6" /></svg>
        </button>
        <span className="muted small">{session.worktrees.map((w) => w.path.split('/').pop()).join(', ')}</span>
        <div className="spacer" />
        {running ? (
          <button type="button" onClick={() => api.stop(session.id).catch((e) => setError(e.message))}>중단</button>
        ) : (
          <button type="submit" className="dark" disabled={sending}>{sending ? '보내는 중' : '보내기'}</button>
        )}
      </div>
    </form>
  );
}
