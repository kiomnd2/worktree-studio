import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { HOST, PORT, SESSION_SERVER, UPLOAD_DIR } from './config.js';
import { addClient, broadcast } from './hub.js';
import {
  addProject, createWorkspace, deleteProject, deleteWorkspace, describeProject,
  addToWorkspace, getProject, getWorkspace, listProjectRows, listWorkspaces, setWorkspaceErd, setWorkspaceProjects, updateProject, updateWorkspace,
} from './projects.js';
import { listBranches } from './git.js';
import { closeChat, closeSession, createSession, getSession, listMessages, listSessions, removeQueued, setChat } from './sessions.js';
import { resumeQueue, runPrompt, startChat, stopPrompt, submitPrompt } from './claude.js';
import { abortMerge, checkConflicts, proposeResolution, resolveConflicts } from './conflicts.js';
import { decide, listApprovals } from './approvals.js';
import { clearTasks, getTasks } from './tasks.js';
import { deleteDoc, docHtml, listArchive, listDocs, revealArchive } from './docs.js';
import { fileDiff, sessionChanges } from './changes.js';
import { draftTicket } from './ticketdraft.js';
import { chooseSite, createIssue, getIssue, issueTypes, jiraConfigView, requiredFields, jiraLogout, jiraStatus, oauthCallback, oauthStart, searchIssues } from './jira.js';
import { confirmRoleAccount, deleteCase, generateCases, runTests, saveCase, stopTests, testShotPath, testState } from './tests.js';
import { getSettings, saveSettings, type Settings } from './settings.js';
import { HELPER_PURPOSES } from './models.js';
import { usageReport } from './usage.js';
import { sendNotification } from './notify.js';
import { cleanupOrphans, clearFailure, getLogs, listServers, planPorts, startServers, stopAll, stopServers } from './runner.js';
import { markPortEnvChecked, suggestServerEnv } from './envsuggest.js';
import { hasPortVar, sessionAddrs, toTemplate } from './portvars.js';
import { sessionEnvState, startPrep } from './envapi.js';
import { addRequiredKeys, deleteProfile, ensureDefaultProfile, profileVars, saveSessionEnv, seedProfileIfEmpty, selectProfile, setProfileValues, setSessionValues, type EnvVar } from './envstore.js';
import { ENGINES, defaultEnvMap, deleteConnection, enableConnection, getConnection, guessFromEnv, listConnections, probe, saveConnection, sessionDbs, type Engine } from './dbconn.js';
import { describeConnection, engineSupported } from './dbquery.js';
import { explainFor, worktreeDbs } from './querydb.js';
import { STUDIO_ENGINES, createStudioDb, localSetup, openDockerDesktop, setCopyFiles, setStacks } from './localenv.js';
import { ANALYZE_FIELDS, analyzeProject } from './projectanalyze.js';
import { analyzeEnvWithAI, parseDotenv, scanEnv, springProfiles } from './envscan.js';
import {
  accountPassword, accountsForWorkspace, addAccount, deleteAccount, listAccounts, updateAccount,
} from './accounts.js';
import { githubStatus } from './github.js';
import { getProject as projectById } from './projects.js';
import { assertNewWork, closePr, continueIgnoringChecks, getPrJob, listPrs, preparePr, startPr } from './pr.js';
import { addScreen, capturePreview, detectScreens, removeScreen, screenState, setScreenChecked } from './screens.js';
import { getQuery, getSqlLogInfo, listQueries, muteQuery, resetQueries } from './querylog.js';
import { createDictEntry, createErdProject, deleteDictEntries, erdApi, erdConfigView, erdProject, erdStatus, erdWebUrl, dictionary, listErdProjects, saveErdConfig, updateDictEntry, type DictKind } from './erdvibe.js';
import { checkSession, erdDiffSession, erdFindingsOf, excludesOf, ignoresOf, sessionIndex, setExcludes, setIgnore, sessionErdId } from './dictscan.js';
import { clearBaseline, compareBaseline, setBaselineStatus, snapshotBaseline } from './dictbaseline.js';
import { dictUsage, forgetUsage } from './dictusage.js';
import { schemaCheck, schemaIgnoresOf, setSchemaIgnore } from './schemasync.js';
import { searchDictionary } from './dictsearch.js';
import { approveDictRequest, createDictRequest, duplicateOf, listDictRequests, rejectDictRequest } from './dictrequests.js';
import { buildIndex, resolve as judgeName, typeMatches } from './dict/judge.js';
import { columnType } from './dict/types.js';
import { parseDDL } from './dict/ddlparse.js';
import { generateDDL } from './dict/ddlgen.js';
import { walk } from './mapperindex.js';
import { cleanSession, listCleanup, refreshPrStates, refreshSessionPrsSoon, scheduleCleanupPoll, startupSweep } from './cleanup.js';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 40 * 1024 * 1024 });
await app.register(cors, { origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] });
await app.register(websocket);

app.setErrorHandler((err: Error & { statusCode?: number; details?: Record<string, unknown> }, _req, reply) => {
  const status = err instanceof z.ZodError ? 400 : err.statusCode && err.statusCode < 500 ? err.statusCode : 400;
  // 직접 적은 검증 문구(refine 등)는 그대로 보여 주고, 형식 오류는 짧게 알린다.
  const zodMessage = err instanceof z.ZodError ? (err.issues.find((i) => i.code === 'custom')?.message ?? '입력값을 확인하세요.') : null;
  reply.status(status).send({ error: zodMessage ?? err.message, ...(err.details ?? {}) });
});


const idParam = z.object({ id: z.coerce.number().int().positive() });

