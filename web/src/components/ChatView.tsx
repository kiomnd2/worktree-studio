import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { useServerEvents } from '../events';
import type { Session, StoredMessage } from '../types';
import PromptInput from './PromptInput';

type ToolResult = { text: string; isError: boolean };

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

export default function ChatView({ session }: { session: Session }) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.messages(session.id).then(setMessages).catch((e) => setLoadError(e.message));
  }, [session.id]);

  useServerEvents((e) => {
    if (e.type === 'message' && e.sessionId === session.id) {
      setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]));
    }
  });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const m of messages) {
      if (m.kind !== 'sdk' || m.payload?.type !== 'user') continue;
      const content = m.payload.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_result') map.set(block.tool_use_id, { text: resultText(block.content), isError: Boolean(block.is_error) });
      }
    }
    return map;
  }, [messages]);

  return (
    <main className="main chat">
      <div className="stream" ref={scroller}>
        {loadError && <p className="error-text" role="alert">{loadError}</p>}
        {messages.length === 0 && !loadError && (
          <div className="stream-empty">
            <p>이 세션의 워크트리에서 할 일을 적어 보내세요.</p>
            <ul>{session.worktrees.map((w) => <li key={w.id}><code>{w.path}</code></li>)}</ul>
          </div>
        )}
        {messages.map((m) => <MessageItem key={m.id} message={m} toolResults={toolResults} />)}
        {session.status === 'running' && <div className="working" aria-live="polite"><span className="spinner" aria-hidden="true" />작업 중</div>}
        <div ref={bottom} />
      </div>
      <PromptInput session={session} />
    </main>
  );
}

function MessageItem({ message, toolResults }: { message: StoredMessage; toolResults: Map<string, ToolResult> }) {
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
          if (b.type === 'tool_use') {
            const r = toolResults.get(b.id);
            return (
              <details key={i} className={`tool${r?.isError ? ' failed' : ''}`}>
                <summary><span className="tool-name">{b.name}</span> <span className="tool-arg">{toolSummary(b.name, b.input)}</span>{!r && <span className="tool-pending"> 실행 중</span>}</summary>
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
