import { getProject } from './projects.js';
import { getSession } from './sessions.js';
import {
  ensureDefaultProfile, listProfiles, profileVars, seedProfileIfEmpty, selectedProfile, sessionOverrides,
  type EnvVar, type Profile,
} from './envstore.js';
import { scanEnv } from './envscan.js';
import { listServers } from './runner.js';

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
  missing: string[];
};

/** 환경값 화면에 보여줄 상태. 프로필이 비어 있으면 워크트리를 분석해 먼저 채운다. */
export function sessionEnvState(sessionId: number): ProjectEnvState[] {
  const s = getSession(sessionId);
  if (!s) throw new Error('세션이 없습니다.');
  const running = listServers(s);
  const bePort = running.find((r) => r.project_kind !== 'fe' && r.url)?.port ?? null;
  return s.worktrees.map((w) => {
    const project = getProject(w.project_id)!;
    ensureDefaultProfile(project.id);
    const profile = selectedProfile(sessionId, project.id);
    seedProfileIfEmpty(profile.id, scanEnv(w.path, project.local_path).map((f) => ({ ...f })));
    const base = profileVars(profile.id);
    const overrides = sessionOverrides(sessionId, project.id);
    const vars = base.map((v) => (v.key in overrides ? { ...v, value: overrides[v.key], overridden: true } : { ...v, overridden: false }));
    for (const [k, v] of Object.entries(overrides)) {
      if (!base.some((b) => b.key === k)) vars.push({ key: k, value: v, required: false, secret: false, source: 'manual', found_in: null, overridden: true });
    }
    const srv = running.find((r) => r.worktree_id === w.id);
    const portText = srv?.url && srv.port ? String(srv.port) : '실행할 때 배정';
    const auto = [{ key: 'PORT', value: portText }];
    if (project.port_env && project.port_env !== 'PORT') auto.push({ key: project.port_env, value: portText });
    if (project.api_env_key) auto.push({ key: project.api_env_key, value: bePort ? `http://localhost:${bePort}` : '같은 세션 BE 포트로 연결' });
    const autoKeys = auto.map((a) => a.key);
    const missing = vars.filter((v) => v.required && !v.value && !autoKeys.includes(v.key)).map((v) => v.key);
    return {
      projectId: project.id, project: project.name, kind: project.kind, worktreeId: w.id, path: w.path,
      profiles: listProfiles(project.id), selectedProfileId: profile.id,
      vars: vars.filter((v) => !autoKeys.includes(v.key)), auto, missing,
    };
  });
}
