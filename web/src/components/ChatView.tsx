import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { hasNewChatPending, openDoc, useServerEvents } from '../events';
import type { Session, StoredMessage } from '../types';
import PromptInput from './PromptInput';
import ApprovalCards from './ApprovalCards';
import TaskBar from './TaskBar';

type ToolResult = { text: string; isError: boolean; at: number };

function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash') return input.command ?? '';
  if (input.file_path) return input.file_path;
  if (input.pattern) return `${input.pattern}${input.path ? `  ${input.path}` : ''}`;
  if (input.url) return input.url;
  if (input.description) return input.description;
  const s = JSON.stringify(input);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[이미지]' : '')).join('\n');
  }
  return '';
}

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

/** 저장 시각(SQLite, UTC 'YYYY-MM-DD HH:MM:SS')을 ms로. 초 단위라 도구 시간은 1초 단위로 보인다. */
const atOf = (createdAt: string) => Date.parse(`${createdAt.replace(' ', 'T')}Z`);

/** 도구 하나가 걸린 시간. 1초 안에 끝난 것은 따로 적는다. */
function toolDuration(ms: number) {
  return ms < 1000 ? '1초 미만' : formatDuration(ms);
}

/** 작업 중일 때만 1초마다 다시 그려 진행 시간을 올린다. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** 대화 하나의 실행 상태. id 0은 메인 대화, 'new'는 아직 보내지 않은 새 대화 */
export type Thread = { id: number | 'new'; status: 'idle' | 'running'; queue: Session['queue']; queue_paused: boolean };

export default function ChatView({ session }: { session: Session }) {
  // 고른 대화는 세션마다 기억한다.
  const selKey = `wts:chat:${session.id}`;
  const [sel, setSelRaw] = useState<number | 'new'>(() => { try { return Number(localStorage.getItem(selKey)) || 0; } catch { return 0; } });
  const setSel = (v: number | 'new') => {
    setSelRaw(v);
    if (v !== 'new') try { localStorage.setItem(selKey, String(v)); } catch { /* 사생활 보호 모드 등 */ }
  };
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // 스크롤이 맨 아래에 붙어 있으면 새 메시지를 따라 내려간다. 위로 올려 보는 중이면 그대로 둔다.
  const stick = useRef(true);

  const chat = typeof sel === 'number' && sel !== 0 ? session.chats.find((c) => c.id === sel) : undefined;
  // 방금 시작한 대화. 세션 목록에 나타나기 전까지는 닫힌 대화로 보지 않고 작업 중으로 보여 준다.
  const [started, setStarted] = useState<number | null>(null);
  useEffect(() => { if (chat && chat.id === started) setStarted(null); }, [chat, started]);
  const waiting = typeof sel === 'number' && sel !== 0 && !chat && sel === started;
  // 닫힌 대화를 고르고 있으면 메인으로 돌아간다.
  useEffect(() => { if (typeof sel === 'number' && sel !== 0 && !chat && !waiting) setSel(0); }, [sel, chat, waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const thread: Thread = sel === 'new' ? { id: 'new', status: 'idle', queue: [], queue_paused: false }
    : chat ? { id: chat.id, status: chat.status, queue: chat.queue, queue_paused: chat.queue_paused }
    : waiting ? { id: sel, status: 'running', queue: [], queue_paused: false }
    : { id: 0, status: session.status, queue: session.queue, queue_paused: session.queue_paused };

  // 도구 화면에서 넘긴 프롬프트는 새 대화 탭에 연다. 입력창이 나타나면서 기다리던 것을 가져간다.
  useEffect(() => {
    const open = () => setSelRaw('new');
    window.addEventListener('wts:new-chat', open);
    if (hasNewChatPending()) open();
    // 도구가 시작한 대화(충돌 해결 등)를 연다. 목록에 나타나기 전이라도 그 대화로 간다.
    const openChat = (e: Event) => { const id = (e as CustomEvent<number>).detail; setStarted(id); setSel(id); };
    window.addEventListener('wts:open-chat', openChat);
    return () => { window.removeEventListener('wts:new-chat', open); window.removeEventListener('wts:open-chat', openChat); };
  }, []);

  useEffect(() => {
    setLoadError(null);
    stick.current = true;
    if (thread.id === 'new') { setMessages([]); return; }
    setMessages([]);
    api.messages(session.id, thread.id).then(setMessages).catch((e) => setLoadError(e.message));
  }, [session.id, thread.id]);

  // 보고 있는 추가 대화의 새 결과 표시는 바로 지운다(메인 대화는 App이 지운다).
  useEffect(() => {
    if (chat?.unread && document.visibilityState === 'visible') api.markRead(session.id, chat.id).catch(() => {});
  }, [session.id, chat?.id, chat?.unread]);

  useServerEvents((e) => {
    if (e.type === 'message' && e.sessionId === session.id && (e.message.chat_id ?? 0) === thread.id) {
      setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]));
    }
  });

  // 도구 결과나 '작업 중' 표시처럼 메시지 수와 상관없이 높이가 바뀌는 경우도 있어 messages 자체와 상태를 본다.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, thread.status]);

  // 첨부 이미지는 그린 뒤에 늦게 로드돼 높이가 늘어난다. load 이벤트는 버블링되지 않아 캡처로 받는다.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onLoad = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, []);

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const m of messages) {
      if (m.kind !== 'sdk' || m.payload?.type !== 'user') continue;
      const content = m.payload.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_result') map.set(block.tool_use_id, { text: resultText(block.content), isError: Boolean(block.is_error), at: atOf(m.created_at) });
      }
    }
    return map;
  }, [messages]);

  const running = thread.status === 'running';
  const now = useNow(running);
  // 이번 작업은 마지막으로 보낸 프롬프트부터 센다.
  const lastUser = [...messages].reverse().find((m) => m.kind === 'user');
  const runStart = running && lastUser ? atOf(lastUser.created_at) : null;

  return (
    <main className="main chat">
      <ChatTabs session={session} sel={sel} onSelect={setSel} />
      {thread.id === 0 && <TaskBar sessionId={session.id} running={running} />}
      <div
        className="stream"
        ref={scroller}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      >
        {loadError && <p className="error-text" role="alert">{loadError}</p>}
        {messages.length === 0 && !loadError && (thread.id === 'new' ? (
          <div className="stream-empty">
            <p>새 대화는 메인 대화와 같은 워크트리에서 따로 실행합니다. 메인 대화가 작업 중이어도 바로 시작합니다.</p>
            <p className="muted small">두 대화가 같은 파일을 동시에 고치면 서로 덮어쓸 수 있으니, 메인 작업과 겹치지 않는 작은 수정에 쓰세요.</p>
          </div>
        ) : (
          <div className="stream-empty">
            <p>이 세션의 워크트리에서 할 일을 적어 보내세요.</p>
            <ul>{[...new Set(session.worktrees.map((w) => w.path))].map((p) => <li key={p}><code>{p}</code></li>)}</ul>
          </div>
        ))}
        {messages.map((m) => <MessageItem key={m.id} message={m} toolResults={toolResults} now={runStart !== null && atOf(m.created_at) >= runStart ? now : null} />)}
        {running && (
          <div className="working" aria-live="off">
            <span className="spinner" aria-hidden="true" />작업 중
            {runStart !== null && <span className="muted small">· {formatDuration(Math.max(0, now - runStart))}째</span>}
          </div>
        )}
      </div>
      {thread.id !== 'new' && <ApprovalCards session={session} chatId={thread.id} />}
      <PromptInput
        key={thread.id}
        session={session}
        thread={thread}
        onStarted={(id) => { setStarted(id); setSel(id); }}
      />
    </main>
  );
}

