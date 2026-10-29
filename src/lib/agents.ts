// ComboTrader agents. Principle: agents PROPOSE, rules DISPOSE.
// - Agents read platform data and draft actions. They never move money, approve withdrawals or change balances.
// - Every action is an `agent_actions` row with a risk level. Admin-only alerts run straight away; low-risk messages
//   to Champions run automatically only when Settings → Agents autonomy is "auto_low"; everything else waits in
//   Admin → Agents for a person to approve, edit or reject.
// - Every model call is logged in `agent_runs` (input, output, tokens).
import { q, now } from './db';
import { completeJson, aiLive, AiUnavailable, POLICY, logRun } from './ai';
import { settings } from './settings';
import { notify, queueEmail, emailShell, escapeHtml } from './notify';
import { audit } from './audit';
import { userById } from './auth';
import { walletBalance } from './ledger';
import { addTrailEvent, getLot, STAGES, siteStats, impactFor } from './trading';
import { treasurySnapshot } from './treasury';
import { faqsFor } from './content';
import { config } from './config';
import { fmtNGN, randomCode } from './util';
import { translate, isLang, LANGS, type Lang } from './i18n';
import type { User } from './http';

export const AGENTS = {
  support: { name: 'Support', what: 'Answers tickets and WhatsApp questions from the FAQs and the Champion\'s own account; hands over anything about money movement.' },
  onboarding: { name: 'Onboarding', what: 'Finds Champions stuck in sign-up, verification, payment or a paused Harvest Plan and drafts a personal next step.' },
  treasury: { name: 'Treasury', what: 'Checks payouts due against cash, credit line and buyer money due; writes the daily brief and raises shortfall alerts.' },
  risk: { name: 'Risk', what: 'Looks for shared bank accounts, shared devices, fast in-and-out money and referral rings; proposes flags for review.' },
  growth: { name: 'Growth', what: 'Drafts the weekly newsletter and social posts from real lots, Trail updates, prices and payouts. Never contacts people who have not opted in.' },
  ops: { name: 'Ops copilot', what: 'Turns field notes into Harvest Trail updates and contract summaries into draft lots, for an admin to approve.' },
} as const;
export type AgentName = keyof typeof AGENTS;
export const agentOn = (a: AgentName) => String(settings().agents_enabled).split(',').map((s) => s.trim()).includes(a);

type Risk = 'info' | 'low' | 'medium' | 'high';
export interface ActionInput { agent: AgentName; kind: string; risk: Risk; title: string; summary?: string; payload: Record<string, unknown>; targetUserId?: number | null; runId?: number | null }

