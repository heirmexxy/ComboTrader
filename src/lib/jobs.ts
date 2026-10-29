// Scheduled work. Runs in-process every minute (RUN_SCHEDULER=true), or from a system cron:
//   npm run job -- <name>        e.g. npm run job -- prices
import { q, now } from './db';
import { flushOutbox, notify, queueEmail, emailShell, escapeHtml } from './notify';
import { crawlPrices } from './prices';
import { expireCircles } from './circles';
import { closeExpiredLots, markMatured, siteStats, autoPayDue, processRollovers, rateFor, lotDefaultPeriod } from './trading';
import { runPlans } from './plans';
import { AGENT_JOBS } from './agents';
import { scoreOutcomes } from './learning';
import { treasurySnapshot } from './treasury';
import { reportError } from './alerts';
import { autoSendSmallWithdrawals } from './wallet';
import * as paystack from './paystack';
import { walletBalance, trialBalance } from './ledger';
import { fmtNGN, lagosNow } from './util';
import { audit } from './audit';
import { userById } from './auth';
import { config } from './config';
import { settings } from './settings';
import { marked } from 'marked';

function ran(name: string, status: string) {
  q.run('INSERT INTO job_runs (name, last_run, last_status) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET last_run=excluded.last_run, last_status=excluded.last_status', name, now(), status.slice(0, 2000));
}
const lastRun = (name: string) => q.get<{ last_run: string }>('SELECT last_run FROM job_runs WHERE name=?', name)?.last_run;

/** Daily jobs run once per Lagos calendar day, at or after the given hour. */
function dueDaily(name: string, hour: number) {
  const l = lagosNow();
  if (l.getUTCHours() < hour) return false;
  const todayLagos = l.toISOString().slice(0, 10);
  const last = lastRun(name);
  return !last || new Date(new Date(last).getTime() + 3600e3).toISOString().slice(0, 10) !== todayLagos;
}

export const JOBS: Record<string, () => Promise<string>> = {
  async outbox() { await flushOutbox(); return 'ok'; },
  async publish() {
    const p = q.run("UPDATE posts SET status='published' WHERE status='scheduled' AND publish_at<=?", now()).changes;
    let sent = 0;
    for (const n of q.all<any>("SELECT * FROM newsletters WHERE status='scheduled' AND send_at<=?", now())) sent += sendNewsletter(n.id);
    return `${p} posts published, ${sent} newsletter emails queued`;
  },
  async lifecycle() {
    const a = closeExpiredLots(), b = markMatured(), p = autoPayDue(), r = processRollovers(), c = expireCircles(), d = await autoSendSmallWithdrawals();
    return `${a} lots closed, ${b} trades matured, ${p} payouts credited, ${r} rolled over, ${c} circles expired, ${d} withdrawals auto-sent`;
  },
  async prices() {
    if (!settings().price_crawler_enabled) return 'crawler switched off (manual prices only)';
    const s = await crawlPrices();
    return s.map((x) => `${x.source}: ${x.status}`).join('; ') || 'no sources enabled';
  },
  async nudges() { return runNudges(); },
  async plans() { return runPlans(); },
  async agents() {
    const out: string[] = [];
    try { out.push(`learning: ${scoreOutcomes()}`); } catch (e: any) { out.push(`learning: error ${e.message}`); }
    for (const name of ['treasury', 'onboarding', 'risk', 'prospector'] as const) { try { out.push(`${name}: ${await AGENT_JOBS[name]()}`); } catch (e: any) { out.push(`${name}: error ${e.message}`); } }
    return out.join('; ');
  },
  async growth() { return AGENT_JOBS.growth(); },
  async reconcile() { return reconcile(); },
  async weekly() { return weeklySummary(); },
};

export async function runJob(name: string) {
  const fn = JOBS[name];
  if (!fn) throw new Error(`Unknown job ${name}`);
  let status: string;
  try { status = await fn(); } catch (e: any) { status = `error: ${e?.message || e}`; reportError(`job ${name}`, e); }
  ran(name, status);
  return status;
}

