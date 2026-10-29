import { normalizePhone } from '../lib/util';
import { get, post } from '../lib/router';
import { render } from '../views/render';
import { createElement as h } from 'react';
import * as V from '../views/app/pages';
import { q, now } from '../lib/db';
import { walletBalance, reservedBalance, walletStatement } from '../lib/ledger';
import { openLots, getLot, joinLot, trailFor, impactFor, rankFor, TradeError, isRollover } from '../lib/trading';
import { closureBlockers } from '../lib/account';
import { supportOnTicket } from '../lib/agents';
import { startFunding, requestWithdrawal } from '../lib/wallet';
import { circlesVisibleTo, userCircles, publicCircles, getCircle, getCircleByInvite, takeSlots, releaseSlots, createCircle } from '../lib/circles';
import { certificatePdf } from '../lib/cards';
import { settings } from '../lib/settings';
import * as paystack from '../lib/paystack';
import { verifyTotp, newTotpSecret, otpauthUrl } from '../lib/totp';
import { hashPassword, verifyPassword, parseNaira, addDays, hmac, safeEqual, fmtNGN } from '../lib/util';
import { passwordProblem, rateLimit, userById } from '../lib/auth';
import { countryOptions, COUNTRY_CODES } from '../lib/geo';
import { isLang } from '../lib/i18n';
import { savePrivateFile } from '../lib/uploads';
import { audit } from '../lib/audit';
import { notify } from '../lib/notify';
import { HttpError, type Ctx } from '../lib/http';

const err = (c: Ctx, e: unknown) => (e instanceof TradeError ? c.t(e.key, e.vars) : (e as Error).message);

get('/app', 'auth', (c) => {
  const u = c.user!;
  if (!u.onboarded && !c.isAdmin) return c.redirect('/welcome');
  const impact = impactFor(u.id);
  render(c, h(V.AppHome, { d: {
    wallet: walletBalance(u.id), reserved: reservedBalance(u.id), impact, rank: rankFor(impact.tons) as any,
    nextPayout: q.get<any>("SELECT t.*, l.title AS lot_title FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? AND t.status IN ('active','matured') ORDER BY t.matures_at LIMIT 1", u.id),
    activeCount: Number(q.val("SELECT COUNT(*) FROM trades WHERE user_id=? AND status IN ('active','matured')", u.id)),
    lots: openLots(3), recent: q.all<any>('SELECT title, body, created_at, link FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 6', u.id),
  } }));
});

// ---------- Lots ----------
get('/app/lots', 'auth', (c) => render(c, h(V.AppLots, { lots: openLots() })));
get('/app/lots/:id', 'auth', (c) => {
  const lot = getLot(Number(c.params.id));
  if (!lot || lot.status === 'draft') throw new HttpError(404, 'Not found');
  render(c, h(V.JoinLot, { lot, wallet: walletBalance(c.user!.id), trail: trailFor(lot.id) }));
});
post('/app/lots/:id/join', 'auth', (c) => {
  const lot = getLot(Number(c.params.id));
  if (!lot) throw new HttpError(404, 'Not found');
  const amount = parseNaira(c.body.amount);
  try {
    if (!c.bool('agree')) throw new TradeError('auth.must_agree');
    const t = joinLot(c.user!, lot.id, amount, { rollover: isRollover(c.body.rollover) ? c.body.rollover : undefined, months: c.int('months') || undefined });
    c.redirect(`/app/trades/${t.id}`, ['ok', c.t('lots.joined', { lot: lot.title })]);
  } catch (e) {
    render(c, h(V.JoinLot, { lot, wallet: walletBalance(c.user!.id), trail: trailFor(lot.id), error: err(c, e) }), 422);
  }
});

// ---------- Trades ----------
const TRADE_SQL = `SELECT t.*, l.title AS lot_title, l.code AS lot_code, l.buyer_type, l.tonnage, l.target_amount, l.farmers, c.name AS commodity_name
  FROM trades t JOIN lots l ON l.id=t.lot_id JOIN commodities c ON c.code=l.commodity`;
