// Automated checks for the money logic and parsers. Runs on an in-memory database.
process.env.NO_AUTOSTART = '1';
process.env.RUN_SCHEDULER = 'false';
process.env.DATABASE_FILE = ':memory:';
process.env.PAYSTACK_SECRET_KEY = '';
import crypto from 'node:crypto';
import { openDb, q, now } from '../src/lib/db';
import { bootstrap } from '../src/lib/bootstrap';
import { createUser, userById } from '../src/lib/auth';
import { walletBalance, reservedBalance, trialBalance, balance } from '../src/lib/ledger';
import { confirmPayment, requestWithdrawal, approveWithdrawal, completeWithdrawal } from '../src/lib/wallet';
import { joinLot, getLot, payTrade, impactFor, rankFor, TradeError, rateFor, lotPeriods }  from '../src/lib/trading';
import { createCircle, takeSlots, expireCircles, getCircle } from '../src/lib/circles';
import { setSetting } from '../src/lib/settings';
import { earningsFor, addDays, hashPassword, verifyPassword } from '../src/lib/util';
import { totpCode, verifyTotp, newTotpSecret } from '../src/lib/totp';
import { parseSource, parseRobots, robotsAllows, recordPrice, latestPrices } from '../src/lib/prices';
import { encryptPayload } from '../src/lib/webpush';
import { translate, missingKeys, LANGS } from '../src/lib/i18n';
import en from '../src/locales/en';