let busy = false;
export function startScheduler() {
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runJob('outbox');
      await runJob('publish');
      const l = lastRun('lifecycle');
      if (!l || Date.now() - new Date(l).getTime() > 10 * 60e3) await runJob('lifecycle');
      if (dueDaily('prices', 6)) await runJob('prices');
      if (dueDaily('nudges', 9)) await runJob('nudges');
      if (dueDaily('plans', 9)) await runJob('plans');
      if (dueDaily('agents', 7)) await runJob('agents');
      if (lagosNow().getUTCDay() === 1 && dueDaily('growth', 7)) await runJob('growth');
      if (dueDaily('reconcile', 2)) await runJob('reconcile');
      if (lagosNow().getUTCDay() === 1 && dueDaily('weekly', 8)) await runJob('weekly');
    } finally { busy = false; }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60e3).unref();
}

// ---------- Automatic messages ----------
function once(userId: number, kind: string, ref = '') {
  const r = q.run('INSERT OR IGNORE INTO nudges (user_id, kind, ref, created_at) VALUES (?,?,?,?)', userId, kind, ref, now());
  return r.changes > 0;
}
export function runNudges() {
  let n = 0;
  const d = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
  // Signed up 2+ days ago, never funded.
  for (const u of q.all<any>(`SELECT * FROM users WHERE role='champion' AND status='active' AND created_at<=?
      AND id NOT IN (SELECT user_id FROM payments WHERE status='success')`, d(2))) {
    if (once(u.id, 'no_deposit')) { notify(u, 'nudge_no_deposit', {}, { link: '/app/wallet' }); n++; }
  }
  // Funded 3+ days ago, never traded, still holds a balance.
  for (const u of q.all<any>(`SELECT * FROM users WHERE status='active' AND id IN (SELECT user_id FROM payments WHERE status='success' AND paid_at<=?)
      AND id NOT IN (SELECT user_id FROM trades) AND id NOT IN (SELECT user_id FROM circle_slots)`, d(3))) {
    if (walletBalance(u.id) > 0 && once(u.id, 'no_trade')) { notify(u, 'nudge_no_trade', {}, { link: '/app/lots' }); n++; }
  }
  // Payout in 7 days.
  const in7 = new Date(Date.now() + 7 * 864e5).toISOString();
  for (const t of q.all<any>(`SELECT t.*, l.title FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.status='active' AND t.matures_at<=? AND t.matures_at>?`, in7, now())) {
    const u = userById(t.user_id);
    if (u && once(u.id, 'payout_soon', String(t.id))) { notify(u, 'payout_soon', { lot: t.title, date: t.matures_at.slice(0, 10) }, { link: `/app/trades/${t.id}`, sms: true }); n++; }
  }
  // Inactive 60 days (once per 60-day period).
  const tons = siteStats().tons;
  for (const u of q.all<any>("SELECT * FROM users WHERE role='champion' AND status='active' AND COALESCE(last_active_at, created_at)<=?", d(60))) {
    if (once(u.id, 'inactive', new Date().toISOString().slice(0, 7))) { notify(u, 'inactive', { tons: tons.toLocaleString('en') }, { link: '/app/lots' }); n++; }
  }
  return `${n} messages`;
}

export function notifyWaitlist(lotId: number) {
  const lot = q.get<any>('SELECT l.*, c.name AS cname FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.id=?', lotId);
  if (!lot) return 0;
  let n = 0;
  const top = rateFor(lotDefaultPeriod(lot)) / 100;
  for (const w of q.all<any>("SELECT * FROM waitlist WHERE commodity IN (?, 'any') AND notified_at IS NULL", lot.commodity)) {
    const u = w.user_id ? userById(w.user_id) : null;
    if (u) notify(u, 'waitlist_open', { commodity: lot.cname, lot: lot.title, rate: top }, { link: `/lots/${lot.code}`, sms: true });
    else if (w.email) queueEmail(w.email, `A new ${lot.cname} lot is open`, emailShell(`A new ${escapeHtml(lot.cname)} lot is open`, `<p>${escapeHtml(lot.title)} is open, earning up to ${top}% per annum depending on how long you stay. Slots are limited.</p>`, { label: 'View the lot', url: `${config.baseUrl}/lots/${lot.code}` }));
    q.run('UPDATE waitlist SET notified_at=? WHERE id=?', now(), w.id);
    n++;
  }
  return n;
}

