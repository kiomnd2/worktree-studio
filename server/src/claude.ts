import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE, UPLOAD_DIR } from './config.js';
import { appendMessage, getSession, setSession } from './sessions.js';
import { getSettings } from './settings.js';
import { notifyRunFinished } from './notify.js';
import { serverPorts } from './runner.js';
import { accountOf } from './accounts.js';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
export type IncomingImage = { mediaType: string; data: string; name?: string };
type StoredImage = { file: string; mediaType: ImageType; name?: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const running = new Map<number, AbortController>();

export function isRunning(sessionId: number) {
  return running.has(sessionId);
}

function storeImages(images: IncomingImage[]): StoredImage[] {
  return images.map((img) => {
    if (!IMAGE_TYPES.includes(img.mediaType as ImageType)) throw new Error(`지원하지 않는 이미지 형식입니다: ${img.mediaType}`);
    const buf = Buffer.from(img.data, 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('이미지는 한 장에 5MB까지 첨부할 수 있습니다.');
    const ext = img.mediaType.split('/')[1].replace('jpeg', 'jpg');
    const file = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    return { file, mediaType: img.mediaType as ImageType, name: img.name };
  });
}

function buildSystemAppend(worktrees: { project_name: string; path: string; branch: string; base_branch: string }[]) {
  const lines = worktrees.map((w) => `- ${w.project_name}: ${w.path} (브랜치 ${w.branch}, ${w.base_branch}에서 분기)`);
  return [
    '이 세션은 아래 git 워크트리에서만 작업한다. 원본 클론 폴더나 다른 워크트리는 수정하지 않는다.',
    ...lines,
    '커밋, 푸시, PR 생성은 사용자가 도구에서 따로 실행하므로 요청받지 않으면 하지 않는다.',
    '개발 서버는 도구가 띄우고 관리한다. 직접 띄우거나 끄지 말고, 메시지의 <tool_context>에 적힌 주소로 확인한다.',
  ].join('\n');
}

/** 시스템 프롬프트는 세션 처음에 고정되므로, 바뀌는 정보(서버 주소, 계정)는 매 메시지에 붙인다. */
function runtimeContext(sessionId: number): string | null {
  const ports = serverPorts(sessionId);
  const account = accountOf(sessionId);
  const lines: string[] = [];
  if (ports.length) {
    lines.push('실행 중인 개발 서버:', ...ports.map((p) => `- ${p.project_name}: http://localhost:${p.port} (${p.status})`));
    lines.push('핫 리로드가 안 되는 서버(예: Spring)는 코드를 바꾼 뒤 사용자에게 서버 재시작을 부탁한다.');
  } else {
    lines.push('지금 실행 중인 개발 서버가 없다. 화면 확인이 필요하면 사용자에게 서버 실행을 부탁한다.');
  }
  if (account) lines.push(`화면 확인용 테스트 계정: ${account.login} / ${account.password} (이 세션 전용)`);
  return `<tool_context>\n${lines.join('\n')}\n</tool_context>`;
}

/** 세션의 워크트리에서 Claude Code를 실행하고 메시지를 저장·중계한다. */
export async function runPrompt(sessionId: number, text: string, images: IncomingImage[]) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  if (running.has(sessionId)) throw new Error('이미 작업 중입니다. 끝나거나 중단한 뒤 보내세요.');
  if (!text.trim() && images.length === 0) throw new Error('프롬프트를 입력하세요.');

  const primary = session.worktrees.find((w) => w.id === session.primary_worktree_id) ?? session.worktrees[0];
  if (!primary) throw new Error('세션에 워크트리가 없습니다.');
  const others = session.worktrees.filter((w) => w.id !== primary.id).map((w) => w.path);

  const stored = storeImages(images);
  appendMessage(sessionId, 'user', { text, images: stored });

  const content: SDKUserMessage['message']['content'] = [
    ...stored.map((img) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: img.mediaType, data: fs.readFileSync(path.join(UPLOAD_DIR, img.file)).toString('base64') },
    })),
    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
  ];
  const ctx = runtimeContext(sessionId);
  if (ctx) content.push({ type: 'text', text: ctx });

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
  }

  const abort = new AbortController();
  running.set(sessionId, abort);
  setSession(sessionId, { status: 'running', unread: 0 });

  const started = Date.now();
  let ok = false;
  let lastText = '';
  try {
    const q = query({
      prompt: input(),
      options: {
        cwd: primary.path,
        additionalDirectories: others,
        resume: session.claude_session_id ?? undefined,
        permissionMode: getSettings().permissionMode,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(session.worktrees) },
        abortController: abort,
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      },
    });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.session_id && msg.session_id !== session.claude_session_id) setSession(sessionId, { claude_session_id: msg.session_id });
        continue;
      }
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) if (block.type === 'text') lastText = block.text;
        appendMessage(sessionId, 'sdk', msg);
      } else if (msg.type === 'user') {
        appendMessage(sessionId, 'sdk', msg);
      } else if (msg.type === 'result') {
        ok = msg.subtype === 'success' && !msg.is_error;
        appendMessage(sessionId, 'sdk', msg);
        if (msg.session_id) setSession(sessionId, { claude_session_id: msg.session_id });
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      appendMessage(sessionId, 'event', { kind: 'stopped' });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      appendMessage(sessionId, 'event', { kind: 'error', message });
      lastText = message;
    }
  } finally {
    running.delete(sessionId);
    const stopped = abort.signal.aborted;
    setSession(sessionId, { status: 'idle', unread: 1 });
    if (!stopped) {
      notifyRunFinished({ sessionId, ticket: session.ticket, ok, durationMs: Date.now() - started, summary: lastText });
    }
  }
}

export function stopPrompt(sessionId: number) {
  const ctl = running.get(sessionId);
  if (!ctl) return false;
  ctl.abort();
  return true;
}
