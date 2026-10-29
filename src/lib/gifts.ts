// Gift a Harvest: a Champion funds a trade from their wallet for someone else.
// The trade stays the giver's until the recipient claims it with the link; then ownership (and the payout) moves to them.
import { q, tx, now } from './db';
import { joinLot, getLot, TradeError } from './trading';
import { settings } from './settings';
import { notify, queueEmail, queueSms, emailShell, escapeHtml } from './notify';
import { audit } from './audit';
import { userById } from './auth';
import { randomToken, sha256, fmtNGN, isEmail, normalizePhone, earningsFor } from './util';
import { config } from './config';
import type { User } from './http';

export interface GiftInput { lotId: number; amount: number; recipientName: string; recipientEmail?: string; recipientPhone?: string; message?: string }

export function createGift(giver: User, g: GiftInput) {
  if (!settings().gifts_enabled) throw new TradeError('gift.off');
  const name = g.recipientName.trim().slice(0, 80);
  const email = (g.recipientEmail || '').trim().toLowerCase();
  const phone = g.recipientPhone ? normalizePhone(g.recipientPhone, giver.country) : '';
  if (!name) throw new TradeError('gift.need_name');
  if (!email && !phone) throw new TradeError('gift.need_contact');
  if (email && !isEmail(email)) throw new TradeError('auth.bad_email');
  if (email && email === giver.email) throw new TradeError('gift.self');
  const raw = randomToken(18);
  const res = tx(() => {
    const trade = joinLot(giver, g.lotId, g.amount, { rollover: 'off' });
    const id = q.insert('gifts', { giver_id: giver.id, trade_id: trade.id, recipient_name: name, recipient_email: email || null, recipient_phone: phone || null, message: (g.message || '').slice(0, 300) || null, token_hash: sha256(raw), created_at: now() }).id;
    q.run('UPDATE trades SET gift_id=? WHERE id=?', id, trade.id);
    return { id, trade };
  });
  const lot = getLot(g.lotId)!;
  const url = `${config.baseUrl}/gift/${raw}`;
  const earn = earningsFor(g.amount, lot.rate_bps, lot.period_months);
  const line = `${giver.first_name} has gifted you a ${fmtNGN(g.amount)} ${lot.commodity_name} harvest trade on ComboTrader. It pays ${fmtNGN(g.amount + earn)} on ${res.trade.matures_at.slice(0, 10)}.`;
  if (email) queueEmail(email, `${giver.first_name} sent you a Harvest gift`, emailShell(`A Harvest gift from ${escapeHtml(giver.first_name)}`,
    `<p>Hello ${escapeHtml(name)},</p><p>${escapeHtml(line)}</p>${g.message ? `<blockquote style="border-left:3px solid #D4A017;margin:12px 0;padding:4px 12px">${escapeHtml(g.message)}</blockquote>` : ''}<p>Claim it with this private link. It takes two minutes to create your account.</p>`,
    { label: 'Claim your gift', url }));
  if (phone) queueSms(phone, `ComboTrader: ${line} Claim it: ${url}`);
  audit(giver.id, 'gift.create', `gift:${res.id}`, { trade: res.trade.id, amount: g.amount });
  notify(giver, 'gift_sent', { name, amount: fmtNGN(g.amount) }, { link: `/app/gifts`, email: false });
  return { id: res.id, url, trade: res.trade };
}

export const giftByToken = (raw: string) => q.get<any>(`SELECT g.*, u.first_name AS giver_first, t.amount, t.matures_at, t.rate_bps, t.period_months, t.status AS trade_status, l.title AS lot_title, l.region, c.name AS commodity
  FROM gifts g JOIN users u ON u.id=g.giver_id JOIN trades t ON t.id=g.trade_id JOIN lots l ON l.id=t.lot_id JOIN commodities c ON c.code=l.commodity WHERE g.token_hash=?`, sha256(raw));

export function claimGift(user: User, raw: string) {
  return tx(() => {
    const g = giftByToken(raw);
    if (!g || g.status !== 'sent') throw new TradeError('gift.invalid');
    if (g.giver_id === user.id) throw new TradeError('gift.self');
    if (!user.email_verified_at) throw new TradeError('lots.verify_first');
    if (!['active', 'matured'].includes(g.trade_status)) {
      q.run("UPDATE gifts SET status='expired' WHERE id=?", g.id);
      throw new TradeError('gift.expired');
    }
    q.run('UPDATE trades SET user_id=? WHERE id=?', user.id, g.trade_id);
    q.run("UPDATE gifts SET status='claimed', recipient_id=?, claimed_at=? WHERE id=?", user.id, now(), g.id);
    audit(user.id, 'gift.claim', `gift:${g.id}`, { trade: g.trade_id, from: g.giver_id });
    const giver = userById(g.giver_id);
    if (giver) notify(giver, 'gift_claimed', { name: user.first_name }, { link: '/app/gifts' });
    notify(user, 'gift_received', { name: g.giver_first, amount: fmtNGN(g.amount), date: String(g.matures_at).slice(0, 10) }, { link: `/app/trades/${g.trade_id}` });
    return g.trade_id as number;
  });
}

/** The giver cancels an unclaimed gift: the trade simply stays theirs. */
export function cancelGift(giver: User, id: number) {
  const r = q.run("UPDATE gifts SET status='cancelled' WHERE id=? AND giver_id=? AND status='sent'", id, giver.id);
  if (!r.changes) throw new TradeError('gift.invalid');
  audit(giver.id, 'gift.cancel', `gift:${id}`);
}

export const giftsBy = (uid: number) => q.all<any>(`SELECT g.*, t.amount, t.matures_at, t.status AS trade_status, l.title AS lot_title FROM gifts g JOIN trades t ON t.id=g.trade_id JOIN lots l ON l.id=t.lot_id WHERE g.giver_id=? ORDER BY g.id DESC`, uid);
export const giftsTo = (uid: number) => q.all<any>(`SELECT g.*, u.first_name AS giver_first, t.amount, t.matures_at, l.title AS lot_title FROM gifts g JOIN users u ON u.id=g.giver_id JOIN trades t ON t.id=g.trade_id JOIN lots l ON l.id=t.lot_id WHERE g.recipient_id=? ORDER BY g.id DESC`, uid);
