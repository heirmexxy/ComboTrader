// Harvest Plan: save a fixed amount every month (saved card, or manual top-ups) until the target is reached,
// then join the next suitable Trade Lot automatically. Savings belong to the Champion and can be moved to the wallet at any time.
import { q, tx, now } from './db';
import { move, planAcct, walletAcct, balance } from './ledger';
import { settings } from './settings';
import * as paystack from './paystack';
import { startFunding, confirmPayment, fundingAllowed, newReference, setPlanPaymentHook, estimateFee } from './wallet';
import { joinLot, pickRolloverLot, lotRemaining, TradeError } from './trading';
import { notify } from './notify';
import { audit } from './audit';
import { userById } from './auth';
import { fmtNGN } from './util';
import type { User } from './http';

export interface Plan {
  id: number; user_id: number; name: string; target_amount: number; monthly_amount: number; day_of_month: number; commodity: string | null;
  authorization_code: string | null; card_label: string | null; status: string; next_charge_at: string | null; failures: number; trade_id: number | null;
  created_at: string; completed_at: string | null; saved?: number;
}

export const planSaved = (p: { id: number }) => balance(`plan:${p.id}`);
export const getPlan = (id: number) => q.get<Plan>('SELECT * FROM plans WHERE id=?', id);
export const userPlans = (uid: number) => q.all<Plan>("SELECT * FROM plans WHERE user_id=? AND status!='setup' ORDER BY id DESC", uid).map((p) => ({ ...p, saved: planSaved(p) }));

/** The next charge date on the plan's day of the month (1–28), at 09:00 Lagos. */
export function nextChargeDate(day: number, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day, 8, 0, 0));
  if (d.getTime() <= from.getTime() + 3600e3) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}
export function monthsToTarget(target: number, monthly: number, saved = 0) {
  return Math.max(0, Math.ceil((target - saved) / monthly));
}

/** Creates the plan and returns the checkout URL for the first instalment (which also saves the card). */
export async function createPlan(user: User, o: { name: string; target: number; monthly: number; day: number; commodity?: string | null }) {
  const s = settings();
  if (!s.plans_enabled) throw new TradeError('plan.off');
  if (!user.email_verified_at) throw new TradeError('lots.verify_first');
  if (o.monthly < s.plan_min_monthly) throw new TradeError('plan.min_monthly', { amount: fmtNGN(s.plan_min_monthly) });
  if (o.target < o.monthly * 2) throw new TradeError('plan.target_small');
  if (o.target > 10_000_000_000) throw new TradeError('plan.target_big');
  const day = Math.min(28, Math.max(1, Math.round(o.day) || 1));
  fundingAllowed(user, o.monthly);
  const id = q.insert('plans', { user_id: user.id, name: o.name || 'Harvest Plan', target_amount: o.target, monthly_amount: o.monthly, day_of_month: day, commodity: o.commodity || null, status: 'setup', created_at: now() }).id;
  audit(user.id, 'plan.create', `plan:${id}`, { target: o.target, monthly: o.monthly });
  return { id, url: await startFunding(user, o.monthly, { purpose: 'plan', planId: id }) };
}

/** One-off top-up of a plan (card, transfer or USSD). */
export async function topUpPlan(user: User, planId: number, amount: number) {
  const p = getPlan(planId);
  if (!p || p.user_id !== user.id || !['active', 'paused', 'ready'].includes(p.status)) throw new TradeError('plan.not_found');
  return startFunding(user, amount, { purpose: 'plan', planId });
}

// Called by confirmPayment for every successful plan payment.
setPlanPaymentHook((payment, auth) => {
  const p = getPlan(payment.plan_id);
  if (!p) return;
  const u = userById(p.user_id)!;
  if (p.status === 'setup') {
    const saveCard = auth?.reusable && (auth.channel === 'card' || !auth.channel);
    q.run("UPDATE plans SET status='active', authorization_code=?, card_label=?, next_charge_at=? WHERE id=?",
      saveCard ? auth!.authorization_code : null, saveCard ? `${String(auth!.brand || 'card').toUpperCase()} •••• ${auth!.last4 || ''}`.trim() : null, nextChargeDate(p.day_of_month), p.id);
    notify(u, 'plan_started', { plan: p.name, amount: fmtNGN(p.monthly_amount), target: fmtNGN(p.target_amount) }, { link: `/app/plans/${p.id}` });
  } else {
    q.run('UPDATE plans SET failures=0 WHERE id=?', p.id);
    notify(u, 'plan_saved', { plan: p.name, amount: fmtNGN(payment.amount - payment.fee), saved: fmtNGN(planSaved(p)), target: fmtNGN(p.target_amount) }, { link: `/app/plans/${p.id}`, email: false });
  }
  safeCheck(p.id);
});
function safeCheck(id: number) {
  try { return checkPlanTarget(id); } catch (e) { audit(null, 'plan.join_failed', `plan:${id}`, String((e as Error).message)); return null; }
}

