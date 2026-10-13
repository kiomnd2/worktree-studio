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
  getProject, listProjectRows, listWorkspaces, updateProject,
} from './projects.js';
import { listBranches } from './git.js';
import { closeSession, createSession, getSession, listMessages, listSessions, setSession } from './sessions.js';
import { runPrompt, stopPrompt } from './claude.js';
import { getSettings, saveSettings, type Settings } from './settings.js';
import { sendNotification } from './notify.js';
import { cleanupOrphans, getLogs, listServers, startServers, stopAll, stopServers } from './runner.js';
import { sessionEnvState } from './envapi.js';
import { deleteProfile, saveSessionEnv, selectProfile, type EnvVar } from './envstore.js';
import { analyzeEnvWithAI, parseDotenv, scanEnv } from './envscan.js';
import {
  accountPassword, addAccount, assignAccount, deleteAccount, freeAccountCount, listAccounts, releaseAccount, updateAccount,
} from './accounts.js';
import { githubStatus } from './github.js';
import { getProject as projectById } from './projects.js';
import { closePr, getPrJob, listPrs, preparePr, startPr } from './pr.js';
import {
  SCREEN_DIR, addScreen, capturePreview, captureScreens, cropForPrompt, detectScreens, getScreen, removeScreen, screenState, setScreenStatus,
} from './screens.js';
import { cleanSession, listCleanup, refreshPrStates, scheduleCleanupPoll, startupSweep } from './cleanup.js';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 40 * 1024 * 1024 });
await app.register(cors, { origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] });
await app.register(websocket);

app.setErrorHandler((err: Error & { statusCode?: number; details?: Record<string, unknown> }, _req, reply) => {
  const status = err instanceof z.ZodError ? 400 : err.statusCode && err.statusCode < 500 ? err.statusCode : 400;
  reply.status(status).send({ error: err instanceof z.ZodError ? '입력값을 확인하세요.' : err.message, ...(err.details ?? {}) });
});

const orphans = cleanupOrphans();
if (orphans) app.log.info(`이전 실행에서 남은 서버 프로세스 ${orphans}개를 정리했습니다.`);
startupSweep(orphans).catch((e) => app.log.error(e));
scheduleCleanupPoll();

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
    baseline_url: z.string().url('기준 서버 주소는 http://로 시작하는 전체 주소로 넣으세요.').nullable().optional(),
    login_path: z.string().nullable().optional(),
    setup_cmd: z.string().nullable().optional(),
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
  if (body.firstPrompt?.trim()) {
    runPrompt(session.id, body.firstPrompt, []).catch((e) => app.log.error(e));
  }
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
  }).parse(req.body);
  // 실행은 백그라운드로 두고, 진행 상황은 WebSocket으로 보낸다.
  const s = getSession(id);
  if (!s) throw new Error('세션이 없습니다.');
  if (s.status === 'running') throw new Error('이미 작업 중입니다.');
  runPrompt(id, body.text, body.images).catch((e) => app.log.error(e));
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
app.get('/api/worktrees/:id/logs', async (req) => getLogs(idParam.parse(req.params).id));

// 테스트 계정 풀
app.get('/api/accounts', async () => ({ accounts: listAccounts(), free: freeAccountCount() }));
app.post('/api/accounts', async (req) => {
  const b = z.object({ login: z.string(), password: z.string(), note: z.string().default('') }).parse(req.body);
  addAccount(b.login, b.password, b.note);
  return { ok: true };
});
app.patch('/api/accounts/:id', async (req) => {
  const b = z.object({ password: z.string().optional(), note: z.string().optional() }).parse(req.body);
  updateAccount(idParam.parse(req.params).id, b);
  return { ok: true };
});
app.delete('/api/accounts/:id', async (req) => {
  deleteAccount(idParam.parse(req.params).id);
  return { ok: true };
});
app.get('/api/accounts/:id/password', async (req) => ({ password: accountPassword(idParam.parse(req.params).id) }));
app.post('/api/sessions/:id/account/assign', async (req) => ({ account: assignAccount(idParam.parse(req.params).id) }));
app.post('/api/sessions/:id/account/release', async (req) => {
  const { id } = idParam.parse(req.params);
  releaseAccount(id);
  setSession(id, {});
  return { ok: true };
});

