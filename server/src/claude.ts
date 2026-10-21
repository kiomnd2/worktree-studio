import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionMode, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { cancelApprovals, requestAccount, requestAnswers, requestEnv, requestPlanApproval, type Question } from './approvals.js';
import { docsDir, listDocs, saveDoc } from './docs.js';
import { setTasks, startFirstTask, tasksForContext } from './tasks.js';
import { CLAUDE_EXECUTABLE, UPLOAD_DIR } from './config.js';
import { type RepoView, appendMessage, createChat, enqueuePrompt, getChat, getSession, isQueuePaused, queueLength, setChat, setQueuePaused, shiftQueue } from './sessions.js';
import { getSettings } from './settings.js';
import { notifyRunFinished } from './notify.js';
import { serverPorts } from './runner.js';
import { accountsOf } from './accounts.js';
import { recordUsage } from './usage.js';
import { playwrightMcpCli } from './tests.js';
import { SCREEN_DIR } from './screens.js';

// 대화가 이 크기(토큰)를 넘으면 앞부분을 요약해 줄인다. 매 호출이 대화 전체를 다시 읽으므로 길수록 토큰이 커진다.
export const AUTO_COMPACT_TOKENS = 300_000;
// Studio 대화에서만 끄는 사용자 플러그인. bkit은 Bash 호출마다 훅 문구를 넣고 매 답변에 보고 표를 요구한다.
const DISABLED_PLUGINS = ['bkit@bkit-marketplace'];

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
/** 이미지와 문서(PDF, md·html·txt 같은 텍스트 파일) 첨부. 이름은 예전 그대로 images로 둔다. */
export type IncomingImage = { mediaType: string; data: string; name?: string };
type StoredImage = { file: string; mediaType: string; name?: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const TEXT_TYPES = ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/javascript', 'application/x-sh', 'application/sql'];
const isTextType = (t: string) => t.startsWith('text/') || TEXT_TYPES.includes(t);
/** 대화마다(세션:대화) 하나씩 돈다. 대화 0은 메인 대화 */
const running = new Map<string, AbortController>();
/** 실행 중인 프롬프트에서 저장한 문서 이름. 계획 승인 카드에 이번 계획의 문서만 보여 준다. */
const savedThisRun = new Map<string, Set<string>>();
const rkey = (sessionId: number, chatId: number) => `${sessionId}:${chatId}`;

function storeImages(images: IncomingImage[]): StoredImage[] {
  return images.map((img) => {
    const buf = Buffer.from(img.data, 'base64');
    const label = img.name || '첨부 파일';
    let ext: string;
    if (IMAGE_TYPES.includes(img.mediaType as ImageType)) {
      if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${label}: 이미지는 한 장에 5MB까지 첨부할 수 있습니다.`);
      ext = img.mediaType.split('/')[1].replace('jpeg', 'jpg');
    } else if (img.mediaType === 'application/pdf') {
      if (buf.length > MAX_PDF_BYTES) throw new Error(`${label}: PDF는 20MB까지 첨부할 수 있습니다.`);
      ext = 'pdf';
    } else if (isTextType(img.mediaType)) {
      if (buf.length > MAX_TEXT_BYTES) throw new Error(`${label}: 텍스트 문서는 1MB까지 첨부할 수 있습니다.`);
      if (buf.includes(0)) throw new Error(`${label}: 텍스트 파일이 아닙니다.`);
      ext = 'txt';
    } else {
      throw new Error(`${label}: 지원하지 않는 파일 형식입니다(${img.mediaType || '알 수 없음'}).`);
    }
    const file = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    return { file, mediaType: img.mediaType, name: img.name };
  });
}

/** 저장한 첨부를 Claude에 보낼 블록으로. 이미지는 image, PDF는 document, 텍스트 문서는 파일 이름을 붙인 text. */
function attachmentBlock(a: StoredImage): Exclude<SDKUserMessage['message']['content'], string>[number] {
  const buf = fs.readFileSync(path.join(UPLOAD_DIR, a.file));
  if (a.file.endsWith('.pdf')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, ...(a.name ? { title: a.name } : {}) } as never;
  }
  if (a.file.endsWith('.txt')) {
    return { type: 'text', text: `첨부 문서 "${a.name ?? a.file}" (${a.mediaType}):\n<document>\n${buf.toString('utf8')}\n</document>` };
  }
  return { type: 'image', source: { type: 'base64', media_type: a.mediaType as ImageType, data: buf.toString('base64') } };
}

function buildSystemAppend(repos: RepoView[], side: boolean) {
  // 저장소 하나에 앱이 여럿이면(모노레포) 앱 폴더도 알려 준다.
  const lines = repos.map((w) => `- ${w.project_name}: ${w.path} (브랜치 ${w.branch}, ${w.base_branch}에서 분기)${w.apps.length > 1
    ? `. 이 저장소의 앱: ${w.apps.map((a) => `${a.project_kind.toUpperCase()} ${a.subdir ? `${a.subdir}/` : '루트'}`).join(', ')}`
    : ''}`);
  const sideLines = side ? [
    '이 대화는 세션의 추가 대화다. 같은 워크트리에서 메인 대화의 Claude가 다른 작업을 동시에 하고 있을 수 있다.',
    '요청받은 일만 좁게 고치고, 관련 없는 파일은 건드리지 않는다. 파일을 고치기 직전에 다시 읽어 최신 내용 위에 고친다. git stash, checkout, reset처럼 워크트리 전체를 바꾸는 명령은 쓰지 않는다.',
    '세션의 작업 목록은 메인 대화가 관리하므로 이 대화에서는 바꾸지 않는다.',
  ] : [];
  return [
    ...sideLines,
    '이 세션은 아래 git 워크트리에서만 작업한다. 원본 클론 폴더나 다른 워크트리는 수정하지 않는다.',
    ...lines,
    '커밋, 푸시, PR 생성은 사용자가 도구에서 따로 실행하므로 요청받지 않으면 하지 않는다.',
    '개발 서버는 도구가 띄우고 관리한다. 직접 띄우거나 끄지 말고, 메시지의 <tool_context>에 적힌 주소로 확인한다.',
    '빌드·테스트·로그처럼 출력이 긴 명령은 `| tail -n 80`이나 조용한 옵션(-q 등)으로 실행한다. 명령 출력은 이후 모든 호출에서 다시 읽힌다. 실패하면 필요한 범위만 다시 본다.',
    '화면 확인은 mcp__browser 도구로 한다.',
    '환경값은 도구가 관리한다. 필요한 값이 없거나 틀렸으면 .env 파일을 만들거나 고치지 말고 mcp__studio__request_env_values로 요청한다.',
    '다른 역할의 테스트 계정이 필요하면 mcp__studio__request_test_account로 요청한다. 두 요청 모두 사용자가 화면에서 확인해야 적용된다.',
    '작업 중에 사용자가 정해야 할 것(요구사항이 애매함, 방법이 여럿임, 데이터를 바꿔도 되는지 등)이 생기면 추측하지 말고 AskUserQuestion으로 바로 묻는다. 답을 받으면 이어서 작업한다.',
    '계획서, 화면설계서처럼 사람이 읽을 산출물은 mcp__studio__save_doc으로 HTML 문서로 저장한다. 저장소에 문서 파일을 만들지 않는다.',
    '저장한 문서 목록은 메시지의 <tool_context>에 나온다. 사용자가 문서를 언급하면 그 경로의 파일을 Read로 읽어 따른다.',
    '<tool_context>에 작업 목록이 있으면 그 목록대로 진행한다. 항목을 시작하기 전에 doing으로, 끝나면 바로 done으로 mcp__studio__set_tasks를 불러 바꾼다(목록 전체를 보낸다). doing은 지금 하는 한 항목만 둔다. 하지 않기로 한 항목은 skipped와 이유를 note에 적는다.',
    '작업 목록은 사용자 화면에 항상 보인다. 계획에 없던 일을 하게 되면 목록에 항목을 더한다. 할 일이 여럿인 큰 작업은 계획 모드가 아니어도 목록을 만들어 진행한다.',
  ].join('\n');
}

/** 시스템 프롬프트는 세션 처음에 고정되므로, 바뀌는 정보(서버 주소, 계정)는 매 메시지에 붙인다. */
function runtimeContext(sessionId: number, chatId: number): string | null {
  const ports = serverPorts(sessionId);
  const accounts = accountsOf(sessionId);
  const lines: string[] = [];
  if (ports.length) {
    lines.push('실행 중인 개발 서버:', ...ports.map((p) => `- ${p.project_name}: ${p.url} (${p.status})`));
    lines.push('핫 리로드가 안 되는 서버(예: Spring)는 코드를 바꾼 뒤 사용자에게 서버 재시작을 부탁한다.');
  } else {
    lines.push('지금 실행 중인 개발 서버가 없다. 화면 확인이 필요하면 사용자에게 서버 실행을 부탁한다.');
  }
  const tasks = chatId === 0 ? tasksForContext(sessionId) : null;
  if (tasks) lines.push(tasks);
  const docs = listDocs(sessionId);
  if (docs.length) {
    lines.push('이 세션의 산출물 (계획서·화면설계서·테스트 결과서, 필요하면 Read로 읽는다):');
    lines.push(...docs.map((d) => `- ${d.name} "${d.title}" (${KIND_LABEL[d.kind]}, ${d.version}판): ${d.path}`));
  }
  if (accounts.length) {
    lines.push('화면 확인용 테스트 계정 (다른 세션과 같이 쓴다. 역할이 다르면 메모를 보고 골라 쓴다):');
    lines.push(...accounts.map((a) => `- ${a.login} / ${a.password}${a.note ? ` (${a.note})` : ''}`));
  }
  return `<tool_context>\n${lines.join('\n')}\n</tool_context>`;
}

const KIND_LABEL = { plan: '계획서', screen: '화면설계서', test: '테스트 결과서', other: '문서' } as const;

/** 계획 모드에서 따를 순서. 산출물을 HTML 문서로 남기고, 사용자가 확인한 뒤에만 실행한다. */
const PLAN_INSTRUCTIONS = [
  '1. 코드를 읽어 요청을 이해한다. 계획을 정하는 데 필요한데 코드로 알 수 없는 것은 AskUserQuestion으로 바로 묻고, 답을 계획에 반영한다. 사소한 것은 계획서의 "확인할 것"에 적는다.',
  '2. 계획서를 mcp__studio__save_doc(kind "plan", name "plan")으로 저장한다. 목표, 바꿀 파일과 이유, 단계, 데이터·API 변경, 영향 범위, 테스트 방법, 확인할 것을 담는다.',
  '   업무 흐름이 걸린 작업(여러 역할이 주고받는 절차, 신청·승인·정산 같은 단계, 상태가 바뀌는 데이터)이면 계획서에 비즈니스 플로우 그림을 넣는다. 단순한 버그 수정이나 화면 문구 변경처럼 흐름과 상관없으면 넣지 않는다.',
  '   그림은 문서 안에 직접 쓴 인라인 <svg>로 그린다(스크립트·Mermaid·외부 이미지는 문서 화면에서 보이지 않는다). 역할별 가로 레인, 단계 상자, 화살표, 분기 조건 글자를 넣고, 이번 작업으로 새로 생기거나 바뀌는 단계는 색으로 구분하고 범례를 단다.',
  '   데이터 상태가 바뀌면(예: 대기→승인→체결) 상태 전이 그림도 따로 그린다. 그림 아래에 단계별 설명(누가, 무엇을, 어떤 API·테이블)을 짧은 표로 붙인다. 글자는 한국어로, 겹치지 않게 viewBox를 넉넉히 잡는다.',
  '3. 화면이 새로 생기거나 바뀌면 화면마다 화면설계서를 mcp__studio__save_doc(kind "screen", name "screen-<영문 화면 이름>")으로 저장한다.',
  '   화면설계서는 실제 화면과 같은 배치의 와이어프레임(HTML/CSS로 그린 것)에 번호 표시를 달고, 옆이나 아래에 번호별 설명 표(항목, 동작, 검증 규칙, 데이터 출처)를 둔다.',
  '   바뀌는 화면이면 지금 화면과 달라지는 부분을 표시한다. 상태(빈 목록, 오류, 로딩, 권한별 차이)가 있으면 함께 그린다.',
  '4. 문서는 한국어로 쓰고, 외부 파일이나 스크립트 없이 CSS를 <style>에 넣은 완결된 HTML로 만든다. 계획서에서 화면설계서를 이름으로 언급한다.',
  '5. 계획의 실행 단계를 mcp__studio__set_tasks로 작업 목록에 올린다(모두 todo). 한 항목은 확인할 수 있는 한 가지 일로, 보통 3~10개. 사용자가 승인 뒤에도 이 목록으로 진행을 본다. 목록에 없는 준비 작업(확인, 조사)도 해야 하면 그것도 항목으로 넣는다.',
  '6. 다 저장했으면 ExitPlanMode로 계획 요약을 보낸다. 사용자가 문서를 보고 승인해야 실행한다. 고쳐 달라는 의견이 오면 문서를 같은 name으로 다시 저장하고 다시 ExitPlanMode를 부른다.',
].join('\n');

/**
 * 사용자가 보낸 프롬프트. 그 대화에서 Claude가 작업 중이거나 앞에 기다리는 프롬프트가 있으면 대기열 끝에 넣고,
 * 아니면 바로 실행한다. 이미지는 지금 파일로 저장해 둬서 대기열에는 이름만 남긴다. chatId 0은 메인 대화.
 */
export function submitPrompt(sessionId: number, text: string, images: IncomingImage[], opts: { plan?: boolean; chatId?: number } = {}): { queued: boolean; position: number } {
  const chatId = opts.chatId ?? 0;
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  if (chatId !== 0 && !session.chats.some((c) => c.id === chatId)) throw new Error('닫았거나 없는 대화입니다.');
  if (!text.trim() && images.length === 0) throw new Error('프롬프트를 입력하세요.');
  const stored = storeImages(images);
  if (running.has(rkey(sessionId, chatId)) || queueLength(sessionId, chatId) > 0) {
    return { queued: true, position: enqueuePrompt(sessionId, chatId, text, stored, Boolean(opts.plan)) };
  }
  runPrompt(sessionId, text, [], stored, { plan: opts.plan, chatId }).catch(() => { /* 오류는 대화에 event로 남는다 */ });
  return { queued: false, position: 0 };
}

/** 추가 대화를 열고 첫 프롬프트를 바로 실행한다. */
export function startChat(sessionId: number, text: string, images: IncomingImage[], opts: { plan?: boolean; title?: string } = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  if (!text.trim() && images.length === 0) throw new Error('프롬프트를 입력하세요.');
  const chat = createChat(sessionId, text, opts.title);
  submitPrompt(sessionId, text, images, { plan: opts.plan, chatId: chat.id });
  return { id: chat.id, title: chat.title };
}

/** 대화의 대기열에서 다음 프롬프트를 꺼내 실행한다. 작업 중이거나 멈춘 대기열이면 아무것도 안 한다. */
export function drainQueue(sessionId: number, chatId: number) {
  if (running.has(rkey(sessionId, chatId)) || isQueuePaused(sessionId, chatId)) return;
  const next = shiftQueue(sessionId, chatId);
  if (!next) return;
  runPrompt(sessionId, next.text, [], JSON.parse(next.images) as StoredImage[], { plan: Boolean(next.plan), chatId }).catch(() => {});
}

export function resumeQueue(sessionId: number, chatId: number) {
  setQueuePaused(sessionId, chatId, false);
  drainQueue(sessionId, chatId);
}

/** 프롬프트 중에 Claude가 환경값·테스트 계정을 요청하는 도구. 사용자가 승인할 때까지 기다린다. */
function studioTools(sessionId: number, chatId: number) {
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
        async (args) => text(await requestEnv(sessionId, chatId, args.project, args.vars, args.reason)),
      ),
      tool(
        'request_test_account',
        '특정 역할의 테스트 계정을 찾는다. 메모에 그 역할이 적힌 계정과 비밀번호를 돌려주고, 없으면 사용자에게 추가를 부탁하라고 알려 준다.',
        {
          role: z.string().describe('필요한 역할. 예: 사업자, 지자체(광역), 관리자'),
          reason: z.string().describe('필요한 이유 한 문장'),
        },
        async (args) => text(requestAccount(sessionId, args.role)),
      ),
      tool(
        'set_tasks',
        '작업 목록을 통째로 바꾼다. 계획을 세우면 단계를 올리고, 진행하면서 상태를 바꿔 다시 보낸다. 사용자 화면 위쪽에 항상 보인다.',
        {
          title: z.string().describe('목록 제목. 보통 계획 제목'),
          tasks: z.array(z.object({
            title: z.string().describe('한 가지 일. 예: "RegoSellOrderFacade.buyRequest에 수량 검증 추가"'),
            status: z.enum(['todo', 'doing', 'done', 'skipped']),
            note: z.string().optional().describe('진행 메모나 하지 않은 이유. 짧게'),
          })),
        },
        async (args) => {
          const l = setTasks(sessionId, args.title, args.tasks);
          const done = l.tasks.filter((t) => t.status === 'done').length;
          return text(`작업 목록을 바꿨습니다 (${done}/${l.tasks.length} 완료).`);
        },
        // 저장소를 건드리지 않으므로 계획 모드에서도 쓸 수 있다.
        { annotations: { readOnlyHint: true } },
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
            savedThisRun.get(rkey(sessionId, chatId))?.add(d.name);
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
export async function runPrompt(sessionId: number, text: string, images: IncomingImage[], preStored?: StoredImage[], opts: { plan?: boolean; chatId?: number } = {}): Promise<{ ok: boolean; stopped: boolean }> {
  const chatId = opts.chatId ?? 0;
  const key = rkey(sessionId, chatId);
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  const chat = chatId === 0 ? null : getChat(sessionId, chatId);
  if (chatId !== 0 && (!chat || chat.closed)) throw new Error('닫았거나 없는 대화입니다.');
  if (running.has(key)) throw new Error('이미 작업 중입니다. 끝나거나 중단한 뒤 보내세요.');
  if (!text.trim() && images.length === 0 && !preStored?.length) throw new Error('프롬프트를 입력하세요.');

  const primary = session.worktrees.find((w) => w.id === session.primary_worktree_id) ?? session.worktrees[0];
  if (!primary) throw new Error('세션에 워크트리가 없습니다.');
  const others = session.repos.filter((w) => w.path !== primary.path).map((w) => w.path);

  const stored = preStored ?? storeImages(images);
  appendMessage(sessionId, 'user', { text, images: stored, ...(opts.plan ? { plan: true } : {}) }, chatId);

  const content: SDKUserMessage['message']['content'] = [
    ...stored.map(attachmentBlock),
    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
  ];
  const ctx = runtimeContext(sessionId, chatId);
  if (ctx) content.push({ type: 'text', text: ctx });

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
  }

  const abort = new AbortController();
  running.set(key, abort);
  savedThisRun.set(key, new Set());
  setChat(sessionId, chatId, { status: 'running', unread: 0 });

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
    if (toolName === 'AskUserQuestion') {
      // 화면에 질문 카드를 띄우고 답을 받아 이어서 작업한다.
      const questions = Array.isArray(input.questions) ? (input.questions as Question[]) : [];
      if (questions.length === 0) return { behavior: 'deny', message: '질문이 비어 있습니다.' };
      const answers = await requestAnswers(sessionId, chatId, questions);
      if (!answers) return { behavior: 'deny', message: '사용자가 질문에 답하지 않았습니다. 추측해서 진행하지 말고, 지금까지 한 것과 정해야 할 것을 정리해 이번 작업을 마치세요.' };
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    if (toolName !== 'ExitPlanMode') return { behavior: 'deny', message: '이 도구는 승인 화면이 없어 쓸 수 없습니다. 필요하면 사용자에게 직접 실행을 부탁하세요.' };
    let plan = typeof input.plan === 'string' ? input.plan : '';
    if (!plan && typeof input.planFilePath === 'string') { try { plan = fs.readFileSync(input.planFilePath, 'utf8'); } catch { /* 요약 없이 문서만 보여 준다 */ } }
    // ExitPlanMode가 본문을 넘기지 않으면 Claude가 마지막으로 쓴 글을 요약으로 보여 준다.
    if (!plan) plan = lastText;
    const saved = savedThisRun.get(key);
    const docs = listDocs(sessionId).filter((d) => saved?.has(d.name)).map((d) => ({ name: d.name, title: d.title, kind: d.kind }));
    const d = await requestPlanApproval(sessionId, chatId, plan, docs);
    if (d.approve) {
      if (chatId === 0) startFirstTask(sessionId);
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
        resume: (chat ? chat.claude_session_id : session.claude_session_id) ?? undefined,
        permissionMode: opts.plan ? 'plan' : mode,
        // 추가 대화는 세션 작업 목록을 건드리지 않으므로 목록을 올리는 단계를 뺀다.
        ...(opts.plan ? { planModeInstructions: chatId === 0 ? PLAN_INSTRUCTIONS : PLAN_INSTRUCTIONS.split('\n').filter((l) => !l.includes('set_tasks')).join('\n') } : {}),
        canUseTool,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(session.repos, chatId !== 0) },
        abortController: abort,
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
        // Studio가 넘긴 MCP만 쓴다. 사용자 설정의 MCP·커넥터는 도구 목록이 바뀔 때마다 대화에 목록이 다시 들어간다.
        strictMcpConfig: true,
        mcpServers: {
          studio: studioTools(sessionId, chatId),
          // 화면 확인용 브라우저. 스크린샷은 워크트리가 아닌 세션 화면 폴더에 남겨 커밋에 섞이지 않게 한다(세션 정리 때 함께 지운다).
          browser: {
            type: 'stdio',
            command: process.execPath,
            args: [playwrightMcpCli(), '--headless', '--browser', 'chrome', '--isolated', '--ignore-https-errors', '--viewport-size', '1440,900', '--output-dir', path.join(SCREEN_DIR, String(sessionId), 'chat')],
          },
        },
        settings: { autoCompactWindow: AUTO_COMPACT_TOKENS, enabledPlugins: Object.fromEntries(DISABLED_PLUGINS.map((p) => [p, false])) },
        allowedTools: ['mcp__studio__request_env_values', 'mcp__studio__request_test_account', 'mcp__studio__save_doc', 'mcp__studio__set_tasks', 'mcp__browser'],
        // 추가 대화는 세션 작업 목록을 바꾸지 않는다.
        ...(chatId !== 0 ? { disallowedTools: ['mcp__studio__set_tasks'] } : {}),
      },
    });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        const prev = chat ? chat.claude_session_id : session.claude_session_id;
        if (msg.session_id && msg.session_id !== prev) setChat(sessionId, chatId, { claude_session_id: msg.session_id });
        continue;
      }
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) if (block.type === 'text') lastText = block.text;
        appendMessage(sessionId, 'sdk', msg, chatId);
      } else if (msg.type === 'user') {
        appendMessage(sessionId, 'sdk', msg, chatId);
      } else if (msg.type === 'result') {
        recordUsage(msg, { purpose: 'chat', sessionId, chatId, cwd: primary.path, resumed: Boolean(chat ? chat.claude_session_id : session.claude_session_id) });
        ok = msg.subtype === 'success' && !msg.is_error;
        appendMessage(sessionId, 'sdk', msg, chatId);
        if (msg.session_id) setChat(sessionId, chatId, { claude_session_id: msg.session_id });
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      appendMessage(sessionId, 'event', { kind: 'stopped' }, chatId);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      appendMessage(sessionId, 'event', { kind: 'error', message }, chatId);
      lastText = message;
    }
  } finally {
    running.delete(key);
    savedThisRun.delete(key);
    cancelApprovals(sessionId, { chatId });
    const stopped = abort.signal.aborted;
    setChat(sessionId, chatId, { status: 'idle', unread: 1 });
    // 중단했거나 오류로 끝났으면 다음 프롬프트를 바로 보내지 않고 대기열을 멈춘다. 사용자가 보고 이어서 실행한다.
    const waiting = queueLength(sessionId, chatId);
    if (waiting > 0 && (stopped || !ok)) setQueuePaused(sessionId, chatId, true);
    if (!stopped && (waiting === 0 || !ok)) {
      notifyRunFinished({ sessionId, ticket: chat ? `${session.ticket} · ${chat.title}` : session.ticket, ok, durationMs: Date.now() - started, summary: lastText });
    }
    setImmediate(() => drainQueue(sessionId, chatId));
    // eslint-disable-next-line no-unsafe-finally
    return { ok: ok && !stopped, stopped };
  }
}

export function stopPrompt(sessionId: number, chatId = 0) {
  const ctl = running.get(rkey(sessionId, chatId));
  if (!ctl) return false;
  ctl.abort();
  return true;
}