// 프로젝트 (로컬 클론 폴더 기준)
app.get('/api/projects', async () => Promise.all(listProjectRows().map(describeProject)));
app.post('/api/projects', async (req) => {
  const { path: p, workspaceId } = z.object({ path: z.string().min(1), workspaceId: z.number().int().optional() }).parse(req.body);
  // 모노레포면 앱 여러 개가 한 번에 등록된다. 워크스페이스에서 추가했으면 바로 그 워크스페이스에 넣는다.
  const rows = await addProject(p);
  if (workspaceId) addToWorkspace(workspaceId, rows.map((r) => r.id));
  return Promise.all(rows.map(async (row) => ({ ...(await describeProject(row)), note: row.note })));
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
    app_url: z.string().nullable().optional().refine((v) => !v || /^https?:\/\/[^\s/]+/.test(v.trim()), '접속 주소는 http:// 또는 https://로 시작해야 합니다. 예: https://localhost:{port}'),
  }).parse(req.body);
  return describeProject(updateProject(id, patch));
});
// 등록한 프로젝트를 Claude가 읽고 실행 설정을 제안한다(읽기만, 1분쯤). 적용은 사용자가 고른 것만.
app.post('/api/projects/:id/analyze', async (req) => analyzeProject(idParam.parse(req.params).id));
app.post('/api/projects/:id/analyze/apply', async (req) => {
  const { id } = idParam.parse(req.params);
  const b = z.object({
    patch: z.record(z.string(), z.string()).default({}),
    env_keys: z.array(z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/), reason: z.string().default('') })).default([]),
  }).parse(req.body);
  const p = getProject(id);
  if (!p) throw new Error('프로젝트가 없습니다.');
  // 제안할 수 있는 항목만 바꾼다.
  const patch = Object.fromEntries(Object.entries(b.patch).filter(([k]) => (ANALYZE_FIELDS as readonly string[]).includes(k)).map(([k, v]) => [k, v.trim() || null]));
  if (patch.app_url && !/^https?:\/\/[^\s/]+/.test(patch.app_url)) throw new Error('접속 주소는 http:// 또는 https://로 시작해야 합니다.');
  updateProject(id, patch);
  let added = 0;
  if (b.env_keys.length) {
    // 빈 프로필에 키를 먼저 넣으면 나중에 코드에서 찾은 키로 채우지 않으므로, 찾은 키부터 채운 뒤 더한다.
    const profile = ensureDefaultProfile(id);
    seedProfileIfEmpty(profile.id, scanEnv(p.local_path, undefined, springProfiles(getProject(id)!.start_cmd)));
    added = addRequiredKeys(profile.id, b.env_keys);
  }
  return { project: await describeProject(getProject(id)!), env_keys_added: added };
});
// 로컬 실행 환경: 클론에서 복사할 파일, 서버 앞에 띄울 도커, DB 연결
/** DB 환경변수 틀을 고를 때 참고할 키: 기본 프로필 값과 코드에서 찾은 키 */
function knownKeys(projectId: number): { key: string; value: string }[] {
  const p = getProject(projectId);
  if (!p) throw new Error('프로젝트가 없습니다.');
  const prof = profileVars(ensureDefaultProfile(projectId).id);
  const scanned = fs.existsSync(p.local_path) ? scanEnv(p.local_path, undefined, springProfiles(p.start_cmd)) : [];
  return [...prof, ...scanned.filter((v) => !prof.some((x) => x.key === v.key))].map((v) => ({ key: v.key, value: v.value }));
}
const engineSchema = z.enum(ENGINES as [Engine, ...Engine[]]);
const connSchema = z.object({
  name: z.string().min(1), engine: engineSchema, host: z.string().default('localhost'), port: z.number().int().min(1).max(65535).nullable().default(null),
  database: z.string().default(''), username: z.string().default(''), password: z.string().default(''),
  env_map: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, '환경변수 이름은 영문·숫자·_ 로 넣어 주세요.'), z.string()).default({}),
  enabled: z.boolean().default(true), note: z.string().default(''),
});
app.get('/api/projects/:id/local', async (req) => {
  const p = getProject(idParam.parse(req.params).id);
  if (!p) throw new Error('프로젝트가 없습니다.');
  return { ...(await localSetup(p)), connections: listConnections(p.id), studio_engines: STUDIO_ENGINES };
});
app.put('/api/projects/:id/local', async (req) => {
  const { id } = idParam.parse(req.params);
  const b = z.object({
    copy_files: z.array(z.string().min(1).refine((f) => !f.startsWith('/') && !f.split('/').includes('..'), '저장소 안의 상대 경로만 넣을 수 있습니다.')).nullable().optional(),
    stacks: z.array(z.object({ file: z.string().min(1), services: z.array(z.string().min(1)) })).optional(),
  }).parse(req.body);
  if (b.copy_files !== undefined) setCopyFiles(id, b.copy_files);
  if (b.stacks) setStacks(id, b.stacks);
  return { ok: true };
});
// 새 연결 칸을 채울 기본값: 엔진에 맞는 환경변수 틀과, 프로필에 이미 있는 DB 주소에서 짐작한 접속 정보
app.post('/api/projects/:id/db/defaults', async (req) => {
  const { id } = idParam.parse(req.params);
  const { engine } = z.object({ engine: engineSchema }).parse(req.body);
  const known = knownKeys(id);
  const guess = guessFromEnv(Object.fromEntries(known.filter((k) => k.value).map((k) => [k.key, k.value]))).find((g) => g.engine === engine) ?? null;
  return { env_map: defaultEnvMap(getProject(id)!, engine, known), guess };
});
app.post('/api/projects/:id/db', async (req) => {
  const { id } = idParam.parse(req.params);
  return saveConnection(id, connSchema.parse(req.body));
});
app.post('/api/projects/:id/db/studio', async (req) => {
  const { id } = idParam.parse(req.params);
  const { engine } = z.object({ engine: engineSchema }).parse(req.body);
  return createStudioDb(getProject(id)!, engine, knownKeys(id));
});
app.put('/api/db/:id', async (req) => {
  const { id } = idParam.parse(req.params);
  const cur = getConnection(id);
  if (!cur) throw new Error('DB 연결이 없습니다.');
  return saveConnection(cur.project_id, connSchema.parse(req.body), id);
});
app.delete('/api/db/:id', async (req) => {
  deleteConnection(idParam.parse(req.params).id);
  return { ok: true };
});
app.post('/api/db/:id/enable', async (req) => {
  enableConnection(idParam.parse(req.params).id);
  return { ok: true };
});
app.post('/api/db/:id/test', async (req) => {
  const c = getConnection(idParam.parse(req.params).id);
  if (!c) throw new Error('DB 연결이 없습니다.');
  const port = c.port ?? ({ postgres: 5432, mysql: 3306, mariadb: 3306, oracle: 1521, mssql: 1433, mongodb: 27017, redis: 6379 } as const)[c.engine];
  return { reachable: await probe(c.host || 'localhost', port), target: `${c.host || 'localhost'}:${port}` };
});
app.post('/api/docker/open', async () => {
  openDockerDesktop();
  return { ok: true };
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
  const body = z.object({ name: z.string(), projectIds: z.array(z.number().int()).default([]) }).parse(req.body);
  return { id: createWorkspace(body.name, body.projectIds) };
});
app.patch('/api/workspaces/:id', async (req) => {
  const b = z.object({ jira_project: z.string().nullable().optional(), name: z.string().optional() }).parse(req.body);
  updateWorkspace(idParam.parse(req.params).id, b);
  return { ok: true };
});
// 워크스페이스마다 ERD를 고른다. 그 워크스페이스의 세션은 검사·ERD 화면·Claude 도구에서 이 ERD를 쓴다.
app.put('/api/workspaces/:id/erd', async (req) => {
  const { id } = idParam.parse(req.params);
  const { erd_project_id } = z.object({ erd_project_id: z.string().nullable() }).parse(req.body);
  const want = erd_project_id?.trim() || null;
  if (want && !(await listErdProjects()).some((p) => p.id === want)) throw new Error('erd-vibe에 없는 ERD 프로젝트입니다.');
  setWorkspaceErd(id, want);
  return { ok: true };
});
app.put('/api/workspaces/:id/projects', async (req) => {
  const { projectIds } = z.object({ projectIds: z.array(z.number().int()) }).parse(req.body);
  setWorkspaceProjects(idParam.parse(req.params).id, projectIds);
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
    inPlace: z.boolean().default(false),
    firstPrompt: z.string().optional(),
    /** 첫 프롬프트를 계획 모드로 보낼지. 계획서·화면설계서를 만들고 승인을 기다린다. */
    firstPromptPlan: z.boolean().default(false),
  }).parse(req.body);
  const created = await createSession(body);
  const session = getSession(created.id)!;
  if (body.firstPrompt?.trim()) submitPrompt(session.id, body.firstPrompt, [], { plan: body.firstPromptPlan });
  return session;
});
app.get('/api/sessions/:id', async (req) => {
  const s = getSession(idParam.parse(req.params).id);
  if (!s) throw Object.assign(new Error('세션이 없습니다.'), { statusCode: 404 });
  return s;
});
/** ?chat=N: 그 대화의 메시지. 0이나 생략은 메인 대화 */
const chatQuery = z.object({ chat: z.coerce.number().int().min(0).default(0) });
const promptBody = z.object({
  text: z.string().default(''),
  images: z.array(z.object({ mediaType: z.string(), data: z.string(), name: z.string().optional() })).max(10).default([]),
  plan: z.boolean().default(false),
});
app.get('/api/sessions/:id/messages', async (req) => listMessages(idParam.parse(req.params).id, chatQuery.parse(req.query).chat));
app.post('/api/sessions/:id/prompt', async (req) => {
  const { id } = idParam.parse(req.params);
  const body = promptBody.extend({ chat: z.number().int().min(0).default(0) }).parse(req.body);
  // 실행은 백그라운드로 두고, 진행 상황은 WebSocket으로 보낸다. 작업 중이면 대기열에 넣는다.
  return submitPrompt(id, body.text, body.images, { plan: body.plan, chatId: body.chat });
});
// 추가 대화: 같은 워크트리에서 메인 대화와 따로 Claude를 돌린다. 첫 프롬프트와 함께 연다.
app.post('/api/sessions/:id/chats', async (req) => {
  const { id } = idParam.parse(req.params);
  const body = promptBody.parse(req.body);
  const { db } = z.object({ db: z.number().int().optional() }).parse(req.body);
  return startChat(id, body.text, body.images, { plan: body.plan, db });
});
// DB 대화를 열 수 있는 연결(세션 앱들의 DB 설정). 비밀번호는 보내지 않는다.
app.get('/api/sessions/:id/db', async (req) => {
  const session = getSession(idParam.parse(req.params).id);
  if (!session) throw new Error('세션이 없습니다.');
  return sessionDbs(session).map((c) => ({ id: c.id, name: c.name, engine: c.engine, project_name: c.project_name, target: describeConnection(c), enabled: c.enabled, queryable: engineSupported(c) }));
});
app.post('/api/sessions/:id/chats/:cid/close', async (req) => {
  const { id, cid } = z.object({ id: z.coerce.number().int(), cid: z.coerce.number().int().min(1) }).parse(req.params);
  if (getSession(id)?.chats.find((c) => c.id === cid)?.status === 'running') throw Object.assign(new Error('작업 중인 대화는 닫을 수 없습니다. 먼저 중단하세요.'), { statusCode: 409 });
  closeChat(id, cid);
  return { ok: true };
});
app.delete('/api/sessions/:id/queue/:qid', async (req) => {
  const { id, qid } = z.object({ id: z.coerce.number().int(), qid: z.coerce.number().int() }).parse(req.params);
  removeQueued(id, qid);
  return { ok: true };
});
app.post('/api/sessions/:id/queue/resume', async (req) => {
  resumeQueue(idParam.parse(req.params).id, chatQuery.parse(req.query).chat);
  return { ok: true };
});
app.post('/api/sessions/:id/stop', async (req) => ({ stopped: stopPrompt(idParam.parse(req.params).id, chatQuery.parse(req.query).chat) }));
app.post('/api/sessions/:id/read', async (req) => {
  setChat(idParam.parse(req.params).id, chatQuery.parse(req.query).chat, { unread: 0 });
  return { ok: true };
});
app.post('/api/sessions/:id/close', async (req) => {
  const { id } = idParam.parse(req.params);
  const { removeWorktrees } = z.object({ removeWorktrees: z.boolean().default(false) }).parse(req.body ?? {});
  await stopServers(id);
  await closeSession(id, removeWorktrees);
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
  const scanned = scanEnv(wt.app_path, project.local_path, springProfiles(project.start_cmd));
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
  /** 실행 전에 정해 둔 포트(설정 제안의 기준). 비어 있으면 그대로 쓴다. */
  ports: z.record(z.string(), z.number().int()).optional(),
  /** false면 프로젝트에 설정한 도커(DB 등)를 띄우지 않는다 */
  docker: z.boolean().optional(),
  /** false면 BE의 SQL 로그(쿼리 감시)를 켜지 않는다 */
  sqlLog: z.boolean().optional(),
});
const commandMap = (c?: Record<string, string>) => Object.fromEntries(Object.entries(c ?? {}).map(([k, v]) => [Number(k), v]));
const portMap = (c?: Record<string, number>) => Object.fromEntries(Object.entries(c ?? {}).map(([k, v]) => [Number(k), v]));
// 서버를 띄우기 전: 세션의 모든 앱에 쓸 포트를 정하고(이번에 안 띄우는 앱 포함), 그 포트로 FE·BE가 맞물리게 바꿔야 할 환경값을 제안받는다.
app.post('/api/sessions/:id/servers/plan', async (req) => {
  const { id } = idParam.parse(req.params);
  return { ports: await planPorts(id) };
});
// 실행 전 준비(도커, 로컬 파일 복사, DB 연결)를 서버 실행 창에 먼저 보여 준다.
app.get('/api/sessions/:id/servers/prep', async (req) => {
  const { id } = idParam.parse(req.params);
  const { worktrees } = z.object({ worktrees: z.string().optional() }).parse(req.query);
  return startPrep(id, worktrees ? worktrees.split(',').map(Number).filter(Boolean) : undefined);
});
app.post('/api/sessions/:id/servers/suggest-env', async (req) => {
  const { id } = idParam.parse(req.params);
  const { ports, force } = z.object({ ports: z.record(z.string(), z.number().int()), force: z.boolean().optional() }).parse(req.body);
  return suggestServerEnv(id, portMap(ports), force);
});
// 이 세션 주소가 들어간 값은 포트 자리({be_url} 등)로 바꿔 프로필에 넣는다. 자리로 바꿀 수 없는 값만 이번 세션에 넣는다.
app.post('/api/sessions/:id/env/apply', async (req) => {
  const { id } = idParam.parse(req.params);
  const { items } = z.object({ items: z.array(z.object({ project_id: z.number().int(), key: z.string().min(1), value: z.string(), found_in: z.string().optional() })).min(1) }).parse(req.body);
  const session = getSession(id);
  if (!session) throw new Error('세션이 없습니다.');
  const addrs = sessionAddrs(session);
  const profile = new Map<number, { key: string; value: string; found_in?: string }[]>();
  const only = new Map<number, Record<string, string>>();
  for (const it of items) {
    const key = it.key.trim();
    const tpl = toTemplate(it.value, addrs);
    if (hasPortVar(tpl)) profile.set(it.project_id, [...(profile.get(it.project_id) ?? []), { key, value: tpl, found_in: it.found_in }]);
    else only.set(it.project_id, { ...only.get(it.project_id), [key]: it.value });
  }
  for (const [projectId, values] of profile) setProfileValues(id, projectId, values);
  for (const [projectId, values] of only) setSessionValues(id, projectId, values);
  markPortEnvChecked(session.worktrees.map((w) => w.project_id));
  return { profile: [...profile.values()].flat().map((v) => `${v.key}=${v.value}`), session: [...only.values()].flatMap((v) => Object.keys(v)) };
});
app.post('/api/sessions/:id/servers/start', async (req) => {
  const { id } = idParam.parse(req.params);
  const { worktreeIds, commands, ports, docker, sqlLog } = startBody.parse(req.body ?? {});
  await startServers(id, worktreeIds, commandMap(commands), portMap(ports), { docker, sqlLog });
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
  const { worktreeIds, commands, ports, docker, sqlLog } = startBody.parse(req.body ?? {});
  await stopServers(id, worktreeIds);
  await startServers(id, worktreeIds, commandMap(commands), portMap(ports), { docker, sqlLog });
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
// 사용량 보고서: Claude 호출의 토큰·비용 집계
app.get('/api/usage', async (req) => usageReport(z.object({ days: z.coerce.number().int().min(0).max(3650).default(30) }).parse(req.query).days));
// Claude가 프롬프트 중에 요청한 환경값·테스트 계정 확인
app.get('/api/sessions/:id/tasks', async (req) => getTasks(idParam.parse(req.params).id));
app.delete('/api/sessions/:id/tasks', async (req) => { clearTasks(idParam.parse(req.params).id); return { ok: true }; });
app.get('/api/sessions/:id/approvals', async (req) => listApprovals(idParam.parse(req.params).id));
app.post('/api/approvals/:id', async (req) => {
  const d = z.union([
    z.object({ approve: z.literal(false), feedback: z.string().max(4000).optional() }),
    z.object({
      approve: z.literal(true),
      answers: z.record(z.string(), z.string()).optional(),
      plan: z.string().max(4000).optional(),
      vars: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      target: z.enum(['session', 'profile']).optional(),
      account_id: z.number().int().optional(),
      sql: z.string().max(100_000).optional(),
    }),
  ]).parse(req.body);
  await decide(idParam.parse(req.params).id, d);
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

// erd-vibe 용어·도메인 사전: 연결 설정, 사전 검색, ERD, 소스 용어 검사, 등록 요청
app.get('/api/erd-vibe/config', async () => erdConfigView());
app.put('/api/erd-vibe/config', async (req) => {
  saveErdConfig(z.object({ base_url: z.string().optional(), api_key: z.string().optional() }).parse(req.body));
  return erdConfigView();
});
app.get('/api/erd-vibe/status', async () => erdStatus());
app.get('/api/erd-vibe/projects', async () => listErdProjects());
app.post('/api/erd-vibe/refresh', async () => {
  const d = await dictionary(true);
  return { words: d.words.length, terms: d.terms.length, domains: d.domains.length, loaded_at: d.loaded_at };
});
const sessionOf = (id: number) => {
  const s = getSession(id);
  if (!s) throw new Error('세션이 없습니다.');
  return s;
};
app.get('/api/sessions/:id/dict/search', async (req) => {
  const { q, limit } = z.object({ q: z.string().default(''), limit: z.coerce.number().int().min(1).max(2000).default(50) }).parse(req.query);
  return searchDictionary(sessionOf(idParam.parse(req.params).id), q, limit);
});
app.post('/api/sessions/:id/dict/check', async (req) => {
  const { scope } = z.object({ scope: z.enum(['changed', 'all']).default('changed') }).parse(req.body ?? {});
  return checkSession(idParam.parse(req.params).id, scope);
});
app.get('/api/sessions/:id/dict/ignores', async (req) => ignoresOf(sessionOf(idParam.parse(req.params).id).workspace_id));
app.put('/api/sessions/:id/dict/ignores', async (req) => {
  const b = z.object({ name: z.string().min(1), reason: z.string().nullable() }).parse(req.body);
  setIgnore(sessionOf(idParam.parse(req.params).id).workspace_id, b.name, b.reason);
  return { ok: true };
});
app.get('/api/sessions/:id/dict/excludes', async (req) => excludesOf(sessionOf(idParam.parse(req.params).id).workspace_id));
app.put('/api/sessions/:id/dict/excludes', async (req) => {
  const { patterns } = z.object({ patterns: z.array(z.string().max(300)).max(200) }).parse(req.body);
  const s = sessionOf(idParam.parse(req.params).id);
  setExcludes(s.workspace_id, patterns);
  forgetUsage();
  return excludesOf(s.workspace_id);
});
// 기준선: 전체 검사 결과를 찍어 두고 이후 검사마다 남음·해결을 센다.
app.post('/api/sessions/:id/dict/baseline', async (req) => {
  const id = idParam.parse(req.params).id;
  const ws = sessionOf(id).workspace_id;
  const report = await checkSession(id, 'all');
  snapshotBaseline(ws, report.findings);
  return { ...report, baseline: compareBaseline(ws, report.findings, 'all') };
});
app.delete('/api/sessions/:id/dict/baseline', async (req) => {
  clearBaseline(sessionOf(idParam.parse(req.params).id).workspace_id);
  return { ok: true };
});
app.put('/api/sessions/:id/dict/baseline/status', async (req) => {
  const b = z.object({
    keys: z.array(z.object({ name: z.string().min(1), issue: z.string().min(1) })).min(1).max(5000),
    status: z.enum(['todo', 'hold', 'accepted']),
    note: z.string().max(500).default(''),
  }).parse(req.body);
  if (b.status !== 'todo' && !b.note.trim()) throw new Error('보류·허용은 이유가 필요합니다.');
  setBaselineStatus(sessionOf(idParam.parse(req.params).id).workspace_id, b.keys, b.status, b.note.trim());
  return { ok: true };
});
app.get('/api/sessions/:id/dict/usage', async (req) => {
  const { refresh } = z.object({ refresh: z.enum(['0', '1']).default('0') }).parse(req.query);
  return dictUsage(sessionOf(idParam.parse(req.params).id), refresh === '1');
});
// Liquibase 최종 스키마 ↔ 매퍼·JPA
app.post('/api/sessions/:id/schema/check', async (req) => {
  const { scope } = z.object({ scope: z.enum(['changed', 'all']).default('changed') }).parse(req.body ?? {});
  return schemaCheck(idParam.parse(req.params).id, scope);
});
app.get('/api/sessions/:id/schema/ignores', async (req) => schemaIgnoresOf(sessionOf(idParam.parse(req.params).id).workspace_id));
app.put('/api/sessions/:id/schema/ignores', async (req) => {
  const b = z.object({ key: z.string().min(1).max(300), reason: z.string().max(500).nullable() }).parse(req.body);
  const s = sessionOf(idParam.parse(req.params).id);
  setSchemaIgnore(s.workspace_id, b.key.toUpperCase(), b.reason);
  return schemaIgnoresOf(s.workspace_id);
});
const termPayload = z.object({ logical_name: z.string(), physical_name: z.string(), physical_abbr_name: z.string().nullable(), domain_name: z.string().nullable(), description: z.string() });
const wordPayload = z.object({ name: z.string(), english_name: z.string(), abbreviation: z.string().nullable(), definition: z.string() });
// ERD 변경 초안은 dictrequests.validateErd가 모양을 확인한다.
const erdPayload = z.object({ action: z.enum(['add_table', 'add_column', 'update_column', 'drop_column']) }).passthrough();
app.get('/api/sessions/:id/dict/requests', async (req) => listDictRequests(idParam.parse(req.params).id));
app.post('/api/sessions/:id/dict/requests', async (req) => {
  const b = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('term'), payload: termPayload, reason: z.string().default('') }),
    z.object({ kind: z.literal('word'), payload: wordPayload, reason: z.string().default('') }),
  ]).parse(req.body);
  return createDictRequest(idParam.parse(req.params).id, b.kind === 'term' ? { kind: 'term', payload: b.payload } : { kind: 'word', payload: b.payload }, b.reason, 'user');
});
app.post('/api/dict-requests/:id/approve', async (req) => {
  const b = z.object({ payload: z.union([erdPayload, termPayload, wordPayload]) }).parse(req.body);
  return approveDictRequest(idParam.parse(req.params).id, b.payload as Parameters<typeof approveDictRequest>[1]);
});
app.post('/api/dict-requests/:id/reject', async (req) => {
  rejectDictRequest(idParam.parse(req.params).id);
  return { ok: true };
});

