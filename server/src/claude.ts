import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionMode, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { cancelApprovals, requestAccount, requestAnswers, requestDbWrite, requestEnv, requestPlanApproval, requestSession, type Question } from './approvals.js';
import { type DbConnection, sessionDbs } from './dbconn.js';
import { MAX_ROWS, describeConnection, engineSupported, explainQuery, formatExplain, formatResult, isReadOnly, runQuery } from './dbquery.js';
import { WARNING_LABEL, getQuery, listQueries } from './querylog.js';
import { docsDir, listDocs, saveDoc } from './docs.js';
import { setTasks, startFirstTask, tasksForContext } from './tasks.js';
import { CLAUDE_EXECUTABLE, UPLOAD_DIR } from './config.js';
import { type RepoView, appendMessage, createChat, enqueuePrompt, getChat, getSession, isQueuePaused, queueLength, setChat, setQueuePaused, shiftQueue } from './sessions.js';
import { getSettings } from './settings.js';
import { chatModel } from './models.js';
import { notifyRunFinished } from './notify.js';
import { serverPorts } from './runner.js';
import { accountsOf } from './accounts.js';
import { recordUsage } from './usage.js';
import { playwrightMcpCli } from './tests.js';
import { SCREEN_DIR } from './screens.js';
import { DICT_RULE, checkFilterShape, checkSession, createDictRequest, dictContextLines, erdTableText, exportReport, formatCheck, formatLookup, schemaCheckText, searchDictionary } from './dicttools.js';
import { requestLabel } from './dictrequests.js';
import { refreshSessionDictionary } from './dictscan.js';
import { ISSUES } from './dict/extract.js';
import { erdConfigured } from './erdvibe.js';
import { domainHint, type ErdPayload, type TermPayload } from './dictrequests.js';

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

/**
 * 하네스 지시문은 영어로 쓰고(토큰이 적고 지시가 정확하다), 사람에게 보이는 모든 출력은 한국어로 하게 한다.
 * 시스템 프롬프트 맨 앞에 둔다.
 */
const LANGUAGE_RULE = [
  'LANGUAGE: These instructions are written in English, but you must ALWAYS answer the user in Korean.',
  'Everything a person reads must be Korean: chat replies, AskUserQuestion questions and options, documents saved with save_doc, task titles and notes, request reasons, plan summaries for ExitPlanMode, and final summaries.',
  'Keep code, identifiers, file paths, commands, SQL, and log excerpts as they are. Code comments follow the existing style of the file you edit.',
].join('\n');

/** DB 대화에서 따를 것. 코드는 고치지 않고 이 연결에만 질의한다. */
function dbChatLines(c: DbConnection) {
  return [
    `This is a DB chat. Query only DB connection #${c.id} ${c.name} (${describeConnection(c)}) with mcp__studio__db_query. If another connection is needed, ask the user to open another DB chat.`,
    'Do not modify code or files. If you do not know the tables or columns, query the DB metadata first (information_schema, ALL_TAB_COLUMNS, etc.). If the meaning is unclear, read the worktree entities, mappers, and migration files with Read/Grep.',
    'Select only the columns you need and limit the row count (LIMIT, FETCH FIRST, TOP). When answering, summarize the result and show the SQL you ran.',
    'Send data-changing statements one at a time. They run only after the user reviews and approves the SQL. Before sending one, count the affected rows with a SELECT and show the count.',
  ];
}

function buildSystemAppend(repos: RepoView[], side: boolean, db: DbConnection | null) {
  // 저장소 하나에 앱이 여럿이면(모노레포) 앱 폴더도 알려 준다.
  const lines = repos.map((w) => `- ${w.project_name}: ${w.path} (branch ${w.branch}, ${w.in_place ? 'this is the original clone folder shared with other work; ask the user before any git command that switches or resets branches' : `branched from ${w.base_branch}`})${w.apps.length > 1
    ? `. Apps in this repository: ${w.apps.map((a) => `${a.project_kind.toUpperCase()} ${a.subdir ? `${a.subdir}/` : 'root'}`).join(', ')}`
    : ''}`);
  if (db) {
    return [
      LANGUAGE_RULE,
      ...dbChatLines(db),
      'Worktrees of this session (read only):',
      ...lines,
      'When something needs the user to decide, do not guess; ask with AskUserQuestion.',
    ].join('\n');
  }
  const sideLines = side ? [
    'This is a side chat of the session. Claude in the main chat may be working on something else in the same worktree at the same time.',
    'Change only what was asked, narrowly, and do not touch unrelated files. Re-read a file right before editing it so you edit the latest content. Do not use commands that change the whole worktree, such as git stash, checkout, or reset.',
    'The main chat manages the session task list, so do not change it from this chat.',
  ] : [];
  return [
    LANGUAGE_RULE,
    ...sideLines,
    'This session works only in the git worktrees below. Do not modify the original clone folder or other worktrees.',
    ...lines,
    'The user runs commit, push, and PR creation separately in the tool, so do not do them unless asked.',
    'The tool starts and manages the dev servers. Do not start or stop them yourself; use the addresses in <tool_context> of each message.',
    'Run commands with long output (build, test, logs) with `| tail -n 80` or quiet options (-q, etc.). Command output is re-read in every later call. On failure, look again only at the part you need.',
    'Check screens with the mcp__browser tools.',
    'The tool manages environment values. If a value is missing or wrong, do not create or edit .env files; request it with mcp__studio__request_env_values.',
    'If you need a test account for another role, request it with mcp__studio__request_test_account. Both requests take effect only after the user confirms them on screen.',
    'If work unrelated to this ticket comes up (another feature, a fix in another repository\'s tool, etc.), do not do it in this session; propose a new session and Jira issue with mcp__studio__request_session. The user edits and creates it on screen.',
    'To check data in the dev DB, query a DB connection from <tool_context> with mcp__studio__db_query. Reads run immediately; data-changing statements run only after the user reviews and approves the SQL. Do not use DB clients directly through Bash.',
    'For slow screens or queries, use mcp__studio__server_queries to see query stats counted from the BE server log (calls, rows, warnings such as N+1), and mcp__studio__db_explain to see execution plans and indexes. When fixing, cite the evidence (stats, plan, mapper location) and propose code changes such as mapper XML. Send index DDL through mcp__studio__db_query for user approval.',
    ...(erdConfigured() ? [DICT_RULE] : []),
    'If something comes up that the user must decide (unclear requirements, several possible approaches, whether data may be changed, etc.), do not guess; ask right away with AskUserQuestion, then continue with the answer.',
    'Save documents for people (plan, screen spec, DB change spec) with mcp__studio__save_doc (plan and DB change spec in Markdown, screen spec in HTML). Do not create document files in the repository.',
    'Saved documents are listed in <tool_context> of each message. When the user mentions a document, Read the file at that path and follow it.',
    'When development is done and the user asks for a completion report, follow these steps.',
    REPORT_INSTRUCTIONS,
    'If <tool_context> has a task list, work through it in order. Before starting an item, set it to doing; as soon as it is finished, set it to done, by calling mcp__studio__set_tasks (send the whole list). Keep only the one item you are working on as doing. For items you decide not to do, set skipped and put the reason in note.',
    'The task list is always visible on the user screen. If you take on work that was not in the plan, add an item. For large work with several steps, create a list even outside plan mode.',
  ].join('\n');
}

