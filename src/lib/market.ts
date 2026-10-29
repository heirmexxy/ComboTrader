// Marketplace: Champions sell trades (whole, or in units of at least the unit size) to other Champions before the payout date.
// Price = value to date: principal + the earnings built up so far, less any discount the seller offers (up to the limit).
// The seller is paid at once (less the fee); the buyer holds the trade and Kitovu pays the holder on the payout date as usual,
// so Kitovu's obligation does not change. Kitovu itself can buy like any other buyer, with no commitment to do so.
import { q, tx, now } from './db';
import { config } from './config';
import { settings } from './settings';
import { post, walletAcct, account, walletBalance } from './ledger';
import { TradeError, getLot, newCertificateNo } from './trading';
import { notify } from './notify';
import { audit } from './audit';
import { userById } from './auth';
import { earningsFor, fmtNGN, randomToken } from './util';
import type { User } from './http';

const testing = () => !!settings().test_mode && config.paystackDemo;
export const marketOn = () => settings().marketplace_mode === 'on' || testing();
/** Days a trade must be held before listing (skipped in test mode so selling can be tried at once). */
const holdDays = () => (testing() ? 0 : Number(settings().market_min_hold_days) || 0);
const DAY = 864e5;

/** How many units a trade can be sold in, and the principal per unit (equal units, each at least the unit size). */
export function unitsOf(amount: number) {
  const size = Math.max(100, Number(settings().market_unit) || 25000000);
  const n = Math.max(1, Math.floor(amount / size));
  return { units: n, unitAmount: Math.floor(amount / n) };
}
/** Value to date of `principal` of a trade: principal + earnings built up day by day since the start. */
export function valueToDate(t: { start_at: string; matures_at: string; rate_bps: number; period_months: number }, principal: number, at = Date.now()) {
  const start = new Date(t.start_at).getTime(), end = new Date(t.matures_at).getTime();
  const share = Math.min(1, Math.max(0, (at - start) / Math.max(1, end - start)));
  return principal + Math.floor(earningsFor(principal, t.rate_bps, t.period_months) * share);
}
/** Everything a buyer and seller see for `units` of a listing right now. */
export function quote(l: { unit_amount: number; discount_bps: number }, t: any, units: number, at = Date.now()) {
  const principal = l.unit_amount * units;
  const value = valueToDate(t, principal, at);
  const price = Math.round(value * (1 - l.discount_bps / 10000));
  const fee = Math.round(price * (Number(settings().market_fee_bps) || 0) / 10000);
  const payout = principal + earningsFor(principal, t.rate_bps, t.period_months);
  const daysLeft = Math.max(1, Math.round((new Date(t.matures_at).getTime() - at) / DAY));
  const annualPct = Math.round(((payout - price) / price) * (365 / daysLeft) * 1000) / 10;
  return { principal, value, price, fee, sellerGets: price - fee, payout, gain: payout - price, daysLeft, annualPct };
}

/** Why a trade cannot be listed now (a translation key), or null if it can. */
export function cannotList(t: any, user: User): string | null {
  const s = settings();
  if (!marketOn()) return 'market.off';
  if (!t || t.user_id !== user.id || t.status !== 'active') return 'market.not_yours';
  if (t.original_matures_at) return 'market.delayed';
  if (t.gift_id && q.get("SELECT 1 FROM gifts WHERE id=? AND status='sent'", t.gift_id)) return 'market.gift';
  const heldSince = new Date(t.acquired_at || t.start_at).getTime();
  if (Date.now() - heldSince < holdDays() * DAY) return 'market.too_soon';
  if (new Date(t.matures_at).getTime() - Date.now() < Number(s.market_cutoff_days) * DAY) return 'market.too_late';
  if (q.get("SELECT 1 FROM trade_listings WHERE trade_id=? AND status='listed'", t.id)) return 'market.already';
  return null;
}
export function canListFrom(t: any) {
  const s = settings();
  return new Date(new Date(t.acquired_at || t.start_at).getTime() + holdDays() * DAY).toISOString();
}