// erd-vibe 사전 직접 편집(사용자가 화면에서). 저장하면 팀 공유 사전에 바로 반영된다.
const dictKind = z.object({ kind: z.enum(['word', 'term', 'domain']) });
const upOrNull = (s: string | null | undefined) => (s ?? '').trim().toUpperCase() || null;
const dictBody = {
  term: z.object({ logical_name: z.string().trim().min(1, '논리명이 필요합니다.'), physical_name: z.string().trim().min(1, '물리명이 필요합니다.'), physical_abbr_name: z.string().nullable().default(null), domain_name: z.string().nullable().default(null), description: z.string().trim().min(1, '설명이 필요합니다.') })
    .transform((t) => ({ ...t, physical_name: t.physical_name.toUpperCase(), physical_abbr_name: upOrNull(t.physical_abbr_name), domain_name: t.domain_name?.trim() || null })),
  word: z.object({ name: z.string().trim().min(1, '단어가 필요합니다.'), english_name: z.string().trim().min(1, '영문명이 필요합니다.'), abbreviation: z.string().nullable().default(null), definition: z.string().trim().min(1, '정의가 필요합니다.') })
    .transform((w) => ({ ...w, english_name: w.english_name.toUpperCase(), abbreviation: upOrNull(w.abbreviation) })),
  domain: z.object({
    name: z.string().trim().min(1, '도메인명이 필요합니다.'), data_type_default: z.string().trim().min(1, '기본 타입이 필요합니다.'),
    data_type_oracle: z.string().nullable().optional(), data_type_mysql: z.string().nullable().optional(), data_type_postgresql: z.string().nullable().optional(), description: z.string().nullable().optional(),
  }).transform((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]).filter(([, v]) => v !== null && v !== undefined && v !== ''))),
};
async function checkDictDuplicate(kind: DictKind, body: Record<string, unknown>, exceptId?: string) {
  if (kind === 'domain') {
    const d = await dictionary();
    const hit = d.domains.find((x) => x.id !== exceptId && x.name === body.name);
    if (hit) throw new Error(`이미 있는 도메인입니다: ${hit.name}`);
    return;
  }
  const dup = await duplicateOf(kind, body as never, exceptId);
  if (dup) throw new Error(dup);
}
app.post('/api/erd-vibe/dict/:kind', async (req) => {
  const { kind } = dictKind.parse(req.params);
  const body = dictBody[kind].parse(req.body) as Record<string, unknown>;
  await checkDictDuplicate(kind, body);
  const created = await createDictEntry(kind, body);
  broadcast({ type: 'dict.updated' });
  return created;
});
app.put('/api/erd-vibe/dict/:kind/:id', async (req) => {
  const { kind, id } = dictKind.extend({ id: z.string().min(1) }).parse(req.params);
  const body = dictBody[kind].parse(req.body) as Record<string, unknown>;
  await checkDictDuplicate(kind, body, id);
  const updated = await updateDictEntry(kind, id, body);
  broadcast({ type: 'dict.updated' });
  return updated;
});
app.delete('/api/erd-vibe/dict/:kind', async (req) => {
  const { kind } = dictKind.parse(req.params);
  const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).parse(req.body);
  await deleteDictEntries(kind, ids);
  broadcast({ type: 'dict.updated' });
  return { ok: true };
});
app.post('/api/erd-vibe/projects', async (req) => {
  const b = z.object({ name: z.string().trim().min(1, 'ERD 이름이 필요합니다.'), description: z.string().optional() }).parse(req.body);
  return createErdProject({ ...b, author: 'worktree-studio' });
});