get('/app/trades', 'auth', (c) => {
  const lotFilter = Number(c.query.lot) || 0;
  const trades = q.all<any>(`${TRADE_SQL} WHERE t.user_id=? ${lotFilter ? 'AND t.lot_id=?' : ''} ORDER BY t.id DESC`, c.user!.id, ...(lotFilter ? [lotFilter] : []));
  if (lotFilter && trades.length === 1) return c.redirect(`/app/trades/${trades[0].id}`);
  render(c, h(V.AppTrades, { trades }));
});
function myTrade(c: Ctx) {
  const t = q.get<any>(`${TRADE_SQL} WHERE t.id=? AND t.user_id=?`, Number(c.params.id), c.user!.id);
  if (!t) throw new HttpError(404, 'Not found');
  return t;
}
get('/app/trades/:id', 'auth', (c) => {
  const t = myTrade(c);
  const share = t.amount / t.target_amount;
  render(c, h(V.TradeDetail, { t, trail: trailFor(t.lot_id), tons: share * t.tonnage, farmers: Math.max(1, Math.round(share * t.farmers)) }));
});
get('/app/trades/:id/certificate.pdf', 'auth', async (c) => {
  const t = myTrade(c);
  const u = c.user!;
  const pdf = await certificatePdf({ certificateNo: t.certificate_no, name: `${u.first_name} ${u.last_name}`, email: u.email, lotTitle: t.lot_title, lotCode: t.lot_code, commodity: t.commodity_name, amount: t.amount, rateBps: t.rate_bps, months: t.period_months, startAt: t.start_at, maturesAt: t.matures_at, buyerType: t.buyer_type, status: t.status });
  c.send(200, pdf, 'application/pdf', { 'Content-Disposition': `inline; filename="ComboTrader-${t.certificate_no}.pdf"` });
});

// ---------- Harvest Circles ----------
function circlesGuard(c: Ctx) { if (!circlesVisibleTo(c.user)) throw new HttpError(404, 'Not found'); }
get('/app/circles', 'auth', (c) => {
  circlesGuard(c);
  render(c, h(V.AppCircles, { mine: userCircles(c.user!.id), open: publicCircles(), lots: openLots().filter((l) => l.circles_enabled) }));
});
post('/app/circles', 'auth', (c) => {
  circlesGuard(c);
  const slotPrice = [5000, 10000, 20000, 50000].includes(c.int('slot_price')) ? c.int('slot_price') * 100 : 1000000;
  const slots = [10, 20, 25, 50].includes(c.int('slots')) ? c.int('slots') : 25;
  try {
    const ci = createCircle({ lotId: c.int('lot_id'), name: c.str('name', 60) || 'Harvest Circle', slots, slotPrice, creatorId: c.user!.id, isPrivate: true });
    c.redirect(`/app/circles/${ci.id}`, ['ok', c.t('circles.created')]);
  } catch (e) { c.redirect('/app/circles', ['error', err(c, e)]); }
});
get('/app/circles/:id', 'auth', (c) => {
  circlesGuard(c);
  const ci = getCircle(Number(c.params.id));
  if (!ci) throw new HttpError(404, 'Not found');
  const mySlots = Number(q.val("SELECT COALESCE(SUM(slots),0) FROM circle_slots WHERE circle_id=? AND user_id=? AND status IN ('reserved','converted')", ci.id, c.user!.id));
  render(c, h(V.CircleDetail, { ci, mySlots, wallet: walletBalance(c.user!.id) }));
});
post('/app/circles/:id/take', 'auth', (c) => {
  circlesGuard(c);
  try {
    const ci = takeSlots(c.user!, Number(c.params.id), c.int('slots'));
    c.redirect(`/app/circles/${ci.id}`, ['ok', ci.status === 'filled' ? c.t('msg.circle_filled.body', { circle: ci.name }) : c.t('circles.reserved')]);
  } catch (e) { c.redirect(`/app/circles/${c.params.id}`, ['error', err(c, e)]); }
});
post('/app/circles/:id/release', 'auth', (c) => {
  circlesGuard(c);
  releaseSlots(c.user!, Number(c.params.id));
  c.redirect('/app/wallet', ['ok', c.t('jk.circle_release')]);
});
get('/c/:code', 'public', (c) => {
  const ci = getCircleByInvite(c.params.code.toUpperCase());
  if (!ci) throw new HttpError(404, 'Not found');
  c.redirect(c.user ? `/app/circles/${ci.id}` : `/signup?next=/app/circles/${ci.id}`);
});

