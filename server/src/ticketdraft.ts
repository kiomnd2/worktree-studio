import fs from 'node:fs';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EXECUTABLE } from './config.js';
import { getProject, getWorkspace } from './projects.js';
import { issueTypes, recentTicketExamples } from './jira.js';

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
    `Jira ${ws.jira_project} 프로젝트에 만들 티켓의 제목과 설명을 제안해줘. 사용자가 하려는 일은 아래와 같다.`,
    '',
    input.prompt.trim(),
    '',
    '할 일:',
    '- 이 워크스페이스 코드(읽기만)에서 관련 화면·API·테이블을 찾아 무엇을 바꿔야 하는지 구체적으로 파악한다. 찾은 화면 이름·경로·메뉴명은 설명에 쓴다.',
    '- 제목: 한 줄, 무엇을 하는지 바로 알 수 있게. 사용자가 말한 뜻을 바꾸거나 범위를 넓히지 않는다.',
    `- issue_type: 다음 중 하나. ${types.map((t) => t.name).join(', ')}. 버그 수정이면 버그, 새 기능이면 작업이나 기능.`,
    '- description: Markdown. 예시 티켓이 있으면 그 섹션 구성과 문체를 따른다. 없으면 "## 배경", "## 작업 내용", "## 완료 조건"으로 쓴다.',
    '- 예시 티켓은 섹션 구성·문체·길이만 참고한다. 예시에 있는 요청자·담당자 같은 사람 정보나 인사말은 쓰지 않는다.',
    '- 코드에서 확인하지 못한 것은 단정하지 말고 "확인 필요"로 적는다. 구현 방법을 너무 자세히 정하지 않는다(티켓은 무엇을, 왜가 중심).',
    '- 모두 한국어로.',
    '',
    examples.length
      ? `## ${examples[0].mine ? '내가' : '팀이'} 이 프로젝트에 쓴 최근 티켓 (형식 예시, 내용은 베끼지 말 것. 길이도 이 정도로 맞출 것)\n${examples.map((e) => `### ${e.key} [${e.type}] ${e.summary}\n${e.description}`).join('\n\n')}`
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
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    },
  });
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === 'result') {
      if (msg.subtype !== 'success' || msg.is_error) throw new Error('티켓 내용을 쓰지 못했습니다. 다시 시도하세요.');
      structured = msg.structured_output ?? JSON.parse(msg.result);
    }
  }
  const d = structured as { title: string; issue_type: string; description: string };
  const type = types.find((t) => t.name === d.issue_type) ?? types.find((t) => t.name === '작업') ?? types[0];
  return { title: d.title.trim(), issuetype_id: type?.id ?? '', description: d.description.trim(), examples: examples.map((e) => e.key), examples_mine: examples[0]?.mine ?? false };
}