// ERD 화면: 보기(판정 포함)는 세션 기준, 편집은 ERD 프로젝트 기준. 편집 뒤에는 최신 ERD를 돌려준다.
app.get('/api/sessions/:id/erd', async (req) => {
  const s = sessionOf(idParam.parse(req.params).id);
  const q = z.object({ project: z.string().optional(), refresh: z.enum(['0', '1']).default('0') }).parse(req.query);
  const linked = sessionErdId(s);
  const pid = q.project || linked;
  if (!pid) return { web_url: erdWebUrl(), linked_id: null, project: null, findings: [], terms: {} };
  const [dict, erd] = await Promise.all([dictionary(), erdProject(pid, q.refresh === '1')]);
  const ix = buildIndex(dict, erd.dbms_type);
  const ignored = new Set(ignoresOf(s.workspace_id).map((i) => i.name));
  const used = new Set(erd.tables.flatMap((t) => t.columns.map((c) => c.term_dictionary_id)).filter(Boolean));
  const terms = Object.fromEntries(dict.terms.filter((t) => used.has(t.id)).map((t) => [t.id, { logical_name: t.logical_name, standard: (t.physical_abbr_name || t.physical_name).toUpperCase() }]));
  return { web_url: erdWebUrl(), linked_id: linked, project: erd, findings: erdFindingsOf(ix, erd, ignored), terms };
});
app.get('/api/sessions/:id/erd/diff', async (req) => erdDiffSession(idParam.parse(req.params).id));

