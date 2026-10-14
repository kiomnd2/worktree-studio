import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { HOST, PORT, UPLOAD_DIR } from './config.js';
import { addClient } from './hub.js';
import {
  addProject, createWorkspace, deleteProject, deleteWorkspace, describeProject,
  getProject, getWorkspace, listProjectRows, listWorkspaces, updateProject, updateWorkspace,
} from './projects.js';
import { listBranches } from './git.js';
import { closeSession, createSession, getSession, listMessages, listSessions, removeQueued, setSession } from './sessions.js';
import { resumeQueue, runPrompt, stopPrompt, submitPrompt } from './claude.js';
import { decide, listApprovals } from './approvals.js';
import { deleteDoc, docHtml, listArchive, listDocs, revealArchive } from './docs.js';
import { fileDiff, sessionChanges } from './changes.js';
import { draftTicket } from './ticketdraft.js';
import { chooseSite, createIssue, getIssue, issueTypes, jiraConfigView, requiredFields, jiraLogout, jiraStatus, oauthCallback, oauthStart, searchIssues } from './jira.js';
import { confirmRoleAccount, deleteCase, generateCases, runTests, saveCase, stopTests, testShotPath, testState } from './tests.js';
import { getSettings, saveSettings, type Settings } from './settings.js';
import { sendNotification } from './notify.js';
import { cleanupOrphans, clearFailure, getLogs, listServers, startServers, stopAll, stopServers } from './runner.js';
import { sessionEnvState } from './envapi.js';
import { deleteProfile, saveSessionEnv, selectProfile, type EnvVar } from './envstore.js';
import { analyzeEnvWithAI, parseDotenv, scanEnv } from './envscan.js';
import {
  accountPassword, addAccount, assignAccount, deleteAccount, freeAccountCount, listAccounts, releaseAccount, releaseAccountById, updateAccount,
} from './accounts.js';
import { githubStatus } from './github.js';
import { getProject as projectById } from './projects.js';
import { assertNewWork, closePr, continueIgnoringChecks, getPrJob, listPrs, preparePr, startPr } from './pr.js';
import { addScreen, capturePreview, detectScreens, removeScreen, screenState, setScreenChecked } from './screens.js';
import { cleanSession, listCleanup, refreshPrStates, refreshSessionPrsSoon, scheduleCleanupPoll, startupSweep } from './cleanup.js';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 40 * 1024 * 1024 });
await app.register(cors, { origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] });
await app.register(websocket);

app.setErrorHandler((err: Error & { statusCode?: number; details?: Record<string, unknown> }, _req, reply) => {
  const status = err instanceof z.ZodError ? 400 : err.statusCode && err.statusCode < 500 ? err.statusCode : 400;
  reply.status(status).send({ error: err instanceof z.ZodError ? '입력값을 확인하세요.' : err.message, ...(err.details ?? {}) });
});


const idParam = z.object({ id: z.coerce.number().int().positive() });

// 프로젝트 (로컬 클론 폴더 기준)
app.get('/api/projects', async () => Promise.all(listProjectRows().map(describeProject)));
app.post('/api/projects', async (req) => {
  const { path: p } = z.object({ path: z.string().min(1) }).parse(req.body);
  return describeProject(await addProject(p));
});
app.patch('/api/projects/:id', async (req) => {
  const { id } = idParam.parse(req.params);
  const patch = z.object({
    name: z.string().min(1).optional(),
    kind: z.enum(['be', 'fe', 'full', 'unknown']).optional(),
    start_cmd: z.string().nullable().optional(),
    check_cmd: z.string().nullable().optional(),
    health_path: z.string().nullable().optional(),
    port_env: z.string().nullable().optional(),
    api_env_key: z.string().nullable().optional(),
    login_path: z.string().nullable().optional(),
    setup_cmd: z.string().nullable().optional(),
    commit_template: z.string().nullable().optional(),
  }).parse(req.body);
  return describeProject(updateProject(id, patch));
});
app.delete('/api/projects/:id', async (req) => {
  deleteProject(idParam.parse(req.params).id);
  return { ok: true };
});
app.get('/api/projects/:id/branches', async (req) => {
  const p = getProject(idParam.parse(req.params).id);
  if (!p) throw new Error('프로젝트가 없습니다.');
  return listBranches(p.local_path);
});