// ---------- Executors: the only things an approved action can do ----------
const EXECUTORS: Record<string, (p: any, by: number | null) => string> = {
  /** In-app + email (+ SMS when asked) message to one Champion. */
  send_message(p) {
    const u = userById(Number(p.user_id));
    if (!u || u.status !== 'active') throw new Error('Champion not found or inactive');
    const title = String(p.title || '').slice(0, 120), body = String(p.body || '').slice(0, 1200);
    if (!title || !body) throw new Error('Message needs a title and body');
    q.insert('notifications', { user_id: u.id, title, body, link: p.link ? String(p.link).slice(0, 200) : null, created_at: now() });
    if (u.notif_email) queueEmail(u.email, title, emailShell(escapeHtml(title), `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`, p.link ? { label: translate(u.lang, 'msg.open'), url: config.baseUrl + p.link } : undefined));
    return `sent to ${u.email}`;
  },
  /** Answers a support ticket. */
  reply_ticket(p) {
    const t = q.get<any>('SELECT * FROM tickets WHERE id=?', Number(p.ticket_id));
    if (!t) throw new Error('Ticket not found');
    if (t.status !== 'open') return 'ticket already answered';
    const reply = String(p.reply || '').slice(0, 3000);
    q.run("UPDATE tickets SET reply=?, status='closed' WHERE id=?", reply, t.id);
    const u = userById(t.user_id); if (u) notify(u, 'ticket_reply', { reply }, { link: '/app/support' });
    return 'reply sent';
  },
  /** Posts a Harvest Trail update (notifies every Champion in the lot). */
  trail_update(p, by) {
    const lot = getLot(Number(p.lot_id));
    if (!lot) throw new Error('Lot not found');
    if (!(STAGES as readonly string[]).includes(p.stage)) throw new Error('Unknown stage');
    const n = addTrailEvent(lot.id, p.stage, String(p.note || '').slice(0, 600), p.photo_path || null, by || 0);
    return `posted; ${n} Champions notified`;
  },
  /** Creates a lot as a DRAFT (never opens it). */
  draft_lot(p, by) {
    if (!q.get('SELECT 1 FROM commodities WHERE code=?', p.commodity)) throw new Error('Unknown commodity');
    const target = Math.round(Number(p.target_naira) * 100), min = Math.round(Number(p.min_naira || 1_000_000) * 100);
    if (!(target > 0) || !(min > 0) || min > target) throw new Error('Check the lot size and minimum');
    const code = `${String(p.commodity).slice(0, 2).toUpperCase()}-${randomCode(4)}`;
    const id = q.insert('lots', {
      code, commodity: p.commodity, title: String(p.title).slice(0, 120), description: String(p.description || '').slice(0, 1000), region: String(p.region || '').slice(0, 80),
      buyer_type: String(p.buyer_type || 'Buyer').slice(0, 80), buyer_name: String(p.buyer_name || '').slice(0, 120) || null, contract_ref: String(p.contract_ref || '').slice(0, 80) || null,
      tonnage: Number(p.tonnage) || 0, farmers: Math.round(Number(p.farmers) || 0), target_amount: target, min_commit: min,
      period_months: [4, 6, 9, 12].includes(Number(p.period_months)) ? Number(p.period_months) : 6, rate_bps: Math.round((Number(p.rate_pct) || 20) * 100),
      closes_at: new Date(Date.now() + 21 * 864e5).toISOString(), status: 'draft', buyer_amount: p.buyer_amount_naira ? Math.round(Number(p.buyer_amount_naira) * 100) : null,
      buyer_due_at: p.buyer_due ? new Date(`${p.buyer_due}T12:00:00Z`).toISOString() : null, created_by: by, created_at: now(),
    }).id;
    return `draft lot ${code} created (#${id}) — review and open it in Trade Lots`;
  },
  /** Creates a newsletter DRAFT (never sends). */
  draft_newsletter(p, by) {
    const id = q.insert('newsletters', { subject: String(p.subject).slice(0, 150), body: String(p.body).slice(0, 20000), segment: 'all', status: 'draft', created_by: by, created_at: now() }).id;
    return `newsletter draft #${id} created — review it in Newsletter`;
  },
  /** Adds a review note to a Champion record (no account change). */
  flag_account(p, by) {
    const u = userById(Number(p.user_id));
    if (!u) throw new Error('Champion not found');
    const note = `[${now().slice(0, 10)} risk review] ${String(p.reason).slice(0, 400)}`;
    q.run("UPDATE users SET notes=TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?", note, u.id);
    audit(by, 'risk.flag', `user:${u.id}`, p.reason);
    return 'note added to the Champion record';
  },
  /** Emails the finance and super admins (internal only). */
  admin_alert(p) {
    const admins = q.all<any>("SELECT email FROM users WHERE role='admin' AND status='active' AND (admin_roles LIKE '%super%' OR admin_roles LIKE '%finance%')");
    for (const a of admins) queueEmail(a.email, String(p.subject).slice(0, 150), emailShell(escapeHtml(String(p.subject)), `<div>${escapeHtml(String(p.body)).replace(/\n/g, '<br>')}</div>`, { label: 'Open treasury', url: `${config.baseUrl}/admin/treasury` }));
    return `emailed ${admins.length} admins`;
  },
  /** Copy-ready social posts; nothing is published automatically. */
  social_posts() { return 'ready to copy'; },
};
export const ACTION_KINDS = Object.keys(EXECUTORS);

export function propose(a: ActionInput) {
  const id = q.insert('agent_actions', { run_id: a.runId ?? null, agent: a.agent, kind: a.kind, risk: a.risk, title: a.title.slice(0, 200), summary: a.summary?.slice(0, 2000) ?? null, payload: JSON.stringify(a.payload), target_user_id: a.targetUserId ?? null, status: 'proposed', created_at: now() }).id;
  const autonomous = a.risk === 'info' || (a.risk === 'low' && settings().agent_autonomy === 'auto_low');
  if (autonomous && a.kind !== 'social_posts') executeAction(id, null);
  return id;
}