// ---------- Wallet ----------
get('/app/wallet', 'auth', (c) => {
  const u = c.user!;
  render(c, h(V.AppWallet, { d: {
    balance: walletBalance(u.id), reserved: reservedBalance(u.id), statement: walletStatement(u.id, 100),
    withdrawals: q.all('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 20', u.id),
    banks: q.all('SELECT * FROM bank_accounts WHERE user_id=? AND active=1 ORDER BY id DESC', u.id), kyc: u.kyc_status,
  } }));
});
post('/app/wallet/fund', 'auth', async (c) => {
  if (!c.user!.email_verified_at) return c.redirect('/app/wallet', ['error', c.t('lots.verify_first')]);
  try {
    const url = await startFunding(c.user!, parseNaira(c.body.amount));
    c.redirect(url);
  } catch (e) { c.redirect('/app/wallet', ['error', err(c, e)]); }
});
post('/app/wallet/withdraw', 'auth', (c) => {
  const u = c.user!;
  if (!rateLimit(`wd:${u.id}`, 10, 3600)) return c.redirect('/app/wallet', ['error', c.t('auth.too_many')]);
  if (u.totp_enabled && !verifyTotp(u.totp_secret, c.str('code', 8))) return c.redirect('/app/wallet', ['error', c.t('auth.bad_code')]);
  const manual = c.body.route === 'manual';
  try {
    requestWithdrawal(u, parseNaira(c.body.amount), manual ? null : c.int('bank_account_id'), manual ? 'manual' : 'paystack');
    c.redirect('/app/wallet', ['ok', c.t('wallet.withdraw_requested')]);
  } catch (e) { c.redirect('/app/wallet', ['error', err(c, e)]); }
});
get('/app/wallet/statement.csv', 'auth', (c) => {
  const rows = walletStatement(c.user!.id, 10000);
  const csv = ['date,type,description,amount_ngn', ...rows.map((r) => [r.created_at, r.kind, `"${String(r.memo || '').replace(/"/g, '""')}"`, (r.amount / 100).toFixed(2)].join(','))].join('\n');
  c.send(200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="combotrader-statement.csv"' });
});

// ---------- Referrals ----------
get('/app/referrals', 'auth', (c) => {
  const u = c.user!;
  const friends = q.all<any>(`SELECT f.first_name, f.created_at, (SELECT COUNT(*) FROM trades WHERE user_id=f.id) AS funded,
    (SELECT amount FROM referral_rewards WHERE referred_id=f.id AND status='credited') AS reward FROM users f WHERE f.referred_by=? ORDER BY f.id DESC`, u.id);
  const earned = Number(q.val("SELECT COALESCE(SUM(amount),0) FROM referral_rewards WHERE referrer_id=? AND status='credited'", u.id));
  render(c, h(V.AppReferrals, { friends, earned, reward: settings().referral_reward }));
});

// ---------- Profile, verification, bank ----------
async function profilePage(c: Ctx) {
  const banks = q.all('SELECT * FROM bank_accounts WHERE user_id=? AND active=1 ORDER BY id DESC', c.user!.id);
  render(c, h(V.AppProfile, { banks, bankList: await paystack.banks().catch(() => []), countries: countryOptions(c.lang), blockers: closureBlockers(c.user!.id) }));
}
get('/app/profile', 'auth', profilePage);
post('/app/profile', 'auth', (c) => {
  const u = c.user!;
  const lang = isLang(c.body.lang) ? c.body.lang : u.lang;
  const country = COUNTRY_CODES.includes(c.str('country', 2)) ? c.str('country', 2) : u.country;
  const phone = c.str('phone', 30) ? normalizePhone(c.str('phone', 30), country) : u.phone;
  q.run(`UPDATE users SET first_name=?, last_name=?, country=?, city=?, phone=?, next_of_kin_name=?, next_of_kin_phone=?, lang=?, notif_email=?, notif_sms=?, feed_opt_in=? WHERE id=?`,
    c.str('first_name', 60) || u.first_name, c.str('last_name', 60) || u.last_name, u.kyc_status === 'verified' ? u.country : country, c.str('city', 60), /^\+\d{8,15}$/.test(phone || '') ? phone : u.phone,
    c.str('next_of_kin_name', 100), c.str('next_of_kin_phone', 30), lang, c.bool('notif_email'), c.bool('notif_sms'), c.bool('feed_opt_in'), u.id);
  c.setCookie('lang', lang, { maxAge: 365 * 86400 });
  c.redirect('/app/profile', ['ok', c.t('profile.saved')]);
});

/** Adds a Nigerian bank account after Paystack resolves the account name and it matches the Champion. */
async function addBank(c: Ctx, bankCode: string, acct: string) {
  const u = c.user!;
  if (!/^\d{10}$/.test(acct)) throw new TradeError('bank.number');
  const banks = await paystack.banks();
  const bank = banks.find((b) => b.code === bankCode);
  if (!bank) throw new TradeError('bank.bank');
  const r = await paystack.resolveAccount(acct, bankCode, `${u.first_name} ${u.last_name}`);
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  const nameParts = norm(r.account_name);
  const match = norm(u.first_name).every((p) => nameParts.includes(p)) && norm(u.last_name).some((p) => nameParts.includes(p));
  if (!match) throw new TradeError('bank.name_mismatch', { acct: r.account_name });
  const rec = await paystack.createRecipient(r.account_name, acct, bankCode);
  const hadBank = q.get('SELECT 1 FROM bank_accounts WHERE user_id=? AND active=1', u.id);
  q.run('UPDATE bank_accounts SET active=0 WHERE user_id=?', u.id);
  q.insert('bank_accounts', {
    user_id: u.id, country: 'NG', bank_code: bankCode, bank_name: bank.name, account_number: acct, account_name: r.account_name,
    recipient_code: rec.recipient_code, name_match: 1, hold_until: hadBank ? addDays(now(), 1) : null, created_at: now(),
  });
  audit(u.id, 'bank.add', `user:${u.id}`, { bank: bank.name, last4: acct.slice(-4) }, c.ip);
  if (hadBank) notify(u, 'new_device', {}, { link: '/app/security', sms: true });
  return r.account_name;
}
post('/app/profile/bank', 'auth', async (c) => {
  const u = c.user!;
  if (u.totp_enabled && !verifyTotp(u.totp_secret, c.str('code', 8))) return c.redirect('/app/profile#bank', ['error', c.t('auth.bad_code')]);
  try {
    const name = await addBank(c, c.str('bank_code', 10), c.str('account_number', 10));
    c.redirect('/app/profile#bank', ['ok', c.t('bank.added', { acct: name })]);
  } catch (e) { c.redirect('/app/profile#bank', ['error', err(c, e)]); }
});
post('/app/profile/bank-intl', 'auth', (c) => {
  const u = c.user!;
  q.run("UPDATE bank_accounts SET active=0 WHERE user_id=? AND country!='NG'", u.id);
  q.insert('bank_accounts', { user_id: u.id, country: u.country, account_number: 'INTL', details: c.str('details', 600), name_match: 0, created_at: now() });
  c.redirect('/app/profile#bank', ['ok', c.t('profile.saved')]);
});
post('/app/profile/kyc', 'auth', async (c) => {
  const u = c.user!;
  const bvn = c.str('bvn', 11);
  if (!/^\d{11}$/.test(bvn)) return c.redirect('/app/profile#kyc', ['error', c.t('kyc.bvn')]);
  if (!rateLimit(`kyc:${u.id}`, 5, 86400)) return c.redirect('/app/profile#kyc', ['error', c.t('auth.too_many')]);
  try {
    await addBank(c, c.str('bank_code', 10), c.str('account_number', 10));
    const r = await paystack.validateIdentity({ email: u.email, first_name: u.first_name, last_name: u.last_name, phone: u.phone, bvn, account_number: c.str('account_number', 10), bank_code: c.str('bank_code', 10), customerCode: u.paystack_customer_code });
    // The BVN itself is never stored.
    q.run('UPDATE users SET paystack_customer_code=?, kyc_status=?, kyc_method=?, kyc_note=NULL WHERE id=?', r.customer_code, r.instant ? 'verified' : 'pending', 'bvn', u.id);
    if (r.instant) notify(userById(u.id)!, 'kyc_verified', {}, { link: '/app/wallet' });
    c.redirect('/app/profile#kyc', ['ok', r.instant ? c.t('kyc.verified') : c.t('kyc.started')]);
  } catch (e) { c.redirect('/app/profile#kyc', ['error', err(c, e)]); }
});
post('/app/profile/kyc-doc', 'auth', (c) => {
  const u = c.user!;
  try {
    const rel = savePrivateFile(c.files.doc);
    if (!rel) throw new TradeError('kyc.upload');
    q.run("UPDATE users SET id_doc_path=?, kyc_status='pending', kyc_method='document', kyc_note=NULL WHERE id=?", rel, u.id);
    c.redirect('/app/profile#kyc', ['ok', c.t('kyc.submitted')]);
  } catch (e) { c.redirect('/app/profile#kyc', ['error', err(c, e)]); }
});

// ---------- Security ----------
function securityPage(c: Ctx, setup?: string) {
  const u = c.user!;
  render(c, h(V.AppSecurity, {
    setupSecret: setup, otpauth: setup ? otpauthUrl(setup, u.email) : undefined,
    sessions: q.all('SELECT * FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen DESC', u.id, now()),
    logins: q.all('SELECT * FROM login_events WHERE user_id=? ORDER BY id DESC LIMIT 10', u.id),
  }));
}
function pendingSecret(c: Ctx) {
  const [sec, sig] = String(c.cookies.totp_setup || '').split('.');
  return sec && sig && safeEqual(hmac(`${c.user!.id}:${sec}`), sig) ? sec : undefined;
}
get('/app/security', 'auth', (c) => securityPage(c, pendingSecret(c)));
post('/app/security/2fa/setup', 'auth', (c) => {
  const sec = newTotpSecret();
  c.setCookie('totp_setup', `${sec}.${hmac(`${c.user!.id}:${sec}`)}`, { maxAge: 900 });
  c.redirect('/app/security');
});
post('/app/security/2fa/enable', 'auth', (c) => {
  const sec = pendingSecret(c);
  if (!sec || !verifyTotp(sec, c.str('code', 8))) return c.redirect('/app/security', ['error', c.t('auth.bad_code')]);
  q.run('UPDATE users SET totp_secret=?, totp_enabled=1 WHERE id=?', sec, c.user!.id);
  c.setCookie('totp_setup', '', { maxAge: 0 });
  audit(c.user!.id, '2fa.enable', `user:${c.user!.id}`, undefined, c.ip);
  c.redirect(c.isAdmin ? '/admin' : '/app/security', ['ok', c.t('sec.enabled')]);
});
post('/app/security/2fa/disable', 'auth', (c) => {
  const u = c.user!;
  if (!verifyTotp(u.totp_secret, c.str('code', 8))) return c.redirect('/app/security', ['error', c.t('auth.bad_code')]);
  q.run('UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?', u.id);
  audit(u.id, '2fa.disable', `user:${u.id}`, undefined, c.ip);
  c.redirect('/app/security', ['ok', c.t('sec.disabled')]);
});
post('/app/security/password', 'auth', (c) => {
  const u = c.user!;
  const hash = q.val<string>('SELECT password_hash FROM users WHERE id=?', u.id);
  if (hash && !verifyPassword(String(c.body.current || ''), hash)) return c.redirect('/app/security', ['error', c.t('sec.bad_current')]);
  const pw = String(c.body.password || '');
  const prob = passwordProblem(pw);
  if (prob) return c.redirect('/app/security', ['error', c.t(prob)]);
  q.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(pw), u.id);
  q.run('DELETE FROM sessions WHERE user_id=? AND id!=?', u.id, c.sessionId);
  audit(u.id, 'password.change', `user:${u.id}`, undefined, c.ip);
  c.redirect('/app/security', ['ok', c.t('sec.pw_changed')]);
});
post('/app/security/signout-others', 'auth', (c) => {
  q.run('DELETE FROM sessions WHERE user_id=? AND id!=?', c.user!.id, c.sessionId);
  c.redirect('/app/security', ['ok', c.t('sec.signed_out')]);
});