// ---------- Newsletter ----------
export function sendNewsletter(id: number) {
  const n = q.get<any>('SELECT * FROM newsletters WHERE id=?', id);
  if (!n || n.status === 'sent') return 0;
  let where = "status='confirmed'";
  const params: any[] = [];
  if (n.segment === 'champions') where += ' AND user_id IS NOT NULL';
  if (n.segment === 'visitors') where += ' AND user_id IS NULL';
  if (n.lang) { where += ' AND lang=?'; params.push(n.lang); }
  const subs = q.all<any>(`SELECT * FROM subscribers WHERE ${where}`, ...params);
  const html = marked.parse(n.body, { async: false }) as string;
  for (const s of subs) {
    const unsub = `${config.baseUrl}/newsletter/unsubscribe/${s.token}`;
    queueEmail(s.email, n.subject, emailShell(escapeHtml(n.subject), `${html}<p style="font-size:12px;color:#777;margin-top:24px"><a href="${unsub}">Unsubscribe</a></p>`));
  }
  q.run("UPDATE newsletters SET status='sent', sent_count=?, send_at=COALESCE(send_at, ?) WHERE id=?", subs.length, now(), id);
  return subs.length;
}

// ---------- Reconciliation ----------
export async function reconcile() {
  const issues: string[] = [];
  if (trialBalance() !== 0) issues.push(`Ledger out of balance by ${trialBalance()} kobo`);
  // Every successful payment must have exactly one funding journal.
  const missing = q.all<any>("SELECT reference FROM payments WHERE status='success' AND reference NOT IN (SELECT ref FROM journals WHERE kind='fund')");
  if (missing.length) issues.push(`${missing.length} successful payments without a ledger entry: ${missing.slice(0, 5).map((m) => m.reference).join(', ')}`);
  // Negative Champion balances (should be impossible).
  const neg = q.all<any>("SELECT a.code, SUM(e.amount) s FROM entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.kind IN ('wallet','reserved') GROUP BY a.code HAVING s<0");
  if (neg.length) issues.push(`Negative balances: ${neg.map((x) => x.code).join(', ')}`);
  // Compare with Paystack for the last 2 days (live mode only).
  const from = new Date(Date.now() - 2 * 864e5).toISOString();
  try {
    const remote = await paystack.transactionsBetween(from, now());
    if (remote) {
      const local = new Map(q.all<any>("SELECT reference, amount FROM payments WHERE status='success' AND paid_at>=?", from).map((p) => [p.reference, p.amount]));
      for (const r of remote) {
        if (!r.reference.startsWith('CTF-')) continue;
        if (!local.has(r.reference)) issues.push(`Paystack success not credited: ${r.reference}`);
        else if (local.get(r.reference) !== r.amount) issues.push(`Amount mismatch ${r.reference}`);
      }
    }
  } catch (e: any) { issues.push(`Paystack check failed: ${e.message}`); }
  const status = issues.length ? `ISSUES: ${issues.join(' | ')}` : 'ok: ledger balanced, all payments matched';
  audit(null, 'reconcile', undefined, status);
  return status;
}

// ---------- Weekly management summary ----------
export function weeklySummary() {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const signups = q.val("SELECT COUNT(*) FROM users WHERE role='champion' AND created_at>=?", since);
  const funded = Number(q.val("SELECT COALESCE(SUM(amount-fee),0) FROM payments WHERE status='success' AND paid_at>=?", since));
  const traded = Number(q.val("SELECT COALESCE(SUM(amount),0) FROM trades WHERE created_at>=?", since));
  const due = Number(q.val("SELECT COALESCE(SUM(amount),0) FROM trades WHERE status IN ('active','matured') AND matures_at<=?", new Date(Date.now() + 7 * 864e5).toISOString()));
  const tr = treasurySnapshot();
  const h30 = tr.horizons[1];
  const html = `<ul><li>New Champions: <b>${signups}</b></li><li>Wallet funding: <b>${fmtNGN(funded)}</b></li><li>New trades: <b>${fmtNGN(traded)}</b></li><li>Principal due in the next 7 days: <b>${fmtNGN(due)}</b></li>
<li>Owed to Champions in 30 days (principal + earnings): <b>${fmtNGN(h30.due.total)}</b>; coverage <b>${h30.ratio === null ? '—' : h30.ratio.toFixed(2)}</b> (${h30.level})</li>
<li>Overdue buyer money (Kitovu covering): <b>${fmtNGN(tr.overdueTotal)}</b></li></ul>`;
  const admins = q.all<any>("SELECT email FROM users WHERE role='admin' AND (admin_roles LIKE '%super%' OR admin_roles LIKE '%finance%')");
  for (const a of admins) queueEmail(a.email, 'ComboTrader weekly summary', emailShell('Weekly summary', html, { label: 'Open admin', url: `${config.baseUrl}/admin` }));
  return `sent to ${admins.length}`;
}
