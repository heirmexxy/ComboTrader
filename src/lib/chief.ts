// Chief of Staff agent. Every morning it reads the whole platform (health, money, lots, queues, marketing
// results, progress against the playbook's targets), writes one brief for the founder with ranked
// recommendations, assigns tasks to the other agents, and learns which tasks actually move results.
// It cannot move money, change rates or terms, or publish anything itself: tasks only ask agents to do their
// normal work, whose outputs still follow the approval rules. Works with AI (richer brief and judgement) or
// without (fixed thresholds).
import { q, now } from './db';
import { config } from './config';
import { settings, setSetting } from './settings';
import { completeJson, useAI, AiUnavailable, POLICY, logRun, callsToday } from './ai';
import { agentOn, executeAction, AGENT_JOBS, researchProspects } from './agents';
import { learn, bestLesson, scoreLesson, lessonScore, type Lesson } from './learning';
import { queueEmail, emailShell, escapeHtml } from './notify';
import { audit } from './audit';
import { runChecks } from './watchdog';
import { paystackFloat } from './paysync';
import { treasurySnapshot } from './treasury';
import { createPost, planForLot, lotPushAudience, proposeCampaign } from './marketing';
import { runLibrary } from './library';
import { fmtNGN, lagosNow } from './util';
import { offMessage, playbookFor, TARGETS_90, PROSPECT_SEGMENTS, PROSPECT_REGIONS } from '../content/playbook';
import { marked } from 'marked';

/** What the Chief of Staff may ask each agent to do. */
export const TASK_KINDS = {
  'social.promote_lot': { agent: 'social', what: 'Prepare a post now for a lot that is behind', needs: 'lot_code' },
  'email.lot_push': { agent: 'email', what: 'Email past funders about a lot that is behind', needs: 'lot_code' },
  'social.pause_promotion': { agent: 'social', what: 'Stop promoting new lots for some days (e.g. Treasury short)', needs: 'days' },
  'social.boost_topic': { agent: 'social', what: 'Favour a how-to topic that is getting clicks', needs: 'topic' },
  'email.retire_template': { agent: 'email', what: 'Switch off an email or post wording that keeps losing', needs: 'lesson_id' },
  'onboarding.run': { agent: 'onboarding', what: 'Nudge Champions stuck between sign-up and first trade now', needs: '' },
  'prospector.research': { agent: 'prospector', what: 'Find more organisations of a type in a city (AI only)', needs: 'segment, region' },
  'growth.library': { agent: 'growth', what: 'Prepare the next library article or newsletter if due', needs: '' },
} as const;
export type TaskKind = keyof typeof TASK_KINDS;
interface TaskIn { kind: TaskKind; detail?: Record<string, unknown>; reason: string }
interface Rec { priority: number; text: string; link?: string }

const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
const num = (sql: string, ...p: (string | number | null)[]) => Number(q.val(sql, ...p) ?? 0);

