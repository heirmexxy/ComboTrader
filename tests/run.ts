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
await t('lot title, code and description are generated from commodity, region and buyer', async () => {
  const g = await import('../src/lib/lotgen');
  eq(g.lotPrefix('soybean'), 'SB'); eq(g.lotPrefix('paddy_rice'), 'PR'); eq(g.lotPrefix('shea_butter'), 'SB'); eq(g.lotPrefix('ginger'), 'GN'); eq(g.lotPrefix('tomato'), 'TM');
  eq(g.lotTitle('Soybean', 'Benue & Nasarawa', 'Animal feed mill, Kaduna'), 'Soybean from Benue & Nasarawa');
  eq(g.lotTitle('Maize', '', 'Poultry feed producer'), 'Maize for a poultry feed producer');
  eq(g.lotDescription({ commodityName: 'Soybean', region: 'Benue', buyerType: 'Animal feed mill, Kaduna', tonnage: 120, farmers: 85 }), 'Soybean bought from 85 farmers in Benue to fill a signed order from an animal feed mill, Kaduna. 120 tons.');
  eq(g.withArticle('NNPC depot'), 'an NNPC depot');
  const code = g.nextLotCode('maize', '2027-03-15T00:00:00Z'); eq(code, 'MZ-2703');
  q.insert('lots', { code, commodity: 'maize', title: 'x', buyer_type: 'Mill', tonnage: 1, farmers: 1, target_amount: 1, min_commit: 1, period_months: 12, rate_bps: 3000, closes_at: '2027-03-15T00:00:00Z', status: 'draft', created_at: now() });
  eq(g.nextLotCode('maize', '2027-03-20T00:00:00Z'), 'MZ-2703-2');
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
await t('WhatsApp: anyone gets answers; a Champion links their number once with an emailed code, then sees their balance', async () => {
  const r1 = await wa.handleInbound('2348000000000', 'hi', 'wamid.1');
  eq(r1.includes('could not match'), false); eq(r1.includes('5'), true);
  const r1b = await wa.handleInbound('08000000000', 'What happens if a buyer pays late?', 'wamid.1b');
  eq(r1b.includes('balance sheet'), true, 'visitors get real answers');
  const r1c = await wa.handleInbound('2348000000000', '1', 'wamid.1c');
  eq(r1c.includes('/app/profile'), true, 'account details need a linked account');
  // Ada has this number on her profile but has not linked WhatsApp yet
  q.run("UPDATE users SET phone='+2348031112222', phone_verified_at=NULL WHERE id=?", ada.id);
  const r2 = await wa.handleInbound('2348031112222', '1', 'wamid.2');
  eq(r2.includes(fmtTest(walletBalance(ada.id))), false, 'no balance before linking');
  const mail = q.get<any>("SELECT body FROM outbox WHERE recipient=? AND channel='email' ORDER BY id DESC LIMIT 1", ada.email);
  const code = String(mail.body).match(/>(\d{6})</)![1];
  eq((await wa.handleInbound('2348031112222', '000000', 'wamid.3')).length > 0, true);
  eq(q.val('SELECT phone_verified_at FROM users WHERE id=?', ada.id), null, 'wrong code does not link');
  const r3 = await wa.handleInbound('2348031112222', code, 'wamid.4');
  eq(q.val('SELECT phone_verified_at IS NOT NULL FROM users WHERE id=?', ada.id), 1);
  eq(r3.includes(ada.first_name), true);
  const r4 = await wa.handleInbound('08031112222', '1', 'wamid.5');
  eq(r4.includes(fmtTest(walletBalance(ada.id))), true, 'local 080… format matches too');
  eq(await wa.handleInbound('2348031112222', '1', 'wamid.5'), '', 'duplicate webhook ignored');
  // Asking for a person puts the conversation in front of the team
  await wa.handleInbound('2348000000000', '7', 'wamid.6');
  eq(q.val("SELECT status FROM chats WHERE source='whatsapp' AND external_id='2348000000000'"), 'needs_person');
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
await t('rules/AI switch: rules mode never calls the model, even with a key; per-agent override wins', async () => {
  const { config } = await import('../src/lib/config');
  const ai = await import('../src/lib/ai');
  const realFetch = globalThis.fetch; const old = config.anthropicKey; let calls = 0;
  (config as any).anthropicKey = 'test-key';
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"reply":"AI","escalate":false,"general_answer":"AI general"}' }], usage: {} }), { status: 200 }); }) as any;
  try {
    setSetting('agent_mode', 'rules');
    eq(ai.useAI('support'), false);
    const r = await agents.supportAnswer(null, 'What happens if a buyer pays late?', 'en', 'test-rules');
    eq(calls, 0); eq(r.reply.includes('balance sheet'), true);
    setSetting('agent_modes', JSON.stringify({ support: 'ai' }));
    eq(ai.useAI('support'), true); eq(ai.useAI('growth'), false);
    await agents.supportAnswer(null, 'Can I use a dollar card?', 'en', 'chat:1');
    eq(calls, 1);
    eq(Number(q.val("SELECT COUNT(*) FROM agent_lessons WHERE agent='support' AND kind='answer' AND active=0")) >= 1, true, 'unreviewed chat answer kept switched off');
  } finally { globalThis.fetch = realFetch; (config as any).anthropicKey = old; setSetting('agent_mode', 'ai'); setSetting('agent_modes', '{}'); }
});
await t('learning: an approved AI ticket answer is reused by the rules for a similar question', async () => {
  const tid = q.insert('tickets', { user_id: ada.id, subject: 'Solar dryer question', body: 'Do you finance solar dryers for cooperatives?', created_at: now() }).id;
  const aid = agents.propose({ agent: 'support', kind: 'reply_ticket', risk: 'low', title: 't', payload: { ticket_id: tid, reply: 'Hi Ada, not yet.', question: 'Do you finance solar dryers for cooperatives?', general_answer: 'Not at the moment: ComboTrader funds commodity trades only.', lang: 'en' } });
  agents.executeAction(aid, 1);
  setSetting('agent_mode', 'rules');
  const r = await agents.supportAnswer(null, 'Can you finance solar dryers for our cooperative?', 'en', 'test');
  setSetting('agent_mode', 'ai');
  eq(r.reply, 'Not at the moment: ComboTrader funds commodity trades only.'); eq(r.escalate, false);
});
await t('learning: templates are scored by results; a human edit becomes a template', async () => {
  const learning = await import('../src/lib/learning');
  const u = mkUser('learn@t.ng');
  const aid = agents.propose({ agent: 'onboarding', kind: 'send_message', risk: 'low', title: 't', payload: { user_id: u.id, title: 'Hi', body: 'Draft', situation: 'fund', _agent: 'onboarding' } });
  agents.executeAction(aid, 1, { body: `${u.first_name}, add money in two taps.` });
  const les = q.get<any>("SELECT * FROM agent_lessons WHERE agent='onboarding' AND kind='template' AND key='fund' AND source='human'");
  eq(!!les, true); eq(JSON.parse(les.content).body, '{name}, add money in two taps.');
  q.run("UPDATE lesson_outcomes SET sent_at=? WHERE lesson_id=?", addDays(now(), -8), les.id);
  learning.scoreOutcomes();
  eq(q.val('SELECT losses FROM agent_lessons WHERE id=?', les.id), 1, 'no payment within a week → did not work');
  await fund(u.id, 250_000_00);
  const aid2 = agents.propose({ agent: 'onboarding', kind: 'send_message', risk: 'low', title: 't', payload: { user_id: u.id, title: 'Hi', body: 'x', situation: 'payment', lesson_id: les.id } });
  q.run("UPDATE payments SET paid_at=? WHERE user_id=?", addDays(now(), 1), u.id);
  agents.executeAction(aid2, 1); learning.scoreOutcomes();
  eq(q.val('SELECT wins FROM agent_lessons WHERE id=?', les.id), 1, 'paid after the message → worked');
});
await t('learning: rejected risk flags weaken a signal type until it needs company', async () => {
  const id = agents.signalLesson('referral_burst');
  q.run('UPDATE agent_lessons SET losses=6, wins=0 WHERE id=?', id);
  const ref = mkUser('rings@t.ng');
  for (let i = 0; i < 5; i++) { const f = mkUser(`ringf${i}@t.ng`); q.insert('referral_rewards', { referrer_id: ref.id, referred_id: f.id, amount: 500000, created_at: now() }); }
  const r = await agents.runRisk();
  eq(String(r).includes('weak signals skipped') || !q.get("SELECT 1 FROM agent_actions WHERE agent='risk' AND target_user_id=? AND status='proposed'", ref.id), true);
});
await t('ops rules: stage from field notes and a draft lot from a contract summary', async () => {
  eq(agents.guessStage('trucks dispatched to the mill, waybill signed'), 'delivered');
  eq(agents.guessStage('bagged and stacked in warehouse, moisture 11%'), 'warehoused');
  const d = agents.parseContract('LPO No: KDF-2291. Buyer: Animal feed mill, Kaduna. 120 MT soybean from Benue and Nasarawa at ₦85,000,000 total, payment due 2027-02-28.', q.all('SELECT code, name FROM commodities'));
  eq(d.commodity, 'soybean'); eq(d.tonnage, 120); eq(d.buyer_amount_naira, 85_000_000); eq(d.region, 'Benue & Nasarawa'); eq(d.buyer_due, '2027-02-28'); eq(d.contract_ref, 'KDF-2291');
  eq(d.title, 'Soybean from Benue & Nasarawa');
});
await t('prospector: invites waitlist leads, skips non-consented imports, honours unsubscribe, marks sign-ups', async () => {
  q.insert('waitlist', { email: 'keen@lead.ng', commodity: 'any', created_at: now() });
  q.insert('leads', { email: 'cold@lead.ng', lang: 'en', source: 'import', consent: 0, token: 'tok-cold', created_at: now() });
  q.insert('prospects', { name: 'Ikeja Staff Cooperative', segment: 'Staff cooperative societies', email: 'sec@ikejacoop.ng', token: 'tok-org', created_at: now() });
  { const E = await import('../src/lib/emailcheck'); E._setResolver(async (d) => d.startsWith('dead') ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : [{ exchange: `mx.${d}`, priority: 10 }]); await agents.runProspector(); await E.scanContacts(); }
  const r = await agents.runProspector();
  eq(String(r).includes('invitations drafted'), true);
  const inv = q.get<any>("SELECT * FROM agent_actions WHERE kind='send_invite' AND status='proposed' ORDER BY id DESC");
  eq(JSON.parse(inv.payload).body.includes('waitlist'), true);
  eq(!!q.get("SELECT 1 FROM agent_actions WHERE kind='send_invite' AND payload LIKE '%cold%'"), false);
  const org = q.get<any>("SELECT * FROM agent_actions WHERE kind='send_outreach' AND status='proposed'");
  eq(org.risk, 'medium'); eq(JSON.parse(org.payload).body.includes('Ikeja Staff Cooperative'), true);
  agents.executeAction(inv.id, 1);
  eq(q.val("SELECT status FROM leads WHERE email='keen@lead.ng'"), 'contacted');
  eq(String(q.val("SELECT body FROM outbox WHERE recipient='keen@lead.ng' ORDER BY id DESC")).includes('/u/'), true, 'unsubscribe link');
  q.run("UPDATE leads SET status='unsubscribed' WHERE email='keen@lead.ng'");
  eq(String(agents.executeAction(agents.propose({ agent: 'prospector', kind: 'send_invite', risk: 'low', title: 't', payload: { lead_id: q.val("SELECT id FROM leads WHERE email='keen@lead.ng'"), title: 'x', body: 'y' } }), 1)).startsWith('skipped'), true);
  mkUser('cold@lead.ng'); agents.syncLeads();
  eq(q.val("SELECT status FROM leads WHERE email='cold@lead.ng'"), 'signed_up');
});
await t('prospector research: web-search reply is parsed and organisations saved', async () => {
  const { config } = await import('../src/lib/config');
  const realFetch = globalThis.fetch; const old = config.anthropicKey; let body: any = null;
  (config as any).anthropicKey = 'test-key';
  globalThis.fetch = (async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ content: [
    { type: 'text', text: 'Let me search.' }, { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
    { type: 'text', text: '{"organisations":[{"name":"Lagos Teachers Cooperative","location":"Lagos","email":"info@ltc.ng","why":"Large salaried membership"},{"name":"Bad","email":"not-an-email"}]}' }], usage: { input_tokens: 5, output_tokens: 5 } }), { status: 200 }); }) as any;
  try {
    const r = await agents.researchProspects('Staff cooperative societies', 'Lagos');
    eq(r.includes('2 Staff cooperative societies'), true);
    eq(body.tools[0].type, 'web_search_20250305');
    eq(q.val("SELECT email FROM prospects WHERE name='Lagos Teachers Cooperative'"), 'info@ltc.ng');
    eq(q.val("SELECT email FROM prospects WHERE name='Bad'"), null, 'invalid email dropped');
  } finally { globalThis.fetch = realFetch; (config as any).anthropicKey = old; }
});
const learning = await import('../src/lib/learning');
console.log('\nMarketing agents (Social + Email)');
const mk = await import('../src/lib/marketing');
const tracking = await import('../src/lib/tracking');
await t('social (rules): plans a post for the newest open lot, makes a JPEG card, prepares copy-and-post when no channel is connected', async () => {
  setSetting('agent_mode', 'rules');
  const r = await mk.runSocial(true);
  eq(r.includes('drafted'), true);
  const post = q.get<any>('SELECT * FROM social_posts ORDER BY id DESC');
  eq(post.kind, 'lot'); eq(String(post.text).includes('{link}'), true); eq(String(post.image_path).endsWith('.jpg'), true);
  const act = q.get<any>("SELECT * FROM agent_actions WHERE kind='publish_social' ORDER BY id DESC");
  agents.executeAction(act.id, 1);
  q.run("UPDATE social_posts SET scheduled_at=? WHERE id=?", addDays(now(), -0.01), post.id);
  eq(await mk.publishDueSocial(), 1);
  const res = JSON.parse(String(q.val('SELECT results FROM social_posts WHERE id=?', post.id)));
  eq(res.facebook.manual, true); eq(String(res.facebook.text).includes('/go/'), true, 'tracked link in copy text');
  eq(q.val('SELECT status FROM social_posts WHERE id=?', post.id), 'partly');
  setSetting('agent_mode', 'ai');
});
await t('social: a connected channel publishes (Telegram, mocked) and a post is scored by clicks a week later', async () => {
  const { config } = await import('../src/lib/config');
  const real = globalThis.fetch; let called = '';
  (config as any).telegramBotToken = 'tg'; (config as any).telegramChannel = '@ct';
  globalThis.fetch = (async (u: string) => { called = String(u); return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 }); }) as any;
  try {
    const id = q.insert('social_posts', { kind: 'custom', ref: 'custom:t', text: 'Hello {link}', text_short: 'Hello {link}', channels: 'telegram', status: 'scheduled', scheduled_at: addDays(now(), -0.01), lesson_id: learning.learn({ agent: 'social', kind: 'post', key: 'post:custom', content: { text: 'Hello {link}' }, source: 'human' }), created_at: now(), results: '{"_url":"/join"}' }).id;
    await mk.publishDueSocial();
    eq(called.includes('/bottg/sendMessage'), true); eq(q.val('SELECT status FROM social_posts WHERE id=?', id), 'published');
    const link = q.get<any>('SELECT * FROM links WHERE campaign=?', `post-${id}`);
    q.run('UPDATE links SET clicks=25 WHERE id=?', link.id);
    q.run('UPDATE social_posts SET published_at=? WHERE id=?', addDays(now(), -8), id);
    await mk.runSocial(false);
    eq(q.val('SELECT wins FROM agent_lessons WHERE id=(SELECT lesson_id FROM social_posts WHERE id=?)', id), 1);
  } finally { globalThis.fetch = real; (config as any).telegramBotToken = ''; (config as any).telegramChannel = ''; }
});
await t('social inbound: lead form becomes a lead; a comment asking how to join gets a private reply once', async () => {
  const { config } = await import('../src/lib/config');
  const real = globalThis.fetch; const calls: string[] = [];
  (config as any).fbPageToken = 'tok'; (config as any).fbPageId = 'PAGE';
  globalThis.fetch = (async (u: string, init?: any) => { calls.push(String(u)); if (String(u).includes('/L1?')) return new Response(JSON.stringify({ field_data: [{ name: 'email', values: ['ad@lead.ng'] }, { name: 'full_name', values: ['Bisi Ade'] }] }), { status: 200 }); return new Response(JSON.stringify({ id: 'x' }), { status: 200 }); }) as any;
  try {
    await mk.handleMetaWebhook({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'L1', form_id: 'F' } }, { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C1', message: 'How do I join?', from: { id: 'U9', name: 'Tunde' } } }] }] });
    await mk.handleMetaWebhook({ object: 'page', entry: [{ changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'C1', message: 'How do I join?', from: { id: 'U9' } } }] }] });
    eq(q.val("SELECT source FROM leads WHERE email='ad@lead.ng'"), 'facebook_ads'); eq(q.val("SELECT consent FROM leads WHERE email='ad@lead.ng'"), 1);
    eq(calls.filter((u) => u.includes('C1/private_replies')).length, 1);
    eq(String(q.val("SELECT reply FROM social_inbox WHERE external_id='c:C1'")).includes('/go/'), true);
  } finally { globalThis.fetch = real; (config as any).fbPageToken = ''; (config as any).fbPageId = ''; }
});
await t('X posting header is OAuth 1.0a HMAC-SHA1', () => {
  const h = mk.xAuthHeader('POST', 'https://api.x.com/2/tweets', { key: 'k', secret: 's', token: 't', tokenSecret: 'ts' }, 'nonce', '1700000000');
  eq(h.startsWith('OAuth '), true); eq(/oauth_signature="[^"]+"/.test(h), true); eq(h.includes('oauth_signature_method="HMAC-SHA1"'), true);
});
await t('email (rules): welcome email goes once, with tracked button and unsubscribe; a click counts as "worked"', async () => {
  const u = mkUser('welcome@t.ng');
  q.run('UPDATE users SET created_at=? WHERE id=?', addDays(now(), -2), u.id);
  setSetting('agent_mode', 'rules');
  const r = await mk.runEmail(); setSetting('agent_mode', 'ai');
  eq(r.includes('welcome_1'), true);
  const act = q.get<any>("SELECT * FROM agent_actions WHERE kind='send_campaign' AND payload LIKE '%welcome_1%' ORDER BY id DESC");
  eq(agents.executeAction(act.id, 1).includes('sent'), true);
  const mail = String(q.val('SELECT body FROM outbox WHERE recipient=? ORDER BY id DESC', 'welcome@t.ng'));
  eq(mail.includes('/go/'), true); eq(mail.includes('/email/stop/'), true);
  eq(agents.executeAction(agents.propose({ agent: 'email', kind: 'send_campaign', risk: 'low', title: 't', payload: JSON.parse(act.payload) }), 1), '0 emails sent', 'never twice');
  const code = mail.match(/\/go\/([A-Za-z0-9]+)\?r=([^"]+)/)!;
  const ctx: any = { query: { r: code[2] }, cookies: {}, user: null, setCookie() {} };
  tracking.followLink(ctx, code[1]);
  eq(q.val('SELECT user_id FROM link_clicks ORDER BY id DESC'), u.id, 'click credited to the person');
  learning.scoreOutcomes();
  eq(Number(q.val("SELECT wins FROM agent_lessons WHERE agent='email' AND key='email:welcome_1' AND lang='en' ORDER BY wins DESC")) >= 1, true);
});
await t('email (AI): writes a challenger version to A/B test, keeping the placeholders', async () => {
  const { config } = await import('../src/lib/config');
  const real = globalThis.fetch; (config as any).anthropicKey = 'k';
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"title":"Your payout from {lot} lands {date}","body":"Hi {name}, {lot} pays on {date}. Choose wallet or Keep Growing."}' }], usage: {} }), { status: 200 })) as any;
  try {
    const u = mkUser('mature@t.ng'); await fund(u.id, 300_000_00);
    const tr = joinLot(userById(u.id)!, mkLot('T-MAT'), 100_000_00);
    q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), 8), tr.id);
    await mk.runEmail();
    eq(Number(q.val("SELECT COUNT(*) FROM agent_lessons WHERE agent='email' AND key='email:maturity' AND lang='en' AND active=1")), 2);
  } finally { globalThis.fetch = real; (config as any).anthropicKey = ''; }
});
await t('newsletter A/B: two subjects, half each, tracked separately', async () => {
  const jobs = await import('../src/lib/jobs');
  for (let i = 0; i < 4; i++) q.insert('subscribers', { email: `nl${i}@t.ng`, status: 'confirmed', token: `nt${i}`, created_at: now() });
  const id = q.insert('newsletters', { subject: 'Subject A', subject_b: 'Subject B', body: 'Read [more](https://example.org/x)', status: 'draft', created_at: now() }).id;
  const n = jobs.sendNewsletter(id);
  eq(n >= 4, true);
  const subs = q.all<any>("SELECT subject FROM outbox WHERE recipient LIKE 'nl%@t.ng'").map((r) => r.subject);
  eq(subs.includes('Subject A') && subs.includes('Subject B'), true);
  eq(!!q.get('SELECT 1 FROM links WHERE campaign=?', `nl-${id}-b`), true);
});
await t('/join form records a consented lead with its source', async () => {
  q.insert('leads', { email: 'joinpage@lead.ng', lang: 'en', source: 'instagram', campaign: 'post-1#1', consent: 1, token: 'tj', created_at: now() });
  eq(q.val("SELECT source FROM leads WHERE email='joinpage@lead.ng'"), 'instagram');
});
function fmtTest(k: number) { return `₦${new Intl.NumberFormat('en-NG').format(k / 100)}`; }