/** When savings reach the target, join the best open lot (preferred commodity first). Otherwise wait as 'ready'. */
export function checkPlanTarget(planId: number) {
  const p = getPlan(planId);
  if (!p || !['active', 'ready'].includes(p.status)) return null;
  const saved = planSaved(p);
  if (saved < p.target_amount) return null;
  const u = userById(p.user_id)!;
  const lot = pickRolloverLot(saved, p.commodity);
  if (!lot) {
    if (p.status !== 'ready') {
      q.run("UPDATE plans SET status='ready' WHERE id=?", p.id);
      notify(u, 'plan_ready', { plan: p.name, saved: fmtNGN(saved) }, { link: `/app/plans/${p.id}` });
    }
    return null;
  }
  return tx(() => {
    move('plan_release', planAcct(p.id, p.user_id), walletAcct(p.user_id), saved, { ref: `plan_done:${p.id}`, memo: p.name, userId: p.user_id });
    const amt = Math.min(saved, lotRemaining(lot));
    const t = joinLot(u, lot.id, amt);
    q.run("UPDATE plans SET status='completed', trade_id=?, completed_at=?, next_charge_at=NULL WHERE id=?", t.id, now(), p.id);
    notify(u, 'plan_completed', { plan: p.name, amount: fmtNGN(amt), lot: lot.title, date: t.matures_at.slice(0, 10) }, { link: `/app/trades/${t.id}`, sms: true });
    audit(null, 'plan.completed', `plan:${p.id}`, { trade: t.id, amount: amt });
    return t;
  });
}

/** Moves plan savings to the wallet (the plan keeps running unless cancelled). */
export function releasePlanSavings(user: User, planId: number, cancel: boolean) {
  const p = getPlan(planId);
  if (!p || p.user_id !== user.id) throw new TradeError('plan.not_found');
  return tx(() => {
    const saved = planSaved(p);
    if (saved > 0) move('plan_release', planAcct(p.id, p.user_id), walletAcct(p.user_id), saved, { ref: `plan_release:${p.id}:${Date.now()}`, memo: p.name, userId: p.user_id });
    if (cancel) q.run("UPDATE plans SET status='cancelled', authorization_code=NULL, next_charge_at=NULL WHERE id=?", p.id);
    audit(user.id, cancel ? 'plan.cancel' : 'plan.release', `plan:${p.id}`, { amount: saved });
    return saved;
  });
}
export function setPlanPaused(user: User, planId: number, paused: boolean) {
  const p = getPlan(planId);
  if (!p || p.user_id !== user.id || !['active', 'paused'].includes(p.status)) throw new TradeError('plan.not_found');
  q.run('UPDATE plans SET status=?, failures=0, next_charge_at=? WHERE id=?', paused ? 'paused' : 'active', paused ? null : nextChargeDate(p.day_of_month), p.id);
}

/** Daily job: charge saved cards on their day; remind manual savers; retry lots for 'ready' plans. */
export async function runPlans() {
  const s = settings();
  let charged = 0, reminded = 0, failed = 0;
  for (const p of q.all<Plan>("SELECT * FROM plans WHERE status='active' AND next_charge_at IS NOT NULL AND next_charge_at<=?", now())) {
    const u = userById(p.user_id);
    if (!u || u.status !== 'active') { q.run("UPDATE plans SET status='paused' WHERE id=?", p.id); continue; }
    const remaining = p.target_amount - planSaved(p);
    if (remaining <= 0) { safeCheck(p.id); continue; }
    const amount = Math.max(100000, Math.min(p.monthly_amount, remaining));
    q.run('UPDATE plans SET next_charge_at=? WHERE id=?', nextChargeDate(p.day_of_month, new Date(Date.now() + 86400e3)), p.id);
    if (!p.authorization_code) { notify(u, 'plan_reminder', { plan: p.name, amount: fmtNGN(amount) }, { link: `/app/plans/${p.id}`, sms: true }); reminded++; continue; }
    try {
      fundingAllowed(u, amount);
      const fee = s.pass_card_fees ? estimateFee(amount) : 0;
      const reference = newReference('CTF');
      q.insert('payments', { user_id: u.id, reference, amount: amount + fee, fee, status: 'pending', demo: paystack.isDemo() ? 1 : 0, purpose: 'plan', plan_id: p.id, created_at: now() });
      const r = await paystack.chargeAuthorization({ email: u.email, amount: amount + fee, authorization_code: p.authorization_code, reference, metadata: { purpose: 'harvest_plan', plan_id: p.id } });
      if (r.status === 'success') { await confirmPayment(reference, { demoSuccess: paystack.isDemo() }); charged++; }
      else if (r.status === 'failed') throw new Error('charge failed');
      // other statuses (pending, send_otp…) settle by webhook
    } catch (e: any) {
      failed++;
      const n = p.failures + 1;
      q.run('UPDATE plans SET failures=?, status=? WHERE id=?', n, n >= s.plan_max_failures ? 'paused' : 'active', p.id);
      notify(u, n >= s.plan_max_failures ? 'plan_paused' : 'plan_failed', { plan: p.name, amount: fmtNGN(amount), reason: e instanceof TradeError ? '' : String(e.message || '') }, { link: `/app/plans/${p.id}`, sms: true });
    }
  }
  for (const p of q.all<Plan>("SELECT * FROM plans WHERE status='ready'")) safeCheck(p.id);
  return `${charged} charged, ${reminded} reminded, ${failed} failed`;
}
