// ComboTrader agents. Principle: agents PROPOSE, rules DISPOSE.
// - Agents read platform data and draft actions. They never move money, approve withdrawals or change balances.
// - Every action is an `agent_actions` row with a risk level. Admin-only alerts run straight away; low-risk messages
//   to Champions run automatically only when Settings → Agents autonomy is "auto_low"; everything else waits in
//   Admin → Agents for a person to approve, edit or reject.
// - Every model call is logged in `agent_runs` (input, output, tokens).
// - Admin → AI agents switches each agent between AI (Claude) and rules. Rules use what the agents have learned
//   (lib/learning.ts) from approved AI output, human edits and measured outcomes, so they improve without a model.
import { q, now } from './db';
import { completeJson, aiLive, useAI, AiUnavailable, POLICY, logRun } from './ai';
import { learn, bestLesson, lessonsFor, parseLesson, used, trackOutcome, scoreLesson, similarity, keyOf, fill, lessonScore, type Lesson } from './learning';
import { lotTitle, lotDescription, nextLotCode } from './lotgen';
import { settings } from './settings';
import { notify, queueEmail, emailShell, escapeHtml } from './notify';
import { audit } from './audit';
import { userById } from './auth';
import { walletBalance } from './ledger';
import { addTrailEvent, getLot, STAGES, siteStats, impactFor, rateFor, lotPeriods } from './trading';
import { treasurySnapshot } from './treasury';
import { faqsFor } from './content';
import { config } from './config';
import { fmtNGN, randomToken } from './util';
import { translate, isLang, LANGS, type Lang } from './i18n';
import type { User } from './http';

export const AGENTS = {
  support: { name: 'Support', what: 'Answers tickets and WhatsApp questions from the FAQs and the Champion\'s own account; hands over anything about money movement.' },
  onboarding: { name: 'Onboarding', what: 'Finds Champions stuck in sign-up, verification, payment or a paused Harvest Plan and drafts a personal next step.' },
  treasury: { name: 'Treasury', what: 'Checks payouts due against cash, credit line and buyer money due; writes the daily brief and raises shortfall alerts.' },
  risk: { name: 'Risk', what: 'Looks for shared bank accounts, shared devices, fast in-and-out money and referral rings; proposes flags for review.' },
  growth: { name: 'Growth', what: 'Drafts the weekly newsletter and social posts from real lots, Trail updates, prices and payouts. Never contacts people who have not opted in.' },
  ops: { name: 'Ops copilot', what: 'Turns field notes into Harvest Trail updates and contract summaries into draft lots, for an admin to approve.' },
  social: { name: 'Social media', what: 'Plans and writes posts from real lots, Trail updates, prices and how-to topics; makes the images; publishes to Facebook, Instagram, LinkedIn, X and Telegram (or prepares them to copy); answers comments and DMs that ask how to join; captures Facebook/Instagram lead-form sign-ups.' },
  email: { name: 'Email marketing', what: 'Sends lifecycle emails to Champions: welcome series, payout reminders, “your money is back” offers, new-lot alerts and win-backs; tests newsletter subject lines. Every email is tracked and has an unsubscribe link.' },
  prospector: { name: 'Prospector', what: 'Finds new Champions: invites people who joined the waitlist, newsletter, contact form or WhatsApp; asks happy Champions to refer friends; researches organisations (cooperatives, faith groups, diaspora associations) and drafts outreach. Follows up, stops on unsubscribe.' },
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
    if (u.notif_email) queueEmail(u.email, title, emailShell(escapeHtml(title), `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`, p.link ? { label: translate(u.lang, 'msg.open'), url: (String(p.link).startsWith('http') ? '' : config.baseUrl) + p.link } : undefined));
    learnMessage(p, u.first_name, u.lang, { userId: u.id });
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
    // Learn: an AI answer a person approved unchanged is reusable at once; a person's own wording waits for review (it may be personal).
    const question = String(p.question || `${t.subject}\n${t.body}`).slice(0, 500);
    if (p._edited) learn({ agent: 'support', kind: 'answer', key: keyOf(question), lang: p.lang || 'en', content: { q: question, a: reply }, source: 'human', active: false });
    else if (p.general_answer) learn({ agent: 'support', kind: 'answer', key: keyOf(question), lang: p.lang || 'en', content: { q: question, a: String(p.general_answer) }, source: 'ai' });
    return 'reply sent';
  },
  /** Posts a Harvest Trail update (notifies every Champion in the lot). */
  trail_update(p, by) {
    const lot = getLot(Number(p.lot_id));
    if (!lot) throw new Error('Lot not found');
    if (!(STAGES as readonly string[]).includes(p.stage)) throw new Error('Unknown stage');
    const n = addTrailEvent(lot.id, p.stage, String(p.note || '').slice(0, 600), p.photo_path || null, by || 0);
    if (p.notes_raw) learnStageWords(String(p.notes_raw), p.stage);
    return `posted; ${n} Champions notified`;
  },
  /** Creates a lot as a DRAFT (never opens it). */
  draft_lot(p, by) {
    if (!q.get('SELECT 1 FROM commodities WHERE code=?', p.commodity)) throw new Error('Unknown commodity');
    const target = Math.round(Number(p.target_naira) * 100), min = Math.round(Number(p.min_naira || settings().min_commit_default / 100) * 100);
    if (!(target > 0) || !(min > 0) || min > target) throw new Error('Check the lot size and minimum');
    const closes = new Date(Date.now() + 21 * 864e5).toISOString();
    const code = nextLotCode(p.commodity, closes);
    const cname = String(q.val('SELECT name FROM commodities WHERE code=?', p.commodity) || p.commodity);
    const region = String(p.region || '').slice(0, 80), buyerType = String(p.buyer_type || 'Buyer').slice(0, 80);
    const id = q.insert('lots', {
      code, commodity: p.commodity, title: String(p.title || lotTitle(cname, region, buyerType)).slice(0, 120),
      description: String(p.description || lotDescription({ commodityName: cname, region, buyerType, tonnage: Number(p.tonnage) || 0, farmers: Number(p.farmers) || 0 })).slice(0, 1000), region,
      buyer_type: String(p.buyer_type || 'Buyer').slice(0, 80), buyer_name: String(p.buyer_name || '').slice(0, 120) || null, contract_ref: String(p.contract_ref || '').slice(0, 80) || null,
      tonnage: Number(p.tonnage) || 0, farmers: Math.round(Number(p.farmers) || 0), target_amount: target, min_commit: min,
      periods: '4,6,9,12', period_months: 12, rate_bps: rateFor(12),
      closes_at: closes, status: 'draft', buyer_amount: p.buyer_amount_naira ? Math.round(Number(p.buyer_amount_naira) * 100) : null,
      buyer_due_at: p.buyer_due ? new Date(`${p.buyer_due}T12:00:00Z`).toISOString() : null, created_by: by, created_at: now(),
    }).id;
    return `draft lot ${code} created (#${id}) — review and open it in Trade Lots`;
  },
  /** Creates a newsletter DRAFT (never sends). */
  draft_newsletter(p, by) {
    const id = q.insert('newsletters', { subject: String(p.subject).slice(0, 150), subject_b: p.subject_b ? String(p.subject_b).slice(0, 150) : null, body: String(p.body).slice(0, 20000), segment: 'all', status: 'draft', created_by: by, created_at: now() }).id;
    return `newsletter draft #${id} created — review it in Newsletter`;
  },
  /** Adds a review note to a Champion record (no account change). */
  flag_account(p, by) {
    const u = userById(Number(p.user_id));
    if (!u) throw new Error('Champion not found');
    const note = `[${now().slice(0, 10)} risk review] ${String(p.reason).slice(0, 400)}`;
    q.run("UPDATE users SET notes=TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?", note, u.id);
    audit(by, 'risk.flag', `user:${u.id}`, p.reason);
    for (const t of p.signal_types || []) scoreLesson(signalLesson(t), true);
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
  /** Invitation email to a lead who asked to hear from us (waitlist, newsletter, contact form) or an imported contact with consent. */
  send_invite(p) {
    const l = q.get<any>('SELECT * FROM leads WHERE id=?', Number(p.lead_id));
    if (!l || !l.email) throw new Error('Lead not found or has no email');
    if (['unsubscribed', 'signed_up', 'bounced'].includes(l.status)) return `skipped: lead is ${l.status}`;
    if (!l.consent) throw new Error('No consent recorded for this contact; mark consent before inviting');
    if (q.get('SELECT 1 FROM users WHERE email=?', l.email)) { q.run("UPDATE leads SET status='signed_up' WHERE id=?", l.id); return 'skipped: already a Champion'; }
    const title = String(p.title || '').slice(0, 120), body = String(p.body || '').slice(0, 2000);
    if (!title || !body) throw new Error('Invitation needs a subject and body');
    const unsub = `${config.baseUrl}/u/${l.token}`;
    queueEmail(l.email, title, emailShell(escapeHtml(title), `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p><p style="font-size:12px;color:#777">${escapeHtml(translate(l.lang, 'agent.unsub'))} <a href="${unsub}">${unsub}</a></p>`,
      { label: translate(l.lang, 'agent.inv_cta'), url: `${config.baseUrl}/signup?utm_source=${encodeURIComponent(l.source)}&utm_medium=email&utm_campaign=invite` }));
    q.run("UPDATE leads SET status='contacted', touches=touches+1, last_touch_at=? WHERE id=?", now(), l.id);
    learnMessage(p, l.name || '', l.lang, { leadId: l.id });
    return `invitation ${l.touches + 1} sent to ${l.email}`;
  },
  /** Partnership email to an organisation (always reviewed by a person first). */
  send_outreach(p) {
    const o = q.get<any>('SELECT * FROM prospects WHERE id=?', Number(p.prospect_id));
    if (!o || !o.email) throw new Error('Organisation not found or has no email');
    if (['do_not_contact', 'won', 'lost'].includes(o.status)) return `skipped: ${o.status}`;
    const title = String(p.title || '').slice(0, 150), body = String(p.body || '').slice(0, 4000);
    if (!title || !body) throw new Error('Outreach needs a subject and body');
    const optout = `${config.baseUrl}/u/${o.token}`;
    queueEmail(o.email, title, emailShell(escapeHtml(title), `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p><p style="font-size:12px;color:#777">Prefer not to hear from us again? <a href="${optout}">${optout}</a></p>`,
      { label: 'See how Harvest Circles work', url: `${config.baseUrl}/circles?utm_source=outreach&utm_medium=email` }));
    q.run("UPDATE prospects SET status=CASE WHEN status='new' THEN 'contacted' ELSE status END, touches=touches+1, last_touch_at=? WHERE id=?", now(), o.id);
    learnMessage({ ...p, situation: p.situation || `org:${o.segment}` }, o.contact_name || '', 'en', { prospectId: o.id }, o.name);
    return `outreach ${o.touches + 1} sent to ${o.name}`;
  },
  /** Saves organisations found by research to Prospects (no one is contacted). */
  save_prospects(p) {
    let n = 0;
    for (const x of (p.organisations || []) as any[]) {
      if (!x?.name) continue;
      const r = q.run('INSERT OR IGNORE INTO prospects (name, segment, location, website, contact_name, email, phone, why, source, token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        String(x.name).slice(0, 150), String(x.segment || p.segment || 'Other').slice(0, 80), String(x.location || p.region || '').slice(0, 120) || null, String(x.website || '').slice(0, 200) || null,
        String(x.contact_name || '').slice(0, 100) || null, /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(x.email || '')) ? String(x.email).toLowerCase() : null, String(x.phone || '').slice(0, 40) || null,
        String(x.why || '').slice(0, 500) || null, 'ai_research', randomToken(16), now());
      n += Number(r.changes);
    }
    return `${n} organisations added to Prospects`;
  },
};
export const ACTION_KINDS = Object.keys(EXECUTORS);
/** Other modules (marketing) add their own action executors here. */
export function registerExecutors(more: Record<string, (p: any, by: number | null) => string>) {
  for (const [k, fn] of Object.entries(more)) { EXECUTORS[k] = fn; if (!ACTION_KINDS.includes(k)) ACTION_KINDS.push(k); }
}

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
  const payload = { ...JSON.parse(a.payload || '{}'), ...(edited || {}), ...(edited ? { _edited: true } : {}) };
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
  const a = q.get<any>("SELECT * FROM agent_actions WHERE id=? AND status='proposed'", id);
  q.run("UPDATE agent_actions SET status='rejected', decided_by=?, decided_at=?, result=? WHERE id=? AND status='proposed'", by, now(), reason.slice(0, 300) || null, id);
  audit(by, 'agent.reject', `action:${id}`, reason);
  if (!a) return;
  const p = JSON.parse(a.payload || '{}');
  // A rejected risk flag teaches the risk agent that these signals were a false alarm.
  if (a.kind === 'flag_account') for (const t of p.signal_types || []) scoreLesson(signalLesson(t), false);
  // "Done" on social posts means they were used: keep the reusable patterns.
  if (a.kind === 'social_posts') for (const t of p.templates || []) learn({ agent: 'growth', kind: 'post', key: 'lot_post', content: { text: t }, source: 'ai' });
  // A rejected rules template counts against it.
  if (p.lesson_id && ['send_message', 'send_invite', 'send_outreach'].includes(a.kind)) scoreLesson(Number(p.lesson_id), false);
}