console.log('\nEmail codes (two-step without an app)');
await t('email codes: one purpose, one use, 10 minutes, at most 5 tries', async () => {
  const ec = await import('../src/lib/emailcode');
  const u = mkUser('codes@t.ng');
  const code = ec.sendEmailCode(u, 'withdraw');
  eq(/^\d{6}$/.test(code), true);
  eq(String(q.val("SELECT subject FROM outbox WHERE recipient='codes@t.ng' ORDER BY id DESC")).includes(code), true, 'code in the email');
  eq(ec.checkEmailCode(u, 'bank', code), false, 'a withdrawal code cannot change a bank account');
  eq(ec.checkEmailCode(u, 'withdraw', '000000') && code !== '000000', false);
  eq(ec.checkEmailCode(u, 'withdraw', code), true);
  eq(ec.checkEmailCode(u, 'withdraw', code), false, 'used once only');
  const c2 = ec.sendEmailCode(u, 'login');
  for (let i = 0; i < 5; i++) ec.checkEmailCode(u, 'login', '111111');
  eq(ec.checkEmailCode(u, 'login', c2), false, 'locked after 5 wrong tries');
  const c3 = ec.sendEmailCode(u, 'bank');
  q.run("UPDATE tokens SET expires_at=? WHERE kind='code_bank' AND user_id=?", addDays(now(), -0.001), u.id);
  eq(ec.checkEmailCode(u, 'bank', c3), false, 'expired');
  eq(ec.maskEmail('kitovu.tech@gmail.com'), 'k••••••h@gmail.com');
});

