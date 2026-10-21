// Harvest Circles (MicroTrading): many Champions fill one slice of a lot together.
// Slots are RESERVED in the Champion's wallet (not spent). When the last slot is taken,
// every reservation converts into a trade on the same day. Unfilled circles release funds automatically.
import { q, tx, now } from './db';
import { move, walletAcct, reservedAcct, walletBalance } from './ledger';
import { settings } from './settings';
import { getLot, lotRemaining, createTrade, TradeError } from './trading';
import { addDays, randomCode, fmtNGN } from './util';
import { activity, audit } from './audit';
import { notify } from './notify';
import { userById } from './auth';
import type { User } from './http';

export interface Circle {
  id: number; lot_id: number; name: string; creator_id: number | null; is_private: number; invite_code: string; slots: number;
  slot_price: number; max_slots_per_user: number; deadline: string; status: string; filled_at: string | null; created_at: string;
  taken?: number; lot_title?: string; commodity?: string; rate_bps?: number; period_months?: number;
}

/** Who can see and use circles, given the feature switch (Admin → Settings → Features). */
export function circlesVisibleTo(user: User | null) {
  const mode = settings().circles_mode;
  if (mode === 'on') return true;
  if (mode === 'pilot') return !!user && (!!user.circle_pilot || user.role === 'admin');
  return false;
}

const SELECT = `SELECT c.*, l.title AS lot_title, l.commodity, l.rate_bps, l.period_months,
  (SELECT COALESCE(SUM(s.slots),0) FROM circle_slots s WHERE s.circle_id=c.id AND s.status IN ('reserved','converted')) AS taken
  FROM circles c JOIN lots l ON l.id=c.lot_id`;
export const getCircle = (id: number) => q.get<Circle>(`${SELECT} WHERE c.id=?`, id);
export const getCircleByInvite = (code: string) => q.get<Circle>(`${SELECT} WHERE c.invite_code=?`, code);
export const publicCircles = () => q.all<Circle>(`${SELECT} WHERE c.status='filling' AND c.is_private=0 ORDER BY c.deadline`);
export const userCircles = (uid: number) => q.all<Circle & { my_slots: number }>(
  `${SELECT.replace('FROM circles c', ', (SELECT COALESCE(SUM(s2.slots),0) FROM circle_slots s2 WHERE s2.circle_id=c.id AND s2.user_id=? AND s2.status IN (\'reserved\',\'converted\')) AS my_slots FROM circles c')}
   WHERE c.id IN (SELECT circle_id FROM circle_slots WHERE user_id=?) OR c.creator_id=? ORDER BY c.created_at DESC`, uid, uid, uid);
export const allCircles = () => q.all<Circle>(`${SELECT} ORDER BY c.id DESC`);

export function createCircle(o: { lotId: number; name: string; slots: number; slotPrice: number; creatorId: number | null; isPrivate: boolean; deadlineDays?: number; maxSharePct?: number }) {
  return tx(() => {
    const lot = getLot(o.lotId);
    if (!lot || lot.status !== 'open' || !lot.circles_enabled) throw new TradeError('lots.not_open');
    const size = o.slots * o.slotPrice;
    if (size > lotRemaining(lot)) throw new TradeError('lots.too_big', { amount: fmtNGN(lotRemaining(lot)) });
    const s = settings();
    const deadline = addDays(now(), o.deadlineDays ?? s.circle_deadline_days);
    const maxShare = Math.max(1, Math.floor(o.slots * (o.maxSharePct ?? s.circle_max_share_pct) / 100));
    let code = randomCode(8);
    while (q.get('SELECT 1 FROM circles WHERE invite_code=?', code)) code = randomCode(8);
    const id = q.insert('circles', {
      lot_id: o.lotId, name: o.name.slice(0, 80), creator_id: o.creatorId, is_private: o.isPrivate ? 1 : 0, invite_code: code,
      slots: o.slots, slot_price: o.slotPrice, max_slots_per_user: maxShare,
      deadline: deadline < lot.closes_at ? deadline : lot.closes_at, created_at: now(),
    }).id;
    return getCircle(id)!;
  });
}

