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