// ---------- Facts ----------
function lotsFacts() {
  return q.all<any>(`SELECT l.code, l.title, l.target_amount, l.closes_at, (SELECT COALESCE(SUM(t.amount),0) FROM trades t WHERE t.lot_id=l.id AND t.status!='cancelled') AS funded
    FROM lots l WHERE l.status='open' AND l.closes_at>? ORDER BY l.closes_at`, now())
    .map((l) => ({ code: l.code, title: l.title, pct: Math.round((l.funded / Math.max(1, l.target_amount)) * 100), days_left: Math.max(0, Math.round((new Date(l.closes_at).getTime() - Date.now()) / 864e5 * 10) / 10), remaining: fmtNGN(Math.max(0, l.target_amount - l.funded)) }));
}
export function lotPct(code: string) {
  const l = q.get<any>(`SELECT l.target_amount, (SELECT COALESCE(SUM(t.amount),0) FROM trades t WHERE t.lot_id=l.id AND t.status!='cancelled') AS funded FROM lots l WHERE l.code=?`, code);
  return l ? Math.round((l.funded / Math.max(1, l.target_amount)) * 100) : 0;
}
function startedAt() {
  let s = String(settings().chief_start_at || '');
  if (!s) { s = now(); setSetting('chief_start_at', s); }
  return s;
}
export async function gatherFacts() {
  const since = startedAt();
  const health = await runChecks().catch(() => []);
  const pf = await paystackFloat().catch(() => null);
  const tre = treasurySnapshot();
  const queue = q.all<any>("SELECT agent, risk, COUNT(*) n, MIN(created_at) oldest FROM agent_actions WHERE status='proposed' GROUP BY agent, risk");
  const social = q.all<any>(`SELECT p.kind, COUNT(*) posts, COALESCE(SUM((SELECT COALESCE(SUM(clicks),0) FROM links WHERE campaign='post-' || p.id)),0) clicks FROM social_posts p WHERE p.created_at>=? AND p.status IN ('published','partly') GROUP BY p.kind`, ago(30));
  const learnTopics = q.all<any>(`SELECT substr(p.ref, 7, instr(substr(p.ref, 7), ':') - 1) topic, COUNT(*) posts, COALESCE(SUM((SELECT COALESCE(SUM(clicks),0) FROM links WHERE campaign='post-' || p.id)),0) clicks FROM social_posts p WHERE p.ref LIKE 'learn:%' AND p.created_at>=? GROUP BY topic`, ago(45));
  const progress = {
    days_since_start: Math.floor((Date.now() - new Date(since).getTime()) / 864e5),
    leads: num('SELECT COUNT(*) FROM leads WHERE created_at>=?', since), signups: num("SELECT COUNT(*) FROM users WHERE role='champion' AND created_at>=?", since),
    first_trades: num("SELECT COUNT(DISTINCT user_id) FROM trades WHERE created_at>=? AND user_id IN (SELECT id FROM users WHERE role='champion')", since),
    circles: num("SELECT COUNT(*) FROM circles WHERE created_at>=?", since), prospects_talking: num("SELECT COUNT(*) FROM prospects WHERE status IN ('replied','meeting','won')"),
  };
  return {
    date: lagosNow().toISOString().slice(0, 10),
    health: health.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
    paystack: pf && pf.balance !== null ? { low: pf.low, summary: pf.summary } : null,
    treasury: tre.horizons.map((h) => ({ days: h.horizon, level: h.level })), overdue_buyers: tre.overdue.length,
    lots: lotsFacts(),
    queue: { total: queue.reduce((s, r) => s + r.n, 0), by: queue.map((r) => `${r.agent}/${r.risk}: ${r.n}`), oldest_hours: queue.length ? Math.round((Date.now() - Math.min(...queue.map((r) => new Date(r.oldest).getTime()))) / 3600e3) : 0 },
    waiting: { chats: num("SELECT COUNT(*) FROM chats WHERE status='needs_person' AND updated_at<=?", ago(4 / 24)), tickets: num("SELECT COUNT(*) FROM tickets WHERE status='open'"), withdrawals: num("SELECT COUNT(*) FROM withdrawals WHERE status IN ('requested','approved') AND created_at<=?", ago(1)), id_checks: num("SELECT COUNT(*) FROM users WHERE kyc_status='pending' AND kyc_method='document'") },
    week: { signups: num("SELECT COUNT(*) FROM users WHERE role='champion' AND created_at>=?", ago(7)), verified_not_funded: num("SELECT COUNT(*) FROM users u WHERE u.role='champion' AND u.kyc_status='verified' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id=u.id AND p.status='success')"), leads: num('SELECT COUNT(*) FROM leads WHERE created_at>=?', ago(7)), funded_naira: fmtNGN(num("SELECT COALESCE(SUM(amount-fee),0) FROM payments WHERE status='success' AND paid_at>=?", ago(7))) },
    social, learn_topics: learnTopics,
    progress, targets_90: TARGETS_90,
    ai_calls_today: callsToday(), ai_limit: settings().agent_daily_limit,
  };
}
type Facts = Awaited<ReturnType<typeof gatherFacts>>;

// ---------- Rules (also the safety net under the AI) ----------
function recentTask(kind: TaskKind, key: string, days: number) {
  return !!q.get("SELECT 1 FROM agent_tasks WHERE kind=? AND detail LIKE ? AND created_at>=?", kind, `%${key}%`, ago(days));
}
/** Score of a task kind learned from past outcomes (0..1, 0.5 when unknown). */
function kindScore(kind: TaskKind) { const l = bestLesson('chief', 'advice', `task:${kind}`); return l ? lessonScore(l) : 0.5; }

