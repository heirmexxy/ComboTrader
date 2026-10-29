// Trade Lots, trades, Harvest Trail, payouts, referrals, ranks and public stats.
import { q, tx, now } from './db';
import { move, post, walletAcct, lotAcct, account, walletBalance, LedgerError } from './ledger';
import { settings } from './settings';
import { earningsFor, addMonths, randomToken, randomCode, fmtNGN } from './util';
import { activity, audit } from './audit';
import { notify } from './notify';
import { userById } from './auth';
import type { User } from './http';

export interface Lot {
  id: number; code: string; commodity: string; title: string; description: string | null; region: string | null;
  buyer_type: string; buyer_name: string | null; contract_ref: string | null; contract_path: string | null;
  tonnage: number; farmers: number; target_amount: number; min_commit: number; period_months: number; rate_bps: number;
  closes_at: string; status: string; started_at: string | null; matures_at: string | null; circles_enabled: number; created_at: string;
  commodity_name?: string; funded?: number;
}
export interface Trade {
  id: number; user_id: number; lot_id: number; circle_id: number | null; slots: number | null; amount: number; rate_bps: number;
  period_months: number; status: string; start_at: string; matures_at: string; earnings: number | null; paid_at: string | null;
  certificate_no: string; share_token: string; created_at: string; rollover?: string; gift_id?: number | null;
}
export type RolloverMode = 'off' | 'principal' | 'all';
export const isRollover = (v: unknown): v is RolloverMode => v === 'off' || v === 'principal' || v === 'all';

export const STAGES = ['funded', 'sourcing', 'warehoused', 'delivered', 'buyer_paid', 'champions_paid'] as const;

export class TradeError extends Error { constructor(public key: string, public vars: Record<string, string | number> = {}) { super(key); } }

const LOT_SELECT = `SELECT l.*, c.name AS commodity_name,
  (SELECT COALESCE(SUM(t.amount),0) FROM trades t WHERE t.lot_id=l.id AND t.status!='cancelled') +
  (SELECT COALESCE(SUM(s.amount),0) FROM circle_slots s JOIN circles ci ON ci.id=s.circle_id WHERE ci.lot_id=l.id AND s.status='reserved') AS funded
  FROM lots l JOIN commodities c ON c.code=l.commodity`;

export const getLot = (id: number) => q.get<Lot>(`${LOT_SELECT} WHERE l.id=?`, id);
export const getLotByCode = (code: string) => q.get<Lot>(`${LOT_SELECT} WHERE l.code=?`, code);
export const openLots = (limit = 50) => q.all<Lot>(`${LOT_SELECT} WHERE l.status='open' AND l.closes_at > ? ORDER BY l.closes_at LIMIT ?`, now(), limit);
export const publicLots = () => q.all<Lot>(`${LOT_SELECT} WHERE l.status IN ('open','filled','active','completed') ORDER BY CASE l.status WHEN 'open' THEN 0 WHEN 'filled' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, l.closes_at DESC LIMIT 60`);
export const allLots = () => q.all<Lot>(`${LOT_SELECT} ORDER BY l.id DESC`);
export const lotRemaining = (l: Lot) => Math.max(0, l.target_amount - (l.funded || 0));
export const lotPct = (l: Lot) => Math.min(100, Math.round(((l.funded || 0) / l.target_amount) * 100));

export function newCertificateNo() {
  let c = `CT-${new Date().getUTCFullYear()}-${randomCode(6)}`;
  while (q.get('SELECT 1 FROM trades WHERE certificate_no=?', c)) c = `CT-${new Date().getUTCFullYear()}-${randomCode(6)}`;
  return c;
}

