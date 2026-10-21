import type { ModelUsage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { db } from './db.js';

type Ref = { purpose: string; cwd?: string | null; sessionId?: number | null; chatId?: number | null; resumed?: boolean };
type Part = { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number };

/**
 * 결과 메시지 하나의 토큰·비용을 usage_log에 남긴다. 기록이 실패해도 호출은 그대로 진행한다.
 * modelUsage는 query() 하나 안의 누적값이라(이어지는 대화는 결과마다 지금까지의 합), 같은 Claude 세션의 직전 누적값을 빼서 이번 몫만 적는다.
 */
export function recordUsage(msg: SDKResultMessage, ref: Ref) {
  try {
    const cum = msg.modelUsage ?? {};
    // 비정상 종료 결과는 0으로 올 수 있다. 남기면 다음 결과의 몫을 누적 전체로 잘못 센다.
    if (!Object.values(cum).some((u) => u.inputTokens || u.outputTokens || u.cacheReadInputTokens || u.cacheCreationInputTokens)) return;
    const prev = db.prepare(`SELECT cumulative FROM usage_log WHERE claude_session_id = ? ORDER BY id DESC LIMIT 1`).get(msg.session_id) as { cumulative: string } | undefined;
    const before: Record<string, ModelUsage> = prev ? JSON.parse(prev.cumulative) : {};
    // /clear 하면 누적이 처음부터 다시 시작한다. 줄어든 모델이 있으면 직전 값을 빼지 않는다.
    const reset = Object.entries(cum).some(([m, u]) => before[m] && u.outputTokens < before[m].outputTokens);
    const models: Record<string, Part> = {};
    const total: Part = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 };
    for (const [m, u] of Object.entries(cum)) {
      const b = reset ? undefined : before[m];
      const part: Part = {
        input: u.inputTokens - (b?.inputTokens ?? 0),
        output: u.outputTokens - (b?.outputTokens ?? 0),
        cache_read: u.cacheReadInputTokens - (b?.cacheReadInputTokens ?? 0),
        cache_write: u.cacheCreationInputTokens - (b?.cacheCreationInputTokens ?? 0),
        cost_usd: u.costUSD - (b?.costUSD ?? 0),
      };
      if (!part.input && !part.output && !part.cache_read && !part.cache_write) continue;
      models[m] = part;
      for (const k of Object.keys(total) as (keyof Part)[]) total[k] += part[k];
    }
    db.prepare(`INSERT INTO usage_log (purpose, session_id, chat_id, cwd, claude_session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, models, cumulative, num_turns, duration_ms, is_error, carried) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ref.purpose, ref.sessionId ?? null, ref.chatId ?? null, ref.cwd ?? null, msg.session_id,
      total.input, total.output, total.cache_read, total.cache_write, total.cost_usd,
      JSON.stringify(models), JSON.stringify(cum), msg.num_turns, msg.duration_ms, msg.subtype !== 'success' || msg.is_error ? 1 : 0,
      // 이 기록을 만들기 전부터 이어 온 대화는 첫 결과에 예전 사용량까지 들어 있다. 집계할 때 걸러 낼 수 있게 표시한다.
      !prev && ref.resumed ? 1 : 0,
    );
  } catch (err) {
    console.warn('[usage] 사용량을 남기지 못했습니다:', (err as Error).message);
  }
}

type Sum = { calls: number; input: number; output: number; cache_read: number; cache_write: number; cost_usd: number };
export type UsageReport = {
  days: number;
  totals: Sum & { errors: number };
  /** 기록 전부터 이어 온 대화의 첫 결과라 예전 사용량이 섞여 집계에서 뺀 건수 */
  carried: number;
  by_purpose: (Sum & { purpose: string })[];
  by_model: (Sum & { model: string })[];
  by_day: (Sum & { day: string })[];
  by_session: (Sum & { session_id: number; ticket: string; summary: string; workspace_name: string; closed: boolean })[];
};

const sumCols = (t = '') => `COUNT(*) AS calls, SUM(${t}input_tokens) AS input, SUM(${t}output_tokens) AS output, SUM(${t}cache_read_tokens) AS cache_read,
  SUM(${t}cache_write_tokens) AS cache_write, SUM(${t}cost_usd) AS cost_usd`;

/** 사용량 보고서. days가 0이면 전체 기간, 아니면 오늘을 포함한 최근 days일(로컬 날짜 기준). */
export function usageReport(days: number): UsageReport {
  const since = (t = '') => (days > 0 ? ` AND date(${t}created_at, 'localtime') >= date('now', 'localtime', '-${days - 1} days')` : '');
  const where = `carried = 0${since()}`;
  const totals = db.prepare(`SELECT ${sumCols()}, SUM(is_error) AS errors FROM usage_log WHERE ${where}`).get() as UsageReport['totals'];
  const carried = (db.prepare(`SELECT COUNT(*) AS n FROM usage_log WHERE carried = 1${since()}`).get() as { n: number }).n;
  const by_purpose = db.prepare(`SELECT purpose, ${sumCols()} FROM usage_log WHERE ${where} GROUP BY purpose ORDER BY cost_usd DESC`).all() as UsageReport['by_purpose'];
  const by_day = db.prepare(`SELECT date(created_at, 'localtime') AS day, ${sumCols()} FROM usage_log WHERE ${where} GROUP BY day ORDER BY day DESC`).all() as UsageReport['by_day'];
  const by_session = (db.prepare(`SELECT u.session_id, s.ticket, s.summary, s.closed, w.name AS workspace_name, ${sumCols('u.')}
    FROM usage_log u JOIN sessions s ON s.id = u.session_id JOIN workspaces w ON w.id = s.workspace_id
    WHERE u.carried = 0${since('u.')} GROUP BY u.session_id ORDER BY cost_usd DESC LIMIT 30`).all() as (Sum & { session_id: number; ticket: string; summary: string; workspace_name: string; closed: number })[])
    .map((r) => ({ ...r, closed: Boolean(r.closed) }));

  const models = new Map<string, Sum>();
  for (const r of db.prepare(`SELECT models FROM usage_log WHERE ${where}`).all() as { models: string }[]) {
    let parsed: Record<string, Part>;
    try { parsed = JSON.parse(r.models); } catch { continue; }
    for (const [m, p] of Object.entries(parsed)) {
      const s = models.get(m) ?? { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 };
      s.calls += 1; s.input += p.input; s.output += p.output; s.cache_read += p.cache_read; s.cache_write += p.cache_write; s.cost_usd += p.cost_usd;
      models.set(m, s);
    }
  }
  const by_model = [...models].map(([model, s]) => ({ model, ...s })).sort((a, b) => b.cost_usd - a.cost_usd);

  const zero = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0, errors: 0 };
  // 행이 없으면 SUM이 null이다.
  const t = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v ?? 0])) as UsageReport['totals'];
  return { days, totals: { ...zero, ...t }, carried, by_purpose, by_model, by_day, by_session };
}