export function rulePlan(f: Facts) {
  const recs: Rec[] = [], tasks: TaskIn[] = [];
  if (f.health.length) recs.push({ priority: 1, text: `System health needs attention: ${f.health.join('; ')}.`, link: '/admin' });
  if (f.paystack?.low) recs.push({ priority: 1, text: `Top up the Paystack balance: ${f.paystack.summary}`, link: '/admin/withdrawals' });
  const short = f.treasury.find((h) => h.level === 'short');
  if (short) {
    recs.push({ priority: 1, text: `Treasury shows a shortfall within ${short.days} days. Review cash, the credit line and buyer money due; I’ve paused promotion of new lots for 7 days.`, link: '/admin/treasury' });
    if (!String(settings().social_paused_until || '').startsWith(lagosNow().toISOString().slice(0, 10)) && !recentTask('social.pause_promotion', '', 6)) tasks.push({ kind: 'social.pause_promotion', detail: { days: 7 }, reason: `Treasury short within ${short.days} days` });
  }
  if (f.overdue_buyers) recs.push({ priority: 2, text: `${f.overdue_buyers} buyer payment${f.overdue_buyers > 1 ? 's are' : ' is'} overdue. Chase them; Champions are still paid on time.`, link: '/admin/treasury' });
  for (const l of f.lots) {
    if (l.days_left <= 5 && l.pct < 70 && !short) {
      // Prefer what has worked before: try the better-scoring push first, and both when far behind.
      const order: TaskKind[] = kindScore('email.lot_push') >= kindScore('social.promote_lot') ? ['email.lot_push', 'social.promote_lot'] : ['social.promote_lot', 'email.lot_push'];
      const both = l.pct < 40 || l.days_left <= 2;
      for (const k of both ? order : order.slice(0, 1)) if (!recentTask(k, l.code, 3)) tasks.push({ kind: k, detail: { lot_code: l.code, pct_before: l.pct }, reason: `${l.code} is ${l.pct}% funded with ${l.days_left} days left` });
      if (l.days_left <= 2 && l.pct < 50) recs.push({ priority: 2, text: `${l.title} (${l.code}) is ${l.pct}% funded and closes in ${l.days_left} days. Decide whether to extend the closing date or reduce the lot size.`, link: '/admin/lots' });
    }
  }
  if (!f.lots.length && f.week.leads + f.week.signups > 0) recs.push({ priority: 2, text: `No lots are open, but ${f.week.leads} leads and ${f.week.signups} sign-ups came in this week. Open the next lot when a buyer order is ready.`, link: '/admin/lots' });
  if (f.queue.total > 20 || f.queue.oldest_hours > 48) recs.push({ priority: 3, text: `${f.queue.total} agent proposals are waiting (oldest ${f.queue.oldest_hours}h). I’ve triaged them: approve the safe ones in one click.`, link: '/admin/chief#triage' });
  if (f.waiting.chats) recs.push({ priority: 2, text: `${f.waiting.chats} website or WhatsApp chat${f.waiting.chats > 1 ? 's have' : ' has'} waited over 4 hours for a person.`, link: '/admin/chats' });
  if (f.waiting.withdrawals) recs.push({ priority: 2, text: `${f.waiting.withdrawals} withdrawal${f.waiting.withdrawals > 1 ? 's have' : ' has'} waited over a day.`, link: '/admin/withdrawals' });
  if (f.waiting.id_checks) recs.push({ priority: 3, text: `${f.waiting.id_checks} ID document${f.waiting.id_checks > 1 ? 's' : ''} waiting for review.`, link: '/admin/verification' });
  if (f.week.verified_not_funded >= 3 && !recentTask('onboarding.run', '', 3)) tasks.push({ kind: 'onboarding.run', reason: `${f.week.verified_not_funded} verified Champions haven’t funded yet`, detail: { stuck_before: f.week.verified_not_funded } });
  // What's working: favour the how-to topic with the best clicks per post (needs at least 2 posts each).
  const topics = f.learn_topics.filter((t: any) => t.posts >= 2 && t.topic).map((t: any) => ({ ...t, cpp: t.clicks / t.posts })).sort((a: any, b: any) => b.cpp - a.cpp);
  if (topics.length >= 2 && topics[0].cpp >= 2 * Math.max(0.5, topics[topics.length - 1].cpp) && !recentTask('social.boost_topic', '', 13)) tasks.push({ kind: 'social.boost_topic', detail: { topic: topics[0].topic, cpp_before: topics[0].cpp }, reason: `“${topics[0].topic}” posts get ${topics[0].cpp.toFixed(1)} clicks each vs ${topics[topics.length - 1].cpp.toFixed(1)} for “${topics[topics.length - 1].topic}”` });
  // What's not working: wording that keeps losing against an alternative.
  for (const agent of ['email', 'social'] as const) {
    const ls = q.all<Lesson>("SELECT * FROM agent_lessons WHERE agent=? AND active=1 AND kind IN ('template','post') AND wins + losses >= 30", agent);
    const byKey = new Map<string, Lesson[]>(); for (const l of ls) byKey.set(`${l.key}|${l.lang}`, [...(byKey.get(`${l.key}|${l.lang}`) || []), l]);
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      const sorted = group.sort((a, b) => lessonScore(b) - lessonScore(a)), worst = sorted[sorted.length - 1];
      if (lessonScore(worst) < 0.5 * lessonScore(sorted[0]) && !recentTask('email.retire_template', `"lesson_id":${worst.id}`, 30)) tasks.push({ kind: 'email.retire_template', detail: { lesson_id: worst.id, key: worst.key }, reason: `Wording #${worst.id} for ${worst.key} scores ${(lessonScore(worst) * 100).toFixed(0)}% vs ${(lessonScore(sorted[0]) * 100).toFixed(0)}% for the best` });
    }
  }
  if (num("SELECT COUNT(*) FROM prospects WHERE status='new'") < 10 && useAI('prospector') && !recentTask('prospector.research', '', 3)) {
    const n = num("SELECT COUNT(*) FROM agent_tasks WHERE kind='prospector.research'");
    tasks.push({ kind: 'prospector.research', detail: { segment: PROSPECT_SEGMENTS[n % PROSPECT_SEGMENTS.length], region: PROSPECT_REGIONS[Math.floor(n / PROSPECT_SEGMENTS.length) % PROSPECT_REGIONS.length] }, reason: 'Fewer than 10 new organisations to approach' });
  }
  if (!recentTask('growth.library', '', 6)) tasks.push({ kind: 'growth.library', reason: 'Keep the weekly article and fortnightly newsletter on schedule' });
  // Progress against the 90-day targets (pro rata).
  const d = Math.min(90, Math.max(1, f.progress.days_since_start));
  const behind = (Object.keys(TARGETS_90) as (keyof typeof TARGETS_90)[]).filter((k) => f.progress[k] < (TARGETS_90[k] * d) / 90 * 0.6);
  if (d >= 14 && behind.length) recs.push({ priority: 3, text: `Behind the 90-day plan on ${behind.map((k) => `${k.replace('_', ' ')} (${f.progress[k]} of ${Math.round((TARGETS_90[k] * d) / 90)} expected by day ${d})`).join(', ')}.`, link: '/admin/chief' });
  return { recs: recs.sort((a, b) => a.priority - b.priority), tasks };
}