/** Champion joins a lot from their wallet. */
export function joinLot(user: User, lotId: number, amount: number, o: { rollover?: RolloverMode } = {}) {
  return tx(() => {
    const lot = getLot(lotId);
    if (!lot || lot.status !== 'open' || lot.closes_at < now()) throw new TradeError('lots.not_open');
    if (!user.email_verified_at) throw new TradeError('lots.verify_first');
    const remaining = lotRemaining(lot);
    if (amount > remaining) throw new TradeError('lots.too_big', { amount: fmtNGN(remaining) });
    if (amount < lot.min_commit && amount !== remaining) throw new TradeError('lots.too_small', { amount: fmtNGN(lot.min_commit) });
    const bal = walletBalance(user.id);
    if (bal < amount) throw new TradeError('lots.need_funds', { amount: fmtNGN(amount - bal) });
    const trade = createTrade(user.id, lot, amount, now(), { rollover: o.rollover });
    if (lotRemaining(getLot(lotId)!) === 0) q.run("UPDATE lots SET status='filled' WHERE id=? AND status='open'", lotId);
    return trade;
  });
}

/** Creates a trade and moves the money (wallet or reserved -> lot). */
export function createTrade(userId: number, lot: Lot, amount: number, startAt: string, o: { circleId?: number; slots?: number; fromAccount?: number; rollover?: RolloverMode; giftId?: number; silent?: boolean } = {}) {
  const firstTrade = !q.get("SELECT 1 FROM trades WHERE user_id=? AND status!='cancelled'", userId);
  const t = q.insert('trades', {
    user_id: userId, lot_id: lot.id, circle_id: o.circleId ?? null, slots: o.slots ?? null, amount, rate_bps: lot.rate_bps,
    period_months: lot.period_months, status: 'active', start_at: startAt, matures_at: addMonths(startAt, lot.period_months),
    certificate_no: newCertificateNo(), share_token: randomToken(12), created_at: now(),
    rollover: o.rollover ?? (q.val<string>('SELECT rollover_default FROM users WHERE id=?', userId) || 'off'), gift_id: o.giftId ?? null,
  });
  move('trade', o.fromAccount ?? walletAcct(userId), lotAcct(lot.id), amount, { ref: `trade:${t.id}`, memo: lot.code, userId });
  const user = userById(userId)!;
  activity('trade', userId, { commodity: lot.commodity, lot: lot.code });
  const trade = q.get<Trade>('SELECT * FROM trades WHERE id=?', t.id)!;
  if (!o.silent) notify(user, 'trade_joined', { lot: lot.title, amount: fmtNGN(amount), earn: fmtNGN(earningsFor(amount, lot.rate_bps, lot.period_months)), date: trade.matures_at.slice(0, 10) }, { link: `/app/trades/${t.id}` });
  if (firstTrade) rewardReferrer(user, t.id);
  return trade;
}

function rewardReferrer(user: User, tradeId: number) {
  if (!user.referred_by) return;
  if (q.get('SELECT 1 FROM referral_rewards WHERE referred_id=?', user.id)) return;
  const amount = settings().referral_reward;
  if (amount <= 0) return;
  // Fraud checks: same payout bank account, or both accounts first logged in from the same IP.
  const sameBank = q.get(`SELECT 1 FROM bank_accounts a JOIN bank_accounts b ON a.account_number=b.account_number
    WHERE a.user_id=? AND b.user_id=?`, user.id, user.referred_by);
  const sameIp = q.get(`SELECT 1 FROM login_events a JOIN login_events b ON a.ip=b.ip
    WHERE a.user_id=? AND b.user_id=? AND a.success=1 AND b.success=1 AND a.ip NOT IN ('', '127.0.0.1', '::1')`, user.id, user.referred_by);
  const flag = sameBank ? 'same bank account' : sameIp ? 'same IP address' : null;
  q.insert('referral_rewards', { referrer_id: user.referred_by, referred_id: user.id, trade_id: tradeId, amount, status: flag ? 'held' : 'credited', flagged: flag, created_at: now() });
  if (!flag) creditReferral(user.referred_by, user, amount);
}
export function creditReferral(referrerId: number, referred: { first_name: string }, amount: number, by?: number) {
  move('referral', account('kitovu:referrals'), walletAcct(referrerId), amount, { ref: `ref:${referrerId}:${referred.first_name}:${Date.now()}`, memo: 'Referral reward', userId: referrerId, by });
  const ref = userById(referrerId);
  if (ref) notify(ref, 'referral_reward', { friend: referred.first_name, amount: fmtNGN(amount) }, { link: '/app/referrals' });
}

