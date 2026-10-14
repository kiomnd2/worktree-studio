import { broadcast } from './hub.js';
import { getSession } from './sessions.js';
import { profileVars, resolveEnv, saveSessionEnv, selectedProfile, type EnvVar } from './envstore.js';
import { accountOf, assignAccount, freeAccountsFor } from './accounts.js';
import { looksSecret } from './secret.js';
import { sendNotification } from './notify.js';

/**
 * 프롬프트를 실행하던 Claude가 환경값이나 테스트 계정이 더 필요하다고 요청한 것.
 * 사용자가 화면에서 값을 고치거나 계정을 골라 승인해야 적용되고, Claude는 그때까지 기다린다.
 */
export type EnvRequest = {
  kind: 'env';
  project_id: number;
  project_name: string;
  profile_name: string;
  vars: { key: string; value: string; reason: string; secret: boolean; current: string | null }[];
};
export type AccountRequest = { kind: 'account'; role: string };
/** 계획 모드에서 Claude가 계획을 마치고 실행해도 되는지 묻는 것. docs는 이번 계획에서 저장한 산출물 이름 */
export type PlanRequest = { kind: 'plan'; plan: string; docs: { name: string; title: string; kind: string }[] };
/** 작업 중 Claude가 정해야 할 것을 묻는 것(AskUserQuestion). 답을 받을 때까지 기다린다. */
export type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };
export type QuestionRequest = { kind: 'question'; questions: Question[] };

export type Approval = {
  id: number;
  session_id: number;
  reason: string;
  request: EnvRequest | AccountRequest | PlanRequest | QuestionRequest;
  created_at: number;
};

export type Decision =
  | { approve: false; feedback?: string }
  | { approve: true; answers?: Record<string, string>; vars?: { key: string; value: string }[]; target?: 'session' | 'profile'; account_id?: number };

const pending = new Map<number, { approval: Approval; resolve: (text: string) => void }>();
/** 승인했을 때 실제로 적용하고 Claude에게 돌려줄 문장을 만드는 함수 */
const decisionHandlers = new Map<number, (d: Decision) => string>();
let nextId = 1;

function changed(sessionId: number) {
  broadcast({ type: 'approvals.updated', sessionId });
}

export function listApprovals(sessionId: number): Approval[] {
  return [...pending.values()].map((p) => p.approval).filter((a) => a.session_id === sessionId);
}

function ask(sessionId: number, reason: string, request: Approval['request'], apply: (d: Decision) => string): Promise<string> {
  const approval: Approval = { id: nextId++, session_id: sessionId, reason, request, created_at: Date.now() };
  return new Promise((resolve) => {
    decisionHandlers.set(approval.id, apply);
    pending.set(approval.id, {
      approval,
      resolve: (text) => { pending.delete(approval.id); changed(sessionId); resolve(text); },
    });
    changed(sessionId);
    const s = getSession(sessionId);
    const body = request.kind === 'plan'
      ? '계획을 마쳤습니다. 산출물을 보고 실행할지 정해 주세요.'
      : request.kind === 'question'
      ? `Claude가 묻습니다: ${request.questions[0]?.question ?? ''}`
      : `Claude가 ${request.kind === 'env' ? `${request.project_name} 환경값 ${request.vars.map((v) => v.key).join(', ')}` : `테스트 계정 (${request.role})`}을(를) 요청했습니다.`;
    sendNotification(`${s?.ticket ?? ''} 확인이 필요합니다`, body, sessionId);
  });
}

/** 사용자의 승인·거절. 적용 결과를 Claude에게 도구 결과로 돌려준다. */
export function decide(approvalId: number, d: Decision) {
  const p = pending.get(approvalId);
  const apply = decisionHandlers.get(approvalId);
  if (!p || !apply) throw new Error('이미 처리했거나 사라진 요청입니다.');
  const text = apply(d);
  decisionHandlers.delete(approvalId);
  p.resolve(text);
}

/** 프롬프트가 끝나거나 중단되면 남은 요청은 거절로 끝낸다. */
export function cancelApprovals(sessionId: number) {
  for (const p of [...pending.values()]) {
    if (p.approval.session_id !== sessionId) continue;
    decisionHandlers.delete(p.approval.id);
    p.resolve('작업이 끝나 요청이 취소됐습니다.');
  }
}