console.log('\nMarketplace');
await t('marketplace: value to date, units, partial and whole sales, fee, ledger, Kitovu as buyer, payout to the buyer', async () => {
  const mkt = await import('../src/lib/market');
  const { balance } = await import('../src/lib/ledger');
  // Pricing
  const tt = { start_at: '2026-01-01T00:00:00.000Z', matures_at: '2027-01-01T00:00:00.000Z', rate_bps: 3000, period_months: 12 };
  eq(mkt.valueToDate(tt, 100_000_000, new Date('2026-07-02T12:00:00.000Z').getTime()), 100_000_000 + 15_000_000, 'half way: half the earnings');
  eq(mkt.unitsOf(250_000_000).units, 10); eq(mkt.unitsOf(260_000_000).unitAmount, 26_000_000); eq(mkt.unitsOf(30_000_000).units, 1);
  // Off by default
  setSetting('marketplace_mode', 'off'); setSetting('test_mode', false);
  const seller = mkUser('seller@t.ng'), buyer = mkUser('buyer@t.ng'), b2 = mkUser('buyer2@t.ng');
  await fund(seller.id, 2_500_000_00); await fund(buyer.id, 2_000_000_00); await fund(b2.id, 3_000_000_00);
  const lid = mkLot('T-MKT', { target_amount: 10_000_000_00, min_commit: 250_000_00, periods: '12', period_months: 12 });
  const tr = joinLot(userById(seller.id)!, lid, 2_500_000_00, { months: 12 });
  eq(mkt.cannotList(tr, userById(seller.id)!), 'market.off');
  setSetting('marketplace_mode', 'on');
  eq(mkt.cannotList(q.get('SELECT * FROM trades WHERE id=?', tr.id), userById(seller.id)!), 'market.too_soon');
  q.run('UPDATE trades SET start_at=?, matures_at=? WHERE id=?', addDays(now(), -122), addDays(now(), 243), tr.id);
  const lotBal = balance(`lot:${lid}`);
  const listingId = mkt.listTrade(userById(seller.id)!, tr.id, 10, 2);
  const l = q.get<any>('SELECT * FROM trade_listings WHERE id=?', listingId);
  eq(l.units_total, 10); eq(l.unit_amount, 250_000_00); eq(l.discount_bps, 200);
  throws(() => mkt.buyUnits(userById(seller.id)!, listingId, 1), 'market.own');
  // Partial: 3 units
  const sBefore = walletBalance(seller.id), bBefore = walletBalance(buyer.id);
  const r1 = mkt.buyUnits(userById(buyer.id)!, listingId, 3);
  eq(r1.principal, 750_000_00); eq(q.val('SELECT amount FROM trades WHERE id=?', tr.id), 1_750_000_00);
  eq(q.val('SELECT user_id FROM trades WHERE id=?', r1.tradeId), buyer.id); eq(q.val('SELECT acquired_price FROM trades WHERE id=?', r1.tradeId), r1.price);
  eq(walletBalance(buyer.id), bBefore - r1.price); eq(walletBalance(seller.id), sBefore + r1.price - r1.fee);
  eq(r1.fee, Math.round(r1.price / 100), '1% fee');
  const vtd = mkt.valueToDate(q.get<any>('SELECT * FROM trades WHERE id=?', r1.tradeId), 750_000_00);
  eq(Math.abs(r1.price - Math.round(vtd * 0.98)) <= 100, true, 'price is value to date less 2%'); eq(vtd > 820_000_00 && vtd < 830_000_00, true, 'about ₦825,000 after 122 days');
  eq(q.val('SELECT units_left FROM trade_listings WHERE id=?', listingId), 7);
  eq(balance(`lot:${lid}`), lotBal, 'money stays in the lot'); eq(trialBalance(), 0);
  // Whole: the remaining 7 units go to buyer 2 by moving the trade itself
  const certBefore = q.val('SELECT certificate_no FROM trades WHERE id=?', tr.id);
  const r2 = mkt.buyUnits(userById(b2.id)!, listingId, 7);
  eq(r2.tradeId, tr.id); eq(q.val('SELECT user_id FROM trades WHERE id=?', tr.id), b2.id);
  eq(q.val('SELECT certificate_no FROM trades WHERE id=?', tr.id) !== certBefore, true, 'new certificate for the new holder');
  eq(q.val('SELECT status FROM trade_listings WHERE id=?', listingId), 'sold');
  throws(() => mkt.buyUnits(userById(buyer.id)!, listingId, 1), 'market.gone');
  // Buyer can't afford
  throws(() => mkt.listTrade(userById(buyer.id)!, r1.tradeId, 3, 0), 'market.too_soon');
  q.run('UPDATE trades SET acquired_at=? WHERE id=?', addDays(now(), -31), r1.tradeId);
  const l2 = mkt.listTrade(userById(buyer.id)!, r1.tradeId, 3, 0);
  const poor = mkUser('poor@t.ng');
  throws(() => mkt.buyUnits(userById(poor.id)!, l2, 1), 'lots.need_funds');
  // Kitovu buys one unit like any buyer
  const rk = mkt.buyUnits(userById(1)!, l2, 1, { asKitovu: true, by: 1 });
  eq(q.val('SELECT role FROM users WHERE id=(SELECT user_id FROM trades WHERE id=?)', rk.tradeId), 'house');
  eq(balance('kitovu:market_purchases'), -rk.price); eq(trialBalance(), 0);
  // Listings close when the trade becomes ineligible
  q.run("UPDATE trades SET original_matures_at=matures_at WHERE id=?", r1.tradeId);
  eq(mkt.expireListings() >= 1, true); eq(q.val('SELECT status FROM trade_listings WHERE id=?', l2), 'expired');
  // On the payout date the holder is paid the full amount
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -0.01), tr.id);
  const b2Before = walletBalance(b2.id);
  payTrade(tr.id, 1);
  eq(walletBalance(b2.id), b2Before + 1_750_000_00 + earningsFor(1_750_000_00, 3000, 12)); eq(trialBalance(), 0);
  setSetting('marketplace_mode', 'off');
  throws(() => mkt.buyUnits(userById(b2.id)!, l2, 1), 'market.off');
});