// ---------- Tasks ----------
export async function runTask(id: number) {
  const t = q.get<any>("SELECT * FROM agent_tasks WHERE id=? AND status='open'", id);
  if (!t) return 'not open';
  const d = JSON.parse(t.detail || '{}');
  let result = '';
  try {
    switch (t.kind as TaskKind) {
      case 'social.promote_lot': { const plan = planForLot(String(d.lot_code)); result = plan ? await createPost(true, plan) : 'lot not open'; break; }
      case 'email.lot_push': { const n = await proposeCampaign('lot_closing', lotPushAudience(String(d.lot_code))); result = n ? `lot email proposed to ${n} Champions` : 'nobody to email (or promotion paused)'; break; }
      case 'social.pause_promotion': { const until = new Date(Date.now() + Number(d.days || 7) * 864e5).toISOString(); setSetting('social_paused_until', until); result = `new-lot promotion paused until ${until.slice(0, 10)}`; break; }
      case 'social.boost_topic': { setSetting('social_boost', JSON.stringify({ topic: d.topic, until: new Date(Date.now() + 14 * 864e5).toISOString() })); result = `“${d.topic}” favoured for 14 days`; break; }
      case 'email.retire_template': {
        const l = q.get<any>('SELECT * FROM agent_lessons WHERE id=?', Number(d.lesson_id));
        const others = l ? num('SELECT COUNT(*) FROM agent_lessons WHERE agent=? AND kind=? AND key=? AND lang=? AND active=1 AND id!=?', l.agent, l.kind, l.key, l.lang, l.id) : 0;
        if (l && others) { q.run('UPDATE agent_lessons SET active=0, updated_at=? WHERE id=?', now(), l.id); result = `wording #${l.id} switched off`; } else result = 'kept (it is the only wording left)';
        break;
      }
      case 'onboarding.run': result = await AGENT_JOBS.onboarding(); break;
      case 'prospector.research': result = await researchProspects(d.segment, d.region); break;
      case 'growth.library': result = runLibrary(); break;
    }
    q.run("UPDATE agent_tasks SET status='done', result=?, done_at=? WHERE id=?", String(result).slice(0, 500), now(), id);
  } catch (e: any) {
    result = e instanceof AiUnavailable ? `skipped: ${e.message}` : `failed: ${e.message}`;
    q.run("UPDATE agent_tasks SET status=?, result=?, done_at=? WHERE id=?", e instanceof AiUnavailable ? 'skipped' : 'failed', result.slice(0, 500), now(), id);
  }
  return result;
}
function assign(t: TaskIn, by: 'chief' | number) {
  if (!(t.kind in TASK_KINDS)) return null;
  const agent = TASK_KINDS[t.kind].agent;
  if (!agentOn(agent as any)) return null;
  return q.insert('agent_tasks', { assigned_to: agent, kind: t.kind, detail: JSON.stringify(t.detail || {}), reason: t.reason.slice(0, 400), status: 'open', created_by: String(by), created_at: now() }).id;
}
/** An admin asks an agent directly (same task kinds, same learning). */
export async function assignTask(t: TaskIn, by: number) {
  const id = assign(t, by);
  if (!id) return { ok: false, message: `The ${TASK_KINDS[t.kind]?.agent || ''} agent is switched off.` };
  audit(by, 'chief.task', String(id), t);
  return { ok: true, message: `Task #${id}: ${await runTask(id)}` };
}