/** 시스템 프롬프트는 세션 처음에 고정되므로, 바뀌는 정보(서버 주소, 계정)는 매 메시지에 붙인다. */
function runtimeContext(sessionId: number, chatId: number, dbs: (DbConnection & { project_name: string })[]): string | null {
  const ports = serverPorts(sessionId);
  const accounts = accountsOf(sessionId);
  const lines: string[] = [];
  if (ports.length) {
    lines.push('Running dev servers:', ...ports.map((p) => `- ${p.project_name}: ${p.url} (${p.status})`));
    lines.push('For servers without hot reload (e.g. Spring), ask the user to restart the server after changing code.');
  } else {
    lines.push('No dev server is running now. If you need to check a screen, ask the user to start the servers.');
  }
  const tasks = chatId === 0 ? tasksForContext(sessionId) : null;
  if (tasks) lines.push(tasks);
  const docs = listDocs(sessionId);
  if (docs.length) {
    lines.push('Documents of this session (plan, screen spec, DB change spec, test report, completion report; Read them when needed):');
    lines.push(...docs.map((d) => `- ${d.name} "${d.title}" (${KIND_LABEL[d.kind]}, v${d.version}): ${d.path}`));
  }
  if (dbs.length) {
    lines.push('DB connections you can query (connection_id for mcp__studio__db_query; "enabled" is the connection used when running servers):');
    lines.push(...dbs.map((c) => `- #${c.id} ${c.name}: ${describeConnection(c)} · ${c.project_name}${c.enabled ? ' · enabled' : ''}${engineSupported(c) ? '' : ' · queries not supported'}`));
  }
  lines.push(...dictContextLines(sessionId));
  if (accounts.length) {
    lines.push('Test accounts for checking screens (shared with other sessions; pick by the note when roles differ):');
    lines.push(...accounts.map((a) => `- ${a.login} / ${a.password}${a.note ? ` (${a.note})` : ''}`));
  }
  return `<tool_context>\n${lines.join('\n')}\n</tool_context>`;
}

const KIND_LABEL = { plan: 'plan', screen: 'screen spec', db: 'DB change spec', test: 'test report', report: 'completion report', other: 'document' } as const;

/** 개발을 마친 뒤 완료 보고서를 쓰는 순서. 계획·작업 목록·실제 변경·검증 결과를 맞대어 사실만 적는다. */
const REPORT_INSTRUCTIONS = [
  '1. Read the documents in <tool_context> (plan, screen spec, DB change spec, test report) and the task list. If a document does not exist, say so.',
  '2. For each repository, check what actually changed against the branch it was branched from: git diff --stat <base branch>...HEAD, git status --short. Read only the files you need.',
  '3. The report contains:',
  '   - Summary: two or three sentences on what was done, why, and the result.',
  '   - Plan vs. result: a table with each plan step and task item marked done / not done / changed from plan; when changed, add the reason and the evidence file. At the top, write items reflected / total.',
  '   - Changes: changed files and reasons per repository. Group data, API, config, and environment value changes separately.',
  '   - Screens: if screens changed, how they differ from the screen spec.',
  '   - DB: if the DB changed, how it differs from the DB change spec, the dictionary check result (violation count re-checked with dict_check), and word/term/ERD requests not yet approved.',
  '   - Verification: builds, tests, and screen checks actually run and their results, plus a summary of the test report. State clearly what you did not run or could not check.',
  '   - Remaining work and known issues, places reviewers must look at, and cautions for deploying or running (migrations, new environment values, etc.).',
  '4. Write only facts you checked. Never say a test passed if you did not run it, and label guesses as guesses.',
  '5. Do not modify code while writing the report. If you find something to fix, list it under remaining work.',
  '6. Save with mcp__studio__save_doc(kind "report", name "report"). Title: "<ticket> 완료 보고서". If asked again, save a new version with the same name.',
  '   Write the document in Korean as complete HTML with CSS in <style>. Refer to other documents by name.',
  '7. After saving, leave only a three-line summary of the result and the remaining work in the chat.',
].join('\n');