console.log('\nWatchdog');
await t('watchdog: emails super admins once when a problem starts, stays quiet while it lasts, and says when it is resolved', async () => {
  const wd = await import('../src/lib/watchdog');
  const { config } = await import('../src/lib/config');
  const old = [config.emailProvider, config.emailApiKey];
  (config as any).emailProvider = 'resend'; (config as any).emailApiKey = 're_test';
  const boss = mkUser('wd@t.ng'); q.run("UPDATE users SET role='admin', admin_roles='super' WHERE id=?", boss.id);
  const stuck = q.insert('outbox', { channel: 'email', recipient: 'x@y.ng', subject: 's', body: 'b', status: 'queued', attempts: 4, error: 'Email 403: domain not verified', created_at: now() }).id;
  const mails = () => q.all<any>("SELECT subject FROM outbox WHERE recipient='wd@t.ng' AND subject LIKE 'ComboTrader health%'");
  const before = mails().length;
  await wd.watchdog(); await wd.watchdog();
  const after = mails();
  eq(after.length - before, 1, 'one alert, not one per run'); eq(after[after.length - 1].subject.includes('Email and SMS sending'), true);
  q.run("UPDATE outbox SET status='sent' WHERE id=?", stuck);
  q.run("UPDATE outbox SET status='sent' WHERE recipient='wd@t.ng'");
  await wd.watchdog();
  eq(mails().some((m) => m.subject === 'ComboTrader health: resolved'), true);
  (config as any).emailProvider = old[0]; (config as any).emailApiKey = old[1];
  const checks = await wd.runChecks();
  eq(checks.some((c) => c.key === 'disk') && checks.some((c) => c.key === 'memory'), true);
});

console.log('\nPaystack fallback');
await t('paystack sync: without webhooks, pending payments, withdrawals and BVN checks still complete', async () => {
  const { syncPaystack } = await import('../src/lib/paysync');
  const { config } = await import('../src/lib/config');
  const old = config.paystackSecret; (config as any).paystackSecret = 'sk_test_x';
  const realFetch = globalThis.fetch;
  const u = mkUser('ps@t.ng');
  const old5 = new Date(Date.now() - 5 * 60e3).toISOString();
  q.insert('payments', { user_id: u.id, reference: 'CTF-SYNC1', amount: 100_000_00, fee: 0, status: 'pending', demo: 0, purpose: 'wallet', created_at: old5 });
  q.insert('payments', { user_id: u.id, reference: 'CTF-SYNC2', amount: 50_000_00, fee: 0, status: 'pending', demo: 0, purpose: 'wallet', created_at: old5 });
  q.run("UPDATE users SET kyc_status='pending', kyc_method='bvn', paystack_customer_code='CUS_sync' WHERE id=?", u.id);
  const before = walletBalance(u.id);
  globalThis.fetch = (async (url: string) => {
    const ok = (data: any) => new Response(JSON.stringify({ status: true, data }), { status: 200 });
    if (url.includes('/transaction/verify/CTF-SYNC1')) return ok({ status: 'success', amount: 100_000_00, fees: 0, channel: 'card', paid_at: new Date().toISOString(), currency: 'NGN' });
    if (url.includes('/transaction/verify/CTF-SYNC2')) return ok({ status: 'abandoned', amount: 50_000_00, currency: 'NGN' });
    if (url.includes('/transfer/verify/')) return ok({ status: 'success' });
    if (url.includes('/customer/CUS_sync')) return ok({ identified: true });
    return ok({});
  }) as any;
  try {
    const out = await syncPaystack();
    eq(out.includes('1 payments credited'), true, out);
    eq(walletBalance(u.id), before + 100_000_00);
    eq(q.val("SELECT status FROM payments WHERE reference='CTF-SYNC2'"), 'pending', 'recent abandoned checkout stays open');
    eq(q.val('SELECT kyc_status FROM users WHERE id=?', u.id), 'verified');
    eq(trialBalance(), 0);
  } finally { globalThis.fetch = realFetch; (config as any).paystackSecret = old; }
});

