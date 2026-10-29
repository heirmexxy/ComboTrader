// Treasury: what Kitovu owes Champions, what buyers owe Kitovu, and whether cash covers it.
// Policy: Champions are paid on the payout date from Kitovu's balance sheet, whether or not the buyer has paid.
import { q, now } from './db';
import { earningsFor } from './util';
import { lateEarnings } from './trading';
import { settings } from './settings';

const iso = (days: number) => new Date(Date.now() + days * 864e5).toISOString();

/** Principal + earnings due to Champions on trades maturing on or before `untilIso` (not yet paid). */
export function payoutsDue(untilIso: string) {
  const rows = q.all<any>("SELECT amount, rate_bps, period_months, matures_at, original_matures_at FROM trades WHERE status IN ('active','matured') AND matures_at<=?", untilIso);
  let principal = 0, earnings = 0;
  for (const t of rows) { principal += t.amount; earnings += earningsFor(t.amount, t.rate_bps, t.period_months) + lateEarnings(t); }
  return { principal, earnings, total: principal + earnings, count: rows.length };
}

export interface Receivable {
  id: number; code: string; title: string; buyer_name: string | null; buyer_type: string; status: string;
  buyer_amount: number | null; buyer_due_at: string | null; received: number; outstanding: number; overdue: boolean; days_overdue: number;
  champions_owed: number; champions_due_at: string | null;
}
/** One row per lot that has (or should have) a buyer receivable. */
export function receivables(): Receivable[] {
  const lots = q.all<any>(`SELECT l.*, (SELECT COALESCE(SUM(amount),0) FROM buyer_payments WHERE lot_id=l.id) AS received,
      (SELECT COALESCE(SUM(amount),0) FROM trades WHERE lot_id=l.id AND status IN ('active','matured')) AS owed_principal,
      (SELECT MIN(matures_at) FROM trades WHERE lot_id=l.id AND status IN ('active','matured')) AS champions_due_at
    FROM lots l WHERE l.status IN ('open','filled','active') OR (l.buyer_amount IS NOT NULL AND l.buyer_amount > (SELECT COALESCE(SUM(amount),0) FROM buyer_payments WHERE lot_id=l.id))
    ORDER BY COALESCE(l.buyer_due_at, l.closes_at)`);
  const t = now();
  return lots.map((l) => {
    const outstanding = Math.max(0, (l.buyer_amount || 0) - l.received);
    const overdue = !!(l.buyer_due_at && l.buyer_due_at < t && outstanding > 0);
    const owed = l.owed_principal + earningsFor(l.owed_principal, l.rate_bps, l.period_months);
    return {
      id: l.id, code: l.code, title: l.title, buyer_name: l.buyer_name, buyer_type: l.buyer_type, status: l.status,
      buyer_amount: l.buyer_amount, buyer_due_at: l.buyer_due_at, received: l.received, outstanding, overdue,
      days_overdue: overdue ? Math.floor((Date.now() - new Date(l.buyer_due_at).getTime()) / 864e5) : 0,
      champions_owed: owed, champions_due_at: l.champions_due_at,
    };
  });
}

export const latestCash = () => q.get<{ amount: number; credit_line: number; note: string | null; as_of: string; created_by: number }>('SELECT * FROM cash_positions ORDER BY as_of DESC, id DESC LIMIT 1');

export interface Coverage {
  horizon: number; due: ReturnType<typeof payoutsDue>; cash: number; creditLine: number; buyerDue: number; available: number; ratio: number | null; level: 'ok' | 'warn' | 'short' | 'unknown';
}
/** Coverage over a horizon: (cash + credit line + buyer money due in the window) ÷ payouts due in the window. */
export function coverage(days: number): Coverage {
  const until = iso(days);
  const due = payoutsDue(until);
  const cash = latestCash();
  const buyerDue = receivables().filter((r) => r.buyer_due_at && r.buyer_due_at <= until && !r.overdue).reduce((s, r) => s + r.outstanding, 0);
  const available = (cash?.amount || 0) + (cash?.credit_line || 0) + buyerDue;
  const ratio = due.total ? available / due.total : null;
  const warn = Number(settings().coverage_warn_ratio) || 1.2;
  const level: Coverage['level'] = !cash ? (due.total ? 'unknown' : 'ok') : ratio === null ? 'ok' : ratio < 1 ? 'short' : ratio < warn ? 'warn' : 'ok';
  return { horizon: days, due, cash: cash?.amount || 0, creditLine: cash?.credit_line || 0, buyerDue, available, ratio, level };
}

/** A plain summary the treasury agent and the weekly email both use. */
export function treasurySnapshot() {
  const horizons = [7, 30, 60, 90].map(coverage);
  const recv = receivables();
  const overdue = recv.filter((r) => r.overdue);
  const cash = latestCash();
  return {
    asOf: now(), cashAsOf: cash?.as_of || null, horizons,
    overdue: overdue.map((r) => ({ lot: r.code, buyer: r.buyer_name || r.buyer_type, outstanding: r.outstanding, days: r.days_overdue })),
    overdueTotal: overdue.reduce((s, r) => s + r.outstanding, 0),
    missingBuyerTerms: recv.filter((r) => ['filled', 'active'].includes(r.status) && !r.buyer_amount).map((r) => r.code),
  };
}