// ---------- Learning from results ----------
/** Scores finished tasks once their effect can be seen, and remembers which kinds of task work. */
export function scoreTasks() {
  let n = 0;
  for (const t of q.all<any>("SELECT * FROM agent_tasks WHERE status='done' AND scored=0 AND done_at<=?", ago(3))) {
    const d = JSON.parse(t.detail || '{}');
    let win: boolean | null = null, note = '';
    if (t.kind === 'social.promote_lot' || t.kind === 'email.lot_push') { const after = lotPct(String(d.lot_code)); win = after - Number(d.pct_before || 0) >= 10; note = `${d.lot_code}: ${d.pct_before}% → ${after}%`; }
    else if (t.kind === 'onboarding.run') { const after = num("SELECT COUNT(*) FROM users u WHERE u.role='champion' AND u.kyc_status='verified' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id=u.id AND p.status='success')"); win = after < Number(d.stuck_before || 0); note = `stuck: ${d.stuck_before} → ${after}`; }
    else if (t.kind === 'social.boost_topic') {
      if (Date.now() - new Date(t.done_at).getTime() < 14 * 864e5) continue;
      const r = q.get<any>(`SELECT COUNT(*) posts, COALESCE(SUM((SELECT COALESCE(SUM(clicks),0) FROM links WHERE campaign='post-' || p.id)),0) clicks FROM social_posts p WHERE p.created_at>=? AND p.status IN ('published','partly')`, t.done_at);
      const cpp = r.posts ? r.clicks / r.posts : 0; win = cpp >= Number(d.cpp_before || 0) * 0.8; note = `clicks per post since: ${cpp.toFixed(1)}`;
    }
    q.run('UPDATE agent_tasks SET scored=1, outcome=? WHERE id=?', win === null ? 'n/a' : `${win ? 'worked' : 'did not move the result'} (${note})`, t.id);
    if (win !== null) { const id = learn({ agent: 'chief', kind: 'advice', key: `task:${t.kind}`, content: { text: TASK_KINDS[t.kind as TaskKind]?.what || t.kind }, source: 'rules' }); scoreLesson(id, win); n++; }
  }
  return n;
}
function whatWorks() {
  return (Object.keys(TASK_KINDS) as TaskKind[]).map((k) => { const l = bestLesson('chief', 'advice', `task:${k}`); return l && l.wins + l.losses ? `${k}: worked ${l.wins} of ${l.wins + l.losses}` : null; }).filter(Boolean) as string[];
}