export function executeAction(id: number, by: number | null, edited?: Record<string, unknown>) {
  const a = q.get<any>('SELECT * FROM agent_actions WHERE id=?', id);
  if (!a || !['proposed', 'failed'].includes(a.status)) throw new Error('This action has already been decided.');
  const fn = EXECUTORS[a.kind];
  if (!fn) throw new Error(`No executor for ${a.kind}`);
  const payload = { ...JSON.parse(a.payload || '{}'), ...(edited || {}) };
  try {
    const result = fn(payload, by);
    q.run("UPDATE agent_actions SET status=?, payload=?, decided_by=?, decided_at=?, result=? WHERE id=?", by ? 'approved' : 'auto', JSON.stringify(payload), by, now(), result, id);
    audit(by, `agent.${a.kind}`, `action:${id}`, { agent: a.agent, result });
    return result;
  } catch (e: any) {
    q.run("UPDATE agent_actions SET status='failed', decided_by=?, decided_at=?, result=? WHERE id=?", by, now(), String(e.message).slice(0, 500), id);
    throw e;
  }
}
export function rejectAction(id: number, by: number, reason = '') {
  q.run("UPDATE agent_actions SET status='rejected', decided_by=?, decided_at=?, result=? WHERE id=? AND status='proposed'", by, now(), reason.slice(0, 300) || null, id);
  audit(by, 'agent.reject', `action:${id}`, reason);
}

// ---------- Shared context ----------
const langName = (l: Lang) => LANGS.find((x) => x.code === l)?.label || 'English';
export function championContext(u: User) {
  const trades = q.all<any>(`SELECT t.certificate_no, t.amount, t.status, t.matures_at, t.rollover, l.title AS lot, l.id AS lot_id,
      (SELECT stage FROM trail_events WHERE lot_id=l.id ORDER BY happened_at DESC, id DESC LIMIT 1) AS latest_stage
    FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? ORDER BY t.id DESC LIMIT 10`, u.id);
  return {
    first_name: u.first_name, language: langName(u.lang), country: u.country, wallet_naira: walletBalance(u.id) / 100,
    identity_check: u.kyc_status, phone_verified: !!u.phone_verified_at, email_verified: !!u.email_verified_at,
    trades: trades.map((t) => ({ ...t, amount_naira: t.amount / 100, amount: undefined })),
    pending_withdrawals: q.all<any>("SELECT amount, status, created_at FROM withdrawals WHERE user_id=? AND status IN ('requested','approved','processing','manual')", u.id).map((w) => ({ naira: w.amount / 100, status: w.status, since: w.created_at.slice(0, 10) })),
    plans: q.all<any>("SELECT name, status, monthly_amount, target_amount FROM plans WHERE user_id=? AND status IN ('active','paused','ready')", u.id).map((p) => ({ name: p.name, status: p.status, monthly_naira: p.monthly_amount / 100, target_naira: p.target_amount / 100 })),
  };
}

// ---------- Support ----------
const words = (s: string) => new Set(s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));
/** Best FAQ by word overlap (demo mode and a hint for the model). */
export function faqMatch(lang: Lang, question: string) {
  const qw = words(question);
  let best: { q: string; a: string; score: number } | null = null;
  for (const f of faqsFor(lang)) {
    const fw = words(`${f.q} ${f.q} ${f.a}`);
    let hit = 0; for (const w of qw) if (fw.has(w)) hit++;
    const score = qw.size ? hit / Math.sqrt(qw.size * Math.max(4, words(f.q).size)) : 0;
    if (!best || score > best.score) best = { ...f, score };
  }
  return best;
}
const MONEY_WORDS = /withdraw|refund|missing|not (?:received|credited)|debited|wrong amount|fraud|hack|stolen|chargeback|lawyer|court|police|complain|retir|retrait|rembours|kutoa|levant|reembols|سحب|استرداد/i;

