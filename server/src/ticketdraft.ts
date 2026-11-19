import fs from 'node:fs';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { getProject, getWorkspace } from './projects.js';
import { issueTypes, recentTicketExamples } from './jira.js';
import { recordUsage } from './usage.js';
import { helperModel } from './models.js';

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    issue_type: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['title', 'issue_type', 'description'],
};

/**
 * 짧은 제목만 보고 새 Jira 티켓의 제목·유형·설명을 쓴다. 워크스페이스 코드는 읽기만 하고,
 * 내가 이 프로젝트에 쓴 최근 티켓을 형식 예시로 따른다. 사용자가 확인하고 고친 뒤 만든다.
 */
export async function draftTicket(workspaceId: number, input: { prompt: string }) {
  const ws = getWorkspace(workspaceId);
  if (!ws?.jira_project) throw new Error('이 워크스페이스에 Jira 프로젝트 키가 없습니다.');
  if (!input.prompt.trim()) throw new Error('무엇을 하려는지 적어 주세요.');
  const dirs = ws.projects.map((p) => getProject(p.id)?.local_path).filter((d): d is string => Boolean(d && fs.existsSync(d)));
  const [types, examples] = await Promise.all([issueTypes(ws.jira_project), recentTicketExamples(ws.jira_project)]);
  const prompt = [
    `Propose a title and description for a ticket to create in the Jira ${ws.jira_project} project. What the user wants to do is below.`,
    '',
    input.prompt.trim(),
    '',
    'Steps:',
    '- In this workspace\'s code (read only), find the related screens, APIs, and tables, and work out concretely what needs to change. Use the screen names, paths, and menu names you find in the description.',
    '- Title: one line that makes it immediately clear what is being done. Do not change what the user meant or widen the scope.',
    `- issue_type: one of the following. ${types.map((t) => t.name).join(', ')}. For a bug fix use 버그; for a new feature use 작업 or 기능.`,
    '- description: Markdown. If there are example tickets, follow their section structure and writing style. If not, write it with "## 배경", "## 작업 내용", "## 완료 조건".',
    '- Use the example tickets only as a reference for section structure, style, and length. Do not include people information from the examples (requester, assignee, etc.) or greetings.',
    '- Do not state as fact anything you could not confirm in the code; write "확인 필요" for it instead. Do not specify the implementation in too much detail (a ticket is about what and why).',
    '- Write every value meant for people (title, description) in Korean.',
    '',
    examples.length
      ? `## Recent tickets ${examples[0].mine ? 'I' : 'the team'} wrote in this project (format examples; do not copy their content; match roughly this length)\n${examples.map((e) => `### ${e.key} [${e.type}] ${e.summary}\n${e.description}`).join('\n\n')}`
      : '',
  ].filter(Boolean).join('\n');

  let structured: unknown = null;
  const q = query({
    prompt,
    options: {
      cwd: dirs[0] ?? process.cwd(),
      additionalDirectories: dirs.slice(1),
      tools: dirs.length ? ['Read', 'Grep', 'Glob'] : [],
      allowedTools: ['Read', 'Grep', 'Glob'],
      // 사용자 플러그인·훅을 불러오지 않는다. 훅이 저장소에 상태 파일을 만들면 커밋에 섞인다.
      settingSources: [],
      permissionMode: 'dontAsk',
      maxTurns: 25,
      persistSession: false,
      model: helperModel('ticket_draft'),
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    },
  });
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === 'result') {
      recordUsage(msg, { purpose: 'ticket_draft', cwd: dirs[0] ?? null });
      if (msg.subtype !== 'success' || msg.is_error) throw new Error('티켓 내용을 쓰지 못했습니다. 다시 시도하세요.');
      structured = msg.structured_output ?? JSON.parse(msg.result);
    }
  }
  const d = structured as { title: string; issue_type: string; description: string };
  const type = types.find((t) => t.name === d.issue_type) ?? types.find((t) => t.name === '작업') ?? types[0];
  return { title: d.title.trim(), issuetype_id: type?.id ?? '', description: d.description.trim(), examples: examples.map((e) => e.key), examples_mine: examples[0]?.mine ?? false };
}