app.get('/api/github/status', async () => githubStatus());

// 푸시와 PR
app.get('/api/sessions/:id/pr', async (req) => {
  const { id } = idParam.parse(req.params);
  return { job: getPrJob(id), prs: listPrs(id) };
});
app.post('/api/sessions/:id/pr/prepare', async (req) => preparePr(idParam.parse(req.params).id));
app.post('/api/sessions/:id/pr', async (req) => {
  const { id } = idParam.parse(req.params);
  const { items } = z.object({
    items: z.array(z.object({ worktree_id: z.number().int(), title: z.string(), body: z.string(), commit_message: z.string() })),
  }).parse(req.body);
  return startPr(id, items);
});
app.post('/api/prs/:id/close', async (req) => {
  await closePr(idParam.parse(req.params).id);
  return { ok: true };
});

// 영향 화면 전후 비교
app.get('/api/sessions/:id/screens', async (req) => screenState(idParam.parse(req.params).id));
app.post('/api/sessions/:id/screens/detect', async (req) => ({ found: await detectScreens(idParam.parse(req.params).id) }));
app.post('/api/sessions/:id/screens', async (req) => {
  const { route } = z.object({ route: z.string() }).parse(req.body);
  addScreen(idParam.parse(req.params).id, route);
  return { ok: true };
});
app.post('/api/sessions/:id/screens/capture', async (req) => {
  const { id } = idParam.parse(req.params);
  const { ids } = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {});
  return captureScreens(id, ids);
});
app.patch('/api/screens/:id', async (req) => {
  const { accepted } = z.object({ accepted: z.boolean() }).parse(req.body);
  setScreenStatus(idParam.parse(req.params).id, accepted);
  return { ok: true };
});
app.delete('/api/screens/:id', async (req) => {
  removeScreen(idParam.parse(req.params).id);
  return { ok: true };
});
app.post('/api/screens/:id/ask', async (req) => {
  const { note } = z.object({ note: z.string().default('') }).parse(req.body ?? {});
  const check = getScreen(idParam.parse(req.params).id);
  if (!check?.before_file || !check.after_file) throw new Error('먼저 화면을 찍으세요.');
  const s = getSession(check.session_id);
  if (s?.status === 'running') throw new Error('Claude가 작업 중입니다. 끝난 뒤에 보내세요.');
  const box = check.boxes[0];
  const text = [
    `${check.route} 화면을 기준 브랜치(첫 번째 이미지)와 작업 브랜치(두 번째 이미지)로 비교했더니 ${((check.diff_ratio ?? 0) * 100).toFixed(2)}%가 달라졌어.`,
    box ? `가장 위쪽 차이는 x=${box.x}, y=${box.y} 근처(${box.w}x${box.h})이고, 이미지는 그 주변을 잘라 붙였어.` : '',
    note.trim() || '의도하지 않은 변경이면 원인을 찾아 고쳐줘. 의도한 변경이면 그렇다고 알려줘.',
  ].filter(Boolean).join('\n');
  runPrompt(check.session_id, text, [
    { mediaType: 'image/png', data: cropForPrompt(check.session_id, check.before_file, box), name: `${check.route} 기준.png` },
    { mediaType: 'image/png', data: cropForPrompt(check.session_id, check.after_file, box), name: `${check.route} 작업.png` },
  ]).catch((e) => app.log.error(e));
  return { ok: true };
});
app.get('/api/screens/file/:session/:file', async (req, reply) => {
  const { session, file } = z.object({ session: z.coerce.number().int(), file: z.string().regex(/^\d+-\d+-(before|after|diff)\.png$/) }).parse(req.params);
  const full = path.join(SCREEN_DIR, String(session), file);
  if (!fs.existsSync(full)) return reply.status(404).send();
  reply.type('image/png');
  return fs.createReadStream(full);
});
app.post('/api/sessions/:id/preview/capture', async (req) => {
  const { url } = z.object({ url: z.string().url() }).parse(req.body);
  return capturePreview(idParam.parse(req.params).id, url);
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
