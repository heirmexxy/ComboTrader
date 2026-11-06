// Claude credit: what the agents cost and how much credit is left.
// Anthropic has no API for the credit balance itself, so you record the balance shown in the Claude Console when you
// top up; spending since then comes from Anthropic's Cost API (needs an Admin API key, ANTHROPIC_ADMIN_KEY), which
// covers everything on the account. Without that key we can only show the agents' token counts.
import { q } from './db';
import { config } from './config';
import { settings } from './settings';

let cache: { key: string; at: number; days: { day: string; usd: number }[] } | null = null;

/** Daily spend in USD from Anthropic's Cost API since a date (cached for an hour). */
export async function costByDay(sinceISO: string): Promise<{ day: string; usd: number }[] | null> {
  if (!config.anthropicAdminKey) return null;
  const start = `${sinceISO.slice(0, 10)}T00:00:00Z`;
  if (cache && cache.key === start && Date.now() - cache.at < 3600e3) return cache.days;
  const days: { day: string; usd: number }[] = [];
  let page: string | null = null;
  for (let i = 0; i < 12; i++) {
    const u = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    u.searchParams.set('starting_at', start); u.searchParams.set('bucket_width', '1d'); u.searchParams.set('limit', '31');
    if (page) u.searchParams.set('page', page);
    const res = await fetch(u, { headers: { 'x-api-key': config.anthropicAdminKey, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(20_000) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error?.message || `Cost API ${res.status}`);
    // Amounts are in cents, as decimal strings ("123.45" = $1.23).
    for (const b of j.data || []) days.push({ day: String(b.starting_at).slice(0, 10), usd: (b.results || []).reduce((t: number, r: any) => t + (Number(r.amount) || 0), 0) / 100 });
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  cache = { key: start, at: Date.now(), days };
  return days;
}

export interface CreditStatus {
  source: 'cost_api' | 'tokens_only';
  creditSet: number | null; creditSetAt: string | null;
  spentSince: number | null; left: number | null;
  yesterday: number | null; last7: number | null; perDay: number | null; runwayDays: number | null;
  tokens7: { calls: number; tin: number; tout: number };
  creditErrors24h: number; error: string | null;
}

/** Credit left = balance you recorded − spend since then; runway = left ÷ average daily spend over 7 days. */
export async function creditStatus(): Promise<CreditStatus> {
  const s = settings();
  const creditSet = Number(s.ai_credit_usd) > 0 ? Number(s.ai_credit_usd) : null;
  const creditSetAt = String(s.ai_credit_at || '') || null;
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const t = q.get<any>('SELECT COUNT(*) calls, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout FROM agent_runs WHERE created_at>=?', since7);
  const creditErrors24h = Number(q.val("SELECT COUNT(*) FROM agent_runs WHERE created_at>=? AND (status LIKE '%credit balance%' OR status LIKE '%billing%')", new Date(Date.now() - 864e5).toISOString()) ?? 0);
  const out: CreditStatus = { source: 'tokens_only', creditSet, creditSetAt, spentSince: null, left: null, yesterday: null, last7: null, perDay: null, runwayDays: null, tokens7: { calls: t.calls, tin: t.tin, tout: t.tout }, creditErrors24h, error: null };
  try {
    const from = creditSetAt && creditSetAt < since7 ? creditSetAt : since7;
    const days = await costByDay(from);
    if (days) {
      out.source = 'cost_api';
      const today = new Date().toISOString().slice(0, 10), yday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      out.yesterday = Math.round((days.find((d) => d.day === yday)?.usd ?? 0) * 100) / 100;
      out.last7 = Math.round(days.filter((d) => d.day >= since7.slice(0, 10) && d.day < today).reduce((a, d) => a + d.usd, 0) * 100) / 100;
      out.perDay = Math.round((out.last7 / 7) * 100) / 100;
      if (creditSet && creditSetAt) {
        // Spend from the day the balance was recorded (that day counted in full, so "left" errs on the low side).
        out.spentSince = Math.round(days.filter((d) => d.day >= creditSetAt.slice(0, 10)).reduce((a, d) => a + d.usd, 0) * 100) / 100;
        out.left = Math.round((creditSet - out.spentSince) * 100) / 100;
        out.runwayDays = out.perDay ? Math.floor(Math.max(0, out.left) / out.perDay) : null;
      }
    }
  } catch (e: any) { out.error = String(e?.message || e).slice(0, 200); }
  return out;
}

export const usd = (n: number | null) => (n === null ? '–' : `$${n.toFixed(2)}`);
/** One line for briefs and the admin page. */
export function creditLine(c: CreditStatus) {
  if (c.source === 'tokens_only') return `${c.tokens7.calls} AI calls in 7 days (${Math.round((c.tokens7.tin + c.tokens7.tout) / 1000)}k tokens). Add an Anthropic Admin API key to see dollars${c.error ? ` (cost report error: ${c.error})` : ''}.`;
  return `${c.left !== null ? `${usd(c.left)} credit left (${usd(c.creditSet)} recorded ${String(c.creditSetAt).slice(0, 10)}, ${usd(c.spentSince)} spent since)` : 'Credit balance not recorded yet'} · yesterday ${usd(c.yesterday)} · last 7 days ${usd(c.last7)}${c.runwayDays !== null ? ` · about ${c.runwayDays} days left at this rate` : ''}.`;
}