export function requestEnv(sessionId: number, projectName: string, vars: { key: string; value?: string; reason: string }[], reason: string): Promise<string> {
  const session = getSession(sessionId);
  if (!session) return Promise.resolve('세션이 없습니다.');
  const wt = session.worktrees.find((w) => w.project_name === projectName) ?? (session.worktrees.length === 1 ? session.worktrees[0] : undefined);
  if (!wt) return Promise.resolve(`프로젝트 ${projectName}를 찾지 못했습니다. 다음 중 하나로 다시 요청하세요: ${session.worktrees.map((w) => w.project_name).join(', ')}`);
  const clean = vars.map((v) => ({ ...v, key: v.key.trim() })).filter((v) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v.key));
  if (clean.length === 0) return Promise.resolve('요청한 키 이름이 올바르지 않습니다.');
  const { env } = resolveEnv(sessionId, wt.project_id);
  const request: EnvRequest = {
    kind: 'env',
    project_id: wt.project_id,
    project_name: wt.project_name,
    profile_name: selectedProfile(sessionId, wt.project_id).name,
    vars: clean.map((v) => ({ key: v.key, value: v.value ?? '', reason: v.reason, secret: looksSecret(v.key), current: env[v.key] ?? null })),
  };
  return ask(sessionId, reason, request, (d) => {
    if (!d.approve) return '사용자가 환경값 요청을 거절했습니다. 값 없이 진행하거나 사용자에게 이유를 물어보세요.';
    const values = new Map((d.vars ?? []).map((v) => [v.key, v.value]));
    const chosen = request.vars.filter((v) => values.has(v.key));
    if (chosen.length === 0) return '사용자가 아무 값도 승인하지 않았습니다.';
    const target = d.target ?? 'session';
    if (target === 'profile') {
      const merged = new Map<string, EnvVar>(profileVars(selectedProfile(sessionId, wt.project_id).id).map((v) => [v.key, v]));
      for (const v of chosen) {
        const prev = merged.get(v.key);
        merged.set(v.key, { key: v.key, value: values.get(v.key)!, required: prev?.required ?? false, secret: prev?.secret ?? v.secret, source: 'manual', found_in: prev?.found_in ?? null });
      }
      saveSessionEnv(sessionId, wt.project_id, 'profile', [...merged.values()]);
    } else {
      // 이번 세션에만: 지금 값 위에 승인한 값만 얹는다.
      const cur = resolveEnv(sessionId, wt.project_id).env;
      const vars: EnvVar[] = Object.entries({ ...cur, ...Object.fromEntries(chosen.map((v) => [v.key, values.get(v.key)!])) })
        .map(([key, value]) => ({ key, value, required: false, secret: looksSecret(key), source: 'manual', found_in: null }));
      saveSessionEnv(sessionId, wt.project_id, 'session', vars);
    }
    const where = target === 'profile' ? `프로필 ${request.profile_name}` : '이번 세션';
    return `사용자가 승인해 ${wt.project_name}의 ${where} 환경값에 ${chosen.map((v) => v.key).join(', ')}를 넣었습니다. `
      + '실행 중인 서버에는 아직 반영되지 않았으니, 확인이 필요하면 사용자에게 서버 재시작을 부탁하세요. 값은 .env 파일로 만들지 마세요.';
  });
}

export function requestAccount(sessionId: number, role: string, reason: string): Promise<string> {
  const s = getSession(sessionId);
  if (!s || freeAccountsFor(s.workspace_id).length === 0) {
    return Promise.resolve('이 워크스페이스에 남은 테스트 계정이 없습니다. 사용자에게 설정의 테스트 계정 풀에 이 워크스페이스 계정을 추가해 달라고 하세요.');
  }
  return ask(sessionId, reason, { kind: 'account', role }, (d) => {
    if (!d.approve || !d.account_id) return '사용자가 테스트 계정 요청을 거절했습니다.';
    assignAccount(sessionId, d.account_id);
    const acc = accountOf(sessionId, d.account_id);
    if (!acc) return '계정을 배정하지 못했습니다.';
    return `사용자가 승인해 테스트 계정을 배정했습니다: ${acc.login} / ${acc.password}${acc.note ? ` (${acc.note})` : ''}. 이 세션 전용입니다.`;
  });
}

/**
 * 계획 승인. 승인하면 true(이어서 실행), 고쳐 달라고 하면 그 내용을 돌려준다.
 * 프롬프트가 끝나거나 중단돼 취소되면 거절로 본다.
 */
export function requestPlanApproval(sessionId: number, plan: string, docs: PlanRequest['docs']): Promise<{ approve: true } | { approve: false; feedback: string }> {
  let result: { approve: true } | { approve: false; feedback: string } = { approve: false, feedback: '' };
  return ask(sessionId, '', { kind: 'plan', plan, docs }, (d) => {
    result = d.approve ? { approve: true } : { approve: false, feedback: d.feedback?.trim() ?? '' };
    return '';
  }).then(() => result);
}

/** Claude의 질문에 대한 사용자 답. 질문 문장을 키로 한 답(여러 개 고르면 쉼표로 이음). 답하지 않으면 null. */
export function requestAnswers(sessionId: number, questions: Question[]): Promise<Record<string, string> | null> {
  let result: Record<string, string> | null = null;
  return ask(sessionId, '', { kind: 'question', questions }, (d) => {
    result = d.approve && d.answers ? d.answers : null;
    return '';
  }).then(() => result);
}