// ---------- Harvest Trail ----------
export function addTrailEvent(lotId: number, stage: string, note: string, photo: string | null, by: number, happenedAt = now()) {
  q.insert('trail_events', { lot_id: lotId, stage, note: note || null, photo_path: photo, happened_at: happenedAt, created_by: by, created_at: now() });
  const lot = getLot(lotId)!;
  const users = q.all<{ user_id: number }>("SELECT DISTINCT user_id FROM trades WHERE lot_id=? AND status!='cancelled'", lotId);
  for (const { user_id } of users) {
    const u = userById(user_id);
    if (u) notify(u, 'trail_update', { lot: lot.title, stage: stageLabel(u.lang, stage) }, { link: `/app/trades?lot=${lotId}` });
  }
  return users.length;
}
import { translate } from './i18n';
export const stageLabel = (lang: any, stage: string) => translate(lang, `trail.${stage}`);
export const trailFor = (lotId: number) => q.all<any>('SELECT * FROM trail_events WHERE lot_id=? ORDER BY happened_at, id', lotId);

// ---------- Maturity & payouts ----------
/** Marks trades whose date has passed as matured. Returns count. */
export function markMatured() {
  return q.run("UPDATE trades SET status='matured' WHERE status='active' AND matures_at <= ?", now()).changes;
}
export const duePayouts = () => q.all<Trade & { first_name: string; last_name: string; lot_title: string; lot_code: string }>(
  `SELECT t.*, u.first_name, u.last_name, l.title AS lot_title, l.code AS lot_code FROM trades t JOIN users u ON u.id=t.user_id JOIN lots l ON l.id=t.lot_id
   WHERE t.status IN ('active','matured') AND t.matures_at <= ? ORDER BY t.matures_at`, now());
export const upcomingPayouts = (days = 30) => q.all<any>(
  `SELECT t.*, u.first_name, u.last_name, l.title AS lot_title FROM trades t JOIN users u ON u.id=t.user_id JOIN lots l ON l.id=t.lot_id
   WHERE t.status='active' AND t.matures_at > ? AND t.matures_at <= ? ORDER BY t.matures_at`, now(), new Date(Date.now() + days * 864e5).toISOString());

/** Credits principal + earnings for one matured trade to the Champion's wallet. Idempotent. */
export function payTrade(tradeId: number, by: number | null) {
  return tx(() => {
    const t = q.get<Trade>('SELECT * FROM trades WHERE id=?', tradeId);
    if (!t) throw new LedgerError('Trade not found');
    if (t.status === 'paid') return t;
    if (t.matures_at > now()) throw new LedgerError(`Trade ${t.certificate_no} has not matured`);
    const lot = getLot(t.lot_id)!;
    const earn = earningsFor(t.amount, t.rate_bps, t.period_months) + lateEarnings(t);
    post('payout', [
      { account: lotAcct(t.lot_id), amount: -t.amount },
      { account: account('kitovu:earnings'), amount: -earn },
      { account: walletAcct(t.user_id), amount: t.amount + earn },
    ], { ref: `payout:${t.id}`, memo: lot.code, userId: t.user_id, by: by ?? undefined });
    q.run("UPDATE trades SET status='paid', earnings=?, paid_at=? WHERE id=?", earn, now(), t.id);
    if (!q.get("SELECT 1 FROM trades WHERE lot_id=? AND status IN ('active','matured')", t.lot_id)) {
      q.run("UPDATE lots SET status='completed' WHERE id=? AND status IN ('filled','active','open')", t.lot_id);
    }
    activity('payout', t.user_id, { commodity: lot.commodity });
    audit(by, 'payout.credit', `trade:${t.id}`, { amount: t.amount, earn });
    const u = userById(t.user_id)!;
    notify(u, 'payout_credited', { amount: fmtNGN(t.amount + earn), earn: fmtNGN(earn), lot: lot.title }, { link: '/app/wallet', sms: true });
    if (t.rollover === 'principal' || t.rollover === 'all') {
      q.run('INSERT OR IGNORE INTO rollovers (user_id, from_trade_id, amount, commodity, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
        t.user_id, t.id, t.rollover === 'all' ? t.amount + earn : t.amount, lot.commodity, 'pending', new Date(Date.now() + 14 * 864e5).toISOString(), now());
    }
    return q.get<Trade>('SELECT * FROM trades WHERE id=?', t.id)!;
  });
}