export function takeSlots(user: User, circleId: number, n: number) {
  return tx(() => {
    const c = getCircle(circleId);
    if (!c || c.status !== 'filling' || c.deadline < now()) throw new TradeError('lots.not_open');
    if (!user.email_verified_at) throw new TradeError('lots.verify_first');
    if (n < 1) throw new TradeError('circles.how_many');
    const mine = Number(q.val("SELECT COALESCE(SUM(slots),0) FROM circle_slots WHERE circle_id=? AND user_id=? AND status='reserved'", c.id, user.id) ?? 0);
    if (mine + n > c.max_slots_per_user) throw new TradeError('circles.max', { n: c.max_slots_per_user });
    const left = c.slots - (c.taken || 0);
    if (n > left) throw new TradeError('circles.slots', { taken: c.taken || 0, total: c.slots });
    const amount = n * c.slot_price;
    if (walletBalance(user.id) < amount) throw new TradeError('lots.need_funds', { amount: fmtNGN(amount - walletBalance(user.id)) });
    const slot = q.insert('circle_slots', { circle_id: c.id, user_id: user.id, slots: n, amount, created_at: now() });
    move('circle_reserve', walletAcct(user.id), reservedAcct(user.id), amount, { ref: `slot:${slot.id}`, memo: c.name, userId: user.id });
    const after = getCircle(c.id)!;
    if ((after.taken || 0) >= after.slots) fillCircle(after.id);
    else {
      const pct = Math.round(((after.taken || 0) / after.slots) * 100);
      if (pct >= 80 && !q.val('SELECT nudged80 FROM circles WHERE id=?', c.id)) {
        q.run('UPDATE circles SET nudged80=1 WHERE id=?', c.id);
        for (const uid of circleMembers(c.id)) { const u = userById(uid); if (u) notify(u, 'circle_80', { circle: c.name, pct }, { link: `/app/circles/${c.id}` }); }
      }
    }
    return getCircle(c.id)!;
  });
}

const circleMembers = (circleId: number) => q.all<{ user_id: number }>("SELECT DISTINCT user_id FROM circle_slots WHERE circle_id=? AND status IN ('reserved','converted')", circleId).map((r) => r.user_id);

/** Converts every reservation into a trade at the same moment. */
export function fillCircle(circleId: number) {
  return tx(() => {
    const c = getCircle(circleId)!;
    if (c.status !== 'filling') return c;
    const lot = getLot(c.lot_id)!;
    const t = now();
    for (const s of q.all<any>("SELECT * FROM circle_slots WHERE circle_id=? AND status='reserved'", c.id)) {
      createTrade(s.user_id, lot, s.amount, t, { circleId: c.id, slots: s.slots, fromAccount: reservedAcct(s.user_id) });
      q.run("UPDATE circle_slots SET status='converted' WHERE id=?", s.id);
    }
    q.run("UPDATE circles SET status='filled', filled_at=? WHERE id=?", t, c.id);
    if (lotRemaining(getLot(lot.id)!) === 0) q.run("UPDATE lots SET status='filled' WHERE id=? AND status='open'", lot.id);
    activity('circle_filled', null, { commodity: lot.commodity });
    for (const uid of circleMembers(c.id)) { const u = userById(uid); if (u) notify(u, 'circle_filled', { circle: c.name }, { link: `/app/circles/${c.id}`, sms: true }); }
    return getCircle(c.id)!;
  });
}

/** A Champion releases their own reservation while the circle is still filling. */
export function releaseSlots(user: User, circleId: number) {
  return tx(() => {
    const rows = q.all<any>("SELECT * FROM circle_slots WHERE circle_id=? AND user_id=? AND status='reserved'", circleId, user.id);
    for (const s of rows) {
      move('circle_release', reservedAcct(user.id), walletAcct(user.id), s.amount, { ref: `slot:${s.id}`, memo: 'Circle reservation released', userId: user.id });
      q.run("UPDATE circle_slots SET status='released' WHERE id=?", s.id);
    }
    return rows.length;
  });
}

/** Releases every reservation in circles past their deadline. Runs on the scheduler. */
export function expireCircles(by?: number) {
  let n = 0;
  for (const c of q.all<Circle>("SELECT * FROM circles WHERE status='filling' AND deadline <= ?", now())) {
    tx(() => {
      const members = circleMembers(c.id);
      for (const s of q.all<any>("SELECT * FROM circle_slots WHERE circle_id=? AND status='reserved'", c.id)) {
        move('circle_release', reservedAcct(s.user_id), walletAcct(s.user_id), s.amount, { ref: `slot:${s.id}`, memo: 'Circle expired', userId: s.user_id });
        q.run("UPDATE circle_slots SET status='released' WHERE id=?", s.id);
      }
      q.run("UPDATE circles SET status='expired' WHERE id=?", c.id);
      for (const uid of members) { const u = userById(uid); if (u) notify(u, 'circle_expired', { circle: c.name }, { link: '/app/wallet' }); }
      audit(by ?? null, 'circle.expired', `circle:${c.id}`);
    });
    n++;
  }
  return n;
}