const pidParam = z.object({ pid: z.string().min(1) });
const afterEdit = async (pid: string) => {
  broadcast({ type: 'erd.updated', projectId: pid });
  return erdProject(pid, true);
};
const ident = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_$]*$/, '물리명은 영문·숫자·밑줄만 씁니다.').transform((v) => v.toUpperCase());
const tableBody = z.object({
  physical_name: ident, logical_name: z.string().trim().min(1, '논리명이 필요합니다.'), description: z.string().optional(),
  position_x: z.number().optional(), position_y: z.number().optional(), header_color: z.string().optional(),
});
const columnBody = z.object({
  physical_name: ident, logical_name: z.string().trim().min(1, '논리명이 필요합니다.'), data_type: z.string().trim().min(1, '타입이 필요합니다.'),
  is_primary_key: z.boolean().optional(), is_nullable: z.boolean().optional(), is_unique: z.boolean().optional(),
  default_value: z.string().optional(), description: z.string().optional(), order_index: z.number().int().optional(),
  term_dictionary_id: z.string().nullable().optional(),
});
const relType = z.enum(['one_to_one', 'one_to_many', 'many_to_many']);

/** 저장하기 전에 다른 사람이 바꿨는지(updated_at) 본다. 다르면 409로 알려 화면이 덮어쓸지 묻게 한다. */
async function assertFresh(pid: string, tableId: string, seen: string | null | undefined) {
  if (!seen) return;
  const now = (await erdProject(pid, true)).tables.find((t) => t.id === tableId);
  if (now && now.updated_at && now.updated_at !== seen) {
    const err = new Error('다른 사람이 이 테이블을 먼저 고쳤습니다. 다시 받아서 확인하거나 덮어쓰세요.') as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }
}