/** Credits every matured trade automatically (setting auto_payouts). Kitovu pays on the payout date whatever the buyer does. */
export function autoPayDue() {
  if (!settings().auto_payouts) return 0;
  let n = 0;
  for (const t of duePayouts()) { try { payTrade(t.id, null); n++; } catch (e) { audit(null, 'payout.auto_failed', `trade:${t.id}`, String((e as Error).message)); } }
  return n;
}

/** Keep Growing: re-commits a paid-out trade into the best open lot. Waits up to 14 days for a suitable lot. */
export function processRollovers() {
  let done = 0;
  for (const r of q.all<any>("SELECT * FROM rollovers WHERE status='pending' ORDER BY id")) {
    const u = userById(r.user_id);
    if (!u || u.status !== 'active') { q.run("UPDATE rollovers SET status='expired' WHERE id=?", r.id); continue; }
    const amount = Math.min(r.amount, walletBalance(u.id));
    const lot = pickRolloverLot(amount, r.commodity);
    if (lot) {
      const amt = Math.min(amount, lotRemaining(lot));
      try {
        const t = joinLot(u, lot.id, amt, { rollover: (q.val<string>('SELECT rollover FROM trades WHERE id=?', r.from_trade_id) as RolloverMode) || 'off' });
        q.run("UPDATE rollovers SET status='done', to_trade_id=? WHERE id=?", t.id, r.id);
        q.run('UPDATE trades SET rolled_to=? WHERE id=?', t.id, r.from_trade_id);
        notify(u, 'rollover_done', { amount: fmtNGN(amt), lot: lot.title, date: t.matures_at.slice(0, 10) }, { link: `/app/trades/${t.id}` });
        done++;
        continue;
      } catch (e) { audit(null, 'rollover.failed', `rollover:${r.id}`, String((e as Error).message)); }
    }
    if (r.expires_at < now() || amount <= 0) {
      q.run("UPDATE rollovers SET status='expired' WHERE id=?", r.id);
      notify(u, 'rollover_expired', { amount: fmtNGN(r.amount) }, { link: '/app/lots' });
    }
  }
  return done;
}
/** Same commodity first, then any open lot that can take at least its minimum from this amount. */
export function pickRolloverLot(amount: number, commodity?: string | null) {
  if (amount <= 0) return null;
  const fits = openLots()
    .map((l) => ({ l, take: Math.min(amount, lotRemaining(l)) }))
    .filter(({ l, take }) => take > 0 && (take >= l.min_commit || take === lotRemaining(l)) && take >= Math.min(amount, l.min_commit))
    .sort((a, b) => (b.take - a.take) || (Number(b.l.commodity === commodity) - Number(a.l.commodity === commodity)));
  const best = fits[0]?.take;
  return (fits.find((f) => f.take === best && f.l.commodity === commodity) || fits[0])?.l || null;
}

