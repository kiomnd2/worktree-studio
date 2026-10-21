import fs from 'node:fs';
import path from 'node:path';
import { db, type ProjectRow } from './db.js';
import { expandHome } from './config.js';
import { currentBranch, isGitRepo, originUrl, repoRoot, worktreeCount } from './git.js';
import { detectApps, detectProject, type Detected } from './detect.js';
import { guessApiEnvKey, scanEnv } from './envscan.js';

export type ProjectView = ProjectRow & {
  current_branch: string | null;
  origin: string | null;
  worktrees: number;
  missing: boolean;
};

export async function describeProject(p: ProjectRow): Promise<ProjectView> {
  const missing = !fs.existsSync(p.local_path);
  if (missing) return { ...p, current_branch: null, origin: null, worktrees: 0, missing };
  const [current_branch, origin, worktrees] = await Promise.all([
    currentBranch(p.local_path),
    originUrl(p.local_path),
    worktreeCount(p.local_path).catch(() => 0),
  ]);
  return { ...p, current_branch, origin, worktrees, missing };
}

export function listProjectRows(): ProjectRow[] {
  return db.prepare(`SELECT * FROM projects WHERE deleted = 0 ORDER BY name`).all() as ProjectRow[];
}

export function getProject(id: number): ProjectRow | undefined {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
}

/** 하위 폴더 앱의 의존성 설치: 락 파일이 저장소 루트에만 있으면(npm·pnpm·yarn 워크스페이스) 루트에서 설치한다. */
function setupFor(root: string, subdir: string, d: Detected): string | null {
  if (!subdir || !d.setupCmd || !/^(npm|pnpm|yarn|bun) /.test(d.setupCmd)) return d.setupCmd;
  const app = path.join(root, subdir);
  const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
  if (locks.some((f) => fs.existsSync(path.join(app, f)))) return d.setupCmd;
  const rootLock = locks.find((f) => fs.existsSync(path.join(root, f)));
  if (!rootLock) return d.setupCmd;
  const cmd = rootLock === 'package-lock.json' ? 'npm ci' : rootLock === 'pnpm-lock.yaml' ? 'pnpm install' : rootLock === 'yarn.lock' ? 'yarn install' : 'bun install';
  return `cd ${subdir.split(path.sep).map(() => '..').join('/')} && ${cmd}`;
}