let pass = 0, fail = 0;
async function t(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (e: any) { fail++; console.log(`  ✗ ${name}\n      ${e?.stack?.split('\n').slice(0, 3).join('\n      ') || e}`); }
}
function eq(a: unknown, b: unknown, msg = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function throws(fn: () => unknown, key?: string) {
  try { fn(); } catch (e: any) { if (key && e.key !== key && !String(e.message).includes(key)) throw new Error(`threw ${e.key || e.message}, expected ${key}`); return; }
  throw new Error('expected an error');
}

openDb(':memory:');
bootstrap();
const mkUser = (email: string, extra: Record<string, unknown> = {}) => {
  const id = createUser({ email, password: 'Passw0rd!', first_name: email.split('@')[0], last_name: 'Test', country: 'NG', lang: 'en' });
  q.run("UPDATE users SET email_verified_at=?, kyc_status='verified' WHERE id=?", now(), id);
  for (const [k, v] of Object.entries(extra)) q.run(`UPDATE users SET ${k}=? WHERE id=?`, v as any, id);
  return userById(id)!;
};
async function fund(uid: number, kobo: number) {
  const ref = `CTF-T-${crypto.randomUUID()}`;
  q.insert('payments', { user_id: uid, reference: ref, amount: kobo, fee: 0, status: 'pending', demo: 1, created_at: now() });
  await confirmPayment(ref, { demoSuccess: true });
  return ref;
}
const lotId = q.insert('lots', { code: 'T-1', commodity: 'soybean', title: 'Test lot', buyer_type: 'Mill', tonnage: 100, farmers: 50, target_amount: 1_000_000_00, min_commit: 100_000_00,
  period_months: 6, periods: '6', rate_bps: 2000, closes_at: addDays(now(), 10), status: 'open', circles_enabled: 1, created_at: now() }).id;

console.log('\nMoney');
await t('earnings are pro-rated: ₦1M for 12 months at 20% = ₦200,000', () => eq(earningsFor(100_000_000, 2000, 12), 20_000_000));
await t('₦1M for 4 months at 20% = ₦66,667', () => eq(earningsFor(100_000_000, 2000, 4), 6_666_667));
await t('rate card: 4m 20%, 6m 22.5%, 9m 26.25%, 12m 30% (longer pays more)', () => {
  eq(rateFor(4), 2000); eq(rateFor(6), 2250); eq(rateFor(9), 2625); eq(rateFor(12), 3000);
  eq(earningsFor(250_000_00, rateFor(12), 12), 75_000_00); eq(earningsFor(250_000_00, rateFor(6), 6), 28_125_00);
});
await t('a Champion chooses the period; the trade keeps that period and rate', async () => {
  const u = mkUser('period@t.ng'); await fund(u.id, 500_000_00);
  const lid = q.insert('lots', { code: 'T-PER', commodity: 'maize', title: 'Periods lot', buyer_type: 'Mill', tonnage: 10, farmers: 5, target_amount: 1_000_000_00, min_commit: 250_000_00,
    period_months: 12, periods: '4,6,9,12', rate_bps: 3000, closes_at: addDays(now(), 10), status: 'open', created_at: now() }).id;
  eq(lotPeriods(getLot(lid)!).join(','), '4,6,9,12');
  const a = joinLot(userById(u.id)!, lid, 250_000_00, { months: 4 });
  eq(a.period_months, 4); eq(a.rate_bps, 2000);
  const b = joinLot(userById(u.id)!, lid, 250_000_00);
  eq(b.period_months, 12, 'defaults to the longest'); eq(b.rate_bps, 3000);
  q.run("UPDATE lots SET periods='6,12' WHERE id=?", lid);
  await fund(u.id, 250_000_00);
  throws(() => joinLot(userById(u.id)!, lid, 250_000_00, { months: 9 }), 'lots.bad_period');
  q.run("UPDATE lots SET status='cancelled' WHERE id=?", lid);
});
await t('homepage figures: add mode includes activity, exact mode shows the typed number only', async () => {
  const { siteStats } = await import('../src/lib/trading');
  setSetting('baseline_champions', 1000);
  setSetting('figures_mode', 'exact'); eq(siteStats().champions, 1000);
  setSetting('figures_mode', 'add'); eq(siteStats().champions > 1000, true);
});
const ada = mkUser('ada@t.ng');
await t('funding credits the wallet exactly once (idempotent)', async () => {
  const ref = await fund(ada.id, 500_000_00);
  await confirmPayment(ref, { demoSuccess: true });
  eq(walletBalance(ada.id), 500_000_00);
});
await t('ledger stays balanced', () => eq(trialBalance(), 0));
await t('cannot join below the minimum', () => throws(() => joinLot(ada, lotId, 50_000_00), 'lots.too_small'));
await t('cannot join with more than the wallet holds', () => throws(() => joinLot(ada, lotId, 600_000_00), 'lots.need_funds'));
let tradeId = 0;
await t('joining moves money from wallet to the lot', () => {
  tradeId = joinLot(ada, lotId, 300_000_00).id;
  eq(walletBalance(ada.id), 200_000_00); eq(balance(`lot:${lotId}`), 300_000_00); eq(trialBalance(), 0);
});
await t('cannot pay a trade before it matures', () => throws(() => payTrade(tradeId, 1), 'not matured'));
await t('payout credits principal + earnings once', () => {
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -1), tradeId);
  payTrade(tradeId, 1); payTrade(tradeId, 1);
  eq(walletBalance(ada.id), 200_000_00 + 300_000_00 + earningsFor(300_000_00, rateFor(6), 6));
  eq(balance(`lot:${lotId}`), 0); eq(trialBalance(), 0);
});
await t('impact and rank are computed from tonnage moved', () => {
  const i = impactFor(ada.id); eq(Math.round(i.tons), 30); eq(rankFor(i.tons).rank, 'granary');
});

await t('a delayed payout keeps earning at the same rate for the extra days', async () => {
  const { delayLotPayouts } = await import('../src/lib/trading');
  const u = mkUser('late@t.ng'); await fund(u.id, 100_000_00);
  const lid = q.insert('lots', { code: 'T-LATE', commodity: 'maize', title: 'Late lot', buyer_type: 'Mill', tonnage: 10, farmers: 5, target_amount: 1_000_000_00, min_commit: 100_000_00,
    period_months: 12, periods: '12', rate_bps: 2000, closes_at: addDays(now(), 10), status: 'open', created_at: now() }).id;
  const tr = joinLot(userById(u.id)!, lid, 100_000_00);
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -1), tr.id);
  eq(delayLotPayouts(lid, addDays(now(), 29), 'Buyer asked for time', 1), 1);
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -0.5), tr.id);
  q.run('UPDATE trades SET original_matures_at=? WHERE id=?', addDays(now(), -30.5), tr.id);
  const paid = payTrade(tr.id, 1);
  eq(paid.earnings, earningsFor(100_000_00, rateFor(12), 12) + Math.round(100_000_00 * rateFor(12) * 30 / 3650000));
});

