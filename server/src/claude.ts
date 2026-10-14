import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionMode, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { cancelApprovals, requestAccount, requestEnv, requestPlanApproval } from './approvals.js';
import { docsDir, listDocs, saveDoc } from './docs.js';
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
/** 실행 중인 프롬프트에서 저장한 문서 이름. 계획 승인 카드에 이번 계획의 문서만 보여 준다. */
const savedThisRun = new Map<number, Set<string>>();

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
    '계획서, 화면설계서처럼 사람이 읽을 산출물은 mcp__studio__save_doc으로 HTML 문서로 저장한다. 저장소에 문서 파일을 만들지 않는다.',
    '저장한 문서 목록은 메시지의 <tool_context>에 나온다. 사용자가 문서를 언급하면 그 경로의 파일을 Read로 읽어 따른다.',
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
  const docs = listDocs(sessionId);
  if (docs.length) {
    lines.push('이 세션의 산출물 (계획서·화면설계서·테스트 결과서, 필요하면 Read로 읽는다):');
    lines.push(...docs.map((d) => `- ${d.name} "${d.title}" (${KIND_LABEL[d.kind]}, ${d.version}판): ${d.path}`));
  }
  if (accounts.length) {
    lines.push('화면 확인용 테스트 계정 (이 세션 전용, 역할이 다르면 메모를 보고 골라 쓴다):');
    lines.push(...accounts.map((a) => `- ${a.login} / ${a.password}${a.note ? ` (${a.note})` : ''}`));
  }
  return `<tool_context>\n${lines.join('\n')}\n</tool_context>`;
}

const KIND_LABEL = { plan: '계획서', screen: '화면설계서', test: '테스트 결과서', other: '문서' } as const;

/** 계획 모드에서 따를 순서. 산출물을 HTML 문서로 남기고, 사용자가 확인한 뒤에만 실행한다. */
const PLAN_INSTRUCTIONS = [
  '1. 코드를 읽어 요청을 이해한다. 모르는 것은 추측하지 말고 계획서의 "확인할 것"에 적는다.',
  '2. 계획서를 mcp__studio__save_doc(kind "plan", name "plan")으로 저장한다. 목표, 바꿀 파일과 이유, 단계, 데이터·API 변경, 영향 범위, 테스트 방법, 확인할 것을 담는다.',
  '3. 화면이 새로 생기거나 바뀌면 화면마다 화면설계서를 mcp__studio__save_doc(kind "screen", name "screen-<영문 화면 이름>")으로 저장한다.',
  '   화면설계서는 실제 화면과 같은 배치의 와이어프레임(HTML/CSS로 그린 것)에 번호 표시를 달고, 옆이나 아래에 번호별 설명 표(항목, 동작, 검증 규칙, 데이터 출처)를 둔다.',
  '   바뀌는 화면이면 지금 화면과 달라지는 부분을 표시한다. 상태(빈 목록, 오류, 로딩, 권한별 차이)가 있으면 함께 그린다.',
  '4. 문서는 한국어로 쓰고, 외부 파일이나 스크립트 없이 CSS를 <style>에 넣은 완결된 HTML로 만든다. 계획서에서 화면설계서를 이름으로 언급한다.',
  '5. 다 저장했으면 ExitPlanMode로 계획 요약을 보낸다. 사용자가 문서를 보고 승인해야 실행한다. 고쳐 달라는 의견이 오면 문서를 같은 name으로 다시 저장하고 다시 ExitPlanMode를 부른다.',
].join('\n');

/**
 * 사용자가 보낸 프롬프트. Claude가 작업 중이거나 앞에 기다리는 프롬프트가 있으면 대기열 끝에 넣고,
 * 아니면 바로 실행한다. 이미지는 지금 파일로 저장해 둬서 대기열에는 이름만 남긴다.
 */
export function submitPrompt(sessionId: number, text: string, images: IncomingImage[], opts: { plan?: boolean } = {}): { queued: boolean; position: number } {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  if (!text.trim() && images.length === 0) throw new Error('프롬프트를 입력하세요.');
  const stored = storeImages(images);
  if (running.has(sessionId) || queueLength(sessionId) > 0) {
    return { queued: true, position: enqueuePrompt(sessionId, text, stored, Boolean(opts.plan)) };
  }
  runPrompt(sessionId, text, [], stored, { plan: opts.plan }).catch(() => { /* 오류는 대화에 event로 남는다 */ });
  return { queued: false, position: 0 };
}

