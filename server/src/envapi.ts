import { getProject } from './projects.js';
import { getSession } from './sessions.js';
import {
  ensureDefaultProfile, listProfiles, profileVars, seedProfileIfEmpty, selectedProfile, sessionOverrides,
  type EnvVar, type Profile,
} from './envstore.js';
import { scanEnv } from './envscan.js';
import { listServers, sessionBeUrl } from './runner.js';
import { dbEnv, listConnections } from './dbconn.js';
import { copyFilesOf, dockerState, neededEngines, pendingCopies, stackPath, stacksOf, type DockerState } from './localenv.js';

export type ProjectEnvState = {
  projectId: number;
  project: string;
  kind: string;
  worktreeId: number;
  path: string;
  profiles: Profile[];
  selectedProfileId: number;
  vars: (EnvVar & { overridden: boolean })[];
  auto: { key: string; value: string }[];
  /** DB 설정이 넣는 값. 프로필 값보다 우선한다. 비밀값은 가린다. */
  db: { key: string; value: string; connection: string }[];
  missing: string[];
};

/** 환경값 화면에 보여줄 상태. 프로필이 비어 있으면 워크트리를 분석해 먼저 채운다. */
export function sessionEnvState(sessionId: number): ProjectEnvState[] {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const running = listServers(s);
  // BE가 꺼져 있어도 잡아 둔 포트가 있으면 그 주소로 연결된다.
  const beUrl = sessionBeUrl(s);
  return s.worktrees.map((w) => {
    const project = getProject(w.project_id)!;
    ensureDefaultProfile(project.id);
    const profile = selectedProfile(sessionId, project.id);
    seedProfileIfEmpty(profile.id, scanEnv(w.app_path, project.local_path).map((f) => ({ ...f })));
    const base = profileVars(profile.id);
    const overrides = sessionOverrides(sessionId, project.id);
    const vars = base.map((v) => (v.key in overrides ? { ...v, value: overrides[v.key], overridden: true } : { ...v, overridden: false }));
    for (const [k, v] of Object.entries(overrides)) {
      if (!base.some((b) => b.key === k)) vars.push({ key: k, value: v, required: false, secret: false, source: 'manual', found_in: null, overridden: true });
    }
    const srv = running.find((r) => r.worktree_id === w.id);
    const portText = srv?.url && srv.port ? String(srv.port) : w.port ? `${w.port} (잡아 둔 포트)` : '실행할 때 배정';
    const auto = [{ key: 'PORT', value: portText }];
    if (project.port_env && project.port_env !== 'PORT') auto.push({ key: project.port_env, value: portText });
    if (project.api_env_key) auto.push({ key: project.api_env_key, value: beUrl ?? '같은 세션 BE 포트로 연결' });
    const autoKeys = auto.map((a) => a.key);
    const dbVars = dbEnv(project.id).filter((d) => !autoKeys.includes(d.key));
    const missing = vars.filter((v) => v.required && !v.value && !autoKeys.includes(v.key) && !dbVars.some((d) => d.key === v.key)).map((v) => v.key);
    return {
      projectId: project.id, project: project.name, kind: project.kind, worktreeId: w.id, path: w.path,
      profiles: listProfiles(project.id), selectedProfileId: profile.id,
      vars: vars.filter((v) => !autoKeys.includes(v.key)), auto,
      db: dbVars.map((d) => ({ key: d.key, value: d.secret ? '••••' : d.value, connection: d.connection })),
      missing,
    };
  });
}

export type StartPrep = {
  worktree_id: number;
  project_id: number;
  project_name: string;
  /** 서버 앞에 띄울 도커 서비스 */
  docker: { file: string; services: string[] }[];
  /** 클론에서 워크트리로 복사할(워크트리에 아직 없는) 로컬 설정 파일 */
  copies: string[];
  /** 켜 둔 DB 연결 요약 */
  db: { name: string; engine: string; target: string }[];
  /** DB 드라이버가 있는데 DB 연결도 도커도 없음 */
  db_missing: string[];
};

/** 서버 실행 창에 보여 줄 실행 전 준비: 도커, 파일 복사, DB 연결. */
export async function startPrep(sessionId: number, worktreeIds?: number[]): Promise<{ items: StartPrep[]; docker: DockerState | null }> {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const items = await Promise.all(s.worktrees.filter((w) => !worktreeIds || worktreeIds.includes(w.id)).map(async (w) => {
    const p = getProject(w.project_id)!;
    const conns = listConnections(p.id).filter((c) => c.enabled);
    const stacks = stacksOf(p);
    const covered = new Set(conns.map((c) => c.engine));
    return {
      worktree_id: w.id, project_id: p.id, project_name: p.name,
      docker: stacks.map((st) => ({ file: stackPath(p, st.file), services: st.services })),
      copies: pendingCopies(p.repo_root, w.path, await copyFilesOf(p)),
      db: conns.map((c) => ({ name: c.name, engine: c.engine, target: `${c.host}:${c.port ?? ''}${c.database ? `/${c.database}` : ''}` })),
      db_missing: w.project_kind === 'fe' || stacks.length ? [] : neededEngines(p).filter((e) => !covered.has(e)),
    };
  }));
  return { items, docker: items.some((i) => i.docker.length) ? await dockerState() : null };
}