console.log('\nWithdrawals');
await t('withdrawal requires identity verification', () => {
  const u = mkUser('nokyc@t.ng', { kyc_status: 'none' });
  throws(() => requestWithdrawal(u, 10_000_00, null, 'manual'), 'wallet.kyc_needed');
});
await t('withdrawal holds funds, then pays out on success', async () => {
  const b = q.insert('bank_accounts', { user_id: ada.id, country: 'NG', bank_code: '058', bank_name: 'GTB', account_number: '0123456789', account_name: 'ADA TEST', recipient_code: 'RCP_demo', name_match: 1, created_at: now() }).id;
  const before = walletBalance(ada.id);
  const w = requestWithdrawal(ada, 50_000_00, b, 'paystack');
  eq(walletBalance(ada.id), before - 50_000_00); eq(reservedBalance(ada.id), 50_000_00);
  const r = await approveWithdrawal(w, 1);
  eq(r, 'paid'); eq(reservedBalance(ada.id), 0); eq(trialBalance(), 0);
});
await t('large withdrawals need two different admins', async () => {
  setSetting('dual_approval_threshold', 10_000_00);
  const b = q.val<number>('SELECT id FROM bank_accounts WHERE user_id=?', ada.id)!;
  const w = requestWithdrawal(ada, 20_000_00, b, 'paystack');
  eq(await approveWithdrawal(w, 1), 'awaiting_second');
  let blocked = false; try { await approveWithdrawal(w, 1); } catch { blocked = true; }
  eq(blocked, true, 'same admin twice');
  eq(await approveWithdrawal(w, 2), 'paid');
  setSetting('dual_approval_threshold', 500_000_000);
});
await t('a failed transfer returns the money to the wallet', () => {
  const b = q.val<number>('SELECT id FROM bank_accounts WHERE user_id=?', ada.id)!;
  const before = walletBalance(ada.id);
  const w = requestWithdrawal(ada, 10_000_00, b, 'paystack');
  const ref = q.val<string>('SELECT reference FROM withdrawals WHERE id=?', w)!;
  completeWithdrawal(ref, false, 'transfer.failed'); completeWithdrawal(ref, false);
  eq(walletBalance(ada.id), before); eq(reservedBalance(ada.id), 0);
});

console.log('\nHarvest Circles');
const lot2 = q.insert('lots', { code: 'T-2', commodity: 'maize', title: 'Circle lot', buyer_type: 'Mill', tonnage: 10, farmers: 5, target_amount: 1_000_000_00, min_commit: 100_000_00,
  period_months: 4, periods: '4', rate_bps: 2000, closes_at: addDays(now(), 30), status: 'open', circles_enabled: 1, created_at: now() }).id;
const members = await Promise.all([1, 2, 3, 4, 5].map(async (i) => { const u = mkUser(`m${i}@t.ng`); await fund(u.id, 100_000_00); return u; }));
await t('slots are reserved, not spent, while the circle fills', () => {
  const ci = createCircle({ lotId: lot2, name: 'Test Circle', slots: 5, slotPrice: 10_000_00, creatorId: null, isPrivate: false, maxSharePct: 40 });
  takeSlots(members[0], ci.id, 2);
  eq(reservedBalance(members[0].id), 20_000_00); eq(walletBalance(members[0].id), 80_000_00);
  eq(getCircle(ci.id)!.taken, 2);
});
await t('one Champion cannot exceed the share cap', () => throws(() => takeSlots(members[0], 1, 1), 'circles.max'));
await t('when the last slot is taken, every reservation becomes a trade on the same day', () => {
  takeSlots(members[1], 1, 2);
  const ci = takeSlots(members[2], 1, 1);
  eq(ci.status, 'filled');
  const trades = q.all<any>('SELECT * FROM trades WHERE circle_id=1');
  eq(trades.length, 3); eq(new Set(trades.map((x) => x.start_at)).size, 1);
  eq(reservedBalance(members[0].id), 0); eq(balance(`lot:${lot2}`), 50_000_00); eq(trialBalance(), 0);
});
await t('an unfilled circle releases funds at its deadline', () => {
  const ci = createCircle({ lotId: lot2, name: 'Slow Circle', slots: 10, slotPrice: 10_000_00, creatorId: null, isPrivate: true });
  takeSlots(members[3], ci.id, 3);
  q.run('UPDATE circles SET deadline=? WHERE id=?', addDays(now(), -1), ci.id);
  eq(expireCircles(), 1);
  eq(walletBalance(members[3].id), 100_000_00); eq(reservedBalance(members[3].id), 0); eq(getCircle(ci.id)!.status, 'expired');
});
await t('lot funding counts reservations so lots cannot be oversold', () => {
  const l = getLot(lot2)!; eq(l.funded, 50_000_00);
});

