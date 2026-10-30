import { db } from './db.js';
import { type DbConnection, guessFromEnv, guessFromParts, listConnections } from './dbconn.js';
import { engineSupported, explainQuery, type ExplainResult } from './dbquery.js';
import { resolveEnv } from './envstore.js';

/**
 * 쿼리 감시에서 실행 계획을 받을 DB 연결. DB 설정에 등록한 연결이 먼저이고, 없으면 서버를 띄울 때 넣는 환경값
 * (SPRING_DATASOURCE_URL, ORACLE_HOST·ORACLE_SID 등)에서 짐작한 연결을 쓴다. 짐작한 연결은 id가 음수다.
 */
export function worktreeDbs(worktreeId: number): (DbConnection & { from_env: boolean })[] {
  const w = db.prepare(`SELECT session_id, project_id FROM worktrees WHERE id = ?`).get(worktreeId) as { session_id: number; project_id: number } | undefined;
  if (!w) return [];
  const saved = listConnections(w.project_id).filter(engineSupported).map((c) => ({ ...c, from_env: false }));
  if (saved.length) return saved;
  const { env } = resolveEnv(w.session_id, w.project_id);
  const seen = new Set<string>();
  return [...guessFromEnv(env), ...guessFromParts(env)]
    .filter((p) => {
      const k = `${p.engine}|${p.host}|${p.port}|${p.database}|${p.username}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((p, i) => ({
      ...p, id: -(i + 1), project_id: w.project_id, name: `서버 환경값 ${p.database || p.host}`, env_map: {}, enabled: false, note: '', from_env: true,
    }))
    .filter(engineSupported);
}

/** 접속 자체가 안 되는 오류(주소·서비스·계정). 짐작한 연결이 여럿이면 다음 것으로 넘어간다. */
const CONNECT_ERROR = /ORA-12514|ORA-12505|ORA-12541|ORA-01017|NJS-5\d\d|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/;
/** 워크트리마다 마지막으로 붙은 연결. 다음 실행 계획부터 그 연결을 먼저 쓴다. */
const lastGood = new Map<number, number>();

export async function explainFor(worktreeId: number, sql: string, opts: { connectionId?: number; analyze?: boolean }): Promise<ExplainResult & { connection_id: number }> {
  const dbs = worktreeDbs(worktreeId);
  if (!dbs.length) throw new Error('이 앱에 질의할 수 있는 DB 연결이 없습니다. DB 설정에서 연결을 추가하거나, 환경값에 DB 주소(SPRING_DATASOURCE_URL이나 ORACLE_HOST 등)를 넣으세요.');
  const picked = opts.connectionId !== undefined ? dbs.filter((c) => c.id === opts.connectionId) : [];
  if (opts.connectionId !== undefined && !picked.length) throw new Error('DB 연결이 없습니다. 목록을 새로 고쳐 주세요.');
  const order = picked.length ? picked : [...dbs].sort((a, b) => Number(b.id === lastGood.get(worktreeId)) - Number(a.id === lastGood.get(worktreeId)) || Number(b.enabled) - Number(a.enabled));
  let lastErr: Error | null = null;
  for (const c of order) {
    try {
      const r = await explainQuery(c, sql, { analyze: opts.analyze });
      lastGood.set(worktreeId, c.id);
      return { ...r, connection_id: c.id };
    } catch (err) {
      lastErr = err as Error;
      if (picked.length || !CONNECT_ERROR.test(lastErr.message)) throw lastErr;
    }
  }
  throw new Error(`DB에 붙지 못했습니다 (${order.map((c) => c.name).join(', ')}): ${lastErr?.message}`);
}