function insertApp(root: string, subdir: string, d: Detected, name: string): ProjectRow & { note: string | null } {
  const dir = subdir ? path.join(root, subdir) : root;
  const apiKey = d.kind === 'fe' ? guessApiEnvKey(scanEnv(dir)) : null;
  const info = db
    .prepare(`INSERT INTO projects (name, local_path, kind, start_cmd, check_cmd, health_path, port_env, api_env_key, setup_cmd, repo_root, subdir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, dir, d.kind, d.startCmd, d.checkCmd, d.healthPath, d.portEnv, apiKey, setupFor(root, subdir, d), root, subdir);
  return { ...getProject(Number(info.lastInsertRowid))!, note: d.note ?? null };
}

/**
 * 로컬에 클론한 폴더를 등록한다. git 저장소가 아니면 거부한다.
 * 저장소 루트를 고르면 안의 앱(FE·BE)을 찾아 앱마다 등록하고(모노레포), 하위 폴더를 고르면 그 폴더를 앱 하나로 등록한다.
 * 이미 등록된 앱은 건너뛰고 새로 등록한 것만 돌려준다.
 */
export async function addProject(inputPath: string): Promise<(ProjectRow & { note: string | null })[]> {
  const abs = path.resolve(expandHome(inputPath.trim()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`폴더를 찾을 수 없습니다: ${abs}`);
  if (!(await isGitRepo(abs))) throw new Error('git 저장소가 아닙니다. 클론한 폴더를 골라 주세요.');
  const root = fs.realpathSync(await repoRoot(abs));
  const dir = fs.realpathSync(abs);
  const existing = (p: string) => db.prepare(`SELECT name FROM projects WHERE local_path = ?`).get(p) as { name: string } | undefined;
  const registered = (p: string) => Boolean(existing(p));
  const repoName = path.basename(root);

  if (dir !== root) {
    if (registered(dir)) throw new Error(`이미 등록된 폴더입니다(프로젝트 ${existing(dir)!.name}). 목록에서 설정을 바꿀 수 있습니다.`);
    const subdir = path.relative(root, dir);
    return [insertApp(root, subdir, detectProject(dir, { ignoreCompose: true }), `${repoName}/${subdir}`)];
  }
  const apps = detectApps(root);
  const fresh = apps.filter((a) => !registered(a.subdir ? path.join(root, a.subdir) : root));
  if (fresh.length === 0) {
    const names = apps.map((a) => existing(a.subdir ? path.join(root, a.subdir) : root)?.name).filter(Boolean).join(', ');
    throw new Error(`${apps.length > 1 ? '이 저장소의 앱은 모두 등록돼 있습니다' : '이미 등록된 폴더입니다'}(프로젝트 ${names}). 목록에서 설정을 바꿀 수 있습니다.`);
  }
  const multi = apps.length > 1;
  return db.transaction(() => fresh.map((a) => insertApp(root, a.subdir, a.detected, a.subdir ? `${repoName}/${a.subdir}` : repoName)))()
    .map((p) => (multi && !p.subdir && p.kind === 'full' ? { ...updateProject(p.id, { kind: 'be' }), note: p.note } : p));
}

export function updateProject(id: number, patch: Partial<Pick<ProjectRow, 'name' | 'kind' | 'start_cmd' | 'check_cmd' | 'health_path' | 'port_env' | 'api_env_key' | 'baseline_url' | 'login_path' | 'setup_cmd' | 'commit_template'>>) {
  const cur = getProject(id);
  if (!cur) throw new Error('프로젝트가 없습니다.');
  const next = { ...cur, ...patch };
  db.prepare(`UPDATE projects SET name = ?, kind = ?, start_cmd = ?, check_cmd = ?, health_path = ?, port_env = ?, api_env_key = ?, baseline_url = ?, login_path = ?, setup_cmd = ?, commit_template = ? WHERE id = ?`)
    .run(next.name, next.kind, next.start_cmd, next.check_cmd, next.health_path, next.port_env, next.api_env_key, next.baseline_url, next.login_path, next.setup_cmd, next.commit_template, id);
  return getProject(id)!;
}

export function deleteProject(id: number) {
  const used = db.prepare(`SELECT 1 FROM worktrees w JOIN sessions s ON s.id = w.session_id WHERE w.project_id = ? AND s.closed = 0 LIMIT 1`).get(id);
  if (used) throw new Error('열려 있는 세션이 이 프로젝트를 쓰고 있습니다.');
  // 닫은 세션의 워크트리 기록이 가리키고 있으면 지우지 않고 숨긴다. 그 세션의 보관 기록과 남은 폴더 정리에 프로젝트 정보가 필요하다.
  // 같은 폴더를 다시 등록할 수 있게 local_path는 비켜 두고, 워크트리 정리에 쓰는 repo_root는 그대로 둔다.
  const referenced = db.prepare(`SELECT 1 FROM worktrees WHERE project_id = ? LIMIT 1`).get(id);
  if (referenced) {
    db.transaction(() => {
      db.prepare(`UPDATE projects SET deleted = 1, local_path = local_path || ' (삭제됨 #' || id || ')' WHERE id = ?`).run(id);
      db.prepare(`DELETE FROM workspace_projects WHERE project_id = ?`).run(id);
    })();
    return;
  }
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

export type WorkspaceView = { id: number; name: string; jira_project: string | null; projects: { id: number; name: string; kind: string; repo_root: string }[] };

export function listWorkspaces(): WorkspaceView[] {
  const ws = db.prepare(`SELECT id, name, jira_project FROM workspaces WHERE deleted = 0 ORDER BY name`).all() as { id: number; name: string; jira_project: string | null }[];
  const rows = db.prepare(`
    SELECT wp.workspace_id, p.id, p.name, p.kind, COALESCE(p.repo_root, p.local_path) AS repo_root FROM workspace_projects wp
    JOIN projects p ON p.id = wp.project_id ORDER BY wp.position`).all() as { workspace_id: number; id: number; name: string; kind: string; repo_root: string }[];
  return ws.map((w) => ({ ...w, projects: rows.filter((r) => r.workspace_id === w.id).map(({ id, name, kind, repo_root }) => ({ id, name, kind, repo_root })) }));
}

export function updateWorkspace(id: number, patch: { jira_project?: string | null }) {
  if (patch.jira_project !== undefined) {
    const key = patch.jira_project?.trim().toUpperCase() || null;
    if (key && !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Jira 프로젝트 키는 KERE처럼 영문 대문자와 숫자로 넣어 주세요.');
    db.prepare(`UPDATE workspaces SET jira_project = ? WHERE id = ?`).run(key, id);
  }
}

export function getWorkspace(id: number): WorkspaceView | undefined {
  return listWorkspaces().find((w) => w.id === id);
}

export function createWorkspace(name: string, projectIds: number[]) {
  if (!name.trim()) throw new Error('워크스페이스 이름을 넣어 주세요.');
  if (projectIds.length === 0) throw new Error('프로젝트를 하나 이상 고르세요.');
  const tx = db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO workspaces (name) VALUES (?)`).run(name.trim()).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO workspace_projects (workspace_id, project_id, position) VALUES (?, ?, ?)`);
    projectIds.forEach((pid, i) => ins.run(id, pid, i));
    return id;
  });
  return tx();
}

export function deleteWorkspace(id: number) {
  const used = db.prepare(`SELECT 1 FROM sessions WHERE workspace_id = ? AND closed = 0 LIMIT 1`).get(id);
  if (used) throw new Error('열려 있는 세션이 있는 워크스페이스는 지울 수 없습니다.');
  // 닫은 세션이 가리키고 있으면 지우지 않고 숨긴다(산출물 보관함이 워크스페이스 이름을 쓴다).
  if (db.prepare(`SELECT 1 FROM sessions WHERE workspace_id = ? LIMIT 1`).get(id)) {
    db.prepare(`UPDATE workspaces SET deleted = 1 WHERE id = ?`).run(id);
    return;
  }
  db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
}