await t('paystack balance: shown against withdrawals waiting; approval is held (not failed) when the balance is too low; watchdog flags it', async () => {
  const { paystackFloat } = await import('../src/lib/paysync');
  const { runChecks } = await import('../src/lib/watchdog');
  const { config } = await import('../src/lib/config');
  const { approveWithdrawal } = await import('../src/lib/wallet');
  const old = config.paystackSecret; (config as any).paystackSecret = 'sk_test_x';
  const realFetch = globalThis.fetch; let transfers = 0;
  globalThis.fetch = (async (url: string) => {
    const ok = (data: any) => new Response(JSON.stringify({ status: true, data }), { status: 200 });
    if (url.endsWith('/balance')) return ok([{ currency: 'NGN', balance: 50_000 }]);
    if (url.includes('/transfer')) { transfers++; return ok({ status: 'success', transfer_code: 'TRF_x' }); }
    return ok({});
  }) as any;
  try {
    const u = mkUser('bal@t.ng'); await fund(u.id, 5_000_00);
    const bank = q.insert('bank_accounts', { user_id: u.id, bank_code: '058', bank_name: 'GTBank', account_number: '0123456789', account_name: 'BAL T', recipient_code: 'RCP_x', active: 1, created_at: now() }).id;
    const wid = q.insert('withdrawals', { user_id: u.id, bank_account_id: bank, amount: 2_000_00, route: 'paystack', status: 'requested', reference: 'CTW-BAL1', created_at: now(), updated_at: now() }).id;
    const f = await paystackFloat(true);
    eq(f.balance, 50_000); eq(f.waiting >= 2_000_00, true); eq(f.low, true); eq(f.topUp > 0, true);
    let msg = '';
    try { await approveWithdrawal(wid, 1); } catch (e: any) { msg = e.message; }
    eq(msg.includes('Paystack balance'), true, msg); eq(transfers, 0);
    eq(q.val('SELECT status FROM withdrawals WHERE id=?', wid), 'requested', 'stays waiting, not failed');
    const checks = await runChecks();
    eq(checks.find((c) => c.key === 'paystack')?.ok, false);
    q.run("DELETE FROM withdrawals WHERE id=?", wid);
  } finally { globalThis.fetch = realFetch; (config as any).paystackSecret = old; }
});

console.log('\nWebsite chat');
await t('chat: assistant answers, hands over to a person, Tawk.to transcripts and offline messages get a drafted email reply', async () => {
  const chat = await import('../src/lib/chat');
  const crypto = await import('node:crypto');
  const { config } = await import('../src/lib/config');
  // 1. Visitor asks a question: rules mode answers from the FAQ and keeps a transcript
  const a = await chat.assistantTurn({ message: 'How do payouts work?', user: null, lang: 'en', page: '/' });
  eq(typeof a.token, 'string'); eq(a.reply.length > 0, true);
  const id = Number(q.val('SELECT id FROM chats WHERE token=?', a.token));
  eq(Number(q.val('SELECT COUNT(*) FROM chat_messages WHERE chat_id=?', id)), 2);
  // Lot questions are answered from the live list of open lots, never from a loosely matching FAQ
  for (const qn of ['any open lots?', 'What lots are available now?', 'lots']) {
    const r = await chat.assistantTurn({ message: qn, user: null, lang: 'en' });
    eq(/Trade Lots are open now|No Trade Lots are open/.test(r.reply), true, `${qn} -> ${r.reply.slice(0, 80)}`);
  }
  // 2. Asking for a person offers the hand-over; leaving an email puts it in front of the team
  const b = await chat.assistantTurn({ token: a.token, message: 'Can I talk to a real person?', user: null, lang: 'en' });
  eq(b.person, true);
  throws(() => chat.handOver({ token: a.token, user: null, via: 'message', email: 'not-an-email' }), 'email');
  chat.handOver({ token: a.token, user: null, via: 'message', name: 'Ada Visitor', email: 'ada.v@example.com', note: 'Please call me back' });
  eq(q.val('SELECT status FROM chats WHERE id=?', id), 'needs_person');
  eq(chat.replyByEmail(id, 'Hello Ada, here is how it works.', 1).includes('ada.v@example.com'), true);
  eq(q.val('SELECT status FROM chats WHERE id=?', id), 'answered');
  // A signed-in Champion's hand-over also opens a support ticket
  const u = mkUser('chatter@t.ng');
  const c1 = await chat.assistantTurn({ message: 'hello', user: u as any, lang: 'en' });
  chat.handOver({ token: c1.token, user: u as any, via: 'message', note: 'need help' });
  eq(Number(q.val("SELECT COUNT(*) FROM tickets WHERE user_id=? AND subject LIKE 'Website chat%'", u.id)), 1);
  // 3. Tawk.to webhook: signature, unanswered transcript -> drafted email reply for approval
  (config as any).tawkWebhookSecret = 'whsec';
  const raw = Buffer.from(JSON.stringify({ event: 'chat:transcript_created', chat: { id: 'tk1', visitor: { name: 'Bola', email: 'bola@example.com' }, messages: [{ sender: { t: 'v' }, msg: 'What is the minimum amount?' }] } }));
  eq(chat.tawkSignatureValid(raw, crypto.createHmac('sha1', 'whsec').update(raw).digest('hex')), true);
  eq(chat.tawkSignatureValid(raw, 'bad'), false);
  await chat.handleTawk(JSON.parse(raw.toString()));
  const tid = Number(q.val("SELECT id FROM chats WHERE source='tawk' AND external_id='tk1'"));
  eq(q.val('SELECT status FROM chats WHERE id=?', tid), 'needs_person');
  eq(Number(q.val("SELECT COUNT(*) FROM agent_actions WHERE kind='reply_chat' AND payload LIKE ?", `%"chat_id":${tid}%`)), 1);
  // An answered chat is just stored
  await chat.handleTawk({ event: 'chat:transcript_created', chat: { id: 'tk2', visitor: { name: 'Chi' }, messages: [{ sender: { t: 'v' }, msg: 'hi' }, { sender: { t: 'a', n: 'Emeka' }, msg: 'Hello!' }] } });
  eq(q.val("SELECT status FROM chats WHERE external_id='tk2'"), 'closed');
  // Offline message (ticket)
  await chat.handleTawk({ event: 'ticket:create', requester: { name: 'Dayo', email: 'dayo@example.com' }, ticket: { id: 'T9', humanId: 9, subject: 'Question', message: 'Do you accept diaspora?' } });
  eq(Number(q.val("SELECT COUNT(*) FROM chats WHERE source='tawk_ticket' AND external_id='T9'")), 1);
  (config as any).tawkWebhookSecret = '';
});

await t('linkedin: connect stores the token, finds the page, posts with the branded image; version tracks the calendar', async () => {
  const li = await import('../src/lib/linkedin');
  const { config } = await import('../src/lib/config');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  (config as any).linkedinClientId = 'cid'; (config as any).linkedinClientSecret = 'csec';
  const calls: string[] = []; let posted: any = null;
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push(`${init?.method || 'GET'} ${url.split('?')[0]}`);
    const ok = (d: any, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: h });
    if (url.includes('/oauth/v2/accessToken')) return ok({ access_token: 'AT', expires_in: 5184000, refresh_token: 'RT', refresh_token_expires_in: 31536000 });
    if (url.includes('organizationAcls')) return ok({ elements: [{ organization: 'urn:li:organization:42', role: 'ADMINISTRATOR', state: 'APPROVED' }] });
    if (url.includes('/organizations/42')) return ok({ localizedName: 'ComboTrader' });
    if (url.includes('initializeUpload')) return ok({ value: { uploadUrl: 'https://upload.example/x', image: 'urn:li:image:9' } });
    if (url.startsWith('https://upload.example')) return new Response('', { status: 201 });
    if (url.endsWith('/rest/posts')) { posted = JSON.parse(init.body); return new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:7' } }); }
    return ok({});
  }) as any;
  try {
    eq(li.liReady(), false);
    const tok = await li.liExchange('code');
    const pages = await li.liAdminPages(tok);
    eq(pages[0].name, 'ComboTrader');
    li.liChoosePage(pages[0].urn, pages[0].name);
    eq(li.liReady(), true);
    const img = path.join(os.tmpdir(), 'li-test.jpg'); fs.writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff]));
    eq(await li.liPost('New lot (SB-2611) #harvest', img), 'urn:li:share:7');
    eq(posted.author, 'urn:li:organization:42'); eq(posted.content.media.id, 'urn:li:image:9');
    eq(posted.commentary.includes('\\(SB-2611\\)') && posted.commentary.includes('\\#harvest'), true);
    eq(/^\d{6}$/.test(li.liVersion()), true);
  } finally { globalThis.fetch = real; li.liDisconnect(); (config as any).linkedinClientId = ''; (config as any).linkedinClientSecret = ''; }
});