app.post('/api/erd/:pid/tables', async (req) => {
  const { pid } = pidParam.parse(req.params);
  const b = tableBody.parse(req.body);
  const erd = await erdProject(pid, true);
  if (erd.tables.some((t) => t.physical_name.toUpperCase() === b.physical_name)) throw new Error(`이미 ${b.physical_name} 테이블이 있습니다.`);
  const t = await erdApi.createTable(pid, b);
  return { created_id: t.id, project: await afterEdit(pid) };
});
app.put('/api/erd/:pid/tables/:tid', async (req) => {
  const { pid, tid } = pidParam.extend({ tid: z.string().min(1) }).parse(req.params);
  const b = z.object({
    table: tableBody.partial().optional(),
    columns: z.array(columnBody.extend({ id: z.string().optional() })).optional(),
    deleted_columns: z.array(z.string()).optional(),
    seen_updated_at: z.string().nullable().optional(),
    force: z.boolean().optional(),
  }).parse(req.body);
  if (!b.force) await assertFresh(pid, tid, b.seen_updated_at);
  const erd = await erdProject(pid, true);
  const table = erd.tables.find((t) => t.id === tid);
  if (!table) throw new Error('ERD에 그 테이블이 없습니다. 다시 받아 주세요.');
  if (b.table?.physical_name && erd.tables.some((t) => t.id !== tid && t.physical_name.toUpperCase() === b.table!.physical_name)) throw new Error(`이미 ${b.table.physical_name} 테이블이 있습니다.`);
  if (b.columns) {
    const names = b.columns.map((c) => c.physical_name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new Error(`같은 컬럼 이름이 두 번 있습니다: ${dup}`);
  }
  if (b.table && Object.keys(b.table).length) await erdApi.updateTable(pid, tid, b.table);
  for (const id of b.deleted_columns ?? []) await erdApi.deleteColumn(pid, id);
  if (b.columns) {
    const byId = new Map(table.columns.map((c) => [c.id, c]));
    for (const [i, c] of b.columns.entries()) {
      const { id, ...rest } = c;
      const body = { ...rest, order_index: i, term_dictionary_id: rest.term_dictionary_id || undefined };
      const prev = id ? byId.get(id) : undefined;
      if (!prev) { await erdApi.createColumn(pid, tid, body); continue; }
      const changed = (Object.keys(body) as (keyof typeof body)[]).some((k) => body[k] !== undefined && (prev as Record<string, unknown>)[k] !== body[k]);
      if (changed) await erdApi.updateColumn(pid, prev.id, body);
    }
  }
  return { project: await afterEdit(pid) };
});
app.delete('/api/erd/:pid/tables/:tid', async (req) => {
  const { pid, tid } = pidParam.extend({ tid: z.string().min(1) }).parse(req.params);
  await erdApi.deleteTable(pid, tid);
  return { project: await afterEdit(pid) };
});
app.put('/api/erd/:pid/positions', async (req) => {
  const { pid } = pidParam.parse(req.params);
  const { moves } = z.object({ moves: z.array(z.object({ id: z.string(), x: z.number(), y: z.number() })).min(1).max(500) }).parse(req.body);
  await erdApi.moveTables(pid, moves);
  broadcast({ type: 'erd.updated', projectId: pid });
  return { ok: true };
});
app.post('/api/erd/:pid/auto-layout', async (req) => {
  const { pid } = pidParam.parse(req.params);
  await erdApi.autoLayout(pid);
  return { project: await afterEdit(pid) };
});
app.post('/api/erd/:pid/relationships', async (req) => {
  const { pid } = pidParam.parse(req.params);
  const b = z.object({ from_table_id: z.string(), from_column_id: z.string(), to_table_id: z.string(), to_column_id: z.string(), relationship_type: relType.default('one_to_many') }).parse(req.body);
  if (b.from_column_id === b.to_column_id) throw new Error('같은 컬럼끼리는 연결할 수 없습니다.');
  const erd = await erdProject(pid);
  if (erd.relationships.some((r) => r.from_column_id === b.from_column_id && r.to_column_id === b.to_column_id)) throw new Error('이미 같은 관계가 있습니다.');
  await erdApi.createRelationship(pid, b);
  return { project: await afterEdit(pid) };
});
app.put('/api/erd/:pid/relationships/:rid', async (req) => {
  const { pid, rid } = pidParam.extend({ rid: z.string().min(1) }).parse(req.params);
  await erdApi.updateRelationship(pid, rid, z.object({ relationship_type: relType }).parse(req.body));
  return { project: await afterEdit(pid) };
});
app.delete('/api/erd/:pid/relationships/:rid', async (req) => {
  const { pid, rid } = pidParam.extend({ rid: z.string().min(1) }).parse(req.params);
  await erdApi.deleteRelationship(pid, rid);
  return { project: await afterEdit(pid) };
});

// DDL: 붙여넣은 글이나 워크트리 파일을 풀어 미리보기 → 반영(이름으로 맞춰 추가·갱신, 지우지 않음), DBMS별로 만들기
/** DDL을 가져올 수 있는 워크트리 파일(.sql, Liquibase XML 중 CREATE TABLE이 있는 것) */
app.get('/api/sessions/:id/erd/ddl/files', async (req) => {
  const s = sessionOf(idParam.parse(req.params).id);
  const out: { worktree_id: number; project_name: string; path: string }[] = [];
  for (const w of s.repos.filter((r) => fs.existsSync(r.path))) {
    walk(w.path, (abs) => {
      if (out.length >= 300 || !/\.(sql|xml)$/i.test(abs)) return;
      try {
        if (fs.statSync(abs).size > 2_000_000) return;
        if (/CREATE\s+TABLE/i.test(fs.readFileSync(abs, 'utf8'))) out.push({ worktree_id: w.id, project_name: w.project_name, path: path.relative(w.path, abs) });
      } catch { /* 읽을 수 없는 파일 */ }
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
});
app.post('/api/sessions/:id/erd/ddl/parse', async (req) => {
  const s = sessionOf(idParam.parse(req.params).id);
  const b = z.object({ ddl: z.string().optional(), file: z.object({ worktree_id: z.number().int(), path: z.string().min(1) }).optional(), dbms: z.string().default('oracle'), project: z.string().optional() }).parse(req.body);
  let ddl = b.ddl ?? '';
  if (b.file) {
    const w = s.repos.find((r) => r.id === b.file!.worktree_id);
    if (!w) throw new Error('세션에 그 저장소가 없습니다.');
    const abs = path.resolve(w.path, b.file.path);
    if (path.relative(w.path, abs).startsWith('..')) throw new Error('워크트리 밖의 파일은 읽지 않습니다.');
    ddl = fs.readFileSync(abs, 'utf8');
  }
  if (!ddl.trim()) throw new Error('DDL이 비어 있습니다.');
  const parsed = parseDDL(ddl, b.dbms);
  if (!parsed.tables.length) throw new Error('CREATE TABLE 문을 찾지 못했습니다. DBMS 종류가 맞는지 확인하세요.');
  const pid = b.project || sessionErdId(s);
  const erd = pid ? await erdProject(pid) : null;
  const dict = await dictionary();
  const ix = buildIndex(dict, erd?.dbms_type ?? b.dbms.toUpperCase());
  const preview = parsed.tables.map((t) => {
    const existing = erd?.tables.find((x) => x.physical_name.toUpperCase() === t.physical_name.toUpperCase());
    const cols = new Map(existing?.columns.map((c) => [c.physical_name.toUpperCase(), c]) ?? []);
    const added = t.columns.filter((c) => !cols.has(c.physical_name.toUpperCase())).length;
    const changed = t.columns.filter((c) => { const e = cols.get(c.physical_name.toUpperCase()); return e && !typeMatches(c.data_type, columnType(e) ?? ''); }).length;
    const verdicts = t.columns.map((c) => judgeName(ix, c.physical_name)).filter((r) => r.verdict !== 'standard');
    return {
      physical_name: t.physical_name, logical_name: t.logical_name, columns: t.columns.length,
      status: !existing ? 'new' : added || changed ? 'changed' : 'same', added_columns: added, changed_columns: changed,
      violations: verdicts.map((r) => ({ name: r.name, verdict: r.verdict, standard: r.term?.standard ?? r.draft?.physical_abbr_name ?? null })),
    };
  });
  return { parsed, preview };
});
app.post('/api/erd/:pid/ddl/apply', async (req) => {
  const { pid } = pidParam.parse(req.params);
  const b = z.object({ tables: z.array(z.object({ physical_name: z.string(), logical_name: z.string(), description: z.string().optional(), columns: z.array(z.object({}).passthrough()) }).passthrough()).min(1), relationships: z.array(z.object({ from_table_name: z.string(), from_column_name: z.string(), to_table_name: z.string(), to_column_name: z.string(), relationship_type: relType })).default([]) }).parse(req.body);
  // 용어 연결: 컬럼 물리명이 용어 표준 이름과 같으면 연결을 채운다.
  const dict = await dictionary();
  const ix = buildIndex(dict, 'ORACLE');
  const tables = b.tables.map((t) => ({ ...t, columns: t.columns.map((c) => {
    const term = ix.byStandard.get(String(c.physical_name ?? '').toUpperCase());
    return term ? { ...c, term_dictionary_id: term.id } : c;
  }) }));
  await erdApi.syncTables(pid, tables);
  let project = await erdProject(pid, true);
  let relCreated = 0;
  const relErrors: string[] = [];
  const U = (s: string) => s.toUpperCase();
  for (const r of b.relationships) {
    const from = project.tables.find((t) => U(t.physical_name) === U(r.from_table_name));
    const to = project.tables.find((t) => U(t.physical_name) === U(r.to_table_name));
    const fc = from?.columns.find((c) => U(c.physical_name) === U(r.from_column_name));
    const tc = to?.columns.find((c) => U(c.physical_name) === U(r.to_column_name));
    if (!from || !to || !fc || !tc) { relErrors.push(`${r.to_table_name}.${r.to_column_name} → ${r.from_table_name}.${r.from_column_name}: ERD에 테이블이나 컬럼이 없습니다.`); continue; }
    if (project.relationships.some((x) => x.from_column_id === fc.id && x.to_column_id === tc.id)) continue;
    try { await erdApi.createRelationship(pid, { from_table_id: from.id, from_column_id: fc.id, to_table_id: to.id, to_column_id: tc.id, relationship_type: r.relationship_type }); relCreated++; }
    catch (err) { relErrors.push((err as Error).message); }
  }
  project = await afterEdit(pid);
  return { project, relationships_created: relCreated, relationship_errors: relErrors };
});
app.post('/api/erd/:pid/ddl/export', async (req) => {
  const { pid } = pidParam.parse(req.params);
  const b = z.object({ table_ids: z.array(z.string()).optional(), dbms: z.string().optional(), drop_first: z.boolean().default(false), comments: z.boolean().default(true), foreign_keys: z.boolean().default(true) }).parse(req.body ?? {});
  const erd = await erdProject(pid);
  const picked = b.table_ids?.length ? erd.tables.filter((t) => b.table_ids!.includes(t.id)) : erd.tables;
  return { ddl: generateDDL(picked, erd.tables, erd.relationships, { dbms: b.dbms || erd.dbms_type, dropFirst: b.drop_first, comments: b.comments, foreignKeys: b.foreign_keys }) };
});

// 쿼리 감시: 서버 로그에서 센 쿼리 모양별 집계
const queryKey = z.object({ id: z.coerce.number().int().positive(), key: z.string().regex(/^[0-9a-f]{16}$/) });
app.get('/api/worktrees/:id/queries', async (req) => {
  const { id } = idParam.parse(req.params);
  const q = z.object({ sort: z.enum(['calls', 'rows', 'time', 'recent']).default('calls'), warnings: z.enum(['0', '1']).default('0') }).parse(req.query);
  return {
    rows: listQueries(id, { sort: q.sort, warningsOnly: q.warnings === '1' }),
    sql_log: getSqlLogInfo(id),
    connections: worktreeDbs(id).map((c) => ({ id: c.id, name: c.name, engine: c.engine, enabled: c.enabled, from_env: c.from_env, target: describeConnection(c) })),
  };
});
app.get('/api/worktrees/:id/queries/:key', async (req) => {
  const { id, key } = queryKey.parse(req.params);
  const d = getQuery(id, key);
  if (!d) throw new Error('쿼리가 없습니다. 초기화됐을 수 있습니다.');
  return d;
});
app.post('/api/worktrees/:id/queries/reset', async (req) => {
  resetQueries(idParam.parse(req.params).id);
  return { ok: true };
});
app.post('/api/worktrees/:id/queries/:key/mute', async (req) => {
  const { id, key } = queryKey.parse(req.params);
  const { muted } = z.object({ muted: z.boolean() }).parse(req.body);
  muteQuery(id, key, muted);
  return { ok: true };
});
// 실행 계획: 로그에서 잡은 예시 SQL(파라미터를 넣은 것)로 계획을 받는다. 한 트랜잭션에서 돌리고 롤백한다.
app.post('/api/worktrees/:id/queries/:key/explain', async (req) => {
  const { id, key } = queryKey.parse(req.params);
  const { connectionId, analyze } = z.object({ connectionId: z.number().int().optional(), analyze: z.boolean().optional() }).parse(req.body ?? {});
  const d = getQuery(id, key);
  if (!d) throw new Error('쿼리가 없습니다. 초기화됐을 수 있습니다.');
  if (!d.example) throw new Error('예시 SQL이 없습니다(도구를 다시 켜면 값이 들어간 SQL은 남지 않습니다). 화면을 한 번 더 열어 쿼리가 다시 찍히게 해 주세요.');
  return explainFor(id, d.example.filled, { connectionId, analyze });
});

// 테스트 계정 풀
app.get('/api/accounts', async (req) => {
  const { workspace } = z.object({ workspace: z.coerce.number().int().optional() }).parse(req.query);
  return { accounts: workspace ? accountsForWorkspace(workspace) : listAccounts() };
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
// 기준 브랜치와의 머지 충돌: 확인(워크트리는 그대로) → 해결 방법 제안(읽기만) → 승인하면 새 대화에서 해결
app.get('/api/sessions/:id/conflicts', async (req) => checkConflicts(idParam.parse(req.params).id));
const conflictParams = z.object({ id: z.coerce.number().int(), wid: z.coerce.number().int() });
app.post('/api/sessions/:id/conflicts/:wid/propose', async (req) => {
  const { id, wid } = conflictParams.parse(req.params);
  return proposeResolution(id, wid);
});
app.post('/api/sessions/:id/conflicts/:wid/resolve', async (req) => {
  const { id, wid } = conflictParams.parse(req.params);
  const proposal = z.object({
    summary: z.string(),
    files: z.array(z.object({ path: z.string(), strategy: z.enum(['ours', 'theirs', 'both', 'manual']), how: z.string(), risk: z.string() })),
    checks: z.array(z.string()),
  }).parse(req.body);
  return resolveConflicts(id, wid, proposal);
});
app.post('/api/sessions/:id/conflicts/:wid/abort', async (req) => {
  const { id, wid } = conflictParams.parse(req.params);
  await abortMerge(id, wid);
  return { ok: true };
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

// 첨부 이미지·문서. 텍스트 문서(html 포함)는 이 서버 주소에서 실행되지 않게 일반 텍스트로 보낸다.
app.get('/api/uploads/:file', async (req, reply) => {
  const { file } = z.object({ file: z.string().regex(/^[0-9a-f-]+\.(png|jpg|gif|webp|pdf|txt)$/) }).parse(req.params);
  const full = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(full)) return reply.status(404).send();
  const ext = path.extname(file).slice(1);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.type(ext === 'pdf' ? 'application/pdf' : ext === 'txt' ? 'text/plain; charset=utf-8' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
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
    defaultModel: z.string().max(100).default(getSettings().defaultModel),
    // 고른 작업만 온다(z.record는 enum 키를 모두 요구한다).
    helperModels: z.partialRecord(z.enum(HELPER_PURPOSES), z.string().max(100)).default(getSettings().helperModels),
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
// 세션 개발 서버로 뜬 경우에도 정리하지 않는다. servers 표에는 바깥 도구가 띄운 서버(이 프로세스 자신 포함)가 들어 있다.
const orphans = SESSION_SERVER ? 0 : cleanupOrphans();
if (orphans) app.log.info(`이전 실행에서 남은 서버 프로세스 ${orphans}개를 정리했습니다.`);
startupSweep(orphans).catch((e) => app.log.error(e));
scheduleCleanupPoll();