console.log('\nReferrals');
await t('referrer is rewarded once, when the friend funds a first trade', async () => {
  const ref = mkUser('referrer@t.ng');
  const friend = mkUser('friend@t.ng', { referred_by: ref.id });
  await fund(friend.id, 200_000_00);
  joinLot(userById(friend.id)!, lot2, 100_000_00);
  joinLot(userById(friend.id)!, lot2, 100_000_00);
  eq(walletBalance(ref.id), 5_000_00);
});

console.log('\nSecurity');
await t('passwords are hashed and verified', () => { const h = hashPassword('S3cret!pw'); eq(verifyPassword('S3cret!pw', h), true); eq(verifyPassword('nope', h), false); });
await t('TOTP codes verify within the time window', () => { const s = newTotpSecret(); eq(verifyTotp(s, totpCode(s)), true); eq(verifyTotp(s, '000000') && totpCode(s) !== '000000', false); });
await t('RFC 6238 test vector', () => eq(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000).slice(-6), '287082'));
await t('web push payload encrypts to the aes128gcm layout', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const out = encryptPayload(Buffer.from('{"title":"x"}'), ua.getPublicKey().toString('base64url'), auth.toString('base64url'));
  eq(out.readUInt32BE(16), 4096); eq(out[20], 65); eq(out.length, 16 + 4 + 1 + 65 + 14 + 16);
});

console.log('\nPrices');
await t('commodity.ng table parser converts 50 kg bag prices to per kg', () => {
  const html = '<table><tr><th>Grains</th><th>Price of 50kg</th></tr><tr><td>Rice</td><td>58,000</td><td>2,400</td></tr><tr><td>Maize</td><td>33,000</td></tr><tr><td>Garri</td><td>31,000</td></tr></table>';
  const r = parseSource('table', html, { label_col: 0, price_col: 1, unit_kg: 50, aliases: { Rice: 'rice', Maize: 'maize' } });
  eq(r.map((x) => [x.commodity, x.perKgNaira]), [['rice', 1160], ['maize', 660]]);
});
await t('NCX pattern parser averages markets per commodity', () => {
  const html = '<h3>Maize White (MZWKAN) <b>₦305.00</b> 22%</h3><h3>Maize White (MZWKAD) <b>₦273.00</b> 12%</h3><h3>Soya (SOYKAD) **₦695.00**</h3>';
  const r = parseSource('pattern_all', html, { regex: '(?<name>Maize White|Soya)\\s*\\((?<code>[A-Z]{5,7})\\)\\s*₦\\s*(?<price>[\\d,]+(?:\\.\\d+)?)', aliases: { 'Maize White': 'maize', Soya: 'soybean' }, markets: { KAN: 'Kano', KAD: 'Kaduna' } });
  eq(r.find((x) => x.commodity === 'maize')!.perKgNaira, 289); eq(r.find((x) => x.commodity === 'soybean')!.perKgNaira, 695);
});
await t('robots.txt rules are honoured', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
  eq(robotsAllows(rules, '/live-prices/'), true); eq(robotsAllows(rules, '/private/x'), false); eq(robotsAllows(rules, '/private/ok'), true);
});
await t('large crawled moves are held; manual prices publish and lead the ticker', () => {
  recordPrice({ commodity: 'sesame', pricePerKg: 150000, sourceName: 'X', force: true });
  const r = recordPrice({ commodity: 'sesame', pricePerKg: 300000, sourceName: 'X' })!;
  eq(r.held, true);
  recordPrice({ commodity: 'sesame', pricePerKg: 155000, sourceName: 'Kitovu', force: true });
  eq(latestPrices().find((p) => p.commodity === 'sesame')!.source_name, 'Kitovu');
});

