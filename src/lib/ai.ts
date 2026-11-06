// Claude API client for the ComboTrader agents. Without ANTHROPIC_API_KEY the agents run in demo mode
// (rule-based drafts), so the whole pipeline — proposals, approvals, execution — works and can be tested.
import { personaLine } from './personas';
import { instructionsLine } from './instructions';
import { q, now } from './db';
import { config } from './config';
import { settings } from './settings';

export type Provider = 'anthropic' | 'openai';
export const providerReady = (p: Provider) => (p === 'anthropic' ? !!config.anthropicKey : !!config.openaiKey);
/** The provider chosen in Admin → AI agents (falls back to whichever has a key). */
export function aiProvider(): Provider {
  const want = (settings() as any).ai_provider === 'openai' ? 'openai' : 'anthropic';
  return providerReady(want) ? want : providerReady(want === 'openai' ? 'anthropic' : 'openai') ? (want === 'openai' ? 'anthropic' : 'openai') : want;
}
export const providerName = (p: Provider) => (p === 'anthropic' ? 'Claude (Anthropic)' : config.openaiBaseUrl.includes('api.openai.com') ? 'OpenAI' : `OpenAI-compatible (${new URL(config.openaiBaseUrl).hostname})`);
export const aiLive = () => providerReady('anthropic') || providerReady('openai');

/** Admin → AI agents: one switch for all agents, with an optional per-agent override. */
export function agentMode(agent: string): 'ai' | 'rules' {
  const s = settings() as any;
  let o: Record<string, string> = {};
  try { o = typeof s.agent_modes === 'string' ? JSON.parse(s.agent_modes || '{}') : s.agent_modes || {}; } catch { o = {}; }
  const m = o[agent] === 'ai' || o[agent] === 'rules' ? o[agent] : s.agent_mode;
  return m === 'rules' ? 'rules' : 'ai';
}
/** True when this agent should call Claude now: AI mode chosen and a key on the server. */
export const useAI = (agent: string) => aiLive() && agentMode(agent) === 'ai';

export function callsToday() {
  return Number(q.val("SELECT COUNT(*) FROM agent_runs WHERE created_at>=? AND model!='demo'", new Date(Date.now() - 864e5).toISOString()) ?? 0);
}

export class AiUnavailable extends Error {}

/**
 * One model call that must return JSON. The system prompt states the policy; `input` is the data.
 * Logged to agent_runs with token counts so admins can see cost.
 */
export async function completeJson<T = any>(agent: string, o: { system: string; input: unknown; trigger?: string; fast?: boolean; maxTokens?: number; tools?: unknown[]; persona?: string }): Promise<{ data: T; runId: number }> {
  if (!aiLive()) throw new AiUnavailable('No AI key (ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  if (agentMode(agent) === 'rules') throw new AiUnavailable('Agent is in rules mode');
  if (callsToday() >= settings().agent_daily_limit) throw new AiUnavailable('Daily agent limit reached');
  const input = typeof o.input === 'string' ? o.input : JSON.stringify(o.input);
  const system = `${personaLine(o.persona || agent)}\n${o.system}\n${instructionsLine(agent)}\n\nReply with one JSON object only, no prose before or after it.`;
  const first = aiProvider();
  const order: Provider[] = [first];
  // Web search is a Claude server tool, so those calls stay on Claude. Otherwise fall back to the other provider on failure.
  if (!o.tools && settings().ai_fallback && providerReady(first === 'anthropic' ? 'openai' : 'anthropic')) order.push(first === 'anthropic' ? 'openai' : 'anthropic');
  if (o.tools && first !== 'anthropic') { if (!providerReady('anthropic')) throw new AiUnavailable('Web research needs Claude (ANTHROPIC_API_KEY)'); order.splice(0, order.length, 'anthropic'); }
  let lastErr: any = null;
  for (const p of order) {
    const model = p === 'anthropic' ? (o.fast ? config.aiModelFast : config.aiModel) : (o.fast ? config.openaiModelFast : config.openaiModel);
    let text = '', tin = 0, tout = 0;
    try {
      ({ text, tin, tout } = p === 'anthropic' ? await callAnthropic(model, system, input, o) : await callOpenAI(model, system, input, o));
      const data = extractJson<T>(text);
      const runId = logRun(agent, o.trigger, input, text, model, tin, tout, 'ok');
      return { data, runId };
    } catch (e: any) {
      logRun(agent, o.trigger, input, text, model, tin, tout, `error: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

async function callAnthropic(model: string, system: string, input: string, o: { maxTokens?: number; tools?: unknown[] }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: o.maxTokens || 1500, system, messages: [{ role: 'user', content: input }], ...(o.tools ? { tools: o.tools } : {}) }),
    signal: AbortSignal.timeout(o.tools ? 180_000 : 60_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `Claude API ${res.status}`);
  // With server tools (web search) the answer is the text after the last tool result.
  const blocks: any[] = j.content || [];
  let lastTool = -1; blocks.forEach((b, i) => { if (String(b.type).endsWith('_tool_result')) lastTool = i; });
  return { text: blocks.slice(lastTool + 1).filter((b) => b.type === 'text').map((b) => b.text).join(''), tin: j.usage?.input_tokens || 0, tout: j.usage?.output_tokens || 0 };
}

/** OpenAI Chat Completions, which most other providers also accept (Gemini, DeepSeek, OpenRouter, Groq…). */
async function callOpenAI(model: string, system: string, input: string, o: { maxTokens?: number }) {
  const official = config.openaiBaseUrl.includes('api.openai.com');
  const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
      ...(official ? { max_completion_tokens: Math.max(4000, o.maxTokens || 1500), response_format: { type: 'json_object' } } : { max_tokens: o.maxTokens || 1500 }) }),
    signal: AbortSignal.timeout(90_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `AI API ${res.status}`);
  return { text: String(j.choices?.[0]?.message?.content || ''), tin: j.usage?.prompt_tokens || 0, tout: j.usage?.completion_tokens || 0 };
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