/** Answers a Champion (or a visitor when u is null). Returns the reply and whether a person must take over. */
export async function supportAnswer(u: User | null, question: string, lang: Lang, trigger: string) {
  const sensitive = MONEY_WORDS.test(question);
  if (aiLive() && agentOn('support')) {
    try {
      const { data, runId } = await completeJson<{ reply: string; escalate: boolean; reason?: string }>('support', {
        fast: true, trigger,
        system: `${POLICY}\nYou are the ComboTrader support assistant. Answer using the FAQ and the Champion's own account data below. ` +
          `Set escalate=true (and say a team member will follow up within one working day) for: anything about money that is missing, late or wrong; withdrawals; complaints; account access; identity checks that failed; anything you cannot answer from the data. ` +
          `Keep replies under 120 words. Answer in ${langName(lang)}. Return {"reply": string, "escalate": boolean, "reason": string}.`,
        input: { question, champion: u ? championContext(u) : 'visitor without an account', faq: faqsFor(lang).map((f) => ({ q: f.q, a: f.a })), support_email: settings().support_email, site: config.baseUrl },
      });
      return { reply: String(data.reply || '').slice(0, 1500), escalate: !!data.escalate || sensitive, reason: data.reason || '', runId };
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.support_error', undefined, String((e as Error).message)); }
  }
  // Demo / fallback: FAQ match, hand over when unsure or sensitive.
  const m = faqMatch(lang, question);
  const runId = logRun('support', trigger, question, m ? `${m.score.toFixed(2)} ${m.q}` : 'no match', 'demo');
  if (m && m.score >= 0.35 && !sensitive) return { reply: `${m.a}`, escalate: false, reason: `FAQ: ${m.q}`, runId };
  return { reply: translate(lang, 'agent.handover'), escalate: true, reason: sensitive ? 'money or account matter' : 'no confident answer', runId };
}

/** New ticket → draft (or send) a reply. Escalations stay open for the team, with the draft attached. */
export async function supportOnTicket(ticketId: number) {
  if (!agentOn('support')) return;
  const t = q.get<any>('SELECT * FROM tickets WHERE id=?', ticketId);
  const u = t && userById(t.user_id);
  if (!t || !u) return;
  const r = await supportAnswer(u, `${t.subject}\n\n${t.body}`, u.lang, `ticket:${t.id}`);
  propose({ agent: 'support', kind: 'reply_ticket', risk: r.escalate ? 'medium' : 'low', title: `Reply to ticket #${t.id}: ${t.subject}`.slice(0, 200), summary: r.escalate ? `Needs a person: ${r.reason}` : r.reason, payload: { ticket_id: t.id, reply: r.reply }, targetUserId: u.id, runId: r.runId });
}

// ---------- Onboarding ----------
function onceFor(userId: number, kind: string, ref = '') {
  return q.run('INSERT OR IGNORE INTO nudges (user_id, kind, ref, created_at) VALUES (?,?,?,?)', userId, kind, ref, now()).changes > 0;
}
export async function runOnboarding(limit = 25) {
  if (!agentOn('onboarding')) return 'off';
  const d = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
  const cases: { u: User; situation: string; link: string; key: string; ref: string }[] = [];
  const add = (rows: any[], key: string, situation: string, link: string) => { for (const r of rows) if (cases.length < limit && !cases.some((x) => x.u.id === r.id)) cases.push({ u: r, situation, link, key, ref: `${key}:${now().slice(0, 7)}` }); };
  add(q.all<any>("SELECT * FROM users WHERE role='champion' AND status='active' AND phone_verified_at IS NULL AND created_at<=? AND created_at>=?", d(1), d(14)), 'phone', 'signed up but has not confirmed their phone number', '/verify-phone');
  add(q.all<any>("SELECT * FROM users WHERE status='active' AND kyc_status='rejected'"), 'kyc', 'identity check failed; they can try again or contact support', '/app/profile#kyc');
  add(q.all<any>("SELECT DISTINCT u.* FROM users u JOIN payments p ON p.user_id=u.id WHERE u.status='active' AND p.status IN ('pending','failed') AND p.created_at>=? AND p.created_at<=? AND NOT EXISTS (SELECT 1 FROM payments s WHERE s.user_id=u.id AND s.status='success' AND s.created_at>=p.created_at)", d(3), d(0.1)), 'payment', 'started a payment that did not complete', '/app/wallet#fund');
  add(q.all<any>("SELECT DISTINCT u.* FROM users u JOIN plans p ON p.user_id=u.id WHERE u.status='active' AND p.status='paused'"), 'plan', 'Harvest Plan is paused after failed card charges', '/app/plans');
  add(q.all<any>("SELECT DISTINCT u.* FROM users u JOIN gifts g ON g.giver_id=u.id WHERE g.status='sent' AND g.created_at<=?", d(7)), 'gift', 'sent a Harvest gift that has not been claimed after a week; they could resend the link', '/app/gifts');
  const todo = cases.filter((x) => !q.get('SELECT 1 FROM nudges WHERE user_id=? AND kind=? AND ref=?', x.u.id, 'agent_onb', x.ref));
  if (!todo.length) return '0 Champions need a nudge';
  let drafts: { user_id: number; title: string; body: string }[] = [];
  let runId: number | null = null;
  if (aiLive()) {
    try {
      const r = await completeJson<{ messages: typeof drafts }>('onboarding', {
        fast: true, trigger: 'daily', maxTokens: 4000,
        system: `${POLICY}\nYou are the ComboTrader onboarding assistant. For each Champion, write one short, kind message (title ≤ 8 words, body ≤ 60 words) in their language that names the one next step for their situation. No pressure, no urgency tricks, no promises about earnings. Return {"messages":[{"user_id":number,"title":string,"body":string}]}.`,
        input: todo.map((x) => ({ user_id: x.u.id, first_name: x.u.first_name, language: langName(x.u.lang), situation: x.situation })),
      });
      drafts = r.data.messages || []; runId = r.runId;
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.onboarding_error', undefined, String((e as Error).message)); }
  }
  if (!drafts.length) {
    runId = logRun('onboarding', 'daily', JSON.stringify(todo.map((x) => x.u.id)), 'template drafts', 'demo');
    drafts = todo.map((x) => ({ user_id: x.u.id, title: translate(x.u.lang, 'agent.onb_title', { name: x.u.first_name }), body: translate(x.u.lang, `agent.onb.${x.key}`, { name: x.u.first_name }) }));
  }
  let n = 0;
  for (const dft of drafts) {
    const x = todo.find((t) => t.u.id === Number(dft.user_id));
    if (!x || !onceFor(x.u.id, 'agent_onb', x.ref)) continue;
    propose({ agent: 'onboarding', kind: 'send_message', risk: 'low', title: `Nudge ${x.u.first_name} ${x.u.last_name}: ${x.situation}`.slice(0, 200), payload: { user_id: x.u.id, title: dft.title, body: dft.body, link: x.link }, targetUserId: x.u.id, runId });
    n++;
  }
  return `${n} nudges drafted`;
}

// ---------- Treasury ----------
export async function runTreasury() {
  if (!agentOn('treasury')) return 'off';
  const snap = treasurySnapshot();
  const h30 = snap.horizons[1];
  const naira = (k: number) => fmtNGN(k);
  const facts = {
    cash_position_as_of: snap.cashAsOf, overdue_buyers: snap.overdue.map((o) => ({ ...o, outstanding: naira(o.outstanding) })), overdue_total: naira(snap.overdueTotal),
    lots_missing_buyer_terms: snap.missingBuyerTerms,
    horizons: snap.horizons.map((h) => ({ days: h.horizon, payouts_due: naira(h.due.total), trades: h.due.count, cash: naira(h.cash), credit_line: naira(h.creditLine), buyer_money_due: naira(h.buyerDue), coverage: h.ratio === null ? 'no payouts due' : h.ratio.toFixed(2), level: h.level })),
  };
  let brief = '', runId: number | null = null;
  if (aiLive()) {
    try {
      const r = await completeJson<{ brief: string }>('treasury', { trigger: 'daily', system: `${POLICY}\nYou are Kitovu's treasury analyst. Kitovu must pay every Champion on the payout date even if buyers are late. From the figures, write a brief for the finance team (≤ 150 words): the position, the biggest risk in the next 30 days, and 2–3 concrete actions (e.g. chase a named overdue buyer, draw on the credit line, slow new lot openings, update a stale cash position). Use only the numbers given. Return {"brief": string}.`, input: facts });
      brief = r.data.brief; runId = r.runId;
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.treasury_error', undefined, String((e as Error).message)); }
  }
  if (!brief) {
    runId = logRun('treasury', 'daily', JSON.stringify(facts), 'template brief', 'demo');
    brief = [`Next 30 days: ${naira(h30.due.total)} due to Champions across ${h30.due.count} trades; available ${naira(h30.available)} (cash ${naira(h30.cash)}, credit line ${naira(h30.creditLine)}, buyer money due ${naira(h30.buyerDue)}). Coverage: ${h30.ratio === null ? 'nothing due' : h30.ratio.toFixed(2)}.`,
      snap.overdue.length ? `Overdue buyers: ${snap.overdue.map((o) => `${o.lot} (${o.buyer}) ${naira(o.outstanding)}, ${o.days} days`).join('; ')}. Kitovu covers these payouts; chase the buyers.` : 'No buyer is overdue.',
      !snap.cashAsOf ? 'No cash position recorded yet — add one in Admin → Treasury.' : `Cash position last updated ${snap.cashAsOf.slice(0, 10)}.`,
      snap.missingBuyerTerms.length ? `Add buyer contract value and due date for: ${snap.missingBuyerTerms.join(', ')}.` : ''].filter(Boolean).join('\n');
  }
  const short = snap.horizons.find((h) => h.level === 'short');
  const warn = snap.horizons.find((h) => h.level === 'warn' || h.level === 'unknown');
  const level: Risk = short ? 'high' : warn ? 'medium' : 'info';
  propose({ agent: 'treasury', kind: 'admin_alert', risk: 'info', title: short ? `Shortfall: payouts in ${short.horizon} days exceed available funds` : warn ? `Coverage needs attention (${warn.horizon} days)` : 'Daily treasury brief', summary: brief,
    payload: { subject: short ? `ComboTrader treasury: SHORTFALL within ${short.horizon} days` : `ComboTrader treasury brief ${now().slice(0, 10)}`, body: brief }, runId });
  return `brief written (${level})`;
}

// ---------- Risk ----------
export async function runRisk() {
  if (!agentOn('risk')) return 'off';
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const signals: { user_id: number; name: string; signal: string }[] = [];
  for (const r of q.all<any>(`SELECT b.account_number, GROUP_CONCAT(DISTINCT b.user_id) AS users FROM bank_accounts b WHERE b.account_number!='INTL' GROUP BY b.account_number HAVING COUNT(DISTINCT b.user_id)>1`))
    for (const id of String(r.users).split(',')) signals.push({ user_id: +id, name: '', signal: `bank account ending ${String(r.account_number).slice(-4)} shared by users ${r.users}` });
  for (const r of q.all<any>(`SELECT ip, GROUP_CONCAT(DISTINCT user_id) AS users, COUNT(DISTINCT user_id) n FROM login_events WHERE success=1 AND created_at>=? AND ip NOT IN ('', '127.0.0.1', '::1') GROUP BY ip HAVING n>=4`, since))
    for (const id of String(r.users).split(',')) signals.push({ user_id: +id, name: '', signal: `${r.n} different accounts signed in from one IP address in 30 days (users ${r.users})` });
  for (const r of q.all<any>(`SELECT p.user_id, SUM(p.amount) funded FROM payments p WHERE p.status='success' AND p.paid_at>=? AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.user_id=p.user_id AND t.created_at>=p.paid_at)
      AND EXISTS (SELECT 1 FROM withdrawals w WHERE w.user_id=p.user_id AND w.created_at>=p.paid_at AND julianday(w.created_at)-julianday(p.paid_at)<2) GROUP BY p.user_id`, since))
    signals.push({ user_id: r.user_id, name: '', signal: `funded ${fmtNGN(r.funded)} and asked to withdraw within 48 hours without trading` });
  for (const r of q.all<any>(`SELECT referrer_id, COUNT(*) n FROM referral_rewards WHERE created_at>=? GROUP BY referrer_id HAVING n>=5`, since))
    signals.push({ user_id: r.referrer_id, name: '', signal: `${r.n} referral rewards in 30 days` });
  const fresh = signals.filter((s) => !q.get("SELECT 1 FROM agent_actions WHERE agent='risk' AND target_user_id=? AND created_at>=?", s.user_id, since));
  const byUser = new Map<number, string[]>();
  for (const s of fresh) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s.signal]);
  if (!byUser.size) return '0 signals';
  let notes: Record<string, string> = {};
  let runId: number | null = null;
  const input = [...byUser].map(([id, sig]) => { const u = userById(id); return { user_id: id, name: u ? `${u.first_name} ${u.last_name}` : '?', kyc: u?.kyc_status, joined: u?.created_at.slice(0, 10), signals: [...new Set(sig)] }; });
  if (aiLive()) {
    try {
      const r = await completeJson<{ reviews: { user_id: number; assessment: string }[] }>('risk', { trigger: 'daily', system: `${POLICY}\nYou are a fraud and AML analyst. For each user, write a one-sentence neutral assessment of the signals and what a human should check (e.g. ask for proof of account ownership, check if family members share a device). Do not accuse. Return {"reviews":[{"user_id":number,"assessment":string}]}.`, input });
      runId = r.runId; for (const x of r.data.reviews || []) notes[x.user_id] = x.assessment;
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.risk_error', undefined, String((e as Error).message)); }
  }
  if (!runId) runId = logRun('risk', 'daily', JSON.stringify(input), 'rule-based', 'demo');
  for (const x of input) {
    propose({ agent: 'risk', kind: 'flag_account', risk: 'medium', title: `Review ${x.name}`, summary: notes[x.user_id] || x.signals.join('; '), payload: { user_id: x.user_id, reason: `${x.signals.join('; ')}${notes[x.user_id] ? ` — ${notes[x.user_id]}` : ''}` }, targetUserId: x.user_id, runId });
  }
  return `${input.length} accounts proposed for review`;
}

// ---------- Growth ----------
export async function runGrowth() {
  if (!agentOn('growth')) return 'off';
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const stats = siteStats();
  const facts = {
    open_lots: q.all<any>("SELECT l.title, l.code, l.period_months, l.rate_bps, l.closes_at, c.name AS commodity FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.status='open' ORDER BY l.closes_at LIMIT 5").map((l) => ({ ...l, rate_pct: l.rate_bps / 100, link: `${config.baseUrl}/lots/${l.code}` })),
    trail_updates_this_week: q.all<any>("SELECT l.title, e.stage, e.note FROM trail_events e JOIN lots l ON l.id=e.lot_id WHERE e.created_at>=? ORDER BY e.id DESC LIMIT 8", since),
    payouts_this_week: Number(q.val("SELECT COUNT(*) FROM trades WHERE status='paid' AND paid_at>=?", since)),
    prices: q.all<any>("SELECT c.name, p.price_per_kg, p.market FROM prices p JOIN commodities c ON c.code=p.commodity WHERE p.status='published' AND p.id IN (SELECT MAX(id) FROM prices WHERE status='published' GROUP BY commodity) LIMIT 8").map((p) => ({ commodity: p.name, naira_per_kg: Math.round(p.price_per_kg / 100), market: p.market })),
    totals: { champions: stats.champions, tons: stats.tons, farmers: stats.farmers },
  };
  let out: { subject: string; body: string; posts: string[] } | null = null;
  let runId: number | null = null;
  if (aiLive()) {
    try {
      const r = await completeJson<typeof out>('growth', { trigger: 'weekly', maxTokens: 3000, system: `${POLICY}\nYou are ComboTrader's content writer for the "Harvest Champions Chronicles" newsletter. Using ONLY the facts given, write: a newsletter (subject ≤ 60 chars; body in Markdown, 150–300 words: one story from the Trail, open lots with links, a price snapshot, a closing line pointing to the risk statement at ${config.baseUrl}/legal/risk) and three social posts (≤ 240 chars each, no hashtags spam, no earnings promises beyond the stated rate). Return {"subject":string,"body":string,"posts":[string,string,string]}.`, input: facts });
      out = r.data; runId = r.runId;
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.growth_error', undefined, String((e as Error).message)); }
  }
  if (!out) {
    runId = logRun('growth', 'weekly', JSON.stringify(facts), 'template', 'demo');
    const lots = facts.open_lots.map((l) => `- **${l.title}** — ${l.commodity}, ${l.period_months} months at ${l.rate_pct}% per annum. [View the lot](${l.link})`).join('\n') || '- New lots open soon. Join the waitlist on the Lots page.';
    const trail = facts.trail_updates_this_week[0];
    out = {
      subject: `This week on the Harvest Trail`,
      body: `## From the field\n${trail ? `${trail.title}: ${String(trail.note || trail.stage).replace(/\.+$/, '')}.` : 'Our field teams are sourcing for the next lots.'}\n\n## Open Trade Lots\n${lots}\n\n## Prices this week\n${facts.prices.map((p) => `- ${p.commodity}: ₦${p.naira_per_kg.toLocaleString('en')}/kg${p.market ? ` (${p.market})` : ''}`).join('\n') || '- See the Prices page.'}\n\n${facts.payouts_this_week ? `${facts.payouts_this_week} Champions were paid this week.` : ''}\n\nTrades are not bank deposits. Read the [risk statement](${config.baseUrl}/legal/risk) before you commit.`,
      posts: facts.open_lots.slice(0, 3).map((l) => `${l.commodity} Trade Lot now open on ComboTrader: ${l.period_months} months, ${l.rate_pct}% p.a., real buyer on file, every step on the Harvest Trail. ${l.link}`),
    };
  }
  propose({ agent: 'growth', kind: 'draft_newsletter', risk: 'low', title: `Newsletter draft: ${out.subject}`, summary: out.body.slice(0, 600), payload: { subject: out.subject, body: out.body }, runId });
  if (out.posts?.length) propose({ agent: 'growth', kind: 'social_posts', risk: 'low', title: 'Social posts for this week', summary: out.posts.join('\n\n'), payload: { posts: out.posts }, runId });
  return 'newsletter and posts drafted';
}

// ---------- Ops copilot (admin-invoked) ----------
export async function opsTrailDraft(lotId: number, notes: string, photo: string | null, by: number) {
  const lot = getLot(lotId);
  if (!lot) throw new Error('Lot not found');
  let stage = '', note = '', runId: number | null = null;
  if (aiLive() && agentOn('ops')) {
    try {
      const r = await completeJson<{ stage: string; note: string }>('ops', { trigger: `admin:${by}`, system: `${POLICY}\nTurn a field officer's rough notes into a Harvest Trail update for Champions in this lot. Pick the stage from ${STAGES.join(', ')}. Write the note in plain English, ≤ 50 words, factual, no buyer names, no promises. Return {"stage":string,"note":string}.`, input: { lot: lot.title, commodity: lot.commodity_name, region: lot.region, notes } });
      stage = r.data.stage; note = r.data.note; runId = r.runId;
    } catch (e) { if (!(e instanceof AiUnavailable)) throw e; }
  }
  if (!note) {
    runId = logRun('ops', `admin:${by}`, notes, 'passthrough', 'demo');
    const low = notes.toLowerCase();
    stage = low.includes('deliver') ? 'delivered' : low.includes('warehouse') || low.includes('store') ? 'warehoused' : low.includes('paid') ? 'buyer_paid' : 'sourcing';
    note = notes.trim().slice(0, 300);
  }
  if (!(STAGES as readonly string[]).includes(stage)) stage = 'sourcing';
  return propose({ agent: 'ops', kind: 'trail_update', risk: 'medium', title: `Trail update for ${lot.code}: ${stage}`, summary: note, payload: { lot_id: lot.id, stage, note, photo_path: photo }, runId });
}
export async function opsLotDraft(text: string, by: number) {
  const commodities = q.all<any>('SELECT code, name FROM commodities WHERE active=1');
  if (!aiLive() || !agentOn('ops')) throw new AiUnavailable('Drafting a lot from a contract needs ANTHROPIC_API_KEY.');
  const r = await completeJson<any>('ops', { trigger: `admin:${by}`, system: `${POLICY}\nExtract a draft Trade Lot from this buyer contract summary. commodity must be one of these codes: ${commodities.map((c) => c.code).join(', ')}. Use null when the text does not say. Return {"title","commodity","region","buyer_type","buyer_name","contract_ref","tonnage","farmers","target_naira","min_naira","period_months","rate_pct","buyer_amount_naira","buyer_due" (YYYY-MM-DD),"description"}.`, input: text });
  return propose({ agent: 'ops', kind: 'draft_lot', risk: 'medium', title: `Draft lot: ${r.data.title || 'from contract'}`, summary: JSON.stringify(r.data, null, 1).slice(0, 1500), payload: r.data, runId: r.runId });
}

export const AGENT_JOBS: Record<string, () => Promise<string>> = { onboarding: () => runOnboarding(), treasury: runTreasury, risk: runRisk, growth: runGrowth };
export const _keep = { impactFor, isLang };