console.log('\nPayouts, Keep Growing and treasury');
const { autoPayDue, processRollovers, pickRolloverLot } = await import('../src/lib/trading');
const { coverage, receivables } = await import('../src/lib/treasury');
const mkLot = (code: string, o: Record<string, unknown> = {}) => q.insert('lots', { code, commodity: 'soybean', title: `Lot ${code}`, buyer_type: 'Mill', tonnage: 20, farmers: 10, target_amount: 2_000_000_00, min_commit: 100_000_00,
  period_months: 6, periods: '6', rate_bps: 2000, closes_at: addDays(now(), 20), status: 'open', created_at: now(), ...o }).id;
await t('matured trades are credited automatically on the payout date', async () => {
  const u = mkUser('auto@t.ng'); await fund(u.id, 200_000_00);
  const lid = mkLot('AUTO-1');
  const tr = joinLot(userById(u.id)!, lid, 200_000_00);
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -0.01), tr.id);
  eq(autoPayDue() >= 1, true);
  eq(q.val('SELECT status FROM trades WHERE id=?', tr.id), 'paid');
  eq(walletBalance(u.id), 200_000_00 + earningsFor(200_000_00, rateFor(6), 6)); eq(trialBalance(), 0);
});
await t('Keep Growing re-commits principal + earnings into an open lot of the same commodity', async () => {
  const u = mkUser('grow@t.ng'); await fund(u.id, 300_000_00);
  const a = mkLot('GROW-A'); mkLot('GROW-B', { commodity: 'maize' });
  const tr = joinLot(userById(u.id)!, a, 300_000_00, { rollover: 'all' });
  q.run("UPDATE lots SET status='active' WHERE id=?", a);
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -0.01), tr.id);
  autoPayDue();
  const target = mkLot('GROW-C');
  eq(processRollovers() >= 1, true);
  const next = q.get<any>('SELECT * FROM trades WHERE user_id=? AND id!=? ORDER BY id DESC', u.id, tr.id)!;
  eq(next.lot_id, target, 'same commodity first'); eq(next.amount, 300_000_00 + earningsFor(300_000_00, rateFor(6), 6)); eq(walletBalance(u.id), 0); eq(trialBalance(), 0);
});
await t('Keep Growing with principal only leaves earnings in the wallet', async () => {
  const u = mkUser('grow2@t.ng'); await fund(u.id, 100_000_00);
  const a = mkLot('GROW-D');
  const tr = joinLot(userById(u.id)!, a, 100_000_00, { rollover: 'principal' });
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -0.01), tr.id);
  autoPayDue(); processRollovers();
  eq(walletBalance(u.id), earningsFor(100_000_00, rateFor(6), 6));
});
await t('rollover lot picker respects the lot minimum', () => {
  eq(pickRolloverLot(50_00), null);
});
await t('treasury coverage compares payouts due with cash, credit line and buyer money', () => {
  const lid = mkLot('TRE-1', { buyer_amount: 3_000_000_00, buyer_due_at: addDays(now(), 10) });
  const c30 = coverage(30);
  eq(c30.level === 'unknown' || c30.level === 'ok', true);
  q.insert('cash_positions', { amount: 1_00, credit_line: 0, as_of: now(), created_at: now() });
  q.insert('buyer_payments', { lot_id: lid, amount: 1_000_000_00, received_at: now(), created_at: now() });
  const r = receivables().find((x) => x.id === lid)!;
  eq(r.outstanding, 2_000_000_00);
  q.run('UPDATE lots SET buyer_due_at=? WHERE id=?', addDays(now(), -3), lid);
  eq(receivables().find((x) => x.id === lid)!.overdue, true);
});