// ---------- Learning hooks ----------
/** After a message goes out: keep the template (AI-written or edited by a person) and check later whether it worked. */
function learnMessage(p: any, firstName: string, lang: string, who: { userId?: number; leadId?: number; prospectId?: number }, orgName?: string) {
  if (!p.situation) return;
  let lessonId: number | null = p.lesson_id ? Number(p.lesson_id) : null;
  const agent = p._agent || (who.userId ? 'onboarding' : 'prospector');
  const generalise = (t: string) => { let x = String(t); if (firstName && firstName.length > 1) x = x.split(firstName).join('{name}'); if (orgName) x = x.split(orgName).join('{org}'); return x; };
  if (p._edited || p.template) {
    const t = p._edited ? { title: generalise(p.title), body: generalise(p.body) } : p.template;
    if (t?.title && t?.body) lessonId = learn({ agent, kind: 'template', key: String(p.situation), lang, content: { title: t.title, body: t.body }, source: p._edited ? 'human' : 'ai' });
  }
  if (lessonId) { used(lessonId); trackOutcome(lessonId, String(p.situation).startsWith('invite:') || String(p.situation).startsWith('org:') ? 'lead' : String(p.situation), who); }
}
export function signalLesson(type: string) {
  const l = bestLesson('risk', 'signal', type);
  return l ? l.id : learn({ agent: 'risk', kind: 'signal', key: type, content: { advice: '' }, source: 'rules' });
}
const STAGE_HINTS: Record<string, string[]> = {
  sourcing: ['collect', 'collected', 'aggregat', 'cluster', 'buying', 'bought', 'farmers', 'purchase', 'sourcing'],
  warehoused: ['warehouse', 'stored', 'store', 'storage', 'moisture', 'bagged', 'stacked'],
  delivered: ['deliver', 'delivered', 'truck', 'trucks', 'dispatched', 'offloaded', 'waybill'],
  buyer_paid: ['paid', 'payment', 'remitted', 'settled', 'invoice'],
  funded: ['funded', 'filled'],
};
function learnStageWords(notes: string, stage: string) {
  const row = bestLesson('ops', 'stage_words', 'all');
  const counts: Record<string, Record<string, number>> = parseLesson(row) || {};
  for (const w of new Set(notes.toLowerCase().match(/[a-z]{4,}/g) || [])) { counts[stage] ||= {}; counts[stage][w] = (counts[stage][w] || 0) + 1; }
  if (row) q.run('UPDATE agent_lessons SET content=?, updated_at=? WHERE id=?', JSON.stringify(counts), now(), row.id);
  else learn({ agent: 'ops', kind: 'stage_words', key: 'all', content: counts, source: 'ai' });
}
/** Rules: picks the Harvest Trail stage from field notes using built-in hints plus words learned from approved updates. */
export function guessStage(notes: string) {
  const learned: Record<string, Record<string, number>> = parseLesson(bestLesson('ops', 'stage_words', 'all')) || {};
  const ws = notes.toLowerCase().match(/[a-z]{4,}/g) || [];
  let best = 'sourcing', top = 0;
  for (const st of STAGES) {
    let sc = 0;
    for (const w of ws) { if ((STAGE_HINTS[st] || []).some((h) => w.startsWith(h))) sc += 2; sc += Math.min(3, learned[st]?.[w] || 0) * 0.5; }
    if (sc > top) { top = sc; best = st; }
  }
  return best;
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
/** Best learned answer (approved by a person or from AI) for a question. */
export function learnedAnswer(lang: Lang, question: string) {
  let best: { q: string; a: string; score: number; id: number } | null = null;
  for (const l of lessonsFor('support', 'answer', { lang })) {
    const c = parseLesson<{ q: string; a: string }>(l); if (!c?.a) continue;
    const score = similarity(question, c.q) * (0.85 + 0.3 * lessonScore(l));
    if (!best || score > best.score) best = { q: c.q, a: c.a, score, id: l.id };
  }
  return best;
}
/** Best FAQ by word overlap (rules mode and a hint for the model). */
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
  if (useAI('support') && agentOn('support')) {
    try {
      const { data, runId } = await completeJson<{ reply: string; escalate: boolean; reason?: string; general_answer?: string }>('support', {
        fast: true, trigger,
        system: `${POLICY}\nYou are the ComboTrader support assistant. Answer using the FAQ and the Champion's own account data below. ` +
          `Set escalate=true (and say a team member will follow up within one working day) for: anything about money that is missing, late or wrong; withdrawals; complaints; account access; identity checks that failed; anything you cannot answer from the data. ` +
          `Keep replies under 120 words. Answer in ${langName(lang)}. ` +
          `Also write "general_answer": the same answer with no personal details (no names, amounts or dates from the account) so it can be reused for anyone asking this; use "" if the answer depends on this person's account. ` +
          `Return {"reply": string, "escalate": boolean, "reason": string, "general_answer": string}.`,
        input: { question, champion: u ? championContext(u) : 'visitor without an account', faq: faqsFor(lang).map((f) => ({ q: f.q, a: f.a })), support_email: settings().support_email, site: config.baseUrl },
      });
      const escalate = !!data.escalate || sensitive;
      const general = escalate ? '' : String(data.general_answer || '').slice(0, 1500);
      // Answers from chats nobody reviewed are kept switched off until an admin turns them on.
      if (general && !trigger.startsWith('ticket:')) learn({ agent: 'support', kind: 'answer', key: keyOf(question), lang, content: { q: question.slice(0, 500), a: general }, source: 'ai', active: false });
      return { reply: String(data.reply || '').slice(0, 1500), escalate, reason: data.reason || '', runId, general };
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.support_error', undefined, String((e as Error).message)); }
  }
  // Rules: the FAQ or an answer the agents have learned, whichever fits better; hand over when unsure or sensitive.
  const m = faqMatch(lang, question);
  const l = learnedAnswer(lang, question);
  const pick = l && (!m || l.score > m.score) ? { ...l, from: 'learned' } : m ? { ...m, from: 'FAQ', id: 0 } : null;
  const runId = logRun('support', trigger, question, pick ? `${pick.score.toFixed(2)} ${pick.from}: ${pick.q}` : 'no match', 'rules');
  if (pick && pick.score >= 0.35 && !sensitive) { if (pick.id) used(pick.id); return { reply: `${pick.a}`, escalate: false, reason: `${pick.from}: ${pick.q}`, runId, general: '' }; }
  return { reply: translate(lang, 'agent.handover'), escalate: true, reason: sensitive ? 'money or account matter' : 'no confident answer', runId, general: '' };
}

/** New ticket → draft (or send) a reply. Escalations stay open for the team, with the draft attached. */
export async function supportOnTicket(ticketId: number) {
  if (!agentOn('support')) return;
  const t = q.get<any>('SELECT * FROM tickets WHERE id=?', ticketId);
  const u = t && userById(t.user_id);
  if (!t || !u) return;
  const r = await supportAnswer(u, `${t.subject}\n\n${t.body}`, u.lang, `ticket:${t.id}`);
  propose({ agent: 'support', kind: 'reply_ticket', risk: r.escalate ? 'medium' : 'low', title: `Reply to ticket #${t.id}: ${t.subject}`.slice(0, 200), summary: r.escalate ? `Needs a person: ${r.reason}` : r.reason, payload: { ticket_id: t.id, reply: r.reply, question: `${t.subject}\n${t.body}`.slice(0, 600), general_answer: r.general, lang: u.lang }, targetUserId: u.id, runId: r.runId });
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
  const anyOpen = !!q.get("SELECT 1 FROM lots WHERE status='open' AND closes_at>?", now());
  add(q.all<any>("SELECT * FROM users WHERE status='active' AND kyc_status='rejected'"), 'kyc', 'identity check failed; they can try again or contact support', '/app/profile#kyc');
  add(q.all<any>("SELECT DISTINCT u.* FROM users u JOIN payments p ON p.user_id=u.id WHERE u.status='active' AND p.status IN ('pending','failed') AND p.created_at>=? AND p.created_at<=? AND NOT EXISTS (SELECT 1 FROM payments s WHERE s.user_id=u.id AND s.status='success' AND s.created_at>=p.created_at)", d(3), d(0.1)), 'payment', 'started a payment that did not complete', '/app/wallet#fund');
  add(q.all<any>(`SELECT * FROM users u WHERE role='champion' AND status='active' AND created_at<=? AND created_at>=? AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id=u.id)`, d(3), d(30)), 'fund', 'confirmed their account but has not added money yet; explain how a Trade Lot works and that the minimum is shown on each lot', '/app/wallet#fund');
  if (anyOpen) add(q.all<any>("SELECT DISTINCT u.* FROM users u JOIN payments p ON p.user_id=u.id AND p.status='success' WHERE u.status='active' AND p.paid_at<=? AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.user_id=u.id)", d(2)), 'first_lot', 'added money to their wallet but has not joined a Trade Lot yet; lots are open now', '/app/lots');
  add(q.all<any>("SELECT DISTINCT u.* FROM users u JOIN payments p ON p.user_id=u.id AND p.status='success' WHERE u.status='active' AND u.role='champion' AND u.totp_enabled=0 AND p.paid_at<=?", d(2)), 'secure_2fa', 'has money on ComboTrader but has not turned on two-step sign-in; suggest adding an authenticator app (Google Authenticator, Microsoft Authenticator) in Security, it takes two minutes', '/app/security');
  add(q.all<any>("SELECT DISTINCT u.* FROM users u JOIN plans p ON p.user_id=u.id WHERE u.status='active' AND p.status='paused'"), 'plan', 'Harvest Plan is paused after failed card charges', '/app/plans');
  add(q.all<any>("SELECT DISTINCT u.* FROM users u JOIN gifts g ON g.giver_id=u.id WHERE g.status='sent' AND g.created_at<=?", d(7)), 'gift', 'sent a Harvest gift that has not been claimed after a week; they could resend the link', '/app/gifts');
  const todo = cases.filter((x) => !q.get('SELECT 1 FROM nudges WHERE user_id=? AND kind=? AND ref=?', x.u.id, 'agent_onb', x.ref));
  if (!todo.length) return '0 Champions need a nudge';
  type Draft = { user_id: number; title: string; body: string; template?: { title: string; body: string }; lesson_id?: number | null };
  let drafts: Draft[] = [];
  let runId: number | null = null;
  if (useAI('onboarding')) {
    try {
      // Show the model what has worked before, so it builds on the best templates.
      const examples = [...new Set(todo.map((x) => x.key))].map((k) => { const l = bestLesson('onboarding', 'template', k); return l && l.wins + l.losses >= 3 ? { situation: k, worked_for: `${l.wins} of ${l.wins + l.losses}`, ...parseLesson(l) } : null; }).filter(Boolean);
      const r = await completeJson<{ messages: Draft[] }>('onboarding', {
        fast: true, trigger: 'daily', maxTokens: 5000,
        system: `${POLICY}\nYou are the ComboTrader onboarding assistant. For each Champion, write one short, kind message (title ≤ 8 words, body ≤ 60 words) in their language that names the one next step for their situation. No pressure, no urgency tricks, no promises about earnings. ` +
          `Also give "template": the same message with the first name replaced by {name}, so it can be reused. Learn from the examples that worked. Return {"messages":[{"user_id":number,"title":string,"body":string,"template":{"title":string,"body":string}}]}.`,
        input: { champions: todo.map((x) => ({ user_id: x.u.id, first_name: x.u.first_name, language: langName(x.u.lang), situation: x.situation })), examples_that_worked: examples },
      });
      drafts = r.data.messages || []; runId = r.runId;
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.onboarding_error', undefined, String((e as Error).message)); }
  }
  if (!drafts.length) {
    runId = logRun('onboarding', 'daily', JSON.stringify(todo.map((x) => x.u.id)), 'learned templates / defaults', 'rules');
    drafts = todo.map((x) => {
      const l = bestLesson('onboarding', 'template', x.key, x.u.lang);
      const t = parseLesson<{ title: string; body: string }>(l);
      if (t) return { user_id: x.u.id, title: fill(t.title, { name: x.u.first_name }), body: fill(t.body, { name: x.u.first_name }), lesson_id: l!.id };
      // No template yet: the built-in wording becomes the first lesson, so it is scored too.
      const title = translate(x.u.lang, 'agent.onb_title', { name: '{name}' }), body = translate(x.u.lang, `agent.onb.${x.key}`, { name: '{name}' });
      const id = learn({ agent: 'onboarding', kind: 'template', key: x.key, lang: x.u.lang, content: { title, body }, source: 'rules' });
      return { user_id: x.u.id, title: fill(title, { name: x.u.first_name }), body: fill(body, { name: x.u.first_name }), lesson_id: id };
    });
  }
  let n = 0;
  for (const dft of drafts) {
    const x = todo.find((t) => t.u.id === Number(dft.user_id));
    if (!x || !onceFor(x.u.id, 'agent_onb', x.ref)) continue;
    propose({ agent: 'onboarding', kind: 'send_message', risk: 'low', title: `Nudge ${x.u.first_name} ${x.u.last_name}: ${x.situation}`.slice(0, 200),
      payload: { user_id: x.u.id, title: dft.title, body: dft.body, link: x.link, situation: x.key, _agent: 'onboarding', ...(dft.lesson_id ? { lesson_id: dft.lesson_id } : {}), ...(dft.template ? { template: dft.template } : {}) }, targetUserId: x.u.id, runId });
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
  const situations = [
    snap.horizons.some((h) => h.level === 'short') && 'shortfall', snap.horizons.some((h) => h.level === 'warn') && 'thin_cover',
    snap.overdue.length && 'overdue_buyer', !snap.cashAsOf && 'no_cash_position', snap.cashAsOf && snap.cashAsOf < new Date(Date.now() - 7 * 864e5).toISOString() && 'stale_cash_position',
    snap.missingBuyerTerms.length && 'missing_buyer_terms',
  ].filter(Boolean) as string[];
  let brief = '', runId: number | null = null;
  if (useAI('treasury')) {
    try {
      const r = await completeJson<{ brief: string; advice?: Record<string, string> }>('treasury', { trigger: 'daily', system: `${POLICY}\nYou are Kitovu's treasury analyst. Kitovu must pay every Champion on the payout date even if buyers are late. From the figures, write a brief for the finance team (≤ 150 words): the position, the biggest risk in the next 30 days, and 2–3 concrete actions (e.g. chase a named overdue buyer, draw on the credit line, slow new lot openings, update a stale cash position). Use only the numbers given. ` +
        `Also give "advice": for each situation listed in "situations", one general sentence (no names or amounts) saying what the finance team should do whenever it happens. Return {"brief": string, "advice": {"<situation>": string}}.`, input: { ...facts, situations } });
      brief = r.data.brief; runId = r.runId;
      for (const [k, v] of Object.entries(r.data.advice || {})) if (situations.includes(k) && v) learn({ agent: 'treasury', kind: 'advice', key: k, content: { text: String(v).slice(0, 400) }, source: 'ai' });
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.treasury_error', undefined, String((e as Error).message)); }
  }
  if (!brief) {
    runId = logRun('treasury', 'daily', JSON.stringify(facts), 'template brief + learned advice', 'rules');
    const advice = situations.map((k) => { const l = bestLesson('treasury', 'advice', k); if (l) used(l.id); return parseLesson<{ text: string }>(l)?.text; }).filter(Boolean);
    brief = [`Next 30 days: ${naira(h30.due.total)} due to Champions across ${h30.due.count} trades; available ${naira(h30.available)} (cash ${naira(h30.cash)}, credit line ${naira(h30.creditLine)}, buyer money due ${naira(h30.buyerDue)}). Coverage: ${h30.ratio === null ? 'nothing due' : h30.ratio.toFixed(2)}.`,
      snap.overdue.length ? `Overdue buyers: ${snap.overdue.map((o) => `${o.lot} (${o.buyer}) ${naira(o.outstanding)}, ${o.days} days`).join('; ')}. Kitovu covers these payouts; chase the buyers.` : 'No buyer is overdue.',
      !snap.cashAsOf ? 'No cash position recorded yet — add one in Admin → Treasury.' : `Cash position last updated ${snap.cashAsOf.slice(0, 10)}.`,
      snap.missingBuyerTerms.length ? `Add buyer contract value and due date for: ${snap.missingBuyerTerms.join(', ')}.` : '',
      advice.length ? `Suggested actions:\n${advice.map((a) => `- ${a}`).join('\n')}` : ''].filter(Boolean).join('\n');
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
  const signals: { user_id: number; name: string; signal: string; type: string }[] = [];
  for (const r of q.all<any>(`SELECT b.account_number, GROUP_CONCAT(DISTINCT b.user_id) AS users FROM bank_accounts b WHERE b.account_number!='INTL' GROUP BY b.account_number HAVING COUNT(DISTINCT b.user_id)>1`))
    for (const id of String(r.users).split(',')) signals.push({ user_id: +id, name: '', type: 'shared_bank', signal: `bank account ending ${String(r.account_number).slice(-4)} shared by users ${r.users}` });
  for (const r of q.all<any>(`SELECT ip, GROUP_CONCAT(DISTINCT user_id) AS users, COUNT(DISTINCT user_id) n FROM login_events WHERE success=1 AND created_at>=? AND ip NOT IN ('', '127.0.0.1', '::1') GROUP BY ip HAVING n>=4`, since))
    for (const id of String(r.users).split(',')) signals.push({ user_id: +id, name: '', type: 'shared_ip', signal: `${r.n} different accounts signed in from one IP address in 30 days (users ${r.users})` });
  for (const r of q.all<any>(`SELECT p.user_id, SUM(p.amount) funded FROM payments p WHERE p.status='success' AND p.paid_at>=? AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.user_id=p.user_id AND t.created_at>=p.paid_at)
      AND EXISTS (SELECT 1 FROM withdrawals w WHERE w.user_id=p.user_id AND w.created_at>=p.paid_at AND julianday(w.created_at)-julianday(p.paid_at)<2) GROUP BY p.user_id`, since))
    signals.push({ user_id: r.user_id, name: '', type: 'fast_in_out', signal: `funded ${fmtNGN(r.funded)} and asked to withdraw within 48 hours without trading` });
  for (const r of q.all<any>(`SELECT referrer_id, COUNT(*) n FROM referral_rewards WHERE created_at>=? GROUP BY referrer_id HAVING n>=5`, since))
    signals.push({ user_id: r.referrer_id, name: '', type: 'referral_burst', signal: `${r.n} referral rewards in 30 days` });
  for (const r of q.all<any>(`SELECT seller_id, buyer_id, COUNT(*) n FROM trade_sales WHERE created_at>=? GROUP BY seller_id, buyer_id HAVING n>=3`, since))
    for (const id of [r.seller_id, r.buyer_id]) signals.push({ user_id: id, name: '', type: 'market_pair', signal: `${r.n} marketplace sales between users ${r.seller_id} and ${r.buyer_id} in 30 days` });
  const fresh = signals.filter((s) => !q.get("SELECT 1 FROM agent_actions WHERE agent='risk' AND target_user_id=? AND created_at>=?", s.user_id, since));
  // Learned weights: a signal type people keep rejecting (5+ reviews, under 20% confirmed) is only raised alongside another signal.
  const weak = (t: string) => { const l = bestLesson('risk', 'signal', t); return !!l && l.wins + l.losses >= 5 && l.wins / (l.wins + l.losses) < 0.2; };
  const byUser = new Map<number, string[]>(), typesOf = new Map<number, Set<string>>();
  for (const s of fresh) { byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s.signal]); typesOf.set(s.user_id, new Set([...(typesOf.get(s.user_id) || []), s.type])); }
  let quiet = 0;
  for (const [id, types] of typesOf) if (types.size === 1 && weak([...types][0])) { byUser.delete(id); quiet++; }
  if (!byUser.size) return quiet ? `${quiet} weak signals skipped (learned from past reviews)` : '0 signals';
  let notes: Record<string, string> = {};
  let runId: number | null = null;
  const input = [...byUser].map(([id, sig]) => { const u = userById(id); return { user_id: id, name: u ? `${u.first_name} ${u.last_name}` : '?', kyc: u?.kyc_status, joined: u?.created_at.slice(0, 10), signals: [...new Set(sig)], signal_types: [...(typesOf.get(id) || [])] }; });
  if (useAI('risk')) {
    try {
      const types = [...new Set(input.flatMap((x) => x.signal_types))];
      const r = await completeJson<{ reviews: { user_id: number; assessment: string }[]; checks?: Record<string, string> }>('risk', { trigger: 'daily', system: `${POLICY}\nYou are a fraud and AML analyst. For each user, write a one-sentence neutral assessment of the signals and what a human should check (e.g. ask for proof of account ownership, check if family members share a device). Do not accuse. ` +
        `Also give "checks": for each signal type in ${JSON.stringify(types)}, one general sentence on what a reviewer should check whenever it appears. Return {"reviews":[{"user_id":number,"assessment":string}],"checks":{"<type>":string}}.`, input });
      runId = r.runId; for (const x of r.data.reviews || []) notes[x.user_id] = x.assessment;
      for (const [t, v] of Object.entries(r.data.checks || {})) if (types.includes(t) && v) { const id = signalLesson(t); q.run('UPDATE agent_lessons SET content=?, source=\'ai\', updated_at=? WHERE id=?', JSON.stringify({ advice: String(v).slice(0, 400) }), now(), id); }
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.risk_error', undefined, String((e as Error).message)); }
  }
  if (!runId) runId = logRun('risk', 'daily', JSON.stringify(input), 'rules + learned checks', 'rules');
  for (const x of input) {
    if (!notes[x.user_id]) notes[x.user_id] = x.signal_types.map((t) => parseLesson<{ advice: string }>(bestLesson('risk', 'signal', t))?.advice).filter(Boolean).join(' ');
    propose({ agent: 'risk', kind: 'flag_account', risk: 'medium', title: `Review ${x.name}`, summary: notes[x.user_id] || x.signals.join('; '), payload: { user_id: x.user_id, signal_types: x.signal_types, reason: `${x.signals.join('; ')}${notes[x.user_id] ? ` — ${notes[x.user_id]}` : ''}` }, targetUserId: x.user_id, runId });
  }
  return `${input.length} accounts proposed for review`;
}

// ---------- Growth ----------
export async function runGrowth() {
  if (!agentOn('growth')) return 'off';
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const stats = siteStats();
  const facts = {
    open_lots: q.all<any>("SELECT l.title, l.code, l.periods, l.period_months, l.closes_at, c.name AS commodity FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.status='open' ORDER BY l.closes_at LIMIT 5").map((l) => { const p = lotPeriods(l); return { title: l.title, code: l.code, commodity: l.commodity, closes_at: l.closes_at, periods: `${p[0]} to ${p[p.length - 1]} months`, rates: `${rateFor(p[0]) / 100}% to ${rateFor(p[p.length - 1]) / 100}% per annum (longer stays earn more)`, link: `${config.baseUrl}/lots/${l.code}` }; }),
    trail_updates_this_week: q.all<any>("SELECT l.title, e.stage, e.note FROM trail_events e JOIN lots l ON l.id=e.lot_id WHERE e.created_at>=? ORDER BY e.id DESC LIMIT 8", since),
    payouts_this_week: Number(q.val("SELECT COUNT(*) FROM trades WHERE status='paid' AND paid_at>=?", since)),
    prices: q.all<any>("SELECT c.name, p.price_per_kg, p.market FROM prices p JOIN commodities c ON c.code=p.commodity WHERE p.status='published' AND p.id IN (SELECT MAX(id) FROM prices WHERE status='published' GROUP BY commodity) LIMIT 8").map((p) => ({ commodity: p.name, naira_per_kg: Math.round(p.price_per_kg / 100), market: p.market })),
    totals: { champions: stats.champions, tons: stats.tons, farmers: stats.farmers },
  };
  let out: { subject: string; subject_b?: string; body: string; posts: string[]; post_templates?: string[] } | null = null;
  let runId: number | null = null, rules = false;
  if (useAI('growth')) {
    try {
      const r = await completeJson<typeof out>('growth', { trigger: 'weekly', maxTokens: 3500, system: `${POLICY}\nYou are ComboTrader's content writer for the "Harvest Champions Chronicles" newsletter. Using ONLY the facts given, write: a newsletter (subject ≤ 60 chars; body in Markdown, 150–300 words: one story from the Trail, open lots with links, a price snapshot, a closing line pointing to the risk statement at ${config.baseUrl}/legal/risk) and three social posts (≤ 240 chars each, no hashtags spam, no earnings promises beyond the stated rate). ` +
        `Also give "post_templates": the three posts rewritten with placeholders {commodity}, {periods}, {rates}, {link} instead of the specific lot details, so they can be reused for any lot. Also give "subject_b": a second subject line with a different angle, to A/B test. Return {"subject":string,"subject_b":string,"body":string,"posts":[string,string,string],"post_templates":[string,string,string]}.`, input: { ...facts, subject_lines_that_won: lessonsFor('growth', 'post', { key: 'subject' }).filter((l) => l.wins > 0).slice(0, 5).map((l) => parseLesson(l)?.text) } });
      out = r.data; runId = r.runId;
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.growth_error', undefined, String((e as Error).message)); }
  }
  if (!out) {
    rules = true;
    runId = logRun('growth', 'weekly', JSON.stringify(facts), 'template + learned post patterns', 'rules');
    const learnedPosts = lessonsFor('growth', 'post', { key: 'lot_post' }).sort((a, b) => String(a.last_used_at || '').localeCompare(String(b.last_used_at || '')));
    const lots = facts.open_lots.map((l) => `- **${l.title}** — ${l.commodity}, ${l.periods} at ${l.rates}. [View the lot](${l.link})`).join('\n') || '- New lots open soon. Join the waitlist on the Lots page.';
    const trail = facts.trail_updates_this_week[0];
    const learnedSubject = lessonsFor('growth', 'post', { key: 'subject' }).filter((l) => l.wins > l.losses).sort((a, b) => lessonScore(b) - lessonScore(a))[0];
    out = {
      subject: `This week on the Harvest Trail`,
      subject_b: parseLesson<{ text: string }>(learnedSubject)?.text?.replace(/\d[\d,.]*/g, '').trim() || (facts.open_lots[0] ? `New: ${facts.open_lots[0].commodity} Trade Lot and news from the field` : 'News from the field and prices this week'),
      body: `## From the field\n${trail ? `${trail.title}: ${String(trail.note || trail.stage).replace(/\.+$/, '')}.` : 'Our field teams are sourcing for the next lots.'}\n\n## Open Trade Lots\n${lots}\n\n## Prices this week\n${facts.prices.map((p) => `- ${p.commodity}: ₦${p.naira_per_kg.toLocaleString('en')}/kg${p.market ? ` (${p.market})` : ''}`).join('\n') || '- See the Prices page.'}\n\n${facts.payouts_this_week ? `${facts.payouts_this_week} Champions were paid this week.` : ''}\n\nTrades are not bank deposits. Read the [risk statement](${config.baseUrl}/legal/risk) before you commit.`,
      posts: facts.open_lots.slice(0, 3).map((l, i) => {
        const t = learnedPosts[i] ? parseLesson<{ text: string }>(learnedPosts[i])?.text : null;
        if (t) { used(learnedPosts[i].id); return fill(t, { commodity: l.commodity, periods: l.periods, rates: l.rates, link: l.link }); }
        return `${l.commodity} Trade Lot now open on ComboTrader: ${l.periods}, ${l.rates}. Real buyer on file, every step on the Harvest Trail. ${l.link}`;
      }),
    };
  }
  propose({ agent: 'growth', kind: 'draft_newsletter', risk: 'low', title: `Newsletter draft: ${out.subject}`, summary: out.body.slice(0, 600), payload: { subject: out.subject, subject_b: out.subject_b && out.subject_b !== out.subject ? out.subject_b : null, body: out.body, ...(rules ? { _rules: true } : {}) }, runId });
  if (out.posts?.length) propose({ agent: 'growth', kind: 'social_posts', risk: 'low', title: 'Social posts for this week', summary: out.posts.join('\n\n'), payload: { posts: out.posts, templates: (out.post_templates || []).filter((t) => typeof t === 'string' && t.includes('{link}')) }, runId });
  return 'newsletter and posts drafted';
}

// ---------- Ops copilot (admin-invoked) ----------
export async function opsTrailDraft(lotId: number, notes: string, photo: string | null, by: number) {
  const lot = getLot(lotId);
  if (!lot) throw new Error('Lot not found');
  let stage = '', note = '', runId: number | null = null;
  if (useAI('ops') && agentOn('ops')) {
    try {
      const r = await completeJson<{ stage: string; note: string }>('ops', { trigger: `admin:${by}`, system: `${POLICY}\nTurn a field officer's rough notes into a Harvest Trail update for Champions in this lot. Pick the stage from ${STAGES.join(', ')}. Write the note in plain English, ≤ 50 words, factual, no buyer names, no promises. Return {"stage":string,"note":string}.`, input: { lot: lot.title, commodity: lot.commodity_name, region: lot.region, notes } });
      stage = r.data.stage; note = r.data.note; runId = r.runId;
    } catch (e) { if (!(e instanceof AiUnavailable)) throw e; }
  }
  if (!note) {
    stage = guessStage(notes);
    runId = logRun('ops', `admin:${by}`, notes, `stage ${stage} from learned words`, 'rules');
    note = notes.trim().replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 300);
  }
  if (!(STAGES as readonly string[]).includes(stage)) stage = 'sourcing';
  return propose({ agent: 'ops', kind: 'trail_update', risk: 'medium', title: `Trail update for ${lot.code}: ${stage}`, summary: note, payload: { lot_id: lot.id, stage, note, photo_path: photo, notes_raw: notes.slice(0, 1000) }, runId });
}
export async function opsLotDraft(text: string, by: number) {
  const commodities = q.all<any>('SELECT code, name FROM commodities WHERE active=1');
  if (!useAI('ops') || !agentOn('ops')) {
    const data = parseContract(text, commodities);
    if (!data.commodity) throw new Error('Could not find a commodity in the text. Name the commodity (e.g. “maize”) or switch the Ops copilot to AI.');
    const runId = logRun('ops', `admin:${by}`, text, JSON.stringify(data), 'rules');
    return propose({ agent: 'ops', kind: 'draft_lot', risk: 'medium', title: `Draft lot: ${data.title}`, summary: `Read by rules — check every figure. ${JSON.stringify(data, null, 1)}`.slice(0, 1500), payload: data, runId });
  }
  const r = await completeJson<any>('ops', { trigger: `admin:${by}`, system: `${POLICY}\nExtract a draft Trade Lot from this buyer contract summary. commodity must be one of these codes: ${commodities.map((c) => c.code).join(', ')}. Use null when the text does not say. Return {"title","commodity","region","buyer_type","buyer_name","contract_ref","tonnage","farmers","target_naira","min_naira","period_months","rate_pct","buyer_amount_naira","buyer_due" (YYYY-MM-DD),"description"}.`, input: text });
  return propose({ agent: 'ops', kind: 'draft_lot', risk: 'medium', title: `Draft lot: ${r.data.title || 'from contract'}`, summary: JSON.stringify(r.data, null, 1).slice(0, 1500), payload: r.data, runId: r.runId });
}

const STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara', 'Abuja', 'FCT'];
/** Rules: reads commodity, tonnage, amounts, states and a due date from a contract or LPO summary. Every figure is checked by a person. */
export function parseContract(text: string, commodities: { code: string; name: string }[]) {
  const t = text.replace(/\s+/g, ' ');
  const com = commodities.slice().sort((a, b) => b.name.length - a.name.length).find((c) => new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t) || new RegExp(`\\b${c.code.replace(/_/g, ' ')}\\b`, 'i').test(t));
  const tons = t.match(/([\d,.]+)\s*(?:mt|metric tons?|metric tonnes?|tons?|tonnes?)\b/i);
  const money = [...t.matchAll(/(?:₦|NGN|N)\s?([\d,]{5,}(?:\.\d+)?)(\s*(?:m|million|bn|billion))?/gi)].map((m) => { let v = Number(m[1].replace(/,/g, '')); if (/^\s*(m|million)/i.test(m[2] || '')) v *= 1e6; if (/^\s*(bn|billion)/i.test(m[2] || '')) v *= 1e9; return v; }).filter((v) => v > 0);
  const buyer = t.match(/\b(?:buyer|offtaker|off-taker)\s*[:\-]\s*([^.;]{3,60})/i)?.[1]?.trim() || null;
  // Sourcing states: those named after "from" (or anywhere but the buyer's address).
  const fromPart = t.match(/\bfrom\s+([^.;]*?)(?:\s+(?:at|for|to|by|with|worth)\b|[.;]|$)/i)?.[1] || '';
  const inText = (src: string) => STATES.filter((st) => new RegExp(`\\b${st}\\b`, 'i').test(src));
  const states = inText(fromPart).length ? inText(fromPart) : inText(t.replace(buyer || '\u0000', ''));
  const due = t.match(/(20\d\d-\d\d-\d\d)/)?.[1] || null;
  const ref = t.match(/\b(?:LPO|PO|contract|ref(?:erence)?)\s*(?:no\.?|number|#)?\s*:?\s*([A-Z0-9][A-Z0-9/-]*\d[A-Z0-9/-]*)/i)?.[1] || null;
  const contractValue = money.length ? Math.max(...money) : null;
  const region = states.slice(0, 3).join(' & ');
  const buyerType = buyer || 'Buyer';
  return {
    title: com ? lotTitle(com.name, region, buyerType) : 'Draft lot', commodity: com?.code || null, region, buyer_type: buyerType, buyer_name: null, contract_ref: ref,
    tonnage: tons ? Number(tons[1].replace(/,/g, '')) : null, farmers: null,
    // Rules default: raise about 80% of the contract value from Champions; a person adjusts it.
    target_naira: contractValue ? Math.round(contractValue * 0.8) : null, min_naira: settings().min_commit_default / 100,
    buyer_amount_naira: contractValue, buyer_due: due, description: null,
  };
}

// ---------- Prospector: finding and onboarding new Champions ----------
const INVITE_GAP_DAYS = [0, 3, 7, 14]; // wait before invitation 1, 2, 3 (then stop)
/** Brings in people who showed interest but have no account yet; marks those who have since signed up. */
export function syncLeads() {
  const add = (email: string | null, phone: string | null, name: string | null, lang: string, source: string) => {
    if (!email && !phone) return;
    q.run('INSERT OR IGNORE INTO leads (email, phone, name, lang, source, consent, token, created_at) VALUES (?,?,?,?,?,1,?,?)', email ? email.toLowerCase() : null, email ? null : phone, name, lang, source, randomToken(16), now());
  };
  for (const r of q.all<any>('SELECT DISTINCT email FROM waitlist WHERE email IS NOT NULL AND user_id IS NULL')) add(r.email, null, null, 'en', 'waitlist');
  for (const r of q.all<any>("SELECT email, lang FROM subscribers WHERE status='confirmed' AND user_id IS NULL")) add(r.email, null, null, r.lang || 'en', 'newsletter');
  for (const r of q.all<any>('SELECT email, name FROM contact_messages WHERE email IS NOT NULL')) add(r.email, null, r.name ? String(r.name).split(' ')[0] : null, 'en', 'contact');
  for (const r of q.all<any>("SELECT DISTINCT phone FROM wa_messages WHERE direction='in' AND user_id IS NULL")) add(null, r.phone, null, 'en', 'whatsapp');
  const joined = q.run("UPDATE leads SET status='signed_up', user_id=(SELECT id FROM users WHERE users.email=leads.email) WHERE status NOT IN ('signed_up','unsubscribed') AND email IN (SELECT email FROM users)").changes;
  return Number(joined);
}

export async function runProspector() {
  if (!agentOn('prospector')) return 'off';
  const limit = Math.max(1, Number(settings().prospect_daily_limit) || 15);
  const joined = syncLeads();
  const out: string[] = [];
  if (joined) out.push(`${joined} leads have signed up`);
  let budget = limit;

  // 1) Invitations to people who asked to hear from us.
  const due = q.all<any>(`SELECT * FROM leads WHERE consent=1 AND email IS NOT NULL AND status IN ('new','contacted') AND touches < 3 ORDER BY touches, id LIMIT 200`)
    .filter((l) => !l.last_touch_at || Date.now() - new Date(l.last_touch_at).getTime() >= INVITE_GAP_DAYS[l.touches] * 864e5)
    .filter((l) => !q.get("SELECT 1 FROM agent_actions WHERE kind='send_invite' AND status='proposed' AND payload LIKE ?", `%"lead_id":${l.id},%`))
    .slice(0, budget);
  if (due.length) {
    type Inv = { lead_id: number; title: string; body: string; template?: { title: string; body: string }; lesson_id?: number };
    let drafts: Inv[] = [], runId: number | null = null;
    const lots = q.all<any>("SELECT l.title, l.code, c.name AS commodity FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.status='open' ORDER BY l.closes_at LIMIT 3");
    const facts = { open_lots: lots.map((l) => ({ title: l.title, link: `${config.baseUrl}/lots/${l.code}` })), rates: `${rateFor(4) / 100}% (4 months) to ${rateFor(12) / 100}% (12 months) per annum`, minimum: fmtNGN(settings().min_commit_default), how_it_works: `${config.baseUrl}/how-it-works`, risk: `${config.baseUrl}/legal/risk` };
    if (useAI('prospector')) {
      try {
        const r = await completeJson<{ invites: Inv[] }>('prospector', { fast: true, trigger: 'daily', maxTokens: 6000,
          system: `${POLICY}\nYou write short invitation emails to people who showed interest in ComboTrader (joined the waitlist, the newsletter, wrote to us, or messaged on WhatsApp) but have not created an account. One email each, in their language: subject ≤ 9 words; body ≤ 90 words; warm, specific to how they found us, one clear next step (create an account); mention that trades carry risk and link the risk statement once. Invitation number 2 or 3 is a gentle follow-up, shorter, with something new (an open lot or how the Harvest Trail works). ` +
            `Also give "template": the email with the first name replaced by {name} (or no name). Return {"invites":[{"lead_id":number,"title":string,"body":string,"template":{"title":string,"body":string}}]}.`,
          input: { facts, leads: due.map((l) => ({ lead_id: l.id, first_name: l.name || '', language: langName(l.lang as Lang), how_they_found_us: l.source, invitation_number: l.touches + 1 })) } });
        drafts = r.data.invites || []; runId = r.runId;
      } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.prospector_error', undefined, String((e as Error).message)); }
    }
    if (!drafts.length) {
      runId = logRun('prospector', 'daily', JSON.stringify(due.map((l) => l.id)), 'learned templates / defaults', 'rules');
      drafts = due.map((l) => {
        const lang = isLang(l.lang) ? l.lang : 'en';
        const key = `invite:${l.touches === 0 ? l.source : 'followup'}`;
        const les = bestLesson('prospector', 'template', key, lang);
        let t = parseLesson<{ title: string; body: string }>(les), id = les?.id;
        if (!t) { t = { title: translate(lang, 'agent.inv_title'), body: `${translate(lang, 'agent.hi', { name: '{name}' })}\n\n${translate(lang, l.touches === 0 ? `agent.inv.${l.source}` : 'agent.inv.followup')}` }; id = learn({ agent: 'prospector', kind: 'template', key, lang, content: t, source: 'rules' }); }
        const name = l.name || translate(lang, 'agent.friend');
        return { lead_id: l.id, title: fill(t.title, { name }), body: fill(t.body, { name }), lesson_id: id };
      });
    }
    let n = 0;
    for (const d of drafts) {
      const l = due.find((x) => x.id === Number(d.lead_id)); if (!l) continue;
      const situation = `invite:${l.touches === 0 ? l.source : 'followup'}`;
      propose({ agent: 'prospector', kind: 'send_invite', risk: l.source === 'import' ? 'medium' : 'low', title: `Invite ${l.email} (${l.source}, email ${l.touches + 1} of 3)`,
        payload: { lead_id: l.id, title: d.title, body: d.body, situation, _agent: 'prospector', ...(d.lesson_id ? { lesson_id: d.lesson_id } : {}), ...(d.template ? { template: d.template } : {}) }, runId });
      n++; budget--;
    }
    out.push(`${n} invitations drafted`);
  }

  // 2) Ask happy Champions to invite friends (recently paid, or 30+ days into a trade, and no referrals yet).
  const askers = q.all<any>(`SELECT DISTINCT u.* FROM users u JOIN trades t ON t.user_id=u.id WHERE u.status='active' AND u.role='champion'
      AND ((t.status='paid' AND t.paid_at>=?) OR (t.status='active' AND t.start_at<=?)) AND NOT EXISTS (SELECT 1 FROM users r WHERE r.referred_by=u.id)
      AND NOT EXISTS (SELECT 1 FROM nudges n WHERE n.user_id=u.id AND n.kind='agent_ref' AND n.created_at>=?) LIMIT ?`,
    new Date(Date.now() - 14 * 864e5).toISOString(), new Date(Date.now() - 30 * 864e5).toISOString(), new Date(Date.now() - 60 * 864e5).toISOString(), Math.max(0, budget));
  let asked = 0;
  for (const u of askers as User[]) {
    if (!onceFor(u.id, 'agent_ref', now().slice(0, 10))) continue;
    const les = bestLesson('prospector', 'template', 'refer', u.lang);
    let t = parseLesson<{ title: string; body: string }>(les), id = les?.id;
    if (!t) { t = { title: translate(u.lang, 'agent.ref_title'), body: translate(u.lang, 'agent.ref_body', { name: '{name}', link: '{link}' }) }; id = learn({ agent: 'prospector', kind: 'template', key: 'refer', lang: u.lang, content: t, source: 'rules' }); }
    const link = `${config.baseUrl}/r/${u.referral_code}`;
    propose({ agent: 'prospector', kind: 'send_message', risk: 'low', title: `Ask ${u.first_name} ${u.last_name} to invite friends`, targetUserId: u.id,
      payload: { user_id: u.id, title: fill(t.title, { name: u.first_name, link }), body: fill(t.body, { name: u.first_name, link }), link: '/app/referrals', situation: 'refer', lesson_id: id, _agent: 'prospector' } });
    asked++; budget--;
  }
  if (asked) out.push(`${asked} referral asks drafted`);

  // 3) Organisations: first emails and one follow-up a week later. Always reviewed by a person.
  const orgs = q.all<any>(`SELECT * FROM prospects WHERE email IS NOT NULL AND ((status='new' AND touches=0) OR (status='contacted' AND touches=1 AND last_touch_at<=?)) ORDER BY touches, id LIMIT ?`, new Date(Date.now() - 7 * 864e5).toISOString(), Math.max(0, budget))
    .filter((o) => !q.get("SELECT 1 FROM agent_actions WHERE kind='send_outreach' AND status='proposed' AND payload LIKE ?", `%"prospect_id":${o.id},%`));
  if (orgs.length) {
    type Out = { prospect_id: number; title: string; body: string; template?: { title: string; body: string }; lesson_id?: number };
    let drafts: Out[] = [], runId: number | null = null;
    if (useAI('prospector')) {
      try {
        const r = await completeJson<{ emails: Out[] }>('prospector', { trigger: 'daily', maxTokens: 6000,
          system: `${POLICY}\nYou write first-contact partnership emails from Kitovu's ComboTrader team to organisations whose members could back real farm trades together through Harvest Circles (a group fills part of a Trade Lot from small slots; each member gets their own certificate). Subject ≤ 9 words. Body ≤ 140 words: why this organisation (use "why"), what members get, that Kitovu has worked with farmers since 2018, one ask (a 20-minute call or a talk at their next meeting), and a sign-off from "The ComboTrader team, Kitovu Technology". Follow-ups (touch 2) are 3 sentences. No earnings promises beyond "${rateFor(4) / 100}% to ${rateFor(12) / 100}% per annum depending on period". ` +
            `Also give "template" with {org} for the organisation name and {name} for the contact. Return {"emails":[{"prospect_id":number,"title":string,"body":string,"template":{"title":string,"body":string}}]}.`,
          input: orgs.map((o) => ({ prospect_id: o.id, organisation: o.name, segment: o.segment, location: o.location, contact_name: o.contact_name, why: o.why, touch: o.touches + 1 })) });
        drafts = r.data.emails || []; runId = r.runId;
      } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.prospector_error', undefined, String((e as Error).message)); }
    }
    if (!drafts.length) {
      runId = logRun('prospector', 'daily', JSON.stringify(orgs.map((o) => o.id)), 'learned outreach templates / defaults', 'rules');
      drafts = orgs.map((o) => {
        const key = o.touches === 0 ? `org:${o.segment}` : 'org:followup';
        const les = bestLesson('prospector', 'template', key) || (o.touches === 0 ? bestLesson('prospector', 'template', 'org:any') : null);
        let t = parseLesson<{ title: string; body: string }>(les), id = les?.id;
        if (!t) { t = o.touches === 0 ? ORG_FIRST : ORG_FOLLOW; id = learn({ agent: 'prospector', kind: 'template', key: o.touches === 0 ? 'org:any' : 'org:followup', content: t, source: 'rules' }); }
        const v = { org: o.name, name: o.contact_name || `${o.name} team`, rates: `${rateFor(4) / 100}% to ${rateFor(12) / 100}%`, site: config.baseUrl };
        return { prospect_id: o.id, title: fill(t.title, v), body: fill(t.body, v), lesson_id: id };
      });
    }
    let n = 0;
    for (const d of drafts) {
      const o = orgs.find((x) => x.id === Number(d.prospect_id)); if (!o) continue;
      propose({ agent: 'prospector', kind: 'send_outreach', risk: 'medium', title: `${o.touches === 0 ? 'Outreach' : 'Follow-up'} to ${o.name} (${o.segment})`,
        payload: { prospect_id: o.id, title: d.title, body: d.body, situation: o.touches === 0 ? `org:${o.segment}` : 'org:followup', ...(d.lesson_id ? { lesson_id: d.lesson_id } : {}), ...(d.template ? { template: d.template } : {}) }, runId });
      n++;
    }
    out.push(`${n} organisation emails drafted`);
  }

  // 4) Research new organisations once a week (AI with web search only).
  const lastResearch = q.val<string>("SELECT MAX(created_at) FROM agent_runs WHERE agent='prospector' AND trigger LIKE 'research%'");
  if (useAI('prospector') && (!lastResearch || Date.now() - new Date(lastResearch).getTime() > 6.5 * 864e5)) out.push(await researchProspects());
  return out.join('; ') || 'nothing to do today';
}

const ORG_FIRST = { title: 'A way for {org} members to back real farm trades', body: `Dear {name},\n\nI'm writing from ComboTrader, run by Kitovu Technology, which has worked with Nigerian farmers since 2018. Members of groups like {org} can fill part of a real commodity trade together through a Harvest Circle: each person takes small slots, gets their own Trade Certificate, and follows every step on the Harvest Trail. Earnings are {rates} per annum depending on the period chosen; trades carry risk and are not bank deposits.\n\nCould we have a 20-minute call, or speak for ten minutes at your next meeting?\n\nThe ComboTrader team, Kitovu Technology\n{site}` };
const ORG_FOLLOW = { title: 'Following up: Harvest Circles for {org}', body: `Dear {name},\n\nFollowing up on my note last week about Harvest Circles for {org} members. Happy to send a one-page summary or join a meeting for ten minutes, whichever suits you.\n\nThe ComboTrader team, Kitovu Technology` };

/** AI + web search: finds organisations for the next segment and region in rotation and saves them to Prospects. */
export async function researchProspects(segment?: string, region?: string) {
  if (!useAI('prospector')) throw new AiUnavailable('Finding organisations on the web needs AI mode and an ANTHROPIC_API_KEY. In rules mode, add or import organisations in Prospects.');
  const segs = String(settings().prospect_segments).split(',').map((x) => x.trim()).filter(Boolean);
  const regs = String(settings().prospect_regions).split(',').map((x) => x.trim()).filter(Boolean);
  const n = Number(q.val("SELECT COUNT(*) FROM agent_runs WHERE agent='prospector' AND trigger LIKE 'research%'") ?? 0);
  const seg = segment || segs[n % Math.max(1, segs.length)] || 'Staff cooperative societies';
  const reg = region || regs[Math.floor(n / Math.max(1, segs.length)) % Math.max(1, regs.length)] || 'Lagos';
  const known = q.all<any>('SELECT name FROM prospects WHERE segment=? LIMIT 200', seg).map((x) => x.name);
  const r = await completeJson<{ organisations: any[] }>('prospector', { trigger: `research:${seg}:${reg}`, maxTokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    system: `${POLICY}\nYou research organisations whose members could join ComboTrader together through Harvest Circles. Use web search. Find up to 10 real, currently active organisations of the type "${seg}" in "${reg}". For each, give only facts you found on public pages: name, location, website, a published general contact email or phone (an organisation's own published contact only; never personal emails of individuals unless published by the organisation for this purpose), contact_name only if it is the published secretary/coordinator, and "why" (one sentence on why their members are a fit). Skip any organisation you cannot verify. Do not repeat these known ones: ${JSON.stringify(known.slice(0, 80))}. ` +
      `Return {"organisations":[{"name":string,"location":string,"website":string,"email":string,"phone":string,"contact_name":string,"why":string}]}.`,
    input: { segment: seg, region: reg } });
  const orgs = (r.data.organisations || []).filter((o) => o?.name).map((o) => ({ ...o, segment: seg }));
  propose({ agent: 'prospector', kind: 'save_prospects', risk: 'info', title: `${orgs.length} ${seg} found in ${reg}`, summary: orgs.map((o) => `${o.name}${o.email ? ` <${o.email}>` : ''}`).join('; ').slice(0, 1500), payload: { organisations: orgs, segment: seg, region: reg }, runId: r.runId });
  return `research: ${orgs.length} ${seg} in ${reg}`;
}

export const AGENT_JOBS: Record<string, () => Promise<string>> = { onboarding: () => runOnboarding(), treasury: runTreasury, risk: runRisk, growth: runGrowth, prospector: runProspector };
export const _keep = { impactFor, isLang, aiLive };
export type { Lesson };