// ---------- Support & notifications ----------
get('/app/support', 'auth', (c) => render(c, h(V.AppSupport, { tickets: q.all('SELECT * FROM tickets WHERE user_id=? ORDER BY id DESC', c.user!.id) })));
post('/app/support', 'auth', (c) => {
  if (!rateLimit(`ticket:${c.user!.id}`, 10, 3600)) return c.redirect('/app/support', ['error', c.t('auth.too_many')]);
  const id = q.insert('tickets', { user_id: c.user!.id, subject: c.str('subject', 120), body: c.str('body', 3000), created_at: now() }).id;
  supportOnTicket(id).catch(() => {}); // the support agent drafts (or sends) a reply
  c.redirect('/app/support', ['ok', c.t('support.sent')]);
});
get('/app/notifications', 'auth', (c) => render(c, h(V.AppNotifications, { items: q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', c.user!.id) })));
post('/app/notifications/read', 'auth', (c) => {
  q.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), c.user!.id);
  c.redirect('/app/notifications');
});
post('/api/push/subscribe', 'auth', (c) => {
  const s = c.body || {};
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth || !/^https:\/\//.test(s.endpoint)) return c.json({ ok: false }, 400);
  q.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id',
    c.user!.id, String(s.endpoint).slice(0, 1000), String(s.keys.p256dh).slice(0, 200), String(s.keys.auth).slice(0, 100), now());
  c.json({ ok: true });
});

export const _ = fmtNGN;