/** 메인 대화와 추가 대화 사이를 오간다. 다른 대화가 작업 중이거나 새 결과가 있으면 표시한다. */
function ChatTabs({ session, sel, onSelect }: { session: Session; sel: number | 'new'; onSelect: (v: number | 'new') => void }) {
  const [error, setError] = useState<string | null>(null);
  const mark = (status: string, unread: number) => (status === 'running'
    ? <span className="spinner" aria-label="작업 중" />
    : unread ? <span className="chat-dot" aria-label="새 결과" /> : null);
  return (
    <div className="chat-tabs" role="tablist" aria-label="대화">
      <button role="tab" aria-selected={sel === 0} className={`chat-tab${sel === 0 ? ' on' : ''}`} onClick={() => onSelect(0)}>
        {mark(session.status, sel === 0 ? 0 : session.unread)}메인 대화
      </button>
      {session.chats.map((c) => (
        <span key={c.id} className={`chat-tab${sel === c.id ? ' on' : ''}`}>
          <button role="tab" aria-selected={sel === c.id} className="chat-tab-label" title={c.title} onClick={() => onSelect(c.id)}>
            {mark(c.status, sel === c.id ? 0 : c.unread)}<span className="chat-tab-title">{c.title}</span>
          </button>
          <button className="icon chat-tab-close" aria-label={`${c.title} 대화 닫기`} disabled={c.status === 'running'}
            title={c.status === 'running' ? '작업 중인 대화는 중단한 뒤 닫을 수 있습니다' : '대화 닫기 (워크트리 변경은 그대로 남습니다)'}
            onClick={() => {
              if (!confirm(`"${c.title}" 대화를 닫을까요? 고친 코드는 워크트리에 그대로 남습니다.`)) return;
              setError(null);
              api.closeChat(session.id, c.id).then(() => { if (sel === c.id) onSelect(0); }).catch((e) => setError(e.message));
            }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </span>
      ))}
      {sel === 'new' && <span className="chat-tab on" role="tab" aria-selected="true"><span className="chat-tab-label">새 대화</span></span>}
      <button className="chat-tab chat-tab-add" onClick={() => onSelect('new')} disabled={sel === 'new'} title="같은 워크트리에서 따로 Claude에게 일을 맡깁니다">+ 새 대화</button>
      {error && <span className="error-text small" role="alert">{error}</span>}
    </div>
  );
}

function MessageItem({ message, toolResults, now }: { message: StoredMessage; toolResults: Map<string, ToolResult>; now: number | null }) {
  const p = message.payload;
  if (message.kind === 'user') {
    return (
      <div className="msg-user">
        {p.images?.length > 0 && (
          <div className="msg-images">
            {p.images.map((img: { file: string; name?: string }) => (
              <a key={img.file} href={`/api/uploads/${img.file}`} target="_blank" rel="noreferrer">
                <img src={`/api/uploads/${img.file}`} alt={img.name ?? '첨부 이미지'} />
              </a>
            ))}
          </div>
        )}
        {p.plan && <span className="plan-badge">계획 먼저</span>}
        {p.text && <div className="bubble">{p.text}</div>}
      </div>
    );
  }
  if (message.kind === 'event') {
    if (p.kind === 'stopped') return <div className="msg-event">작업을 중단했습니다.</div>;
    return <div className="msg-event error" role="alert">오류: {p.message}</div>;
  }
  if (p.type === 'assistant') {
    if (p.parent_tool_use_id) return null; // 서브에이전트 내부 메시지는 상위 도구 카드로 대신한다
    const blocks = p.message?.content ?? [];
    return (
      <div className="msg-assistant">
        {blocks.map((b: any, i: number) => {
          if (b.type === 'text') {
            return (
              <div key={i} className={`markdown${p.error ? ' error-text' : ''}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown>
              </div>
            );
          }
          if (b.type === 'tool_use' && b.name === 'mcp__studio__set_tasks') {
            // 목록은 위쪽 작업 목록에 늘 보이니 대화에는 한 줄만 남긴다.
            const ts: { status: string }[] = Array.isArray(b.input?.tasks) ? b.input.tasks : [];
            const doing = (b.input?.tasks ?? []).find((t: any) => t.status === 'doing')?.title;
            return (
              <div key={i} className="task-update muted small">
                작업 목록 {ts.filter((t) => t.status === 'done' || t.status === 'skipped').length}/{ts.length}{doing ? ` · 지금: ${doing}` : ''}
              </div>
            );
          }
          if (b.type === 'tool_use' && b.name === 'mcp__studio__save_doc') {
            const r = toolResults.get(b.id);
            const kind = b.input?.kind === 'plan' ? '계획서' : b.input?.kind === 'screen' ? '화면설계서' : '문서';
            return (
              <div key={i} className="doc-card">
                <div className="doc-card-text">
                  <strong>{b.input?.title ?? b.input?.name}</strong>
                  <span className={`small ${r?.isError ? 'error-text' : 'muted'}`}>{!r ? `${kind} 저장 중` : r.isError ? r.text : `${kind} 저장함`}</span>
                </div>
                {r && !r.isError && <button className="small-btn" onClick={() => openDoc(b.input?.name)}>열기</button>}
              </div>
            );
          }
          if (b.type === 'tool_use') {
            const r = toolResults.get(b.id);
            const start = atOf(message.created_at);
            // 끝난 도구는 걸린 시간, 실행 중인 도구는 지금까지 흐른 시간. 작업이 끝났는데 결과가 없으면(중단 등) 비운다.
            const took = r ? toolDuration(r.at - start) : now !== null ? `${formatDuration(Math.max(0, now - start))}째` : '';
            return (
              <details key={i} className={`tool${r?.isError ? ' failed' : ''}`}>
                <summary>
                  <span className="tool-name">{b.name}</span>
                  <span className="tool-arg">{toolSummary(b.name, b.input)}</span>
                  {!r && now !== null && <span className="tool-pending">실행 중</span>}
                  {took && <span className={`tool-time${r ? '' : ' live'}`}>{took}</span>}
                </summary>
                {r && <pre>{r.text.length > 6000 ? `${r.text.slice(0, 6000)}\n… (${r.text.length - 6000}자 생략)` : r.text || '(출력 없음)'}</pre>}
              </details>
            );
          }
          return null;
        })}
      </div>
    );
  }
  if (p.type === 'result') {
    const ok = p.subtype === 'success' && !p.is_error;
    return (
      <div className={`msg-result${ok ? '' : ' error'}`}>
        {ok ? '완료' : '실패'} · {formatDuration(p.duration_ms ?? 0)}
        {typeof p.total_cost_usd === 'number' && ` · $${p.total_cost_usd.toFixed(2)}`}
        {p.num_turns ? ` · ${p.num_turns}턴` : ''}
      </div>
    );
  }
  return null;
}
