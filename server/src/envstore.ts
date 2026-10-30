import { db } from './db.js';
import { decrypt, encrypt, looksSecret } from './secret.js';
import { dbEnv, type DbEnvEntry } from './dbconn.js';

export type EnvSource = 'detected' | 'ai' | 'clone' | 'profile' | 'manual';
export type EnvVar = { key: string; value: string; required: boolean; secret: boolean; source: EnvSource; found_in: string | null };
export type Profile = { id: number; project_id: number; name: string; is_default: number };

type VarRow = { key: string; value: string | null; required: number; secret: number; source: string; found_in: string | null };

export function listProfiles(projectId: number): Profile[] {
  return db.prepare(`SELECT * FROM env_profiles WHERE project_id = ? ORDER BY is_default DESC, name`).all(projectId) as Profile[];
}

export function getProfile(id: number): Profile | undefined {
  return db.prepare(`SELECT * FROM env_profiles WHERE id = ?`).get(id) as Profile | undefined;
}

/** 프로필이 하나도 없으면 local 프로필을 기본으로 만든다. */
export function ensureDefaultProfile(projectId: number): Profile {
  const list = listProfiles(projectId);
  if (list.length) return list.find((p) => p.is_default) ?? list[0];
  const id = Number(db.prepare(`INSERT INTO env_profiles (project_id, name, is_default) VALUES (?, 'local', 1)`).run(projectId).lastInsertRowid);
  return getProfile(id)!;
}

export function profileVars(profileId: number): EnvVar[] {
  const rows = db.prepare(`SELECT key, value, required, secret, source, found_in FROM env_vars WHERE profile_id = ? ORDER BY required DESC, key`).all(profileId) as VarRow[];
  return rows.map((r) => ({ key: r.key, value: decrypt(r.value), required: Boolean(r.required), secret: Boolean(r.secret), source: r.source as EnvSource, found_in: r.found_in }));
}

