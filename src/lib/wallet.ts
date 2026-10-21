// Funding (Paystack collections) and withdrawals (Paystack Transfers or manual international).
import { q, tx, now } from './db';
import { move, post, walletAcct, reservedAcct, EXT, account, walletBalance } from './ledger';
import { settings } from './settings';
import * as paystack from './paystack';
import { randomCode, fmtNGN } from './util';
import { notify } from './notify';
import { audit } from './audit';
import { userById } from './auth';
import type { User } from './http';
import { TradeError } from './trading';

export const newReference = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomCode(6)}`;

/** Card fee estimate (Paystack NG local: 1.5% + ₦100 above ₦2,500, capped at ₦2,000). */
export function estimateFee(amount: number) {
  const fee = Math.round(amount * 0.015) + (amount >= 250000 ? 10000 : 0);
  return Math.min(fee, 200000);
}

export function totalFunded(userId: number) {
  return Number(q.val("SELECT COALESCE(SUM(amount - fee),0) FROM payments WHERE user_id=? AND status='success'", userId) ?? 0);
}

export async function startFunding(user: User, amount: number) {
  const s = settings();
  if (amount < 100000) throw new TradeError('wallet.min', { amount: fmtNGN(100000) });
  if (user.kyc_status !== 'verified' && totalFunded(user.id) + amount > s.kyc_required_above) throw new TradeError('wallet.kyc_fund', { amount: fmtNGN(s.kyc_required_above) });
  const fee = s.pass_card_fees ? estimateFee(amount) : 0;
  const reference = newReference('CTF');
  q.insert('payments', { user_id: user.id, reference, amount: amount + fee, fee, status: 'pending', demo: paystack.isDemo() ? 1 : 0, created_at: now() });
  const init = await paystack.initialize({ email: user.email, amount: amount + fee, reference, metadata: { user_id: user.id, purpose: 'wallet_fund' } });
  return init.authorization_url;
}

/**
 * Confirms a payment (from callback, webhook or demo checkout) and credits the wallet exactly once.
 * In live mode the amount is always re-verified with Paystack — never trusted from the browser.
 */
export async function confirmPayment(reference: string, o: { demoSuccess?: boolean } = {}) {
  const p = q.get<any>('SELECT * FROM payments WHERE reference=?', reference);
  if (!p) return { ok: false as const, reason: 'unknown' };
  if (p.status === 'success') return { ok: true as const, payment: p, already: true };
  let v: paystack.Verified;
  if (p.demo) {
    if (!o.demoSuccess) return { ok: false as const, reason: 'pending' };
    v = { status: 'success', amount: p.amount, fees: 0, channel: 'demo', paid_at: now(), currency: 'NGN', raw: { demo: true } };
  } else {
    v = await paystack.verify(reference);
  }
  if (v.status !== 'success') {
    if (v.status === 'failed' || v.status === 'abandoned') q.run("UPDATE payments SET status='failed', raw=? WHERE id=? AND status='pending'", JSON.stringify(v.raw).slice(0, 4000), p.id);
    return { ok: false as const, reason: v.status };
  }
  if (v.amount !== p.amount || v.currency !== 'NGN') {
    audit(null, 'payment.mismatch', reference, { expected: p.amount, got: v.amount, currency: v.currency });
    q.run("UPDATE payments SET status='review', raw=? WHERE id=?", JSON.stringify(v.raw).slice(0, 4000), p.id);
    return { ok: false as const, reason: 'mismatch' };
  }
  tx(() => {
    const credit = p.amount - p.fee;
    const legs = [{ account: EXT(), amount: -p.amount }, { account: walletAcct(p.user_id), amount: credit }];
    if (p.fee) legs.push({ account: account('kitovu:fees'), amount: p.fee });
    post('fund', legs, { ref: reference, memo: 'Wallet funded', userId: p.user_id });
    q.run("UPDATE payments SET status='success', channel=?, paid_at=?, raw=? WHERE id=?", v.channel, v.paid_at || now(), JSON.stringify(v.raw).slice(0, 4000), p.id);
  });
  const u = userById(p.user_id);
  if (u) notify(u, 'fund_success', { amount: fmtNGN(p.amount - p.fee) }, { link: '/app/wallet', email: true });
  return { ok: true as const, payment: q.get<any>('SELECT * FROM payments WHERE id=?', p.id) };
}

// ---------- Withdrawals ----------
export function requestWithdrawal(user: User, amount: number, bankAccountId: number | null, route: 'paystack' | 'manual', note?: string) {
  const s = settings();
  return tx(() => {
    if (amount < s.min_withdrawal) throw new TradeError('wallet.min', { amount: fmtNGN(s.min_withdrawal) });
    if (user.kyc_status !== 'verified') throw new TradeError('wallet.kyc_needed');
    if (walletBalance(user.id) < amount) throw new TradeError('wallet.insufficient');
    if (route === 'paystack') {
      const b = q.get<any>('SELECT * FROM bank_accounts WHERE id=? AND user_id=? AND active=1', bankAccountId, user.id);
      if (!b || !b.name_match || !b.recipient_code) throw new TradeError('wallet.no_bank');
      if (b.hold_until && b.hold_until > now()) throw new TradeError('wallet.hold', { date: b.hold_until.slice(0, 10) });
    }
    const reference = newReference('CTW');
    const w = q.insert('withdrawals', {
      user_id: user.id, bank_account_id: route === 'paystack' ? bankAccountId : null, amount, route,
      status: route === 'manual' ? 'manual' : 'requested', reference, note: note || null, created_at: now(), updated_at: now(),
    });
    move('withdraw_hold', walletAcct(user.id), reservedAcct(user.id), amount, { ref: reference, memo: 'Withdrawal requested', userId: user.id });
    if (route === 'manual') notify(user, 'manual_payout', { amount: fmtNGN(amount) }, { link: '/app/wallet' });
    return w.id;
  });
}

/** Approve (and send) a withdrawal. Above the dual-approval threshold, two different admins must approve. */
export async function approveWithdrawal(id: number, adminId: number) {
  const w = q.get<any>('SELECT * FROM withdrawals WHERE id=?', id);
  if (!w) throw new Error('Not found');
  if (!['requested', 'approved'].includes(w.status)) throw new Error(`Withdrawal is ${w.status}`);
  const s = settings();
  if (w.amount > s.dual_approval_threshold) {
    if (!w.approved_by) {
      q.run("UPDATE withdrawals SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?", adminId, now(), now(), id);
      audit(adminId, 'withdrawal.first_approval', `withdrawal:${id}`, { amount: w.amount });
      return 'awaiting_second';
    }
    if (w.approved_by === adminId) throw new Error('A different admin must give the second approval.');
    q.run('UPDATE withdrawals SET second_approver=? WHERE id=?', adminId, id);
  } else {
    q.run('UPDATE withdrawals SET approved_by=?, approved_at=? WHERE id=?', adminId, now(), id);
  }
  audit(adminId, 'withdrawal.approve', `withdrawal:${id}`, { amount: w.amount });
  return sendWithdrawal(id);
}

export async function sendWithdrawal(id: number) {
  const w = q.get<any>('SELECT * FROM withdrawals WHERE id=?', id)!;
  const b = q.get<any>('SELECT * FROM bank_accounts WHERE id=?', w.bank_account_id);
  if (!b?.recipient_code) throw new Error('No transfer recipient for this bank account');
  q.run("UPDATE withdrawals SET status='processing', updated_at=? WHERE id=?", now(), id);
  try {
    const r = await paystack.transfer({ amount: w.amount, recipient: b.recipient_code, reference: w.reference, reason: 'ComboTrader withdrawal' });
    q.run('UPDATE withdrawals SET transfer_code=? WHERE id=?', r.transfer_code, id);
    if (r.status === 'success') { completeWithdrawal(w.reference, true); return 'paid'; }
    return 'processing'; // final status arrives by webhook (transfer.success / failed / reversed)
  } catch (e: any) {
    completeWithdrawal(w.reference, false, e.message);
    return 'failed';
  }
}

/** Final state of a withdrawal: paid (money left the platform) or failed (back to wallet). Idempotent. */
export function completeWithdrawal(reference: string, success: boolean, note?: string, adminId?: number) {
  return tx(() => {
    const w = q.get<any>('SELECT * FROM withdrawals WHERE reference=?', reference);
    if (!w || ['paid', 'failed', 'rejected'].includes(w.status)) return w?.status;
    const u = userById(w.user_id)!;
    if (success) {
      move('withdraw_paid', reservedAcct(w.user_id), EXT(), w.amount, { ref: reference, memo: 'Withdrawal paid', userId: w.user_id, by: adminId });
      q.run("UPDATE withdrawals SET status='paid', updated_at=?, note=COALESCE(?, note) WHERE id=?", now(), note ?? null, w.id);
      notify(u, 'withdrawal_paid', { amount: fmtNGN(w.amount) }, { link: '/app/wallet', sms: true });
      return 'paid';
    }
    move('withdraw_reversed', reservedAcct(w.user_id), walletAcct(w.user_id), w.amount, { ref: reference, memo: 'Withdrawal returned', userId: w.user_id, by: adminId });
    const st = adminId ? 'rejected' : 'failed';
    q.run('UPDATE withdrawals SET status=?, updated_at=?, note=? WHERE id=?', st, now(), note ?? null, w.id);
    notify(u, 'withdrawal_failed', { amount: fmtNGN(w.amount) }, { link: '/app/wallet', sms: true });
    return st;
  });
}

/** Auto-sends small withdrawals (setting auto_withdraw_limit). */
export async function autoSendSmallWithdrawals() {
  const lim = settings().auto_withdraw_limit;
  if (lim <= 0) return 0;
  const rows = q.all<any>("SELECT id FROM withdrawals WHERE status='requested' AND route='paystack' AND amount<=?", lim);
  for (const r of rows) await sendWithdrawal(r.id).catch(() => {});
  return rows.length;
}
