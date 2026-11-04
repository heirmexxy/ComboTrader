// Fallback for Paystack webhooks. Paystack sends events to one URL per business, and that
// URL may belong to another Kitovu system. Every 2 minutes we ask Paystack directly about
// anything still waiting, so payments, withdrawals and BVN checks finish either way.
import { q } from './db';
import * as paystack from './paystack';
import { confirmPayment, completeWithdrawal } from './wallet';
import { notify } from './notify';
import { audit } from './audit';
import { settings } from './settings';
import { fmtNGN } from './util';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export async function syncPaystack(): Promise<string> {
  if (paystack.isDemo()) return 'skipped (no Paystack key)';
  let paid = 0, failed = 0, sent = 0, returned = 0, kyc = 0, errors = 0;

  // Card/bank payments: pending for 3 minutes to 3 days.
  for (const p of q.all<any>("SELECT reference, created_at FROM payments WHERE status='pending' AND demo=0 AND created_at<=? AND created_at>=? ORDER BY id LIMIT 50", ago(90e3), ago(3 * 864e5))) {
    try {
      const v = await paystack.verify(p.reference);
      const old = p.created_at < ago(864e5);
      if (v.status === 'success' || v.status === 'failed' || (v.status === 'abandoned' && old)) {
        const r = await confirmPayment(p.reference);
        if (r.ok) paid++; else failed++;
      }
    } catch { errors++; }
  }

  // Withdrawals sent to Paystack, still processing after 3 minutes.
  for (const w of q.all<any>("SELECT reference FROM withdrawals WHERE status='processing' AND updated_at<=? ORDER BY id LIMIT 50", ago(90e3))) {
    try {
      const s = await paystack.verifyTransfer(w.reference);
      if (s === 'success') { completeWithdrawal(w.reference, true); sent++; }
      else if (s === 'failed' || s === 'reversed') { completeWithdrawal(w.reference, false, `transfer.${s}`); returned++; }
    } catch { errors++; }
  }

  // BVN identity checks still pending.
  for (const u of q.all<any>("SELECT * FROM users WHERE kyc_status='pending' AND kyc_method='bvn' AND paystack_customer_code IS NOT NULL LIMIT 50")) {
    try {
      if (await paystack.customerIdentified(u.paystack_customer_code)) {
        q.run("UPDATE users SET kyc_status='verified', kyc_note=NULL WHERE id=?", u.id);
        notify(u, 'kyc_verified', {}, { link: '/app/profile', sms: true });
        kyc++;
      }
    } catch { errors++; }
  }

  const out = `${paid} payments credited, ${failed} closed, ${sent} withdrawals paid, ${returned} returned, ${kyc} identities verified${errors ? `, ${errors} lookups failed` : ''}`;
  if (paid + failed + sent + returned + kyc) audit(null, 'paystack.sync', undefined, out);
  return out;
}

/** Paystack Balance against what must leave it soon: withdrawals waiting, plus a safety minimum set in Settings. */
export async function paystackFloat(fresh = false) {
  const waiting = Number(q.val("SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE route='paystack' AND status IN ('requested','approved','processing')"));
  const walletTotal = Number(q.val("SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.kind='wallet'"));
  const min = Number(settings().paystack_low_balance || 0);
  let bal: number | null = null, error: string | null = null;
  try { bal = await paystack.balance(fresh); } catch (e: any) { error = String(e?.message || e); }
  const need = Math.max(waiting, min);
  const topUp = bal === null ? 0 : Math.max(0, need - bal);
  const low = bal !== null && topUp > 0;
  const summary = bal === null ? (error ? `could not read the Paystack balance (${error})` : 'no Paystack key')
    : `${fmtNGN(bal)} in the Paystack balance; ${fmtNGN(waiting)} of withdrawals waiting; minimum kept ${fmtNGN(min)}${low ? `. Top up at least ${fmtNGN(topUp)}.` : ''}`;
  return { balance: bal, waiting, walletTotal, min, topUp, low, error, summary };
}