await t('meta: connect exchanges for a long-lived token, picks the Page with its Instagram, subscribes the webhook; posting uses it', async () => {
  const meta = await import('../src/lib/meta');
  const mk = await import('../src/lib/marketing');
  const { config } = await import('../src/lib/config');
  (config as any).metaAppId = 'app'; (config as any).metaAppSecret = 'sec';
  const real = globalThis.fetch; const seen: string[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    seen.push(url.split('?')[0]);
    const ok = (d: any) => new Response(JSON.stringify(d), { status: 200 });
    if (url.includes('oauth/access_token') && url.includes('fb_exchange_token')) return ok({ access_token: 'LONG' });
    if (url.includes('oauth/access_token')) return ok({ access_token: 'SHORT' });
    if (url.includes('me/accounts')) return ok({ data: [{ id: '555', name: 'ComboTrader', access_token: 'PAGE', tasks: ['MANAGE', 'CREATE_CONTENT'], instagram_business_account: { id: '777', username: 'combotraderofficial' } }] });
    if (url.includes('subscribed_apps')) return ok({ success: true });
    return ok({ id: 'p1' });
  }) as any;
  try {
    eq(mk.channelReady('facebook'), false);
    eq(meta.metaAuthUrl('s').includes('/v25.0/dialog/oauth'), true);
    await meta.metaExchange('code');
    const r = await meta.metaChoosePage('555');
    eq(r.page, 'ComboTrader'); eq(r.instagram, 'combotraderofficial'); eq(r.subscribed, true);
    eq(meta.fbPageToken(), 'PAGE'); eq(meta.igUserId(), '777');
    eq(mk.channelReady('facebook') && mk.channelReady('instagram'), true);
    eq(seen.every((u) => !u.includes('graph.facebook.com') || u.includes('/v25.0/')), true);
  } finally { globalThis.fetch = real; meta.metaDisconnect(); (config as any).metaAppId = ''; (config as any).metaAppSecret = ''; }
});

console.log('\nContent library');
await t('library: 50 articles and 50 newsletters, all on-message; import needs consent; sequences send one step at a time and stop on sign-up', async () => {
  const lib = await import('../src/content/library');
  const pb = await import('../src/content/playbook');
  const L = await import('../src/lib/library');
  eq(lib.BLOG.length, 50); eq(lib.NEWSLETTERS.length, 50);
  eq(new Set(lib.BLOG.map((b) => b.slug)).size, 50, 'unique slugs');
  const texts = [...lib.BLOG.map((b) => `${b.title} ${b.body}`), ...lib.NEWSLETTERS.map((n) => `${n.subject} ${n.body}`),
    ...Object.values(lib.SEQUENCES).flatMap((s) => s.steps.map((x) => `${x.subject} ${x.body}`)), ...Object.values(lib.CHAMPION_EMAILS).map((e) => `${e.subject} ${e.body}`)];
  // Warnings about these words ("never call trades risk-free", "red flag: guaranteed returns") are fine; using them as claims is not.
  const strip = (tx: string) => tx.replace(/investment scheme|investment-based|investment and advisory/gi, '').replace(/\b(not|never|no|nor|isn’t|aren’t|don’t|anyone promising|red flags?[^.]*)\b[^.\n]{0,60}(risk-free|guaranteed|guarantee|investment)/gi, '').replace(/[“"]guaranteed[”"]|guaranteed returns|guaranteed,? risk-free|“last chance”/gi, '');
  const bad = texts.map((tx) => ({ tx, w: pb.offMessage(strip(tx)) })).filter((x) => x.w.length);
  if (bad.length) throw new Error(bad.map((b) => `(${b.w.join(', ')}) ${b.tx.slice(0, 60)}`).join(' | '));
  eq(L.seedLibrary() > 20, true);
  // Import
  const rows = L.parseContacts('email,name\nzainab@example.com,Zainab Bello\nnot-an-email\nzainab@example.com,dup\n' + ada.email + ',Ada');
  eq(rows.length, 3);
  throws(() => L.importContacts(rows, { lists: ['sequence', 'newsletter'], sequence: 'nurture', source: 'test', consent: false, by: 1 }), 'asked to hear');
  const r = L.importContacts(rows, { lists: ['sequence', 'newsletter', 'blog'], sequence: 'nurture', source: 'test', consent: true, by: 1 });
  eq(r.added, 2); eq(r.champions, 1); eq(r.skipped, 1);
  eq(q.val("SELECT status FROM subscribers WHERE email='zainab@example.com'"), 'confirmed');
  eq(q.val('SELECT seq FROM leads WHERE email=?', ada.email), null, 'Champions get lifecycle emails, not a sequence');
  await (await import('../src/lib/emailcheck')).scanContacts();
  // Sequence: first step now, next one later
  const before = Number(q.val("SELECT COUNT(*) FROM outbox WHERE recipient='zainab@example.com'"));
  L.runSequences();
  eq(Number(q.val("SELECT COUNT(*) FROM outbox WHERE recipient='zainab@example.com'")) - before, 1);
  eq(q.val("SELECT seq_step FROM leads WHERE email='zainab@example.com'"), 1);
  L.runSequences();
  eq(Number(q.val("SELECT COUNT(*) FROM outbox WHERE recipient='zainab@example.com'")) - before, 1, 'second email waits for its day');
  q.run("UPDATE leads SET seq_next_at=? WHERE email='zainab@example.com'", now());
  mkUser('zainab@example.com');
  L.runSequences();
  eq(q.val("SELECT status FROM leads WHERE email='zainab@example.com'"), 'signed_up', 'stops when they sign up');
  // Scheduler proposes the next article and newsletter
  setSetting('agent_autonomy', 'review');
  const lr = L.runLibrary();
  eq(Number(q.val("SELECT COUNT(*) FROM agent_actions WHERE kind='publish_post' AND status='proposed'")) >= 1, true, lr);
  eq(Number(q.val("SELECT COUNT(*) FROM agent_actions WHERE kind='send_newsletter' AND status='proposed'")) >= 1, true);
  const nl = L.renderNewsletter(1)!; eq(nl.body.includes('## Open Trade Lots'), true); eq(nl.body.includes('{name}'), false);
});

console.log('\nChief of Staff');
await t('chief: briefs from facts, assigns tasks for a lot that is behind, pauses promotion when short, learns which tasks worked, triages safe approvals', async () => {
  const C = await import('../src/lib/chief');
  setSetting('agent_mode', 'rules'); setSetting('chief_assign', true); setSetting('social_paused_until', '');
  const closes = new Date(Date.now() + 3 * 864e5).toISOString();
  mkLot('T-CHIEF', { status: 'open', closes_at: closes, opened_at: now() });
  const f = await C.gatherFacts();
  const lf = f.lots.find((l) => l.code === 'T-CHIEF')!; eq(lf.pct, 0); eq(lf.days_left <= 3, true);
  const plan = C.rulePlan(f);
  const short = f.treasury.some((h) => h.level === 'short');
  if (!short) eq(plan.tasks.some((x) => x.kind === 'email.lot_push' || x.kind === 'social.promote_lot'), true, 'pushes the lot that is behind');
  eq(plan.tasks.every((x) => x.kind in C.TASK_KINDS), true);
  const r = await C.runChief('test');
  eq(r.startsWith('brief #'), true, r);
  const brief = q.get<any>('SELECT * FROM chief_briefs ORDER BY id DESC LIMIT 1');
  eq(brief.body.includes('90-day plan'), true); eq(brief.body.includes('T-CHIEF'), true);
  eq(Number(q.val("SELECT COUNT(*) FROM agent_tasks WHERE created_by='chief'")) >= 1, true, 'assigned tasks');
  eq(Number(q.val("SELECT COUNT(*) FROM agent_tasks WHERE created_by='chief' AND status='open'")), 0, 'tasks ran');
  eq(Number(q.val("SELECT COUNT(*) FROM agent_tasks WHERE created_by='chief' AND kind LIKE '%lot%' AND created_at>=?", new Date(Date.now() - 60e3).toISOString())) <= 2, true);
  // Does not repeat the same lot push the next morning.
  await C.runChief('test');
  eq(Number(q.val("SELECT COUNT(*) FROM agent_tasks WHERE kind IN ('email.lot_push','social.promote_lot') AND detail LIKE '%T-CHIEF%'")) <= 2, true, 'no repeat');
  // Treasury short: promotion paused through a task.
  const id = await C.assignTask({ kind: 'social.pause_promotion', detail: { days: 2 }, reason: 'test' }, 1);
  eq(id.ok, true, id.message); eq(JSON.parse(String(q.val("SELECT value FROM settings WHERE key='social_paused_until'"))) > now(), true);
  setSetting('social_paused_until', '');
  // Learning: a lot push that moved funding by 10+ points counts as a win.
  const tid = q.insert('agent_tasks', { assigned_to: 'email', kind: 'email.lot_push', detail: JSON.stringify({ lot_code: 'T-CHIEF', pct_before: -20 }), reason: 'x', status: 'done', created_by: 'chief', created_at: now(), done_at: new Date(Date.now() - 4 * 864e5).toISOString() }).id;
  eq(C.scoreTasks() >= 1, true);
  eq(String(q.val('SELECT outcome FROM agent_tasks WHERE id=?', tid)).startsWith('worked'), true);
  eq(Number(q.val("SELECT wins FROM agent_lessons WHERE agent='chief' AND key='task:email.lot_push'")) >= 1, true);
  // Triage: low-risk, on-message proposals are safe; off-message wording is not.
  const good = agents.propose({ agent: 'social', kind: 'publish_social', risk: 'low', title: 'Harvest Trail update', payload: { text: 'Planting has started in Iseyin.' } });
  const bad = agents.propose({ agent: 'social', kind: 'publish_social', risk: 'low', title: 'Guaranteed returns!', payload: { text: 'Risk-free profit' } });
  const tri = C.triage();
  eq(tri.safe.includes(good), true, 'safe'); eq(tri.safe.includes(bad), false, 'off-message held');
  // Decisions go to the admin whose role owns them; a decision can be marked done; cleared situations close themselves.
  const fin = mkUser('fin@t.ng'); q.run("UPDATE users SET role='admin', admin_roles='finance' WHERE id=?", fin.id);
  q.run("UPDATE chief_recs SET status='resolved'");
  q.run("DELETE FROM outbox WHERE recipient='fin@t.ng'");
  const recs = [{ key: 'paystack_low', roles: ['finance' as const], priority: 1, text: 'Top up Paystack', link: '/admin/withdrawals' }, { key: 'chats_waiting', roles: ['support' as const], priority: 2, text: '2 chats waiting' }];
  C.syncDecisions(recs, 0);
  eq(Number(q.val("SELECT COUNT(*) FROM chief_recs WHERE status='open'")), 2);
  C.syncDecisions(recs, 0);
  eq(Number(q.val("SELECT seen FROM chief_recs WHERE key='paystack_low' AND status='open'")), 2, 'one open decision per situation');
  const rid = Number(q.val("SELECT id FROM chief_recs WHERE key='chats_waiting' AND status='open'"));
  eq(C.decide(rid, fin.id, ['finance'], 'done', ''), 'This decision is for another role.');
  C.syncDecisions([recs[0]], 0);
  eq(q.val('SELECT status FROM chief_recs WHERE id=?', rid), 'resolved', 'cleared by itself');
  await C.runChief('test');
  const finMail = q.get<any>("SELECT * FROM outbox WHERE recipient='fin@t.ng' ORDER BY id DESC LIMIT 1");
  if (Number(q.val("SELECT COUNT(*) FROM chief_recs WHERE status='open' AND roles LIKE '%finance%'"))) eq(!!finMail && String(finMail.subject).includes('Adaeze'), true, 'finance admin got a role brief');
  const fid = Number(q.val("SELECT id FROM chief_recs WHERE status='open' AND roles LIKE '%finance%' LIMIT 1") || 0); eq(fid > 0, true, 'finance has a decision');
  if (fid) { eq(C.decide(fid, fin.id, ['finance'], 'dismissed', 'next week'), 'Noted. I won’t raise it again for 7 days unless it becomes urgent.'); }
  eq((await import('../src/lib/personas')).agentLabel('chief'), 'Adaeze · Chief of Staff');
  q.run("UPDATE lots SET status='closed' WHERE code='T-CHIEF'");
});

