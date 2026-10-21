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
import { joinLot, getLot, payTrade, impactFor, rankFor, TradeError } from '../src/lib/trading';
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
  period_months: 6, rate_bps: 2000, closes_at: addDays(now(), 10), status: 'open', circles_enabled: 1, created_at: now() }).id;

console.log('\nMoney');
await t('earnings are pro-rated: ₦1M for 12 months at 20% = ₦200,000', () => eq(earningsFor(100_000_000, 2000, 12), 20_000_000));
await t('₦1M for 4 months at 20% = ₦66,667', () => eq(earningsFor(100_000_000, 2000, 4), 6_666_667));
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
  eq(walletBalance(ada.id), 200_000_00 + 300_000_00 + earningsFor(300_000_00, 2000, 6));
  eq(balance(`lot:${lotId}`), 0); eq(trialBalance(), 0);
});
await t('impact and rank are computed from tonnage moved', () => {
  const i = impactFor(ada.id); eq(Math.round(i.tons), 30); eq(rankFor(i.tons).rank, 'granary');
});

await t('a delayed payout keeps earning at the same rate for the extra days', async () => {
  const { delayLotPayouts } = await import('../src/lib/trading');
  const u = mkUser('late@t.ng'); await fund(u.id, 100_000_00);
  const lid = q.insert('lots', { code: 'T-LATE', commodity: 'maize', title: 'Late lot', buyer_type: 'Mill', tonnage: 10, farmers: 5, target_amount: 1_000_000_00, min_commit: 100_000_00,
    period_months: 12, rate_bps: 2000, closes_at: addDays(now(), 10), status: 'open', created_at: now() }).id;
  const tr = joinLot(userById(u.id)!, lid, 100_000_00);
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -1), tr.id);
  eq(delayLotPayouts(lid, addDays(now(), 29), 'Buyer asked for time', 1), 1);
  q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -0.5), tr.id);
  q.run('UPDATE trades SET original_matures_at=? WHERE id=?', addDays(now(), -30.5), tr.id);
  const paid = payTrade(tr.id, 1);
  eq(paid.earnings, 20_000_00 + Math.round(100_000_00 * 2000 * 30 / 3650000));
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
  period_months: 4, rate_bps: 2000, closes_at: addDays(now(), 30), status: 'open', circles_enabled: 1, created_at: now() }).id;
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