// 워크스페이스
app.get('/api/workspaces', async () => listWorkspaces());
app.post('/api/workspaces', async (req) => {
  const body = z.object({ name: z.string(), projectIds: z.array(z.number().int()) }).parse(req.body);
  return { id: createWorkspace(body.name, body.projectIds) };
});
app.patch('/api/workspaces/:id', async (req) => {
  const b = z.object({ jira_project: z.string().nullable().optional() }).parse(req.body);
  updateWorkspace(idParam.parse(req.params).id, b);
  return { ok: true };
});

// Jira: 워크스페이스의 Jira 프로젝트에서 티켓을 고르거나 새로 만든다.
app.get('/api/jira/config', async () => jiraConfigView());
app.post('/api/jira/oauth/start', async (req) => ({ url: await oauthStart(z.object({ origin: z.string() }).parse(req.body).origin) }));
// Atlassian 로그인 뒤 돌아오는 곳. 처리한 뒤 로그인을 시작한 화면(설정)으로 돌려보낸다.
app.get('/api/jira/oauth/callback', async (req, reply) => {
  const q = z.object({ code: z.string().optional(), state: z.string().default(''), error: z.string().optional(), error_description: z.string().optional() }).parse(req.query);
  try {
    if (q.error || !q.code) throw new Error(q.error_description ?? q.error ?? '로그인이 취소됐습니다.');
    const origin = await oauthCallback(q.code, q.state);
    return reply.redirect(`${origin}/?view=settings&jira=connected`);
  } catch (err) {
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><meta charset="utf-8"><title>Jira 로그인 실패</title><body style="font-family:sans-serif;padding:40px"><h1>Jira 로그인에 실패했습니다</h1><p>${String((err as Error).message).replace(/</g, '&lt;')}</p><p>이 창을 닫고 Worktree Studio 설정에서 다시 시도하세요.</p></body>`;
  }
});
app.post('/api/jira/site', async (req) => {
  chooseSite(z.object({ cloud_id: z.string() }).parse(req.body).cloud_id);
  return jiraStatus();
});
app.post('/api/jira/logout', async () => {
  jiraLogout();
  return { ok: true };
});
app.get('/api/jira/status', async () => jiraStatus());
const jiraProjectOf = (workspaceId: number) => {
  const key = getWorkspace(workspaceId)?.jira_project;
  if (!key) throw new Error('이 워크스페이스에 Jira 프로젝트 키가 없습니다. 설정의 워크스페이스에서 넣어 주세요.');
  return key;
};
app.get('/api/jira/issues', async (req) => {
  const q = z.object({ workspace: z.coerce.number().int(), q: z.string().default('') }).parse(req.query);
  return searchIssues(jiraProjectOf(q.workspace), q.q);
});
app.get('/api/jira/issues/:key', async (req) => getIssue(z.object({ key: z.string() }).parse(req.params).key));
app.get('/api/jira/issuetypes', async (req) => issueTypes(jiraProjectOf(z.object({ workspace: z.coerce.number().int() }).parse(req.query).workspace)));
app.post('/api/jira/draft', async (req) => {
  const b = z.object({ workspace: z.number().int(), prompt: z.string() }).parse(req.body);
  return draftTicket(b.workspace, b);
});
app.get('/api/jira/fields', async (req) => {
  const q = z.object({ workspace: z.coerce.number().int(), issuetype: z.string().min(1) }).parse(req.query);
  return requiredFields(jiraProjectOf(q.workspace), q.issuetype);
});
app.post('/api/jira/issues', async (req) => {
  const b = z.object({ workspace: z.number().int(), summary: z.string(), description: z.string().default(''), issuetype_id: z.string(), fields: z.record(z.string(), z.string()).default({}) }).parse(req.body);
  return createIssue(jiraProjectOf(b.workspace), b);
});

app.delete('/api/workspaces/:id', async (req) => {
  deleteWorkspace(idParam.parse(req.params).id);
  return { ok: true };
});

// 세션
app.get('/api/sessions', async () => listSessions());
app.post('/api/sessions', async (req) => {
  const body = z.object({
    workspaceId: z.number().int(),
    ticket: z.string(),
    summary: z.string().default(''),
    branches: z.array(z.object({ projectId: z.number().int(), base: z.string().min(1), branch: z.string().min(1) })),
    firstPrompt: z.string().optional(),
  }).parse(req.body);
  const created = await createSession(body);
  assignAccount(created.id);
  const session = getSession(created.id)!;
  if (body.firstPrompt?.trim()) submitPrompt(session.id, body.firstPrompt, []);
  return session;
});
app.get('/api/sessions/:id', async (req) => {
  const s = getSession(idParam.parse(req.params).id);
  if (!s) throw Object.assign(new Error('세션이 없습니다.'), { statusCode: 404 });
  return s;
});
app.get('/api/sessions/:id/messages', async (req) => listMessages(idParam.parse(req.params).id));
app.post('/api/sessions/:id/prompt', async (req) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({
    text: z.string().default(''),
    images: z.array(z.object({ mediaType: z.string(), data: z.string(), name: z.string().optional() })).max(10).default([]),
    plan: z.boolean().default(false),
  }).parse(req.body);
  // 실행은 백그라운드로 두고, 진행 상황은 WebSocket으로 보낸다. 작업 중이면 대기열에 넣는다.
  return submitPrompt(id, body.text, body.images, { plan: body.plan });
});
app.delete('/api/sessions/:id/queue/:qid', async (req) => {
  const { id, qid } = z.object({ id: z.coerce.number().int(), qid: z.coerce.number().int() }).parse(req.params);
  removeQueued(id, qid);
  return { ok: true };
});
app.post('/api/sessions/:id/queue/resume', async (req) => {
  resumeQueue(idParam.parse(req.params).id);
  return { ok: true };
});
app.post('/api/sessions/:id/stop', async (req) => ({ stopped: stopPrompt(idParam.parse(req.params).id) }));
app.post('/api/sessions/:id/read', async (req) => {
  setSession(idParam.parse(req.params).id, { unread: 0 });
  return { ok: true };
});
app.post('/api/sessions/:id/close', async (req) => {
  const { id } = idParam.parse(req.params);
  const { removeWorktrees } = z.object({ removeWorktrees: z.boolean().default(false) }).parse(req.body ?? {});
  await stopServers(id);
  await closeSession(id, removeWorktrees);
  releaseAccount(id);
  return { ok: true };
});

// 환경값 (프로필별)
const envVarSchema = z.object({
  key: z.string(), value: z.string().default(''), required: z.boolean().default(false), secret: z.boolean().default(false),
  source: z.enum(['detected', 'ai', 'clone', 'profile', 'manual']).default('manual'), found_in: z.string().nullable().default(null),
});
app.get('/api/sessions/:id/env', async (req) => sessionEnvState(idParam.parse(req.params).id));
app.put('/api/sessions/:id/env', async (req) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({
    projectId: z.number().int(),
    mode: z.enum(['profile', 'new', 'session']),
    newName: z.string().optional(),
    vars: z.array(envVarSchema),
  }).parse(req.body);
  saveSessionEnv(id, body.projectId, body.mode, body.vars as EnvVar[], body.newName);
  return sessionEnvState(id);
});
app.post('/api/sessions/:id/env/select', async (req) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ projectId: z.number().int(), profileId: z.number().int() }).parse(req.body);
  selectProfile(id, body.projectId, body.profileId);
  return sessionEnvState(id);
});
app.post('/api/sessions/:id/env/analyze', async (req) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ projectId: z.number().int(), ai: z.boolean().default(false), known: z.array(z.string()).default([]) }).parse(req.body);
  const s = getSession(id);
  const wt = s?.worktrees.find((w) => w.project_id === body.projectId);
  const project = projectById(body.projectId);
  if (!s || !wt || !project) throw new Error('세션이나 프로젝트를 찾을 수 없습니다.');
  const scanned = scanEnv(wt.path, project.local_path);
  if (!body.ai) return scanned;
  const ai = await analyzeEnvWithAI(wt.path, [...new Set([...body.known, ...scanned.map((v) => v.key)])]);
  // AI 판단을 앞에 두고, AI가 놓친 정적 분석 결과를 덧붙인다.
  const keys = new Set(ai.map((v) => v.key));
  const scannedByKey = new Map(scanned.map((v) => [v.key, v]));
  return [
    ...ai.map((v) => ({ ...v, value: v.value || scannedByKey.get(v.key)?.value || '' })),
    ...scanned.filter((v) => !keys.has(v.key)),
  ];
});
app.post('/api/env/parse', async (req) => {
  const { text } = z.object({ text: z.string() }).parse(req.body);
  return parseDotenv(text);
});
app.delete('/api/env-profiles/:id', async (req) => {
  deleteProfile(idParam.parse(req.params).id);
  return { ok: true };
});

// 서버 실행
app.get('/api/sessions/:id/servers', async (req) => {
  const s = getSession(idParam.parse(req.params).id);
  if (!s) throw new Error('세션이 없습니다.');
  return listServers(s);
});
const startBody = z.object({
  worktreeIds: z.array(z.number().int()).optional(),
  commands: z.record(z.string(), z.string()).optional(),
});
const commandMap = (c?: Record<string, string>) => Object.fromEntries(Object.entries(c ?? {}).map(([k, v]) => [Number(k), v]));
app.post('/api/sessions/:id/servers/start', async (req) => {
  const { id } = idParam.parse(req.params);
  const { worktreeIds, commands } = startBody.parse(req.body ?? {});
  await startServers(id, worktreeIds, commandMap(commands));
  return listServers(getSession(id)!);
});
app.post('/api/sessions/:id/servers/stop', async (req) => {
  const { id } = idParam.parse(req.params);
  const { worktreeIds } = z.object({ worktreeIds: z.array(z.number().int()).optional() }).parse(req.body ?? {});
  await stopServers(id, worktreeIds);
  return listServers(getSession(id)!);
});
app.post('/api/sessions/:id/servers/restart', async (req) => {
  const { id } = idParam.parse(req.params);
  const { worktreeIds, commands } = startBody.parse(req.body ?? {});
  await stopServers(id, worktreeIds);
  await startServers(id, worktreeIds, commandMap(commands));
  return listServers(getSession(id)!);
});
// 계획 산출물(계획서·화면설계서). HTML은 스크립트를 막은 별도 출처로 보여 준다.
app.get('/api/sessions/:id/docs', async (req) => listDocs(idParam.parse(req.params).id));
app.get('/api/sessions/:id/docs/:name', async (req, reply) => {
  const { id, name } = z.object({ id: z.coerce.number().int(), name: z.string() }).parse(req.params);
  const { v } = z.object({ v: z.coerce.number().int().positive().optional() }).parse(req.query);
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
  reply.type('text/html; charset=utf-8');
  return docHtml(id, name, v);
});
// 산출물 보관함: 닫은 세션까지 모든 세션의 산출물
app.get('/api/artifacts', async () => listArchive());
app.post('/api/artifacts/reveal', async (req) => {
  const { session } = z.object({ session: z.number().int().optional() }).parse(req.body ?? {});
  revealArchive(session);
  return { ok: true };
});
app.delete('/api/sessions/:id/docs/:name', async (req) => {
  const { id, name } = z.object({ id: z.coerce.number().int(), name: z.string() }).parse(req.params);
  deleteDoc(id, name);
  return { ok: true };
});
// Claude가 프롬프트 중에 요청한 환경값·테스트 계정 확인
app.get('/api/sessions/:id/approvals', async (req) => listApprovals(idParam.parse(req.params).id));
app.post('/api/approvals/:id', async (req) => {
  const d = z.union([
    z.object({ approve: z.literal(false), feedback: z.string().max(4000).optional() }),
    z.object({
      approve: z.literal(true),
      vars: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      target: z.enum(['session', 'profile']).optional(),
      account_id: z.number().int().optional(),
    }),
  ]).parse(req.body);
  decide(idParam.parse(req.params).id, d);
  return { ok: true };
});

// 화면 테스트: 케이스 만들기 → 역할별 계정 확인 → 브라우저로 실행·촬영
app.get('/api/sessions/:id/tests', async (req) => testState(idParam.parse(req.params).id));
app.post('/api/sessions/:id/tests/generate', async (req) => ({ count: await generateCases(idParam.parse(req.params).id) }));
const caseSchema = z.object({
  id: z.number().int().optional(), title: z.string(), role: z.string().default(''), start_path: z.string().default('/'),
  steps: z.array(z.string()), expected: z.array(z.string()).default([]),
});
app.post('/api/sessions/:id/tests/cases', async (req) => {
  saveCase(idParam.parse(req.params).id, caseSchema.parse(req.body));
  return { ok: true };
});
app.delete('/api/sessions/:id/tests/cases/:caseId', async (req) => {
  const { id, caseId } = z.object({ id: z.coerce.number().int(), caseId: z.coerce.number().int() }).parse(req.params);
  deleteCase(id, caseId);
  return { ok: true };
});
app.post('/api/sessions/:id/tests/accounts', async (req) => {
  const { role, account_id } = z.object({ role: z.string().min(1), account_id: z.number().int() }).parse(req.body);
  confirmRoleAccount(idParam.parse(req.params).id, role, account_id);
  return { ok: true };
});
app.post('/api/sessions/:id/tests/run', async (req) => {
  const { ids } = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {});
  runTests(idParam.parse(req.params).id, ids);
  return { ok: true };
});
app.post('/api/sessions/:id/tests/stop', async (req) => {
  stopTests(idParam.parse(req.params).id);
  return { ok: true };
});
app.get('/api/tests/file/:session/:case/:file', async (req, reply) => {
  const p = z.object({ session: z.coerce.number().int(), case: z.coerce.number().int(), file: z.string() }).parse(req.params);
  const full = testShotPath(p.session, p.case, p.file);
  if (!full) return reply.status(404).send();
  reply.type(full.endsWith('.png') ? 'image/png' : 'image/jpeg');
  return fs.createReadStream(full);
});

// 변경 파일 비교
const scopeSchema = z.enum(['base', 'uncommitted']).default('base');
app.get('/api/sessions/:id/changes', async (req) => {
  const { scope } = z.object({ scope: scopeSchema }).parse(req.query);
  return sessionChanges(idParam.parse(req.params).id, scope);
});
app.get('/api/sessions/:id/diff', async (req) => {
  const q = z.object({
    worktree: z.coerce.number().int(), path: z.string().min(1), scope: scopeSchema,
    full: z.enum(['0', '1']).default('0'), ws: z.enum(['0', '1']).default('0'),
  }).parse(req.query);
  return fileDiff(q.worktree, idParam.parse(req.params).id, q.path, { scope: q.scope, full: q.full === '1', ignoreWhitespace: q.ws === '1' });
});

// 서버 오류 표시 닫기
app.post('/api/sessions/:id/servers/:worktreeId/dismiss', async (req) => {
  const { id, worktreeId } = z.object({ id: z.coerce.number().int(), worktreeId: z.coerce.number().int() }).parse(req.params);
  clearFailure(worktreeId, id);
  return listServers(getSession(id)!);
});
app.get('/api/worktrees/:id/logs', async (req) => getLogs(idParam.parse(req.params).id));

// 테스트 계정 풀
app.get('/api/accounts', async (req) => {
  const { workspace } = z.object({ workspace: z.coerce.number().int().optional() }).parse(req.query);
  return { accounts: listAccounts(), free: freeAccountCount(workspace) };
});
app.post('/api/accounts', async (req) => {
  const b = z.object({ login: z.string(), password: z.string(), note: z.string().default(''), workspace_id: z.number().int().nullable().default(null) }).parse(req.body);
  addAccount(b.login, b.password, b.note, b.workspace_id);
  return { ok: true };
});
app.patch('/api/accounts/:id', async (req) => {
  const b = z.object({ password: z.string().optional(), note: z.string().optional(), workspace_id: z.number().int().nullable().optional() }).parse(req.body);
  updateAccount(idParam.parse(req.params).id, b);
  return { ok: true };
});
app.delete('/api/accounts/:id', async (req) => {
  deleteAccount(idParam.parse(req.params).id);
  return { ok: true };
});
app.get('/api/accounts/:id/password', async (req) => ({ password: accountPassword(idParam.parse(req.params).id) }));
app.post('/api/sessions/:id/account/assign', async (req) => {
  const { accountId } = z.object({ accountId: z.number().int().optional() }).parse(req.body ?? {});
  return { account: assignAccount(idParam.parse(req.params).id, accountId) };
});
app.post('/api/accounts/:id/release', async (req) => {
  releaseAccountById(idParam.parse(req.params).id);
  return { ok: true };
});
app.post('/api/sessions/:id/account/release', async (req) => {
  const { id } = idParam.parse(req.params);
  const { accountId } = z.object({ accountId: z.number().int().optional() }).parse(req.body ?? {});
  releaseAccount(id, accountId);
  setSession(id, {});
  return { ok: true };
});

app.get('/api/github/status', async () => githubStatus());

// 푸시와 PR
app.get('/api/sessions/:id/pr', async (req) => {
  const { id } = idParam.parse(req.params);
  // 머지·닫힘을 바로 반영하도록 열린 PR이 있으면 뒤에서 확인한다. 바뀌면 pr.updated로 다시 불러온다.
  refreshSessionPrsSoon(id);
  return { job: getPrJob(id), prs: listPrs(id) };
});
app.post('/api/sessions/:id/pr/prepare', async (req) => preparePr(idParam.parse(req.params).id));
app.post('/api/sessions/:id/pr', async (req) => {
  const { id } = idParam.parse(req.params);
  const { items, ignore_check_failures } = z.object({
    items: z.array(z.object({
      worktree_id: z.number().int(), title: z.string(), body: z.string(), commit_message: z.string(), update_body: z.boolean().default(false),
    })),
    ignore_check_failures: z.boolean().default(false),
  }).parse(req.body);
  await assertNewWork(id, items);
  return startPr(id, items, { ignoreCheckFailures: ignore_check_failures });
});
app.post('/api/sessions/:id/pr/continue', async (req) => continueIgnoringChecks(idParam.parse(req.params).id));
app.post('/api/prs/:id/close', async (req) => {
  await closePr(idParam.parse(req.params).id);
  return { ok: true };
});

// 영향받는 화면 체크리스트
app.get('/api/sessions/:id/screens', async (req) => screenState(idParam.parse(req.params).id));
app.post('/api/sessions/:id/screens/detect', async (req) => ({ found: await detectScreens(idParam.parse(req.params).id) }));
app.post('/api/sessions/:id/screens', async (req) => {
  const { route } = z.object({ route: z.string() }).parse(req.body);
  addScreen(idParam.parse(req.params).id, route);
  return { ok: true };
});
app.patch('/api/screens/:id', async (req) => {
  const { checked } = z.object({ checked: z.boolean() }).parse(req.body);
  setScreenChecked(idParam.parse(req.params).id, checked);
  return { ok: true };
});
app.delete('/api/screens/:id', async (req) => {
  removeScreen(idParam.parse(req.params).id);
  return { ok: true };
});
app.post('/api/sessions/:id/preview/capture', async (req) => {
  const { url, accountId } = z.object({ url: z.string().url(), accountId: z.number().int().optional() }).parse(req.body);
  return capturePreview(idParam.parse(req.params).id, url, accountId);
});

// 리소스 정리
app.get('/api/cleanup', async () => listCleanup());
app.post('/api/cleanup', async (req) => {
  const b = z.object({ sessionIds: z.array(z.number().int()).min(1), deleteRemote: z.boolean().default(false), force: z.boolean().default(false) }).parse(req.body);
  const results: { session_id: number; steps: { name: string; ok: boolean; detail: string }[]; error: string | null }[] = [];
  for (const sid of b.sessionIds) {
    try { results.push({ session_id: sid, steps: await cleanSession(sid, b), error: null }); } catch (e) { results.push({ session_id: sid, steps: [], error: (e as Error).message }); }
  }
  return results;
});
app.post('/api/cleanup/refresh', async () => ({ changed: await refreshPrStates() }));

// 첨부 이미지
app.get('/api/uploads/:file', async (req, reply) => {
  const { file } = z.object({ file: z.string().regex(/^[0-9a-f-]+\.(png|jpg|gif|webp)$/) }).parse(req.params);
  const full = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(full)) return reply.status(404).send();
  const ext = path.extname(file).slice(1);
  reply.type(`image/${ext === 'jpg' ? 'jpeg' : ext}`);
  return fs.createReadStream(full);
});

// 설정과 알림
app.get('/api/settings', async () => getSettings());
app.put('/api/settings', async (req) => {
  const body = z.object({
    permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']),
    notify: z.object({
      onComplete: z.boolean(), onError: z.boolean(), onServerFail: z.boolean().default(true), os: z.boolean(), sound: z.boolean(),
      skipWhenViewing: z.boolean(), minSeconds: z.number().int().min(0).max(3600),
      onPr: z.boolean().default(true), onCleanup: z.boolean().default(true),
    }),
    cleanup: z.object({
      stopServersOnPr: z.boolean(), autoCleanMerged: z.boolean(), deleteRemoteBranch: z.boolean(),
      pollMinutes: z.number().int().min(1).max(1440), staleDays: z.number().int().min(0).max(365),
    }).default(getSettings().cleanup),
  }).parse(req.body);
  const saved = saveSettings(body as Settings);
  scheduleCleanupPoll();
  return saved;
});
app.post('/api/notify/test', async () => {
  sendNotification('Worktree Studio', '테스트 알림입니다.');
  return { ok: true };
});

app.register(async (scoped) => {
  scoped.get('/ws', { websocket: true }, (socket) => addClient(socket));
});

// 빌드된 웹 화면이 있으면 같은 포트에서 서빙한다.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.status(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

// 도구를 끌 때 띄워 둔 서버도 같이 끈다.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await stopAll().catch(() => {});
    await app.close().catch(() => {});
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });

// 포트를 잡은 뒤에 정리한다. 도구를 실수로 두 번 띄우면 두 번째는 listen에서 실패하는데,
// 그 전에 정리부터 하면 먼저 떠 있던 도구가 띄운 서버들을 남의 것으로 보고 꺼 버린다.
const orphans = cleanupOrphans();
if (orphans) app.log.info(`이전 실행에서 남은 서버 프로세스 ${orphans}개를 정리했습니다.`);
startupSweep(orphans).catch((e) => app.log.error(e));
scheduleCleanupPoll();