export function listTrade(user: User, tradeId: number, units: number, discountPct: number) {
  return tx(() => {
    const t = q.get<any>('SELECT * FROM trades WHERE id=?', tradeId);
    const why = cannotList(t, user); if (why) throw new TradeError(why, { date: t ? canListFrom(t).slice(0, 10) : '' });
    const u = unitsOf(t.amount);
    const n = Math.min(u.units, Math.max(1, Math.floor(units) || u.units));
    const max = Number(settings().market_max_discount_pct) || 0;
    const disc = Math.round(Math.min(max, Math.max(0, Number(discountPct) || 0)) * 100);
    const id = q.insert('trade_listings', { trade_id: t.id, seller_id: user.id, unit_amount: u.unitAmount, units_total: n, units_left: n, discount_bps: disc, created_at: now() }).id;
    audit(user.id, 'market.list', `trade:${t.id}`, { units: n, unit: u.unitAmount, discount_bps: disc });
    return id;
  });
}
export function cancelListing(user: User, listingId: number) {
  const r = q.run("UPDATE trade_listings SET status='cancelled', close_reason='seller', closed_at=? WHERE id=? AND seller_id=? AND status='listed'", now(), listingId, user.id);
  if (!r.changes) throw new TradeError('market.gone');
  audit(user.id, 'market.cancel', `listing:${listingId}`);
}

/** The Kitovu account that holds trades Kitovu buys (it is paid out like any Champion's). */
export function houseUser() {
  let u = q.get<User>("SELECT * FROM users WHERE role='house' ORDER BY id LIMIT 1");
  if (!u) {
    const id = q.insert('users', { email: 'kitovu-house@combotrader.internal', first_name: 'Kitovu', last_name: 'Technology', country: 'NG', lang: 'en', role: 'house', referral_code: `KITOVU${randomToken(4).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4)}`, email_verified_at: now(), onboarded: 1, notif_email: 0, notif_sms: 0, feed_opt_in: 0, marketing_opt_in: 0, created_at: now() }).id;
    u = userById(id)!;
  }
  return u;
}