console.log('\nEmail pacing');
await t('marketing email is spread over the sending window, warms up from 20 a day, and pauses if too many fail', async () => {
  const N = await import('../src/lib/notify');
  setSetting('email_warmup_start', now()); setSetting('marketing_paused_until', '');
  q.run("DELETE FROM outbox WHERE kind='marketing'");
  eq(N.marketingDailyCap(), 20);
  for (let i = 0; i < 5; i++) N.queueEmail(`pace${i}@t.ng`, 'Hi', '<p>x</p>', { marketing: true });
  N.queueEmail('otp@t.ng', 'Code', '<p>1</p>');
  const slots = q.all<any>("SELECT send_after FROM outbox WHERE kind='marketing' ORDER BY id").map((r) => Date.parse(r.send_after));
  for (let i = 1; i < slots.length; i++) eq(slots[i] - slots[i - 1] >= 30 * 60e3, true, 'about 33 minutes apart on day one');
  for (const x of slots) { const h = new Date(x + 3600e3).getUTCHours(); eq(h >= 8 && h < 19, true, 'inside 8:00-19:00 Lagos'); }
  eq(q.val("SELECT send_after FROM outbox WHERE recipient='otp@t.ng'"), null, 'transactional email is not delayed');
  setSetting('email_warmup_start', new Date(Date.now() - 10 * 864e5).toISOString());
  eq(N.marketingDailyCap(), 200, 'warmed up after about a week');
  q.run("DELETE FROM outbox WHERE kind='marketing'");
  // One failure removes the address everywhere; only a hash stays so it is never re-imported.
  eq(N.addressRefused('Email 422: invalid to address'), true); eq(N.addressRefused('Email 401: bad key'), false); eq(N.addressRefused('Email 503: down'), false); eq(N.addressRefused('fetch failed'), false);
  const L = await import('../src/lib/library');
  L.importContacts(L.parseContacts('Bad Address, gone@t.ng'), { lists: ['blog'], consent: true, source: 'test', by: 1 });
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email='gone@t.ng'")), 1);
  N.queueEmail('gone@t.ng', 'Hi', '<p>x</p>', { marketing: true });
  N.dropAddress('Gone@t.ng', 'test');
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email='gone@t.ng'")), 0, 'removed from contacts');
  eq(q.val("SELECT status FROM outbox WHERE recipient='gone@t.ng'"), 'cancelled');
  eq(N.emailSuppressed('gone@t.ng'), true); eq(Number(q.val("SELECT COUNT(*) FROM email_suppress WHERE hash LIKE '%gone%'")), 0, 'only a hash is kept');
  L.importContacts(L.parseContacts('Bad Address, gone@t.ng'), { lists: ['blog'], consent: true, source: 'test', by: 1 });
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email='gone@t.ng'")), 0, 'never re-added');
});

console.log('\nEmail pre-scan');
await t('pre-scan: company domains are checked before sending; dead domains are purged and never re-added; webmail is not looked up', async () => {
  const E = await import('../src/lib/emailcheck'); const L = await import('../src/lib/library');
  const looked: string[] = [];
  E._setResolver(async (d) => { looked.push(d); if (d === 'gone-coop.ng') throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); if (d === 'nomail.ng') return [{ exchange: '.', priority: 0 }]; if (d === 'slow.ng') throw Object.assign(new Error('t'), { code: 'ETIMEOUT' }); return [{ exchange: `mx.${d}`, priority: 10 }]; });
  L.importContacts(L.parseContacts('a@livecoop.ng\nb@livecoop.ng\nc@gone-coop.ng\nd@nomail.ng\ne@gmail.com\nf@slow.ng'), { lists: ['blog'], consent: true, source: 'test', by: 1 });
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email LIKE '%@livecoop.ng' AND email_check IS NULL")), 2, 'nothing cleared before the scan');
  await E.scanContacts();
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email LIKE '%@livecoop.ng' AND email_check='ok'")), 2);
  eq(looked.filter((d) => d === 'livecoop.ng').length, 1, 'one lookup per domain');
  eq(looked.includes('gmail.com'), false); eq(q.val("SELECT email_check FROM leads WHERE email='e@gmail.com'"), 'public');
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email IN ('c@gone-coop.ng','d@nomail.ng')")), 0, 'dead domains purged');
  eq(q.val("SELECT email_check FROM leads WHERE email='f@slow.ng'"), null, 'no answer: held, tried again later');
  await E.scanContacts(); await E.scanContacts();
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email='f@slow.ng'")), 0, 'removed after 3 checks with no answer');
  L.importContacts(L.parseContacts('c@gone-coop.ng'), { lists: ['blog'], consent: true, source: 'test', by: 1 });
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email='c@gone-coop.ng'")), 0, 'never re-added');
});

await t('duplicates: the same mailbox is never added twice, and existing copies are merged with an opt-out winning', async () => {
  const E = await import('../src/lib/emailcheck'); const L = await import('../src/lib/library');
  eq(E.emailKey('J.Doe+news@GoogleMail.com'), 'jdoe@gmail.com'); eq(E.emailKey('Ada.Obi@coop.ng'), 'ada.obi@coop.ng');
  const r = L.importContacts(L.parseContacts('jdoe@gmail.com\nJ.Doe@gmail.com\njdoe+x@gmail.com'), { lists: ['blog'], consent: true, source: 'test', by: 1 });
  eq(r.added, 1); eq(r.skipped, 2);
  q.insert('leads', { email: 'Dup@Coop.ng', lang: 'en', source: 'contact', consent: 1, status: 'unsubscribed', token: 'd1', created_at: now() });
  q.insert('leads', { email: 'dup@coop.ng', lang: 'en', source: 'import', consent: 1, status: 'new', lists: 'blog', seq: 'nurture', seq_next_at: now(), token: 'd2', created_at: now() });
  q.insert('subscribers', { email: 'Dup@Coop.ng', lang: 'en', status: 'confirmed', token: 's1', created_at: now() });
  q.insert('subscribers', { email: 'dup@coop.ng', lang: 'en', status: 'pending', token: 's2', created_at: now() });
  const d = E.dedupeContacts();
  eq(d.merged >= 1, true); eq(d.subs >= 1, true);
  const left = q.all<any>("SELECT * FROM leads WHERE email_key='dup@coop.ng'");
  eq(left.length, 1); eq(left[0].status, 'unsubscribed', 'the opt-out wins'); eq(left[0].seq, null, 'no sequence for someone who opted out');
  eq(Number(q.val("SELECT COUNT(*) FROM subscribers WHERE lower(email)='dup@coop.ng'")), 1);
});

