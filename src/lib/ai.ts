// Claude API client for the ComboTrader agents. Without ANTHROPIC_API_KEY the agents run in demo mode
// (rule-based drafts), so the whole pipeline — proposals, approvals, execution — works and can be tested.
import { q, now } from './db';
import { config } from './config';
import { settings } from './settings';

export const aiLive = () => !!config.anthropicKey;

export function callsToday() {
  return Number(q.val("SELECT COUNT(*) FROM agent_runs WHERE created_at>=? AND model!='demo'", new Date(Date.now() - 864e5).toISOString()) ?? 0);
}

export class AiUnavailable extends Error {}

/**
 * One model call that must return JSON. The system prompt states the policy; `input` is the data.
 * Logged to agent_runs with token counts so admins can see cost.
 */
export async function completeJson<T = any>(agent: string, o: { system: string; input: unknown; trigger?: string; fast?: boolean; maxTokens?: number }): Promise<{ data: T; runId: number }> {
  if (!aiLive()) throw new AiUnavailable('No ANTHROPIC_API_KEY');
  if (callsToday() >= settings().agent_daily_limit) throw new AiUnavailable('Daily agent limit reached');
  const model = o.fast ? config.aiModelFast : config.aiModel;
  const input = typeof o.input === 'string' ? o.input : JSON.stringify(o.input);
  let status = 'ok', text = '', tin = 0, tout = 0;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: o.maxTokens || 1500,
        system: `${o.system}\n\nReply with one JSON object only, no prose before or after it.`,
        messages: [{ role: 'user', content: input }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error?.message || `Claude API ${res.status}`);
    text = (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    tin = j.usage?.input_tokens || 0; tout = j.usage?.output_tokens || 0;
    const data = extractJson<T>(text);
    const runId = logRun(agent, o.trigger, input, text, model, tin, tout, status);
    return { data, runId };
  } catch (e: any) {
    status = `error: ${e.message}`;
    logRun(agent, o.trigger, input, text, model, tin, tout, status);
    throw e;
  }
}

export function logRun(agent: string, trigger: string | undefined, input: string, output: string, model: string, tin = 0, tout = 0, status = 'ok') {
  return q.insert('agent_runs', { agent, trigger: trigger ?? null, input: input.slice(0, 20000), output: output.slice(0, 20000), model, tokens_in: tin, tokens_out: tout, status: status.slice(0, 500), created_at: now() }).id;
}

export function extractJson<T>(text: string): T {
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('The model did not return JSON');
}

/** The rules every agent works under. Kept in one place so they can be reviewed. */
export const POLICY = `You work for ComboTrader, a platform of Kitovu Technology Company Limited (Iseyin, Oyo State, Nigeria).
Champions put money into real agricultural commodity trades (Trade Lots) that have a signed buyer. Kitovu buys from farmers, delivers to the buyer and pays Champions principal plus earnings on the payout date shown on their Trade Certificate.
If a buyer pays late or does not pay, Kitovu still pays Champions on the payout date from its own balance sheet. Trades are not bank deposits, are not NDIC-insured, and depend on Kitovu remaining able to pay.
Rules you must follow:
- Never promise returns other than the rate and date on a lot or certificate. Never call trades "investments" or "guaranteed by a bank or government". Say "earnings", "Trade Lot", "Champion".
- Never ask for or repeat passwords, PINs, one-time codes, BVNs, card numbers or full account numbers.
- You cannot move money, approve withdrawals, change balances, or change payout dates. If someone needs that, hand over to the team.
- No legal, tax or personal financial advice; suggest a qualified adviser.
- Be warm, short and plain. Write in the Champion's language when one is given.
- If you are not sure, say so and hand over to a person. Do not invent facts.`;
