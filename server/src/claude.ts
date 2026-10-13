import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { cancelApprovals, requestAccount, requestEnv } from './approvals.js';
import { CLAUDE_EXECUTABLE, UPLOAD_DIR } from './config.js';
import { appendMessage, enqueuePrompt, getSession, isQueuePaused, queueLength, setQueuePaused, setSession, shiftQueue } from './sessions.js';
import { getSettings } from './settings.js';
import { notifyRunFinished } from './notify.js';
import { serverPorts } from './runner.js';
import { accountsOf } from './accounts.js';

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
    '환경값은 도구가 관리한다. 필요한 값이 없거나 틀렸으면 .env 파일을 만들거나 고치지 말고 mcp__studio__request_env_values로 요청한다.',
    '다른 역할의 테스트 계정이 필요하면 mcp__studio__request_test_account로 요청한다. 두 요청 모두 사용자가 화면에서 확인해야 적용된다.',
  ].join('\n');
}

/** 시스템 프롬프트는 세션 처음에 고정되므로, 바뀌는 정보(서버 주소, 계정)는 매 메시지에 붙인다. */
function runtimeContext(sessionId: number): string | null {
  const ports = serverPorts(sessionId);
  const accounts = accountsOf(sessionId);
  const lines: string[] = [];
  if (ports.length) {
    lines.push('실행 중인 개발 서버:', ...ports.map((p) => `- ${p.project_name}: http://localhost:${p.port} (${p.status})`));
    lines.push('핫 리로드가 안 되는 서버(예: Spring)는 코드를 바꾼 뒤 사용자에게 서버 재시작을 부탁한다.');
  } else {
    lines.push('지금 실행 중인 개발 서버가 없다. 화면 확인이 필요하면 사용자에게 서버 실행을 부탁한다.');
  }
  if (accounts.length) {
    lines.push('화면 확인용 테스트 계정 (이 세션 전용, 역할이 다르면 메모를 보고 골라 쓴다):');
    lines.push(...accounts.map((a) => `- ${a.login} / ${a.password}${a.note ? ` (${a.note})` : ''}`));
  }
  return `<tool_context>\n${lines.join('\n')}\n</tool_context>`;
}

/**
 * 사용자가 보낸 프롬프트. Claude가 작업 중이거나 앞에 기다리는 프롬프트가 있으면 대기열 끝에 넣고,
 * 아니면 바로 실행한다. 이미지는 지금 파일로 저장해 둬서 대기열에는 이름만 남긴다.
 */
export function submitPrompt(sessionId: number, text: string, images: IncomingImage[]): { queued: boolean; position: number } {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  if (!text.trim() && images.length === 0) throw new Error('프롬프트를 입력하세요.');
  const stored = storeImages(images);
  if (running.has(sessionId) || queueLength(sessionId) > 0) {
    return { queued: true, position: enqueuePrompt(sessionId, text, stored) };
  }
  runPrompt(sessionId, text, [], stored).catch(() => { /* 오류는 대화에 event로 남는다 */ });
  return { queued: false, position: 0 };
}

/** 대기열에서 다음 프롬프트를 꺼내 실행한다. 작업 중이거나 멈춘 대기열이면 아무것도 안 한다. */
export function drainQueue(sessionId: number) {
  if (running.has(sessionId) || isQueuePaused(sessionId)) return;
  const next = shiftQueue(sessionId);
  if (!next) return;
  runPrompt(sessionId, next.text, [], JSON.parse(next.images) as StoredImage[]).catch(() => {});
}

export function resumeQueue(sessionId: number) {
  setQueuePaused(sessionId, false);
  drainQueue(sessionId);
}

/** 프롬프트 중에 Claude가 환경값·테스트 계정을 요청하는 도구. 사용자가 승인할 때까지 기다린다. */
function studioTools(sessionId: number) {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  return createSdkMcpServer({
    name: 'studio',
    version: '1.0.0',
    tools: [
      tool(
        'request_env_values',
        '개발 서버 실행에 필요한 환경값을 추가하거나 바꾸자고 사용자에게 요청한다. 사용자가 값을 확인·수정해 승인하면 도구가 관리하는 환경값에 들어간다. 값을 모르면 value를 비워 두면 사용자가 채운다.',
        {
          project: z.string().describe('워크트리의 프로젝트 이름'),
          vars: z.array(z.object({
            key: z.string(),
            value: z.string().optional().describe('제안 값. 모르면 생략'),
            reason: z.string().describe('이 값이 필요한 이유 한 문장'),
          })).min(1),
          reason: z.string().describe('요청 전체 이유 한 문장'),
        },
        async (args) => text(await requestEnv(sessionId, args.project, args.vars, args.reason)),
      ),
      tool(
        'request_test_account',
        '지금 배정된 것과 다른 역할의 테스트 계정이 필요할 때 사용자에게 요청한다. 사용자가 계정 풀에서 골라 승인하면 계정과 비밀번호를 돌려준다.',
        {
          role: z.string().describe('필요한 역할. 예: 사업자, 지자체(광역), 관리자'),
          reason: z.string().describe('필요한 이유 한 문장'),
        },
        async (args) => text(await requestAccount(sessionId, args.role, args.reason)),
      ),
    ],
  });
}

/** 세션의 워크트리에서 Claude Code를 실행하고 메시지를 저장·중계한다. 끝나면 성공 여부를 돌려준다. */
export async function runPrompt(sessionId: number, text: string, images: IncomingImage[], preStored?: StoredImage[]): Promise<{ ok: boolean; stopped: boolean }> {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  if (running.has(sessionId)) throw new Error('이미 작업 중입니다. 끝나거나 중단한 뒤 보내세요.');
  if (!text.trim() && images.length === 0 && !preStored?.length) throw new Error('프롬프트를 입력하세요.');

  const primary = session.worktrees.find((w) => w.id === session.primary_worktree_id) ?? session.worktrees[0];
  if (!primary) throw new Error('세션에 워크트리가 없습니다.');
  const others = session.worktrees.filter((w) => w.id !== primary.id).map((w) => w.path);

  const stored = preStored ?? storeImages(images);
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
        mcpServers: { studio: studioTools(sessionId) },
        allowedTools: ['mcp__studio__request_env_values', 'mcp__studio__request_test_account'],
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
    cancelApprovals(sessionId);
    const stopped = abort.signal.aborted;
    setSession(sessionId, { status: 'idle', unread: 1 });
    // 중단했거나 오류로 끝났으면 다음 프롬프트를 바로 보내지 않고 대기열을 멈춘다. 사용자가 보고 이어서 실행한다.
    const waiting = queueLength(sessionId);
    if (waiting > 0 && (stopped || !ok)) setQueuePaused(sessionId, true);
    if (!stopped && (waiting === 0 || !ok)) {
      notifyRunFinished({ sessionId, ticket: session.ticket, ok, durationMs: Date.now() - started, summary: lastText });
    }
    setImmediate(() => drainQueue(sessionId));
    // eslint-disable-next-line no-unsafe-finally
    return { ok: ok && !stopped, stopped };
  }
}

export function stopPrompt(sessionId: number) {
  const ctl = running.get(sessionId);
  if (!ctl) return false;
  ctl.abort();
  return true;
}