/** 계획 모드에서 따를 순서. 산출물을 문서로 남기고(계획서·DB 변경 설계서는 Markdown, 화면설계서는 HTML), 사용자가 확인한 뒤에만 실행한다. */
const PLAN_INSTRUCTIONS = [
  '1. Read the code to understand the request. If something needed to decide the plan cannot be learned from the code, ask right away with AskUserQuestion and reflect the answer in the plan. Put minor questions under "확인할 것" in the plan.',
  '2. Save the plan with mcp__studio__save_doc(kind "plan", name "plan", markdown). Include the goal, files to change and why, steps, data/API changes, impact, how to test, and open questions.',
  '   If the work involves a business flow (procedures passed between several roles, steps such as apply/approve/settle, data whose state changes), add a business flow diagram to the plan. Skip it for work unrelated to flow, such as simple bug fixes or wording changes.',
  '   Draw diagrams as inline <svg> written directly in the Markdown body (with a blank line before and after; scripts, Mermaid, and external images do not render in the document view). Use horizontal lanes per role, step boxes, arrows, and branch-condition labels; color the steps added or changed by this work and add a legend.',
  '   If data state changes (e.g. 대기→승인→체결), draw a separate state transition diagram. Under each diagram add a short table describing each step (who, what, which API/table). Use Korean labels and a generous viewBox so text does not overlap.',
  '3. For each new or changed screen, save a screen spec with mcp__studio__save_doc(kind "screen", name "screen-<english screen name>", html).',
  '   A screen spec is a wireframe (drawn with HTML/CSS) laid out like the real screen, with numbered markers, and next to or below it a table explaining each number (item, behavior, validation rule, data source).',
  '   For a changed screen, mark what differs from the current screen. If there are states (empty list, error, loading, differences by permission), draw them too.',
  '4. If tables, columns, indexes, constraints, or common codes are added, changed, or removed, or existing data must be moved or fixed, save a DB change spec separately from the plan with mcp__studio__save_doc(kind "db", name "db", markdown). In the plan, write only the changed tables and a summary, and refer to the document by name. Do not create it when only queries change.',
  '   Contents: a change table per table (change type add/change/remove, logical name, column physical name, type/length, NULL, default, description), indexes and constraints, a DDL or Liquibase changeset draft (never edit an applied changeset; add a new one), data migration/backfill SQL, how to roll back, and affected mappers/entities/APIs/screens.',
  '   Dictionary check: for every table/column name you add or change, show in a table how it was matched against the erd-vibe dictionary (logical name, name to use, verdict: 표준 / 표준으로 고침(원래 이름) / 등록 요청함, domain). Include only results you actually checked with mcp__studio__dict_lookup. Request registration of unregistered words/terms per the rules, request ERD changes with mcp__studio__erd_request_change, and list both kinds of requests under the table marked "사용자 승인 필요". In the summary at the top of the document write "용어사전 확인: 컬럼 N개 중 표준 N, 고침 N, 등록 요청 N". If the dictionary is not connected, write "용어사전 미연결로 확인하지 못함".',
  '5. Write documents in Korean. The plan and DB change spec are Markdown (# for the title, ## for sections, GFM tables); the screen spec is complete HTML with CSS in <style> and no external files or scripts. Refer to the screen specs and the DB change spec by name in the plan.',
  '6. Put the execution steps of the plan into the task list with mcp__studio__set_tasks (all todo). Each item is one checkable piece of work, usually 3 to 10 items. The user follows progress with this list after approval. If preparation work not in the list is needed (checks, investigation), add it as items too.',
  '7. When everything is saved, send a plan summary with ExitPlanMode. Execution starts only after the user reviews the documents and approves. If feedback asks for changes, save the documents again with the same name and call ExitPlanMode again.',
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
export function startChat(sessionId: number, text: string, images: IncomingImage[], opts: { plan?: boolean; title?: string; db?: number } = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error('세션이 없습니다.');
  if (session.closed) throw new Error('닫힌 세션입니다.');
  if (!text.trim() && images.length === 0) throw new Error('프롬프트를 입력하세요.');
  let title = opts.title;
  if (opts.db !== undefined) {
    const c = sessionDbs(session).find((x) => x.id === opts.db);
    if (!c) throw new Error('이 세션의 프로젝트에 없는 DB 연결입니다.');
    if (!engineSupported(c)) throw new Error(`${c.engine}은(는) 아직 질의를 지원하지 않습니다.`);
    title ??= `DB · ${c.name}`;
  }
  const chat = createChat(sessionId, text, title, opts.db);
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
function studioTools(sessionId: number, chatId: number, opts: { plan: boolean; dbs: DbConnection[]; dbOnly: number | null }) {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  const fail = (t: string) => ({ ...text(t), isError: true });
  return createSdkMcpServer({
    name: 'studio',
    version: '1.0.0',
    tools: [
      tool(
        'request_env_values',
        'Ask the user to add or change environment values needed to run the dev servers. After the user reviews, edits, and approves them, they go into the environment values managed by the tool. If you do not know a value, leave value empty and the user fills it in.',
        {
          project: z.string().describe('Project name of the worktree'),
          vars: z.array(z.object({
            key: z.string(),
            value: z.string().optional().describe('Suggested value. Omit if unknown'),
            reason: z.string().describe('One sentence on why this value is needed (in Korean)'),
          })).min(1),
          reason: z.string().describe('One sentence on why the whole request is needed (in Korean)'),
        },
        async (args) => text(await requestEnv(sessionId, chatId, args.project, args.vars, args.reason)),
      ),
      tool(
        'request_session',
        'Propose to the user that side work unrelated to this session be split into a new session. A new-session dialog opens in the same workspace, prefilled with the draft; '
          + 'the user creates a new Jira issue or picks an existing one and creates the session. Waits until then and returns the new session number.',
        {
          jira_key: z.string().optional().describe('Key of an existing Jira issue to start from (e.g. ABC-123). Omit to create a new issue'),
          summary: z.string().describe('New Jira issue title and session summary, one line (in Korean)'),
          description: z.string().describe('New Jira issue description: background, what to do, done criteria (in Korean)'),
          first_prompt: z.string().optional().describe('Draft of the first prompt to send to Claude in the new session (in Korean)'),
          reason: z.string().describe('One sentence on why this is split off instead of done here (in Korean)'),
        },
        async (args) => text(await requestSession(sessionId, chatId, args, args.reason)),
      ),
      tool(
        'request_test_account',
        'Find a test account for a specific role. Returns accounts whose note mentions that role, with passwords; if none, tells you to ask the user to add one.',
        {
          role: z.string().describe('Role needed, as written in account notes. e.g. 사업자, 지자체(광역), 관리자'),
          reason: z.string().describe('One sentence on why it is needed (in Korean)'),
        },
        async (args) => text(requestAccount(sessionId, args.role)),
      ),
      tool(
        'set_tasks',
        'Replace the whole task list. Post the steps when you make a plan, then send it again with updated statuses as you progress. Always visible at the top of the user screen.',
        {
          title: z.string().describe('List title in Korean, usually the plan title'),
          tasks: z.array(z.object({
            title: z.string().describe('One piece of work, in Korean. e.g. "RegoSellOrderFacade.buyRequest에 수량 검증 추가"'),
            status: z.enum(['todo', 'doing', 'done', 'skipped']),
            note: z.string().optional().describe('Short progress note or reason for skipping, in Korean'),
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
        'Save a document such as a plan, screen spec, DB change spec, or completion report. The user sees it on screen right away, and it is referenced again in later prompts. '
          + 'Send the plan and DB change spec as markdown (the tool renders the HTML view) and the screen spec as complete html. Completion reports and other documents may use either. '
          + 'Saving with the same name creates a new version and keeps the old ones. Nothing is written to the repository. Document content must be in Korean.',
        {
          name: z.string().describe('Lowercase letters, digits, hyphens. Plan: "plan", screen spec: "screen-<screen>" (e.g. screen-member-list), DB change spec: "db", completion report: "report"'),
          title: z.string().describe('Human-readable title in Korean. e.g. "회원 목록 화면설계서"'),
          kind: z.enum(['plan', 'screen', 'db', 'report', 'other']).describe('plan: plan, screen: screen spec, db: DB change spec, report: completion report, other: any other document'),
          markdown: z.string().optional().describe('Markdown body (GFM tables allowed). Put diagrams as inline <svg> with a blank line before and after. Use this for the plan and DB change spec.'),
          html: z.string().optional().describe('Complete HTML starting with <html>. Put CSS in <style>; no external files, scripts, or image links. Use this for screen specs.'),
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
      tool(
        'db_query',
        `Run one SQL statement on the dev DB. Reads such as SELECT, SHOW, EXPLAIN run immediately in a rolled-back transaction and return up to ${MAX_ROWS} rows as a tab-separated table. `
          + 'Statements that change data or schema run only after the user reviews and approves the SQL; the call waits until then. Send one statement at a time.',
        {
          connection_id: z.number().int().describe('DB connection number from <tool_context> (the number after #)'),
          sql: z.string().min(1).describe('One SQL statement. A trailing semicolon is optional'),
          reason: z.string().describe('One sentence, in Korean, on what this statement checks or changes'),
        },
        async (args) => {
          if (opts.dbOnly !== null && args.connection_id !== opts.dbOnly) return fail(`이 대화는 DB 연결 #${opts.dbOnly} 전용입니다.`);
          const c = opts.dbs.find((x) => x.id === args.connection_id);
          if (!c) return fail(`DB 연결 #${args.connection_id}이 없습니다. <tool_context>의 연결 번호를 쓰세요.`);
          if (!engineSupported(c)) return fail(`${c.engine}은(는) 아직 질의를 지원하지 않습니다.`);
          if (!isReadOnly(args.sql)) {
            if (opts.plan) return fail('계획 모드에서는 데이터를 바꾸지 않습니다. 필요한 변경은 계획서에 적으세요.');
            return text(await requestDbWrite(sessionId, chatId, c, args.sql, args.reason));
          }
          try {
            return text(formatResult(await runQuery(c, args.sql, { readOnly: true })));
          } catch (err) {
            return fail(`질의 오류: ${(err as Error).message}`);
          }
        },
        // 읽기는 롤백하고 쓰기는 따로 승인을 받으므로 계획 모드에서도 쓸 수 있다.
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'server_queries',
        'View per-shape query stats counted from the BE server logs of this session: shape (SQL with values replaced by ?), mapper id, calls, average/max rows, time (when logged), warnings (suspected N+1, large result, slow, etc.). '
          + 'With key, also returns an example SQL for that query (filled with values captured from the log) and its parameters.',
        {
          project: z.string().optional().describe('Worktree project name. Omit for all BE projects'),
          sort: z.enum(['calls', 'rows', 'time', 'recent']).optional().describe('Sort order. Default calls'),
          warnings_only: z.boolean().optional().describe('Only queries with warnings'),
          limit: z.number().int().min(1).max(100).optional().describe('Max count. Default 30'),
          key: z.string().optional().describe('The key of one query to see its details'),
        },
        async (args) => {
          const session = getSession(sessionId);
          const wts = (session?.worktrees ?? []).filter((w) => w.project_kind !== 'fe' && (!args.project || w.project_name === args.project));
          if (!wts.length) return fail(args.project ? `${args.project} 워크트리가 없습니다.` : '이 세션에 BE 워크트리가 없습니다.');
          const warn = (ws: string[]) => (ws.length ? ws.map((w) => WARNING_LABEL[w as keyof typeof WARNING_LABEL]).join(', ') : '-');
          if (args.key) {
            for (const w of wts) {
              const d = getQuery(w.id, args.key);
              if (!d) continue;
              return text([
                `${w.project_name} · ${d.mapper ?? '매퍼 모름'} · 호출 ${d.calls} · 행 평균 ${d.rows_avg ?? '-'} 최대 ${d.rows_max ?? '-'} · 시간 평균 ${d.ms_avg ?? '-'}ms 최대 ${d.ms_max ?? '-'}ms · 경고 ${warn(d.warnings)}`,
                ...(d.location ? [`매퍼: ${d.location.full_id} (${d.location.file}:${d.location.line})`, ...d.location.callers.slice(0, 5).map((c) => `부르는 곳: ${c.file}:${c.line}`)] : []),
                `모양: ${d.shape}`,
                d.example ? `예시 SQL: ${d.example.filled}` : '예시 SQL 없음(도구를 다시 켠 뒤 아직 안 찍힘)',
                ...(d.example?.params.length ? [`파라미터: ${d.example.params.map((p) => (p.value === null ? 'null' : `${p.value}${p.type ? `(${p.type})` : ''}`)).join(', ')}`] : []),
              ].join('\n'));
            }
            return fail(`key ${args.key} 쿼리가 없습니다.`);
          }
          const out: string[] = [];
          for (const w of wts) {
            const rows = listQueries(w.id, { sort: args.sort, warningsOnly: args.warnings_only }).slice(0, args.limit ?? 30);
            out.push(`${w.project_name} (${rows.length}개${rows.length ? '' : ', 서버 로그에 SQL이 없거나 초기화됨'})`);
            out.push(...rows.map((r) => `- key ${r.key} · ${r.mapper ?? '-'} · 호출 ${r.calls} · 행 ${r.rows_avg ?? '-'}/${r.rows_max ?? '-'} · ${r.ms_max !== null ? `${r.ms_avg}/${r.ms_max}ms` : '시간 없음'} · 경고 ${warn(r.warnings)}\n  ${r.shape.length > 300 ? `${r.shape.slice(0, 300)}…` : r.shape}`));
          }
          return text(out.join('\n'));
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'db_explain',
        'Show the execution plan of one SELECT statement on a DB connection, plus indexes and row counts of the related tables. Runs in one transaction and rolls back, leaving nothing in the DB (Oracle writes PLAN_TABLE, then rolls back).',
        {
          connection_id: z.number().int().describe('DB connection number from <tool_context>'),
          sql: z.string().min(1).describe('One SELECT statement. Fill parameter placeholders with values'),
        },
        async (args) => {
          if (opts.dbOnly !== null && args.connection_id !== opts.dbOnly) return fail(`이 대화는 DB 연결 #${opts.dbOnly} 전용입니다.`);
          const c = opts.dbs.find((x) => x.id === args.connection_id);
          if (!c) return fail(`DB 연결 #${args.connection_id}이 없습니다. <tool_context>의 연결 번호를 쓰세요.`);
          try {
            return text(formatExplain(await explainQuery(c, args.sql)));
          } catch (err) {
            return fail(`실행 계획 오류: ${(err as Error).message}`);
          }
        },
        // 계획만 보고 롤백하므로 계획 모드에서도 쓸 수 있다.
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'dict_lookup',
        'Search the erd-vibe dictionary (words, terms, domains). Accepts a logical name (거래일자), physical name (TR_DT, TRADE_DATE), camelCase (trDt), or a word (거래). Given an identifier, it also judges whether it is standard and, if not, what the standard name is.',
        { query: z.string().describe('Text to search. Empty returns the start of the full list'), refresh: z.boolean().optional().describe('Reload the dictionary from erd-vibe before searching (when something just registered or edited is not visible)') },
        async (args) => {
          try {
            if (args.refresh) await refreshSessionDictionary(getSession(sessionId)!);
            return text(formatLookup(await searchDictionary(getSession(sessionId)!, args.query)));
          } catch (err) {
            return fail(`용어사전 조회 오류: ${(err as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'dict_check',
        'Check column names in worktree sources (MyBatis mappers, SQL/DDL, Liquibase, JPA @Column) against the dictionary and ERD, and find violations (non-standard spelling, unregistered term/word, domain mismatch, missing from ERD, mixed spellings of one term) per (table, column). '
          + 'changed looks only at files changed from the base branch. If a baseline exists, only keys not in the baseline block. For long results, page with section/offset/limit; use export to get everything as a JSON file.',
        {
          scope: z.enum(['changed', 'all']).default('changed'),
          ...checkFilterShape,
          section: z.enum(['all', 'findings', 'held', 'groups', 'mixed', 'erd']).optional().describe('all: summary + first part (default), findings: source violations, held: on hold/allowed, groups: grouped by cause, mixed: mixed spellings, erd: ERD column violations'),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(500).optional().describe('Lines per page (max 500)'),
          detail: z.boolean().optional().describe('All locations per violation (for domain mismatch: table.column, type, file:line where the wrong type is written)'),
          export: z.boolean().optional().describe('Write the full result as JSON to the session archive and return the path'),
          refresh: z.boolean().optional().describe('Reload the erd-vibe dictionary and ERD before checking'),
        },
        async (args) => {
          try {
            const { scope, section, offset, limit, detail, export: exp, ...opts } = args;
            const r = await checkSession(sessionId, scope, opts);
            const out = formatCheck(r, { section, offset, limit, detail });
            return text(exp ? `${out}\n전체 결과 JSON: ${exportReport(sessionId, 'dict-check', r)}` : out);
          } catch (err) {
            return fail(`용어 검사 오류: ${(err as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'schema_check',
        'Compare the final schema (Liquibase changelogs applied in order) with the tables and columns used by mapper XML and JPA entities. Finds missing columns and uses of renamed/dropped old names (new lines in this change block the PR). changed checks only changed files.',
        {
          scope: z.enum(['changed', 'all']).default('changed'),
          tables: checkFilterShape.tables, exclude_paths: checkFilterShape.exclude_paths,
          offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(),
          detail: z.boolean().optional().describe('All locations per mismatch'), export: z.boolean().optional().describe('Write everything to a JSON file'),
        },
        async (args) => {
          try {
            const { scope, tables, exclude_paths, ...v } = args;
            return text(await schemaCheckText(sessionId, scope, { tables, exclude_paths }, v));
          } catch (err) {
            return fail(`스키마 검사 오류: ${(err as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'dict_request_term',
        'Request registration of a term (or word) missing from the erd-vibe dictionary. It enters the shared team dictionary only after the user approves it on screen. Returns immediately without waiting, so continue development with the requested standard name. If a word is missing from the dictionary, request the word first with kind "word". '
          + 'Rules: a term logical name joins its words, the physical name joins the words\' English names with underscores, the abbreviated name joins the words\' abbreviations with underscores, and the domain must exist in the domain dictionary. A word\'s English name is uppercase with underscores; its abbreviation is uppercase letters/digits and must not collide with another word. Violations are returned with a reason.',
        {
          kind: z.enum(['term', 'word']),
          logical_name: z.string().describe('term: logical name (거래취소일자). word: the word (취소)'),
          physical_name: z.string().describe('term: full English physical name (TRADE_CANCEL_DATE). word: English name (CANCEL)'),
          abbr_name: z.string().optional().describe('term: abbreviated name (TR_CNCL_DT, the standard name). word: abbreviation (CNCL)'),
          domain_name: z.string().optional().describe('term: domain name from the domain dictionary'),
          description: z.string().describe('Definition in one or two sentences, in Korean'),
          reason: z.string().describe('Where this term is needed and why, in Korean'),
        },
        async (args) => {
          if (opts.dbOnly !== null) return fail('DB 대화에서는 등록 요청을 하지 않습니다.');
          try {
            const r = await createDictRequest(sessionId, args.kind === 'term'
              ? { kind: 'term', payload: { logical_name: args.logical_name, physical_name: args.physical_name, physical_abbr_name: args.abbr_name ?? null, domain_name: args.domain_name ?? null, description: args.description } }
              : { kind: 'word', payload: { name: args.logical_name, english_name: args.physical_name, abbreviation: args.abbr_name ?? null, definition: args.description } }, args.reason, 'claude');
            const hint = r.kind === 'term' ? await domainHint(r.payload as TermPayload).catch(() => null) : null;
            return text(`등록 요청 #${r.id}을 올렸습니다. 사용자가 용어 검사 화면에서 승인하면 erd-vibe 사전에 들어갑니다. 요청한 이름으로 개발을 이어 가고, 마칠 때 올린 요청을 알려 주세요.${hint ? `\n${hint}` : ''}`);
          } catch (err) {
            return fail((err as Error).message);
          }
        },
        // 저장소를 바꾸지 않고, 등록은 사용자가 승인해야 하므로 계획 모드에서도 쓸 수 있다.
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'erd_request_change',
        'Ask the user to add or change tables/columns in the linked erd-vibe ERD. Applied only after the user edits and approves it in the ERD/dictionary screen. Returns immediately without waiting. '
          + 'Use the standard name checked with dict_lookup as the column physical name; putting the term standard name in term also fills the term link. Use the term domain type as the type.',
        {
          action: z.enum(['add_table', 'add_column', 'update_column', 'drop_column']),
          table: z.string().min(1).describe('Table physical name'),
          table_logical_name: z.string().optional().describe('add_table: table logical name'),
          column: z.string().optional().describe('update_column/drop_column: physical name of the column to change'),
          columns: z.array(z.object({
            physical_name: z.string(), logical_name: z.string(), data_type: z.string(),
            is_primary_key: z.boolean().optional(), is_nullable: z.boolean().optional(), term: z.string().optional().describe('Term standard name'),
          })).optional().describe('add_table: all columns. add_column: one column. update_column: one entry with only the values to change'),
          reason: z.string().describe('Where this change is needed and why, in Korean'),
        },
        async (args) => {
          if (opts.dbOnly !== null) return fail('DB 대화에서는 ERD 변경 요청을 하지 않습니다.');
          const cols = args.columns ?? [];
          let payload: ErdPayload;
          if (args.action === 'add_table') payload = { action: 'add_table', table: { physical_name: args.table, logical_name: args.table_logical_name ?? '', columns: cols } };
          else if (args.action === 'add_column') {
            if (!cols[0]) return fail('add_column은 columns에 컬럼 하나를 넣는다.');
            payload = { action: 'add_column', table: args.table, column: cols[0] };
          } else if (!args.column) return fail('바꿀 컬럼(column)을 넣는다.');
          else payload = args.action === 'drop_column' ? { action: 'drop_column', table: args.table, column: args.column } : { action: 'update_column', table: args.table, column: args.column, patch: cols[0] ?? {} };
          try {
            const r = await createDictRequest(sessionId, { kind: 'erd', payload }, args.reason, 'claude');
            return text(`ERD 변경 요청 #${r.id}을 올렸습니다. 사용자가 승인하면 erd-vibe ERD에 반영됩니다. 승인 전에는 ERD가 바뀌지 않았습니다.`);
          } catch (err) {
            return fail((err as Error).message);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'erd_table',
        'View a table definition (columns, types, PK, NULL, linked terms) from the erd-vibe ERD linked to this session workspace. Physical or logical name, or part of it, is fine.',
        { name: z.string().min(1), refresh: z.boolean().optional().describe('Reload the ERD from erd-vibe') },
        async (args) => {
          try {
            if (args.refresh) await refreshSessionDictionary(getSession(sessionId)!);
            return text(await erdTableText(sessionId, args.name));
          } catch (err) {
            return fail((err as Error).message);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'dict_reload',
        'Reload the term/word/domain dictionaries and the linked ERD from erd-vibe. Use when edits just made in the erd-vibe screen or elsewhere are not visible in checks or searches (normally reloaded every minute).',
        {},
        async () => {
          try {
            const r = await refreshSessionDictionary(getSession(sessionId)!);
            return text(`사전을 다시 받았습니다: 단어 ${r.words} · 용어 ${r.terms} · 도메인 ${r.domains}${r.erd_tables !== null ? ` · ERD 테이블 ${r.erd_tables}` : ''}`);
          } catch (err) {
            return fail(`사전 다시 받기 오류: ${(err as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'dict_request_exception',
        'Ask the user to make this dictionary-check violation an exception. Applied only after the user approves. mode "ignore" removes it from checks entirely. mode "hold" puts the baseline item on hold: still counted as remaining work but excluded from violation/blocking counts (requires a baseline). '
          + 'Leaving table/issue empty applies to every use of that column name. Do not use this to hide violations that can be fixed.',
        {
          mode: z.enum(['ignore', 'hold']),
          name: z.string().min(1).describe('Column name'),
          table: z.string().optional().describe('Table physical name. Empty for all tables'),
          issue: z.enum(ISSUES).optional().describe('Violation kind. Empty for all'),
          note: z.string().min(1).describe('Reason for the exception, in Korean (shown on screen and in check results)'),
          reason: z.string().optional().describe('Request description, in Korean'),
        },
        async (args) => {
          if (opts.dbOnly !== null) return fail('DB 대화에서는 예외 요청을 하지 않습니다.');
          try {
            const r = await createDictRequest(sessionId, { kind: 'exception', payload: { mode: args.mode, name: args.name, table: args.table ?? '', issue: args.issue ?? '', note: args.note } }, args.reason ?? args.note, 'claude');
            return text(`예외 요청 #${r.id}을 올렸습니다. 사용자가 용어 검사 화면의 요청 탭에서 승인하면 반영됩니다. 승인 전에는 검사 결과가 그대로입니다.`);
          } catch (err) {
            return fail((err as Error).message);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'dict_request_baseline',
        'Ask the user to save the current full worktree check result as the baseline. On approval, a full check runs and is added to the baseline; after that only (table, column, violation kind) not in the baseline block the PR. Status and notes of existing items stay as they are.',
        { reason: z.string().describe('Why to save the baseline, in Korean') },
        async (args) => {
          if (opts.dbOnly !== null) return fail('DB 대화에서는 기준선 요청을 하지 않습니다.');
          try {
            const r = await createDictRequest(sessionId, { kind: 'baseline', payload: { scope: 'all' } }, args.reason, 'claude');
            return text(`기준선 저장 요청 #${r.id}을 올렸습니다. 사용자가 승인하면 그 시점의 전체 검사 결과가 기준선이 됩니다.`);
          } catch (err) {
            return fail((err as Error).message);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'dict_request_edit',
        'Ask the user to add or edit a term/word/domain in the erd-vibe dictionary (never call the REST API directly). It enters the shared team dictionary only after the user reviews before/after and approves. '
          + 'For update, put the target in target (term: standard/physical/logical name; word: word or abbreviation; domain: name; or an id) and only the fields to change in values. New terms/words may also be requested with dict_request_term.',
        {
          entity: z.enum(['term', 'word', 'domain']),
          action: z.enum(['create', 'update']),
          target: z.string().optional().describe('update: the item to edit'),
          values: z.record(z.string(), z.string().nullable()).describe('term: logical_name, physical_name, physical_abbr_name, domain_name, description · word: name, english_name, abbreviation, definition · domain: name, data_type_default, data_type_oracle, data_type_mysql, data_type_postgresql, description'),
          reason: z.string().describe('Reason and impact of the change (e.g. columns using this term), in Korean'),
        },
        async (args) => {
          if (opts.dbOnly !== null) return fail('DB 대화에서는 사전 수정 요청을 하지 않습니다.');
          if (args.action === 'update' && !args.target) return fail('update는 target에 고칠 항목을 넣는다.');
          try {
            const r = await createDictRequest(sessionId, { kind: 'dict_edit', payload: { entity: args.entity, action: args.action, id: null, target: args.target ?? '', before: null, values: args.values } }, args.reason, 'claude');
            return text(`사전 ${args.action === 'create' ? '추가' : '수정'} 요청 #${r.id}을 올렸습니다(${requestLabel(r)}). 사용자가 승인하기 전에는 사전이 바뀌지 않았습니다.`);
          } catch (err) {
            return fail((err as Error).message);
          }
        },
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
  const dbs = sessionDbs(session);
  // DB 대화면 그 연결만 보여 준다. 연결을 지웠으면 일반 대화처럼 돈다.
  const dbOnly = chat?.db_connection_id ? dbs.find((c) => c.id === chat.db_connection_id) ?? null : null;
  if (chat?.db_connection_id && !dbOnly) appendMessage(sessionId, 'event', { kind: 'error', message: '이 대화의 DB 연결을 지웠거나 찾지 못했습니다. 설정의 로컬 실행에서 연결을 확인하세요.' }, chatId);
  const ctx = runtimeContext(sessionId, chatId, dbOnly ? [dbOnly] : dbs);
  if (ctx) content.push({ type: 'text', text: ctx });
  // /compact 같은 슬래시 명령은 글 하나로만 보내야 명령으로 실행된다. 실행 정보를 덧붙이면 일반 메시지로 넘어간다.
  const slash = stored.length === 0 && /^\/[a-z][\w:-]*(\s|$)/i.test(text.trim());

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: slash ? text.trim() : content }, parent_tool_use_id: null };
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
      if (questions.length === 0) return { behavior: 'deny', message: 'The question list is empty.' };
      const answers = await requestAnswers(sessionId, chatId, questions);
      if (!answers) return { behavior: 'deny', message: 'The user did not answer the question. Do not proceed on guesses; summarize (in Korean) what you have done and what still needs deciding, and end this run.' };
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    if (toolName !== 'ExitPlanMode') return { behavior: 'deny', message: 'This tool cannot be used because there is no approval screen for it. If needed, ask the user (in Korean) to run it themselves.' };
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
        ? `The user asked for changes to the plan. Apply the feedback, save the documents again with the same name, and call ExitPlanMode again.\n\nUser feedback:\n${d.feedback}`
        : 'The user did not approve the plan. Do not execute it; ask the user (in Korean) what should change.',
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
        model: chatModel(),
        permissionMode: opts.plan ? 'plan' : mode,
        // 추가 대화는 세션 작업 목록을 건드리지 않으므로 목록을 올리는 단계를 뺀다.
        ...(opts.plan ? { planModeInstructions: chatId === 0 ? PLAN_INSTRUCTIONS : PLAN_INSTRUCTIONS.split('\n').filter((l) => !l.includes('set_tasks')).join('\n') } : {}),
        canUseTool,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(session.repos, chatId !== 0, dbOnly) },
        abortController: abort,
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
        // Studio가 넘긴 MCP만 쓴다. 사용자 설정의 MCP·커넥터는 도구 목록이 바뀔 때마다 대화에 목록이 다시 들어간다.
        strictMcpConfig: true,
        mcpServers: {
          studio: studioTools(sessionId, chatId, { plan: Boolean(opts.plan), dbs, dbOnly: dbOnly?.id ?? null }),
          // 화면 확인용 브라우저. 스크린샷은 워크트리가 아닌 세션 화면 폴더에 남겨 커밋에 섞이지 않게 한다(세션 정리 때 함께 지운다).
          // DB 대화는 화면을 보지 않으므로 띄우지 않는다.
          ...(dbOnly ? {} : {
            browser: {
              type: 'stdio' as const,
              command: process.execPath,
              args: [playwrightMcpCli(), '--headless', '--browser', 'chrome', '--isolated', '--ignore-https-errors', '--viewport-size', '1440,900', '--output-dir', path.join(SCREEN_DIR, String(sessionId), 'chat')],
            },
          }),
        },
        settings: { autoCompactWindow: AUTO_COMPACT_TOKENS, enabledPlugins: Object.fromEntries(DISABLED_PLUGINS.map((p) => [p, false])) },
        allowedTools: ['mcp__studio__request_env_values', 'mcp__studio__request_session', 'mcp__studio__request_test_account', 'mcp__studio__save_doc', 'mcp__studio__set_tasks', 'mcp__studio__db_query', 'mcp__studio__server_queries', 'mcp__studio__db_explain', 'mcp__studio__dict_lookup', 'mcp__studio__dict_check', 'mcp__studio__schema_check', 'mcp__studio__dict_request_term', 'mcp__studio__erd_table', 'mcp__studio__erd_request_change', 'mcp__studio__dict_reload', 'mcp__studio__dict_request_exception', 'mcp__studio__dict_request_baseline', 'mcp__studio__dict_request_edit', 'mcp__browser'],
        // 추가 대화는 세션 작업 목록을 바꾸지 않는다. DB 대화는 코드와 파일도 고치지 않는다.
        ...(dbOnly ? { disallowedTools: ['mcp__studio__set_tasks', 'mcp__studio__dict_request_term', 'mcp__studio__erd_request_change', 'mcp__studio__dict_request_exception', 'mcp__studio__dict_request_baseline', 'mcp__studio__dict_request_edit', 'Edit', 'Write', 'NotebookEdit', 'Bash'] }
          : chatId !== 0 ? { disallowedTools: ['mcp__studio__set_tasks'] } : {}),
      },
    });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        const prev = chat ? chat.claude_session_id : session.claude_session_id;
        if (msg.session_id && msg.session_id !== prev) setChat(sessionId, chatId, { claude_session_id: msg.session_id });
        continue;
      }
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        const m = msg.compact_metadata;
        appendMessage(sessionId, 'event', { kind: 'compacted', trigger: m.trigger, pre_tokens: m.pre_tokens, post_tokens: m.post_tokens ?? null }, chatId);
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