console.log('\nHarvest Plan');
const plans = await import('../src/lib/plans');
await t('a plan saves the card on the first payment and joins a lot at the target', async () => {
  const u = mkUser('plan@t.ng');
  const { id } = await plans.createPlan(userById(u.id)!, { name: 'Test plan', target: 200_000_00, monthly: 100_000_00, day: 5, commodity: 'soybean' });
  const ref = q.val<string>('SELECT reference FROM payments WHERE plan_id=?', id)!;
  await confirmPayment(ref, { demoSuccess: true });
  let p = plans.getPlan(id)!;
  eq(p.status, 'active'); eq(!!p.authorization_code, true); eq(plans.planSaved(p), 100_000_00); eq(walletBalance(u.id), 0);
  q.run('UPDATE plans SET next_charge_at=? WHERE id=?', addDays(now(), -0.01), id);
  await plans.runPlans();
  p = plans.getPlan(id)!;
  eq(p.status, 'completed'); eq(plans.planSaved(p), 0);
  eq(q.val('SELECT amount FROM trades WHERE id=?', p.trade_id), 200_000_00); eq(trialBalance(), 0);
});
await t('plan savings can be moved to the wallet; plan accounts never go negative', async () => {
  const u = mkUser('plan2@t.ng');
  const { id } = await plans.createPlan(userById(u.id)!, { name: 'P2', target: 1_000_000_00, monthly: 100_000_00, day: 1 });
  await confirmPayment(q.val<string>('SELECT reference FROM payments WHERE plan_id=?', id)!, { demoSuccess: true });
  eq(plans.releasePlanSavings(userById(u.id)!, id, true), 100_000_00);
  eq(walletBalance(u.id), 100_000_00); eq(plans.getPlan(id)!.status, 'cancelled'); eq(trialBalance(), 0);
});
await t('plan validation: minimum monthly amount', async () => {
  let key = ''; try { await plans.createPlan(userById(ada.id)!, { name: 'x', target: 100_000_00, monthly: 1_000_00, day: 1 }); } catch (e: any) { key = e.key; }
  eq(key, 'plan.min_monthly');
});

console.log('\nGift a Harvest');
const gifts = await import('../src/lib/gifts');
await t('a gift creates a trade that moves to the recipient when claimed', async () => {
  const giver = mkUser('giver@t.ng'); await fund(giver.id, 100_000_00);
  const lid = mkLot('GIFT-1');
  const g = gifts.createGift(userById(giver.id)!, { lotId: lid, amount: 100_000_00, recipientName: 'Mama', recipientEmail: 'mama@t.ng' });
  eq(q.val('SELECT user_id FROM trades WHERE id=?', g.trade.id), giver.id);
  const mama = mkUser('mama@t.ng');
  const token = g.url.split('/gift/')[1];
  throws(() => gifts.claimGift(userById(giver.id)!, token), 'gift.self');
  eq(gifts.claimGift(userById(mama.id)!, token), g.trade.id);
  eq(q.val('SELECT user_id FROM trades WHERE id=?', g.trade.id), mama.id);
  throws(() => gifts.claimGift(userById(mama.id)!, token), 'gift.invalid');
});

console.log('\nAccount rights');
const account = await import('../src/lib/account');
await t('account closure is blocked while money is on the platform', () => {
  eq(account.closureBlockers(ada.id).includes('close.wallet'), true);
});
await t('an empty account closes and cannot sign in', () => {
  const u = mkUser('leaver@t.ng');
  account.closeAccount(userById(u.id)!, 'test');
  eq(userById(u.id)!.status, 'closed');
});
await t('data export leaves out secrets', () => {
  const d = account.exportUserData(ada.id);
  eq('password_hash' in (d.profile as any), false); eq(Array.isArray(d.trades), true);
});
await t('annual statement adds up', () => {
  const s = account.statementData(ada.id, new Date().getUTCFullYear());
  eq(s.closing, walletBalance(ada.id)); eq(s.earnings > 0, true);
});
await t('CSV import creates users and pending opening-balance adjustments', () => {
  const rows = account.parseCsv('first_name,last_name,email,opening_balance\n"Ngozi","Okafor",ngozi@t.ng,"250,000"\nBad,,nope,\n');
  const r = account.importUsers(rows, 1, { sendInvites: true });
  eq(r.created, 1); eq(r.skipped.length, 1); eq(r.balances, 1);
  eq(q.val("SELECT amount FROM adjustments WHERE reason LIKE 'Opening balance%' ORDER BY id DESC"), 250_000_00);
});