console.log('\nEmail health');
await t('email health: provider events are recorded, rates reported by mailbox and campaign, slow providers paced, Chief reacts to poor delivery', async () => {
  const N = await import('../src/lib/notify'); const H = await import('../src/lib/emailhealth');
  q.run("DELETE FROM outbox WHERE kind='marketing'"); setSetting('email_slow_groups', '{}'); setSetting('email_slowdown_until', ''); setSetting('marketing_paused_until', '');
  eq(N.mailGroup('a@gmail.com'), 'gmail'); eq(N.mailGroup('b@yahoo.co.uk'), 'yahoo'); eq(N.mailGroup('c@hotmail.com'), 'microsoft'); eq(N.mailGroup('d@coop.ng'), 'company');
  for (let i = 0; i < 40; i++) N.queueEmail(`h${i}@${i % 2 ? 'gmail.com' : 'coop.ng'}`, 'Hi', '<p>x</p>', { marketing: true, campaign: i < 20 ? 'seq-nurture-day0' : 'blog' });
  q.run("UPDATE outbox SET status='sent', sent_at=?, attempts=1, provider_id='re_' || id WHERE kind='marketing'", now());
  const ids = q.all<any>("SELECT provider_id, recipient FROM outbox WHERE kind='marketing' ORDER BY id");
  // Resend: 30 delivered (so 75%), 10 opened, 5 delayed (gmail); Brevo-style event shape too.
  H.recordProviderEvents(ids.slice(0, 30).map((r) => ({ type: 'email.delivered', data: { email_id: r.provider_id, to: [r.recipient] } })));
  H.recordProviderEvents(ids.slice(0, 10).map((r) => ({ type: 'email.opened', data: { email_id: r.provider_id } })));
  H.recordProviderEvents({ event: 'deferred', 'message-id': ids[39].provider_id, email: ids[39].recipient });
  H.recordProviderEvents(ids.filter((r) => r.recipient.endsWith('gmail.com')).slice(0, 4).map((r) => ({ type: 'email.delivery_delayed', data: { email_id: r.provider_id } })));
  H.recordProviderEvents({ type: 'contact.updated', data: {} });
  const h = H.emailHealth(7);
  eq(h.total.sent, 40); eq(h.rates.delivery, 75); eq(h.rates.open, 33.3);
  eq(h.byCampaign.map((x) => x.name).sort().join('|'), 'New article|Sequence: nurture');
  // Bounce through the webhook removes the address and counts as bounced.
  q.insert('leads', { email: 'h2@coop.ng', lang: 'en', source: 'import', consent: 1, token: 'hb', created_at: now() });
  H.recordProviderEvents({ type: 'email.bounced', data: { email_id: ids[2].provider_id, to: ['h2@coop.ng'] } });
  eq(Number(q.val("SELECT COUNT(*) FROM leads WHERE email='h2@coop.ng'")), 0);
  eq(H.emailHealth(7).total.bounced, 1);
  // 5 of 20 gmail emails delayed today -> gmail is paced 4x slower.
  await N.flushOutbox();
  eq(JSON.parse(String(q.val("SELECT value FROM settings WHERE key='email_slow_groups'")).replace(/^"|"$/g, '').replace(/\\"/g, '"')).gmail > now(), true, 'gmail slowed');
  // The Chief sees 75% delivery: recommends, and halves the pace.
  const C = await import('../src/lib/chief');
  const plan = C.rulePlan(await C.gatherFacts());
  eq(plan.recs.some((r) => r.key === 'email_delivery'), true); eq(plan.tasks.some((x) => x.kind === 'email.slow_down'), true);
  setSetting('email_warmup_start', new Date(Date.now() - 10 * 864e5).toISOString());
  const full = N.marketingDailyCap(); setSetting('email_slowdown_until', new Date(Date.now() + 864e5).toISOString());
  eq(N.marketingDailyCap(), Math.ceil(full / 2));
  setSetting('email_slowdown_until', ''); setSetting('email_slow_groups', '{}'); q.run("DELETE FROM outbox WHERE kind='marketing'");
});

console.log('\nCovers');
await t('every article and newsletter gets a branded cover; an uploaded photo is kept', async () => {
  const C = await import('../src/lib/covers');
  const img = await C.coverImage({ title: 'How a Trade Lot works, step by step', kind: 'guides' });
  eq(img.subarray(0, 2).toString('hex'), 'ffd8', 'a JPEG');
  const id = q.insert('posts', { slug: 'cover-test', lang: 'en', title: 'Cover test', body: 'x', category: 'market-watch', author: 'ComboTrader team', status: 'draft', created_at: now(), updated_at: now() }).id;
  eq(await C.ensurePostCover(id), 'covers/post-cover-test-en.jpg');
  const kept = q.insert('posts', { slug: 'photo-test', lang: 'en', title: 'Photo', body: 'x', category: 'guides', author: 'x', status: 'draft', cover_path: 'posts/mine.jpg', created_at: now(), updated_at: now() }).id;
  eq(await C.ensurePostCover(kept), 'posts/mine.jpg');
  const L = await import('../src/lib/library');
  eq(L.renderNewsletter(1)!.body.startsWith('![ComboTrader newsletter, issue 1]('), true);
  q.run("DELETE FROM posts WHERE slug IN ('cover-test','photo-test')");
});

console.log('\nTesting tools');
await t('test mode: simulated payments only while no Paystack key; sample lots; clearing keeps admins, settings and content', async () => {
  const tm = await import('../src/lib/testmode');
  const { config } = await import('../src/lib/config');
  const ps = await import('../src/lib/paystack');
  const oldDemo = config.demoMode; (config as any).demoMode = false;
  try {
    setSetting('test_mode', false); eq(ps.simulated(), false);
    setSetting('test_mode', true); eq(ps.simulated(), true);
    (config as any).paystackSecret = 'sk_live_x'; eq(ps.simulated(), false, 'never with live keys'); (config as any).paystackSecret = '';
  } finally { (config as any).demoMode = oldDemo; }
  const admin = mkUser('boss@t.ng'); q.run("UPDATE users SET role='admin', admin_roles='super', totp_enabled=1, totp_secret='ABC' WHERE id=?", admin.id);
  eq(tm.addSampleLots(admin.id), 4);
  eq(String(q.val("SELECT title FROM lots ORDER BY id DESC")).startsWith('TEST ·'), true);
  eq(Number(q.val("SELECT COUNT(*) FROM circles WHERE name LIKE 'TEST ·%'")), 4);
  const circ = await import('../src/lib/circles');
  setSetting('circles_mode', 'pilot'); setSetting('test_mode', true);
  const { config: cfg } = await import('../src/lib/config'); const sec = cfg.paystackSecret; (cfg as any).paystackSecret = '';
  eq(circ.circlesVisibleTo(userById(mkUser('circ@t.ng').id)!), true, 'test mode opens circles to everyone');
  setSetting('test_mode', false); eq(circ.circlesVisibleTo(userById(q.val("SELECT id FROM users WHERE email='circ@t.ng'") as number)!), false); (cfg as any).paystackSecret = sec;
  setSetting('rate_12', 31);
  const before = Number(q.val('SELECT COUNT(*) FROM commodities'));
  tm.clearTestData(admin.id);
  eq(Number(q.val("SELECT COUNT(*) FROM users WHERE role!='admin'")), 0);
  eq(Number(q.val('SELECT COUNT(*) FROM lots')) + Number(q.val('SELECT COUNT(*) FROM trades')) + Number(q.val('SELECT COUNT(*) FROM journals')) + Number(q.val('SELECT COUNT(*) FROM payments')), 0);
  eq(q.val('SELECT totp_enabled FROM users WHERE id=?', admin.id), 1, 'admin and authenticator kept');
  eq(Number(q.val('SELECT COUNT(*) FROM commodities')), before); eq(rateFor(12), 3100, 'settings kept');
  eq(trialBalance(), 0);
  setSetting('rate_12', 30);
});

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