/** Earnings for the extra days when a payout was delayed (same rate, pro-rated daily). */
export function lateEarnings(t: { amount: number; rate_bps: number; original_matures_at?: string | null; matures_at: string }) {
  if (!t.original_matures_at) return 0;
  const days = Math.max(0, Math.round((new Date(t.matures_at).getTime() - new Date(t.original_matures_at).getTime()) / 864e5));
  return Math.round((t.amount * t.rate_bps * days) / (10000 * 365));
}

/** Moves the payout date of every open trade in a lot (exceptional causes outside Kitovu's control only; buyer delays are covered by Kitovu). Champions are told why and when. */
export function delayLotPayouts(lotId: number, newDateIso: string, reason: string, by: number) {
  return tx(() => {
    const lot = getLot(lotId)!;
    const trades = q.all<Trade & { original_matures_at: string | null }>("SELECT * FROM trades WHERE lot_id=? AND status IN ('active','matured') AND matures_at < ?", lotId, newDateIso);
    for (const t of trades) {
      q.run("UPDATE trades SET original_matures_at=COALESCE(original_matures_at, matures_at), matures_at=?, status='active', delay_reason=? WHERE id=?", newDateIso, reason, t.id);
      const u = userById(t.user_id);
      if (u) notify(u, 'payout_delayed', { lot: lot.title, date: newDateIso.slice(0, 10), reason }, { link: `/app/trades/${t.id}`, sms: true });
    }
    audit(by, 'lot.delay_payouts', `lot:${lotId}`, { to: newDateIso, reason, trades: trades.length });
    return trades.length;
  });
}

/** Closes lots whose window has passed: they stop accepting and run. */
export function closeExpiredLots() {
  return q.run("UPDATE lots SET status='active' WHERE status IN ('open','filled') AND closes_at <= ?", now()).changes;
}

// ---------- Ranks, impact and stats ----------
export const RANKS = ['seedling', 'sprout', 'harvester', 'granary'] as const;
export function impactFor(userId: number) {
  const r = q.get<{ tons: number; farmers: number; committed: number; earned: number; expected: number }>(
    `SELECT COALESCE(SUM(t.amount * 1.0 / l.target_amount * l.tonnage),0) AS tons,
            COALESCE(SUM(t.amount * 1.0 / l.target_amount * l.farmers),0) AS farmers,
            COALESCE(SUM(CASE WHEN t.status IN ('active','matured') THEN t.amount END),0) AS committed,
            COALESCE(SUM(CASE WHEN t.status='paid' THEN t.earnings END),0) AS earned,
            COALESCE(SUM(CASE WHEN t.status IN ('active','matured') THEN t.amount * t.rate_bps * t.period_months / 120000 END),0) AS expected
     FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? AND t.status!='cancelled'`, userId)!;
  return { tons: r.tons, farmers: Math.round(r.farmers), committed: r.committed, earned: r.earned, expected: Math.round(r.expected) };
}
export function rankFor(tons: number) {
  const th = String(settings().rank_thresholds).split(',').map(Number);
  let i = 0;
  while (i < th.length && tons >= th[i]) i++;
  const next = i < th.length ? { rank: RANKS[i + 1], tons: th[i] - tons } : null;
  return { rank: RANKS[i], index: i, next };
}
export function siteStats() {
  const s = settings();
  const champions = Number(q.val("SELECT COUNT(*) FROM users WHERE role='champion'") ?? 0);
  const tons = Number(q.val("SELECT COALESCE(SUM(tonnage),0) FROM lots WHERE status='completed'") ?? 0);
  const farmers = Number(q.val("SELECT COALESCE(SUM(farmers),0) FROM lots WHERE status='completed'") ?? 0);
  const paid = Number(q.val("SELECT COALESCE(SUM(amount + earnings),0) FROM trades WHERE status='paid'") ?? 0);
  return {
    champions: s.baseline_champions + champions,
    tons: s.baseline_tons + tons,
    payouts: s.baseline_payouts + paid,
    farmers: s.baseline_farmers + farmers,
  };
}