function writeVars(profileId: number, vars: EnvVar[], keepSource = false) {
  db.prepare(`DELETE FROM env_vars WHERE profile_id = ?`).run(profileId);
  const ins = db.prepare(`INSERT INTO env_vars (profile_id, key, value, required, secret, source, found_in) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const seen = new Set<string>();
  for (const v of vars) {
    const key = v.key.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // 저장된 값은 다음부터 "프로필" 출처로 보인다. 사용자가 직접 넣은 행만 직접 추가로 남긴다.
    const source = keepSource || v.source === 'manual' ? v.source : 'profile';
    ins.run(profileId, key, v.value ? encrypt(v.value) : null, v.required ? 1 : 0, v.secret || looksSecret(key) ? 1 : 0, source, v.found_in);
  }
}

export function createProfile(projectId: number, name: string, vars: EnvVar[], copyFrom?: number): Profile {
  const n = name.trim();
  if (!n) throw new Error('프로필 이름을 넣어 주세요.');
  if (listProfiles(projectId).some((p) => p.name === n)) throw new Error(`${n} 프로필이 이미 있습니다.`);
  const id = Number(db.prepare(`INSERT INTO env_profiles (project_id, name, is_default) VALUES (?, ?, 0)`).run(projectId, n).lastInsertRowid);
  writeVars(id, copyFrom ? profileVars(copyFrom) : vars);
  return getProfile(id)!;
}

export function deleteProfile(id: number) {
  const p = getProfile(id);
  if (!p) return;
  if (listProfiles(p.project_id).length <= 1) throw new Error('프로필이 하나뿐이라 지울 수 없습니다.');
  db.transaction(() => {
    db.prepare(`DELETE FROM env_profiles WHERE id = ?`).run(id);
    if (p.is_default) {
      const next = listProfiles(p.project_id)[0];
      if (next) db.prepare(`UPDATE env_profiles SET is_default = 1 WHERE id = ?`).run(next.id);
    }
  })();
}

type SessionEnvRow = { profile_id: number | null; overrides: string };

function sessionEnvRow(sessionId: number, projectId: number): SessionEnvRow | undefined {
  return db.prepare(`SELECT profile_id, overrides FROM session_env WHERE session_id = ? AND project_id = ?`).get(sessionId, projectId) as SessionEnvRow | undefined;
}

export function selectedProfile(sessionId: number, projectId: number): Profile {
  const row = sessionEnvRow(sessionId, projectId);
  const p = row?.profile_id ? getProfile(row.profile_id) : undefined;
  return p ?? ensureDefaultProfile(projectId);
}

export function sessionOverrides(sessionId: number, projectId: number): Record<string, string> {
  const row = sessionEnvRow(sessionId, projectId);
  if (!row) return {};
  const raw = JSON.parse(row.overrides) as Record<string, string>;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decrypt(v)]));
}

function upsertSessionEnv(sessionId: number, projectId: number, profileId: number, overrides: Record<string, string>) {
  const enc = JSON.stringify(Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, encrypt(v)])));
  db.prepare(`INSERT INTO session_env (session_id, project_id, profile_id, overrides) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, project_id) DO UPDATE SET profile_id = excluded.profile_id, overrides = excluded.overrides`)
    .run(sessionId, projectId, profileId, enc);
}

export function selectProfile(sessionId: number, projectId: number, profileId: number) {
  const p = getProfile(profileId);
  if (!p || p.project_id !== projectId) throw new Error('이 프로젝트의 프로필이 아닙니다.');
  upsertSessionEnv(sessionId, projectId, profileId, {});
}

export type SaveMode = 'profile' | 'new' | 'session';

/** 화면에서 고친 표를 저장 방식에 맞게 저장한다. */
export function saveSessionEnv(sessionId: number, projectId: number, mode: SaveMode, vars: EnvVar[], newName?: string) {
  const current = selectedProfile(sessionId, projectId);
  if (mode === 'profile') {
    writeVars(current.id, vars);
    upsertSessionEnv(sessionId, projectId, current.id, {});
    return current;
  }
  if (mode === 'new') {
    const p = createProfile(projectId, newName ?? '', vars);
    upsertSessionEnv(sessionId, projectId, p.id, {});
    return p;
  }
  // 이번 세션에만: 프로필과 다른 값만 덮어쓰기로 남긴다.
  const base = new Map(profileVars(current.id).map((v) => [v.key, v.value]));
  const overrides: Record<string, string> = {};
  for (const v of vars) if (v.key.trim() && base.get(v.key) !== v.value) overrides[v.key.trim()] = v.value;
  upsertSessionEnv(sessionId, projectId, current.id, overrides);
  return current;
}

/** 서버를 띄울 때 쓸 값: 프로필 값 위에 DB 설정이 만든 값, 그 위에 이번 세션 덮어쓰기를 얹는다. */
export function resolveEnv(sessionId: number, projectId: number): { env: Record<string, string>; vars: EnvVar[]; overrides: Record<string, string>; db: DbEnvEntry[] } {
  const p = selectedProfile(sessionId, projectId);
  const vars = profileVars(p.id);
  const overrides = sessionOverrides(sessionId, projectId);
  const dbVars = dbEnv(projectId);
  const env: Record<string, string> = {};
  for (const v of vars) if (v.value) env[v.key] = v.value;
  for (const d of dbVars) env[d.key] = d.value;
  for (const [k, v] of Object.entries(overrides)) { if (v) env[k] = v; else delete env[k]; }
  return { env, vars, overrides, db: dbVars };
}

/** 이번 세션에만 몇 개 값을 얹는다(나머지는 그대로). */
export function setSessionValues(sessionId: number, projectId: number, values: Record<string, string>) {
  // DB 설정이 만든 값은 덮어쓰기에 넣지 않는다(넣으면 DB 설정을 바꿔도 이 세션에 옛 값이 남는다).
  const current = selectedProfile(sessionId, projectId);
  const base = new Map(profileVars(current.id).map((v) => [v.key, v.value]));
  const next = { ...sessionOverrides(sessionId, projectId), ...values };
  for (const [k, v] of Object.entries(next)) if (base.get(k) === v) delete next[k];
  upsertSessionEnv(sessionId, projectId, current.id, next);
}

/** 세션이 쓰는 프로필에 몇 개 값을 넣는다(나머지는 그대로). 이 세션 덮어쓰기에 같은 키가 있으면 지워 프로필 값이 쓰이게 한다. */
export function setProfileValues(sessionId: number, projectId: number, values: { key: string; value: string; found_in?: string | null }[]) {
  const current = selectedProfile(sessionId, projectId);
  const merged = new Map(profileVars(current.id).map((v) => [v.key, v]));
  for (const v of values) {
    const prev = merged.get(v.key);
    merged.set(v.key, { key: v.key, value: v.value, required: prev?.required ?? false, secret: prev?.secret ?? false, source: prev?.source ?? 'ai', found_in: v.found_in ?? prev?.found_in ?? null });
  }
  writeVars(current.id, [...merged.values()], true);
  const overrides = sessionOverrides(sessionId, projectId);
  for (const v of values) delete overrides[v.key];
  upsertSessionEnv(sessionId, projectId, current.id, overrides);
}

export function missingRequired(sessionId: number, projectId: number, autoKeys: string[]): string[] {
  const { env, vars } = resolveEnv(sessionId, projectId);
  return vars.filter((v) => v.required && !env[v.key] && !autoKeys.includes(v.key)).map((v) => v.key);
}

/** 프로필이 비어 있으면 분석 결과로 채워 둔다. 출처 표시는 그대로 남겨 사용자가 확인하게 한다. */
/** 프로필에 없는 키를 필수(값 비움)로 더한다. 있는 키는 그대로 둔다. 더한 키 수를 돌려준다. */
export function addRequiredKeys(profileId: number, keys: { key: string; reason: string }[]): number {
  const cur = profileVars(profileId);
  const fresh = keys.filter((k) => !cur.some((v) => v.key === k.key.trim()));
  if (fresh.length === 0) return 0;
  writeVars(profileId, [...cur, ...fresh.map((k) => ({ key: k.key.trim(), value: '', required: true, secret: looksSecret(k.key), source: 'manual' as EnvSource, found_in: k.reason.slice(0, 200) }))], true);
  return fresh.length;
}

export function seedProfileIfEmpty(profileId: number, found: EnvVar[]) {
  if (profileVars(profileId).length > 0 || found.length === 0) return false;
  writeVars(profileId, found, true);
  return true;
}
