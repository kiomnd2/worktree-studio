import fs from 'node:fs';
import path from 'node:path';
import { db, type ProjectRow } from './db.js';
import { expandHome } from './config.js';
import { currentBranch, isGitRepo, originUrl, repoRoot, worktreeCount } from './git.js';
import { detectProject } from './detect.js';
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
  return db.prepare(`SELECT * FROM projects ORDER BY name`).all() as ProjectRow[];
}

export function getProject(id: number): ProjectRow | undefined {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
}

/** 로컬에 클론한 폴더를 등록한다. git 저장소가 아니면 거부한다. */
export async function addProject(inputPath: string): Promise<ProjectRow> {
  const abs = path.resolve(expandHome(inputPath.trim()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`폴더를 찾을 수 없습니다: ${abs}`);
  if (!(await isGitRepo(abs))) throw new Error('git 저장소가 아닙니다. 클론한 폴더를 골라 주세요.');
  const root = await repoRoot(abs);
  const exists = db.prepare(`SELECT id FROM projects WHERE local_path = ?`).get(root);
  if (exists) throw new Error('이미 등록된 폴더입니다.');
  const d = detectProject(root);
  const apiKey = d.kind === 'fe' ? guessApiEnvKey(scanEnv(root)) : null;
  const info = db
    .prepare(`INSERT INTO projects (name, local_path, kind, start_cmd, check_cmd, health_path, port_env, api_env_key, setup_cmd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(path.basename(root), root, d.kind, d.startCmd, d.checkCmd, d.healthPath, d.portEnv, apiKey, d.setupCmd);
  return getProject(Number(info.lastInsertRowid))!;
}

export function updateProject(id: number, patch: Partial<Pick<ProjectRow, 'name' | 'kind' | 'start_cmd' | 'check_cmd' | 'health_path' | 'port_env' | 'api_env_key' | 'baseline_url' | 'login_path' | 'setup_cmd'>>) {
  const cur = getProject(id);
  if (!cur) throw new Error('프로젝트가 없습니다.');
  const next = { ...cur, ...patch };
  db.prepare(`UPDATE projects SET name = ?, kind = ?, start_cmd = ?, check_cmd = ?, health_path = ?, port_env = ?, api_env_key = ?, baseline_url = ?, login_path = ?, setup_cmd = ? WHERE id = ?`)
    .run(next.name, next.kind, next.start_cmd, next.check_cmd, next.health_path, next.port_env, next.api_env_key, next.baseline_url, next.login_path, next.setup_cmd, id);
  return getProject(id)!;
}

export function deleteProject(id: number) {
  const used = db.prepare(`SELECT 1 FROM worktrees w JOIN sessions s ON s.id = w.session_id WHERE w.project_id = ? AND s.closed = 0 LIMIT 1`).get(id);
  if (used) throw new Error('열려 있는 세션이 이 프로젝트를 쓰고 있습니다.');
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

export type WorkspaceView = { id: number; name: string; projects: { id: number; name: string; kind: string }[] };

export function listWorkspaces(): WorkspaceView[] {
  const ws = db.prepare(`SELECT id, name FROM workspaces ORDER BY name`).all() as { id: number; name: string }[];
  const rows = db.prepare(`
    SELECT wp.workspace_id, p.id, p.name, p.kind FROM workspace_projects wp
    JOIN projects p ON p.id = wp.project_id ORDER BY wp.position`).all() as { workspace_id: number; id: number; name: string; kind: string }[];
  return ws.map((w) => ({ ...w, projects: rows.filter((r) => r.workspace_id === w.id).map(({ id, name, kind }) => ({ id, name, kind })) }));
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
  db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
}
