// Double-entry ledger. Balances are never edited; they are the sum of entries.
//
// Accounts
//   ext:paystack           money crossing in/out of the platform
//   wallet:<uid>           a Champion's available balance
//   reserved:<uid>         a Champion's held funds (circle reservations, pending withdrawals)
//   lot:<lotId>            principal committed to a Trade Lot (owed back to Champions)
//   plan:<planId>          a Champion's Harvest Plan savings (theirs; withdrawable to wallet)
//   kitovu:earnings        Kitovu's cost of paying earnings
//   kitovu:referrals       Kitovu's cost of referral rewards
//   kitovu:fees            card fees passed on to Champions
//   kitovu:adjustments     manual corrections (always with a reason and a second approver)
import { q, tx, now } from './db';

export function account(code: string, kind?: string, userId?: number): number {
  const row = q.get<{ id: number }>('SELECT id FROM ledger_accounts WHERE code=?', code);
  if (row) return row.id;
  return q.insert('ledger_accounts', { code, kind: kind || code.split(':')[0], user_id: userId ?? null, created_at: now() }).id;
}
export const walletAcct = (uid: number) => account(`wallet:${uid}`, 'wallet', uid);
export const reservedAcct = (uid: number) => account(`reserved:${uid}`, 'reserved', uid);
export const lotAcct = (lotId: number) => account(`lot:${lotId}`, 'lot');
export const planAcct = (planId: number, uid: number) => account(`plan:${planId}`, 'plan', uid);
export const EXT = () => account('ext:paystack', 'external');

export function balance(code: string): number {
  return Number(q.val('SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.code=?', code) ?? 0);
}
export const walletBalance = (uid: number) => balance(`wallet:${uid}`);
export const reservedBalance = (uid: number) => balance(`reserved:${uid}`);

export class LedgerError extends Error {}

export interface Leg { account: number; amount: number }
/**
 * Posts a balanced journal. `ref` makes the posting idempotent per kind:
 * posting the same (kind, ref) twice returns the first journal id.
 */
export function post(kind: string, legs: Leg[], o: { ref?: string; memo?: string; userId?: number; by?: number; approvedBy?: number; allowNegative?: number[] } = {}): number {
  const sum = legs.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new LedgerError(`Unbalanced journal ${kind}: ${sum}`);
  if (legs.some((l) => !Number.isInteger(l.amount))) throw new LedgerError('Amounts must be integer kobo');
  return tx(() => {
    if (o.ref) {
      const ex = q.get<{ id: number }>('SELECT id FROM journals WHERE kind=? AND ref=?', kind, o.ref);
      if (ex) return ex.id;
    }
    const t = now();
    const j = q.insert('journals', { kind, ref: o.ref ?? null, memo: o.memo ?? null, user_id: o.userId ?? null, created_by: o.by ?? null, approved_by: o.approvedBy ?? null, created_at: t }).id;
    for (const l of legs) q.insert('entries', { journal_id: j, account_id: l.account, amount: l.amount, created_at: t });
    // Champion-owned accounts may never go negative.
    for (const l of legs) {
      if (l.amount >= 0) continue;
      const a = q.get<{ code: string; kind: string }>('SELECT code, kind FROM ledger_accounts WHERE id=?', l.account)!;
      if ((a.kind === 'wallet' || a.kind === 'reserved' || a.kind === 'lot' || a.kind === 'plan') && balance(a.code) < 0) {
        throw new LedgerError(a.kind === 'wallet' ? 'Insufficient wallet balance' : `Insufficient funds in ${a.code}`);
      }
    }
    return j;
  });
}

/** Moves `amount` from one account to another in one journal. */
export const move = (kind: string, from: number, to: number, amount: number, o: Parameters<typeof post>[2] = {}) =>
  post(kind, [{ account: from, amount: -amount }, { account: to, amount }], o);

export function trialBalance(): number {
  return Number(q.val('SELECT COALESCE(SUM(amount),0) FROM entries') ?? 0);
}

export interface StatementRow { id: number; kind: string; memo: string | null; amount: number; created_at: string; ref: string | null }
export function walletStatement(uid: number, limit = 200): StatementRow[] {
  return q.all<StatementRow>(
    `SELECT j.id, j.kind, j.memo, j.ref, e.amount, e.created_at FROM entries e
     JOIN journals j ON j.id=e.journal_id JOIN ledger_accounts a ON a.id=e.account_id
     WHERE a.code=? ORDER BY e.id DESC LIMIT ?`, `wallet:${uid}`, limit);
}