// ---------- Approval triage ----------
/** Proposals that are low risk and on-message, safe to approve together. */
export function triage() {
  const rows = q.all<any>("SELECT * FROM agent_actions WHERE status='proposed' ORDER BY created_at");
  const safe: number[] = [], review: { id: number; why: string }[] = [];
  for (const a of rows) {
    const text = `${a.title} ${a.summary || ''} ${a.payload || ''}`;
    const bad = offMessage(text.replace(/not (a bank deposit|an investment)|investment scheme|never call[^.]*risk-free/gi, ''));
    if (a.risk === 'low' && !bad.length && !['send_outreach', 'flag_account', 'reply_ticket', 'reply_chat'].includes(a.kind)) safe.push(a.id);
    else review.push({ id: a.id, why: bad.length ? `wording: ${bad.join(', ')}` : a.risk !== 'low' ? `${a.risk} risk` : 'needs a person’s judgement' });
  }
  return { safe, review };
}
export function approveSafe(by: number) {
  const { safe } = triage();
  let ok = 0;
  for (const id of safe) { try { executeAction(id, by); ok++; } catch { /* already decided or failed: shown in the queue */ } }
  audit(by, 'chief.approve_safe', undefined, { approved: ok });
  return ok;
}

// ---------- The daily run ----------
export async function runChief(trigger = 'daily') {
  if (!agentOn('chief' as any)) return 'off';
  const scored = scoreTasks();
  const f = await gatherFacts();
  const plan = rulePlan(f);
  const tri = triage();
  let headline = '', extra: TaskIn[] = [], extraRecs: Rec[] = [], runId: number | null = null, mode = 'rules';
  const past = q.all<any>("SELECT kind, reason, result, outcome FROM agent_tasks WHERE created_at>=? ORDER BY id DESC LIMIT 20", ago(21));
  if (useAI('chief')) {
    try {
      const r = await completeJson<{ headline: string; recommendations?: { priority: number; text: string; link?: string }[]; tasks?: { kind: string; detail?: Record<string, unknown>; reason: string }[] }>('chief', { trigger, maxTokens: 2500,
        system: `${POLICY}\n${playbookFor('chief')}\nYou are ComboTrader's Chief of Staff. You coordinate the other agents and brief the founder each morning. From the facts, the rule-based plan already made, past tasks and their outcomes, and what has worked, write: "headline" (2 sentences: the state of the business today and the single most important thing), up to 4 extra "recommendations" for the founder that the rules missed (priority 1 = urgent … 5 = nice to have; concrete, with numbers from the facts; link to an admin page if useful), and up to 3 extra "tasks" for agents, ONLY of these kinds: ${Object.entries(TASK_KINDS).map(([k, v]) => `${k} (${v.what}; needs ${v.needs || 'nothing'})`).join('; ')}. Do not repeat tasks already in the plan. Prefer task kinds that have worked before. Never suggest anything that moves money, changes rates or terms, or contacts people who haven't opted in. Return {"headline":string,"recommendations":[{"priority":number,"text":string,"link":string}],"tasks":[{"kind":string,"detail":object,"reason":string}]}.`,
        input: { facts: f, rule_plan: plan, past_tasks: past, what_worked: whatWorks(), triage: { safe: tri.safe.length, needs_review: tri.review.length } } });
      runId = r.runId; mode = 'ai';
      headline = String(r.data.headline || '').slice(0, 600);
      extraRecs = (r.data.recommendations || []).slice(0, 4).filter((x) => x?.text).map((x) => ({ priority: Math.min(5, Math.max(1, Number(x.priority) || 3)), text: String(x.text).slice(0, 400), link: typeof x.link === 'string' && x.link.startsWith('/admin') ? x.link : undefined }));
      extra = (r.data.tasks || []).slice(0, 3).filter((t) => t && t.kind in TASK_KINDS && !plan.tasks.some((p) => p.kind === t.kind)).map((t) => ({ kind: t.kind as TaskKind, detail: t.detail || {}, reason: String(t.reason || 'Chief of Staff').slice(0, 300) }));
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.chief_error', undefined, String((e as Error).message)); }
  }
  if (!runId) runId = logRun('chief', trigger, JSON.stringify(f).slice(0, 20000), 'rules plan', 'rules');
  const recs = [...plan.recs, ...extraRecs].sort((a, b) => a.priority - b.priority).slice(0, 8);
  // Assign tasks (when allowed) and run them now; their outputs still go through the normal approval rules.
  const assigned: { id: number | null; t: TaskIn; result?: string }[] = [];
  for (const t of [...plan.tasks, ...extra]) {
    if (settings().chief_assign) { const id = assign(t, 'chief'); assigned.push({ id, t, result: id ? await runTask(id) : 'agent is off' }); }
    else assigned.push({ id: null, t });
  }
  if (!settings().chief_assign && assigned.length) recs.push({ priority: 4, text: `Suggested agent tasks (assignment is switched off): ${assigned.map((a) => `${a.t.kind} (${a.t.reason})`).join('; ')}.`, link: '/admin/chief' });
  if (!headline) headline = recs.length ? `${recs.filter((r) => r.priority <= 2).length} urgent item${recs.filter((r) => r.priority <= 2).length === 1 ? '' : 's'} today. ${f.lots.length} lot${f.lots.length === 1 ? '' : 's'} open; ${f.week.signups} sign-ups and ${f.week.funded_naira} funded this week.` : `All quiet. ${f.lots.length} lot${f.lots.length === 1 ? '' : 's'} open; ${f.week.signups} sign-ups and ${f.week.funded_naira} funded this week.`;
  const md = briefMarkdown(f, headline, recs, assigned, tri);
  const id = q.insert('chief_briefs', { period: trigger, headline, body: md, facts: JSON.stringify(f).slice(0, 50000), mode, run_id: runId, created_at: now() }).id;
  const subject = `ComboTrader brief ${f.date}: ${recs.filter((r) => r.priority <= 2).length ? `${recs.filter((r) => r.priority <= 2).length} need you` : 'all quiet'}`;
  const html = marked.parse(escapeHtml(md).replace(/\]\(\/admin/g, `](${config.baseUrl}/admin`), { async: false }) as string;
  for (const a of q.all<any>("SELECT email FROM users WHERE role='admin' AND status='active' AND admin_roles LIKE '%super%'")) queueEmail(a.email, subject, emailShell(escapeHtml(subject), html, { label: 'Open the brief', url: `${config.baseUrl}/admin/chief` }));
  return `brief #${id} (${mode}): ${recs.length} recommendations, ${assigned.length} tasks${scored ? `, ${scored} outcomes learned` : ''}`;
}

function briefMarkdown(f: Facts, headline: string, recs: Rec[], tasks: { t: TaskIn; result?: string }[], tri: ReturnType<typeof triage>) {
  const p = f.progress, d = Math.min(90, Math.max(1, p.days_since_start));
  return [
    `**${headline}**`,
    recs.length ? `## Needs your decision\n${recs.map((r, i) => `${i + 1}. ${r.priority <= 2 ? '**' : ''}${r.text}${r.priority <= 2 ? '**' : ''}${r.link ? ` [Open](${r.link})` : ''}`).join('\n')}` : '## Needs your decision\nNothing today.',
    tasks.length ? `## What I asked the agents to do\n${tasks.map((a) => `- **${a.t.kind}**: ${a.t.reason}${a.result ? `. Result: ${a.result}` : ''}`).join('\n')}` : '',
    `## Approval queue\n${tri.safe.length} low-risk, on-message item${tri.safe.length === 1 ? '' : 's'} ready to approve together; ${tri.review.length} need${tri.review.length === 1 ? 's' : ''} your judgement. [Review](/admin/chief#triage)`,
    `## Open lots\n${f.lots.length ? f.lots.map((l) => `- ${l.title} (${l.code}): ${l.pct}% funded, ${l.days_left} days left, ${l.remaining} to go`).join('\n') : 'None open.'}`,
    `## This week\n- Sign-ups: ${f.week.signups} · New leads: ${f.week.leads} · Funded: ${f.week.funded_naira}\n- Verified but not yet funded: ${f.week.verified_not_funded}`,
    `## Progress against the 90-day plan (day ${p.days_since_start})\n| Measure | Now | Expected by day ${d} | Day-90 target |\n| --- | --- | --- | --- |\n${(Object.keys(TARGETS_90) as (keyof typeof TARGETS_90)[]).map((k) => `| ${k.replace('_', ' ')} | ${p[k]} | ${Math.round((TARGETS_90[k] * d) / 90)} | ${TARGETS_90[k]} |`).join('\n')}`,
    whatWorks().length ? `## What’s working\n${whatWorks().map((w) => `- ${w}`).join('\n')}` : '',
    f.health.length ? `## Health\n${f.health.map((h) => `- ${h}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