console.log('\nAgents and WhatsApp');
const agents = await import('../src/lib/agents');
const wa = await import('../src/lib/whatsapp');
await t('support agent (demo) answers from the FAQs and hands over money questions', async () => {
  const a = await agents.supportAnswer(null, 'What happens if a buyer pays late?', 'en', 'test');
  eq(a.escalate, false); eq(a.reply.includes('balance sheet'), true);
  const b = await agents.supportAnswer(null, 'My withdrawal is missing', 'en', 'test');
  eq(b.escalate, true);
});
await t('agent actions wait for review unless low risk and autonomy allows', () => {
  const id = agents.propose({ agent: 'onboarding', kind: 'send_message', risk: 'low', title: 't', payload: { user_id: ada.id, title: 'Hi', body: 'Hello' } });
  eq(q.val('SELECT status FROM agent_actions WHERE id=?', id), 'proposed');
  setSetting('agent_autonomy', 'auto_low');
  const id2 = agents.propose({ agent: 'onboarding', kind: 'send_message', risk: 'low', title: 't', payload: { user_id: ada.id, title: 'Hi', body: 'Hello' } });
  eq(q.val('SELECT status FROM agent_actions WHERE id=?', id2), 'auto');
  const id3 = agents.propose({ agent: 'ops', kind: 'trail_update', risk: 'medium', title: 't', payload: { lot_id: lotId, stage: 'sourcing', note: 'x' } });
  eq(q.val('SELECT status FROM agent_actions WHERE id=?', id3), 'proposed');
  setSetting('agent_autonomy', 'review');
  agents.rejectAction(id3, 1);
  eq(q.val('SELECT status FROM agent_actions WHERE id=?', id3), 'rejected');
});
await t('agents have no executor that moves money', () => {
  for (const k of agents.ACTION_KINDS) if (/pay|withdraw|transfer|credit|adjust|refund/.test(k)) throw new Error(`unexpected money action ${k}`);
});
await t('treasury, onboarding, risk and growth agents run in demo mode', async () => {
  for (const name of ['treasury', 'onboarding', 'risk', 'growth']) { const r = await agents.AGENT_JOBS[name](); if (String(r).startsWith('error')) throw new Error(`${name}: ${r}`); }
  eq(Number(q.val("SELECT COUNT(*) FROM agent_actions WHERE agent='treasury'")) >= 1, true);
});
await t('WhatsApp: unknown numbers are told to sign up; verified Champions get their balance', async () => {
  const r1 = await wa.handleInbound('2348000000000', 'hi', 'wamid.1');
  eq(r1.includes('/signup'), true);
  q.run("UPDATE users SET phone='+2348031112222', phone_verified_at=? WHERE id=?", now(), ada.id);
  const r2 = await wa.handleInbound('2348031112222', '1', 'wamid.2');
  eq(r2.includes(fmtTest(walletBalance(ada.id))), true);
  eq(await wa.handleInbound('2348031112222', '1', 'wamid.2'), '', 'duplicate webhook ignored');
});
await t('live Claude path: request shape, JSON reply, run logged with tokens', async () => {
  const { config } = await import('../src/lib/config');
  const realFetch = globalThis.fetch; const old = config.anthropicKey;
  let sent: any = null;
  (config as any).anthropicKey = 'test-key';
  globalThis.fetch = (async (url: string, init: any) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '```json\n{"reply":"Kitovu pays you on time.","escalate":false,"reason":"faq"}\n```' }], usage: { input_tokens: 900, output_tokens: 40 } }), { status: 200 });
  }) as any;
  try {
    const r = await agents.supportAnswer(userById(ada.id)!, 'Will I be paid if the buyer is late?', 'en', 'test-live');
    eq(r.reply, 'Kitovu pays you on time.'); eq(r.escalate, false);
    eq(sent.url, 'https://api.anthropic.com/v1/messages'); eq(sent.headers['anthropic-version'], '2023-06-01'); eq(sent.body.model, config.aiModelFast);
    eq(String(sent.body.system).includes('balance sheet'), true);
    eq(JSON.stringify(sent.body).includes('password_hash'), false, 'no secrets sent');
    eq(q.val("SELECT tokens_in FROM agent_runs WHERE trigger='test-live'"), 900);
  } finally { globalThis.fetch = realFetch; (config as any).anthropicKey = old; }
});
function fmtTest(k: number) { return `₦${new Intl.NumberFormat('en-NG').format(k / 100)}`; }

console.log('\nLanguages');
for (const l of LANGS) await t(`${l.label}: every key translated`, () => { const m = missingKeys(l.code); if (m.length) throw new Error(`${m.length} missing, e.g. ${m.slice(0, 5).join(', ')}`); });
await t('placeholders survive translation', () => {
  for (const l of LANGS) for (const k of Object.keys(en)) {
    const need = (String((en as any)[k]).match(/\{\w+\}/g) || []).sort().join();
    const got = (translate(l.code, k).match(/\{\w+\}/g) || []).sort().join();
    if (need !== got) throw new Error(`${l.code} ${k}: ${got} vs ${need}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