/** 대기열에서 다음 프롬프트를 꺼내 실행한다. 작업 중이거나 멈춘 대기열이면 아무것도 안 한다. */
export function drainQueue(sessionId: number) {
  if (running.has(sessionId) || isQueuePaused(sessionId)) return;
  const next = shiftQueue(sessionId);
  if (!next) return;
  runPrompt(sessionId, next.text, [], JSON.parse(next.images) as StoredImage[], { plan: Boolean(next.plan) }).catch(() => {});
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
      tool(
        'save_doc',
        '계획서, 화면설계서 같은 산출물을 HTML 문서로 저장한다. 사용자는 화면에서 바로 보고, 다음 프롬프트에서 다시 참조한다. '
          + '같은 name으로 저장하면 새 판이 되고 예전 판은 남는다. 저장소에는 아무것도 쓰지 않는다.',
        {
          name: z.string().describe('영문 소문자·숫자·하이픈. 계획서는 "plan", 화면설계서는 "screen-<화면>" (예: screen-member-list)'),
          title: z.string().describe('사람이 읽을 제목. 예: "회원 목록 화면설계서"'),
          kind: z.enum(['plan', 'screen', 'other']).describe('plan: 계획서, screen: 화면설계서, other: 그 밖의 문서'),
          html: z.string().describe('<html>로 시작하는 완결된 HTML. CSS는 <style>에 넣고 외부 파일·스크립트·이미지 링크는 쓰지 않는다.'),
        },
        async (args) => {
          try {
            const d = saveDoc(sessionId, args);
            savedThisRun.get(sessionId)?.add(d.name);
            return text(`${d.title}을(를) ${d.version}판으로 저장했습니다: ${d.path}`);
          } catch (err) {
            return { ...text((err as Error).message), isError: true };
          }
        },
        // 저장소를 건드리지 않으므로 계획 모드에서도 쓸 수 있다.
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}

/** 세션의 워크트리에서 Claude Code를 실행하고 메시지를 저장·중계한다. 끝나면 성공 여부를 돌려준다. */
export async function runPrompt(sessionId: number, text: string, images: IncomingImage[], preStored?: StoredImage[], opts: { plan?: boolean } = {}): Promise<{ ok: boolean; stopped: boolean }> {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  if (running.has(sessionId)) throw new Error('이미 작업 중입니다. 끝나거나 중단한 뒤 보내세요.');
  if (!text.trim() && images.length === 0 && !preStored?.length) throw new Error('프롬프트를 입력하세요.');

  const primary = session.worktrees.find((w) => w.id === session.primary_worktree_id) ?? session.worktrees[0];
  if (!primary) throw new Error('세션에 워크트리가 없습니다.');
  const others = session.worktrees.filter((w) => w.id !== primary.id).map((w) => w.path);

  const stored = preStored ?? storeImages(images);
  appendMessage(sessionId, 'user', { text, images: stored, ...(opts.plan ? { plan: true } : {}) });

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
  savedThisRun.set(sessionId, new Set());
  setSession(sessionId, { status: 'running', unread: 0 });

  const started = Date.now();
  let ok = false;
  let lastText = '';
  const mode: PermissionMode = getSettings().permissionMode;
  /**
   * 권한 확인. 계획 모드를 마칠 때(ExitPlanMode)만 사용자에게 묻고, 승인하면 설정의 권한 모드로 이어서 실행한다.
   * 그 밖에 확인이 필요한 도구는 화면에서 승인할 곳이 없으므로 예전처럼 거절한다.
   */
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName.startsWith('mcp__studio__')) return { behavior: 'allow', updatedInput: input };
    if (toolName === 'AskUserQuestion') return { behavior: 'deny', message: '이 화면에는 선택지로 묻는 창이 없습니다. 물어볼 것은 답변 글에 적고 이번 작업을 마치세요. 사용자가 다음 프롬프트로 답합니다.' };
    if (toolName !== 'ExitPlanMode') return { behavior: 'deny', message: '이 도구는 승인 화면이 없어 쓸 수 없습니다. 필요하면 사용자에게 직접 실행을 부탁하세요.' };
    let plan = typeof input.plan === 'string' ? input.plan : '';
    if (!plan && typeof input.planFilePath === 'string') { try { plan = fs.readFileSync(input.planFilePath, 'utf8'); } catch { /* 요약 없이 문서만 보여 준다 */ } }
    // ExitPlanMode가 본문을 넘기지 않으면 Claude가 마지막으로 쓴 글을 요약으로 보여 준다.
    if (!plan) plan = lastText;
    const saved = savedThisRun.get(sessionId);
    const docs = listDocs(sessionId).filter((d) => saved?.has(d.name)).map((d) => ({ name: d.name, title: d.title, kind: d.kind }));
    const d = await requestPlanApproval(sessionId, plan, docs);
    if (d.approve) {
      const next: PermissionMode = mode === 'plan' ? 'default' : mode;
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: next, destination: 'session' }] };
    }
    return {
      behavior: 'deny',
      message: d.feedback
        ? `사용자가 계획을 고쳐 달라고 했습니다. 의견을 반영해 문서를 같은 name으로 다시 저장하고 다시 ExitPlanMode를 부르세요.\n\n사용자 의견:\n${d.feedback}`
        : '사용자가 계획을 승인하지 않았습니다. 실행하지 말고 무엇을 바꾸면 좋을지 사용자에게 물어보세요.',
    };
  };

  try {
    const q = query({
      prompt: input(),
      options: {
        cwd: primary.path,
        // 저장한 문서를 다음 프롬프트에서 읽을 수 있게 문서 폴더도 연다.
        additionalDirectories: [...others, docsDir(sessionId)],
        resume: session.claude_session_id ?? undefined,
        permissionMode: opts.plan ? 'plan' : mode,
        ...(opts.plan ? { planModeInstructions: PLAN_INSTRUCTIONS } : {}),
        canUseTool,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(session.worktrees) },
        abortController: abort,
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
        mcpServers: { studio: studioTools(sessionId) },
        allowedTools: ['mcp__studio__request_env_values', 'mcp__studio__request_test_account', 'mcp__studio__save_doc'],
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
    savedThisRun.delete(sessionId);
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