/** Buys `units` of a listing. Pays the seller at once, moves (or splits) the trade to the buyer. */
export function buyUnits(buyer: User, listingId: number, units: number, o: { asKitovu?: boolean; by?: number } = {}) {
  return tx(() => {
    if (!marketOn()) throw new TradeError('market.off');
    const l = q.get<any>("SELECT * FROM trade_listings WHERE id=? AND status='listed'", listingId);
    if (!l) throw new TradeError('market.gone');
    const t = q.get<any>('SELECT * FROM trades WHERE id=?', l.trade_id);
    const seller = userById(l.seller_id)!;
    const holder = o.asKitovu ? houseUser() : buyer;
    if (!t || t.status !== 'active' || t.user_id !== l.seller_id || t.original_matures_at || new Date(t.matures_at).getTime() - Date.now() < Number(settings().market_cutoff_days) * DAY) {
      q.run("UPDATE trade_listings SET status='expired', close_reason='trade changed', closed_at=? WHERE id=?", now(), l.id);
      throw new TradeError('market.gone');
    }
    if (holder.id === l.seller_id) throw new TradeError('market.own');
    if (!o.asKitovu && !buyer.email_verified_at) throw new TradeError('lots.verify_first');
    const k = Math.floor(units);
    if (!(k >= 1) || k > l.units_left) throw new TradeError('market.units', { n: l.units_left });
    const qt = quote(l, t, k);
    // Whole trade when nothing (or less than one unit) would be left with the seller.
    const whole = t.amount - qt.principal < l.unit_amount;
    const principal = whole ? t.amount : qt.principal;
    const price = whole && principal !== qt.principal ? Math.round(valueToDate(t, principal) * (1 - l.discount_bps / 10000)) : qt.price;
    const fee = Math.round(price * (Number(settings().market_fee_bps) || 0) / 10000);
    const from = o.asKitovu ? account('kitovu:market_purchases', 'kitovu') : walletAcct(buyer.id);
    if (!o.asKitovu && walletBalance(buyer.id) < price) throw new TradeError('lots.need_funds', { amount: fmtNGN(price) });
    const lot = getLot(t.lot_id)!;
    let newId = t.id;
    if (whole) {
      q.run("UPDATE trades SET user_id=?, acquired_at=?, acquired_price=?, rollover='off', certificate_no=?, share_token=?, circle_id=NULL WHERE id=?", holder.id, now(), price, newCertificateNo(), randomToken(12), t.id);
    } else {
      newId = q.insert('trades', { user_id: holder.id, lot_id: t.lot_id, amount: principal, rate_bps: t.rate_bps, period_months: t.period_months, status: 'active', start_at: t.start_at, matures_at: t.matures_at,
        certificate_no: newCertificateNo(), share_token: randomToken(12), rollover: 'off', acquired_at: now(), acquired_price: price, parent_trade_id: t.id, created_at: now() }).id;
      q.run('UPDATE trades SET amount=amount-? WHERE id=?', principal, t.id);
    }
    post('market', [
      { account: from, amount: -price },
      { account: walletAcct(seller.id), amount: price - fee },
      ...(fee ? [{ account: account('kitovu:market_fees', 'kitovu'), amount: fee }] : []),
    ], { ref: `market:${l.id}:${newId}:${Date.now()}`, memo: lot.code, userId: holder.id, by: o.by });
    const left = whole ? 0 : l.units_left - k;
    q.run("UPDATE trade_listings SET units_left=?, status=CASE WHEN ?=0 THEN 'sold' ELSE status END, closed_at=CASE WHEN ?=0 THEN ? ELSE closed_at END WHERE id=?", left, left, left, now(), l.id);
    q.insert('trade_sales', { listing_id: l.id, trade_id: t.id, new_trade_id: newId, seller_id: seller.id, buyer_id: holder.id, units: whole ? l.units_left : k, principal, price, fee, created_at: now() });
    audit(o.by ?? buyer.id, 'market.buy', `listing:${l.id}`, { trade: newId, principal, price, fee, kitovu: !!o.asKitovu });
    notify(seller, 'market_sold', { lot: lot.title, amount: fmtNGN(price - fee) }, { link: '/app/wallet' });
    if (!o.asKitovu) notify(buyer, 'market_bought', { lot: lot.title, amount: fmtNGN(principal + earningsFor(principal, t.rate_bps, t.period_months)), date: t.matures_at.slice(0, 10) }, { link: `/app/trades/${newId}` });
    return { tradeId: newId, price, fee, principal };
  });
}

/** Listings a Champion can buy from (not their own), with live prices. */
export function openListings(excludeUser?: number) {
  return q.all<any>(`SELECT l.*, t.start_at, t.matures_at, t.rate_bps, t.period_months, t.amount AS trade_amount, t.lot_id, lo.title AS lot_title, lo.code AS lot_code, lo.region, c.name AS commodity,
      (SELECT stage FROM trail_events e WHERE e.lot_id=t.lot_id ORDER BY happened_at DESC, id DESC LIMIT 1) AS stage
    FROM trade_listings l JOIN trades t ON t.id=l.trade_id JOIN lots lo ON lo.id=t.lot_id JOIN commodities c ON c.code=lo.commodity
    WHERE l.status='listed' AND (? IS NULL OR l.seller_id!=?) ORDER BY t.matures_at`, excludeUser ?? null, excludeUser ?? null);
}
export const listingsBy = (uid: number) => q.all<any>(`SELECT l.*, t.matures_at, t.start_at, t.rate_bps, t.period_months, lo.title AS lot_title FROM trade_listings l JOIN trades t ON t.id=l.trade_id JOIN lots lo ON lo.id=t.lot_id WHERE l.seller_id=? ORDER BY l.id DESC LIMIT 50`, uid);

/** Closes listings whose trade changed hands, matured, was delayed or entered the last days. */
export function expireListings() {
  const cutoff = new Date(Date.now() + Number(settings().market_cutoff_days) * DAY).toISOString();
  return q.run(`UPDATE trade_listings SET status='expired', close_reason='no longer eligible', closed_at=? WHERE status='listed' AND trade_id IN (
      SELECT t.id FROM trades t WHERE t.status!='active' OR t.original_matures_at IS NOT NULL OR t.matures_at<=? OR t.user_id!=trade_listings.seller_id)`, now(), cutoff).changes;
}
export const _keep = { userById };
