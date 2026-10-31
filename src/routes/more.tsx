// Champion routes for Harvest Plan, Gift a Harvest, Keep Growing, impact receipts, data rights, statements and WhatsApp.
import { handleMetaWebhook, metaSignatureValid } from '../lib/marketing';
import { get, post } from '../lib/router';
import { render } from '../views/render';
import * as M from '../views/app/more';
import { q, now } from '../lib/db';
import { walletBalance } from '../lib/ledger';
import { openLots, TradeError, isRollover } from '../lib/trading';
import { createPlan, getPlan, planSaved, userPlans, topUpPlan, releasePlanSavings, setPlanPaused } from '../lib/plans';
import { createGift, giftByToken, claimGift, cancelGift, giftsBy, giftsTo } from '../lib/gifts';
import { exportUserData, closeAccount, statementPdf } from '../lib/account';
import { processWebhook, signatureValid } from '../lib/whatsapp';
import { settings } from '../lib/settings';
import { verifyTotp } from '../lib/totp';
import { rateLimit, destroySession } from '../lib/auth';
import { parseNaira, randomToken, sha256, fmtNGN } from '../lib/util';
import { queueEmail, queueSms, emailShell, escapeHtml } from '../lib/notify';
import { audit } from '../lib/audit';
import { config } from '../lib/config';
import { HttpError, type Ctx } from '../lib/http';

const err = (c: Ctx, e: unknown) => (e instanceof TradeError ? c.t(e.key, e.vars) : (e as Error).message);
const commodities = () => q.all<{ code: string; name: string }>('SELECT code, name FROM commodities WHERE active=1 ORDER BY sort, name');

// ---------- Harvest Plan ----------
function plansOn() { if (!settings().plans_enabled) throw new HttpError(404, 'Not found'); }
get('/app/plans', 'auth', (c) => { plansOn(); render(c, <M.AppPlans plans={userPlans(c.user!.id)} commodities={commodities()} />); });
post('/app/plans', 'auth', async (c) => {
  plansOn();
  try {
    if (!c.bool('agree')) throw new TradeError('auth.must_agree');
    if (!rateLimit(`plan:${c.user!.id}`, 10, 3600)) throw new TradeError('auth.too_many');
    const r = await createPlan(c.user!, { name: c.str('name', 60), target: parseNaira(c.body.target), monthly: parseNaira(c.body.monthly), day: c.int('day'), commodity: c.str('commodity', 40) || null });
    c.redirect(r.url);
  } catch (e) { render(c, <M.AppPlans plans={userPlans(c.user!.id)} commodities={commodities()} error={err(c, e)} />, 422); }
});
function myPlan(c: Ctx) {
  const p = getPlan(Number(c.params.id));
  if (!p || p.user_id !== c.user!.id || p.status === 'setup') throw new HttpError(404, 'Not found');
  return { ...p, saved: planSaved(p) };
}
get('/app/plans/:id', 'auth', (c) => render(c, <M.PlanDetail p={myPlan(c)} />));
post('/app/plans/:id/topup', 'auth', async (c) => {
  const p = myPlan(c);
  try { c.redirect(await topUpPlan(c.user!, p.id, parseNaira(c.body.amount))); } catch (e) { c.redirect(`/app/plans/${p.id}`, ['error', err(c, e)]); }
});
post('/app/plans/:id/pause', 'auth', (c) => { const p = myPlan(c); setPlanPaused(c.user!, p.id, true); c.redirect(`/app/plans/${p.id}`, ['ok', c.t('plan.paused_ok')]); });
post('/app/plans/:id/resume', 'auth', (c) => { const p = myPlan(c); setPlanPaused(c.user!, p.id, false); c.redirect(`/app/plans/${p.id}`, ['ok', c.t('plan.resumed_ok')]); });
post('/app/plans/:id/release', 'auth', (c) => { const p = myPlan(c); const n = releasePlanSavings(c.user!, p.id, false); c.redirect(`/app/plans/${p.id}`, ['ok', c.t('plan.released_ok', { amount: fmtNGN(n) })]); });
post('/app/plans/:id/cancel', 'auth', (c) => { const p = myPlan(c); const n = releasePlanSavings(c.user!, p.id, true); c.redirect('/app/plans', ['ok', c.t('plan.cancelled_ok', { amount: fmtNGN(n) })]); });

// ---------- Gift a Harvest ----------
function giftsOn() { if (!settings().gifts_enabled) throw new HttpError(404, 'Not found'); }
const giftsPage = (c: Ctx, error?: string, status = 200) => render(c, <M.AppGifts lots={openLots()} sent={giftsBy(c.user!.id)} received={giftsTo(c.user!.id)} wallet={walletBalance(c.user!.id)} error={error} />, status);
get('/app/gifts', 'auth', (c) => { giftsOn(); giftsPage(c); });
post('/app/gifts', 'auth', (c) => {
  giftsOn();
  try {
    if (!c.bool('agree')) throw new TradeError('auth.must_agree');
    if (!rateLimit(`gift:${c.user!.id}`, 20, 86400)) throw new TradeError('auth.too_many');
    createGift(c.user!, { lotId: c.int('lot_id'), amount: parseNaira(c.body.amount), recipientName: c.str('recipient_name', 80), recipientEmail: c.str('recipient_email', 200), recipientPhone: c.str('recipient_phone', 30), message: c.str('message', 300) });
    c.redirect('/app/gifts', ['ok', c.t('gift.sent_ok', { name: c.str('recipient_name', 80) })]);
  } catch (e) { giftsPage(c, err(c, e), 422); }
});
post('/app/gifts/:id/cancel', 'auth', (c) => {
  try { cancelGift(c.user!, Number(c.params.id)); c.redirect('/app/gifts', ['ok', c.t('gift.cancelled_ok')]); } catch (e) { c.redirect('/app/gifts', ['error', err(c, e)]); }
});
post('/app/gifts/:id/resend', 'auth', (c) => {
  const g = q.get<any>("SELECT g.*, t.amount FROM gifts g JOIN trades t ON t.id=g.trade_id WHERE g.id=? AND g.giver_id=? AND g.status='sent'", Number(c.params.id), c.user!.id);
  if (!g) return c.redirect('/app/gifts', ['error', c.t('gift.invalid')]);
  if (!rateLimit(`gift-resend:${g.id}`, 3, 86400)) return c.redirect('/app/gifts', ['error', c.t('auth.too_many')]);
  const raw = randomToken(18);
  q.run('UPDATE gifts SET token_hash=? WHERE id=?', sha256(raw), g.id); // the old link stops working
  const url = `${config.baseUrl}/gift/${raw}`;
  if (g.recipient_email) queueEmail(g.recipient_email, `${c.user!.first_name} sent you a Harvest gift`, emailShell(`A Harvest gift from ${escapeHtml(c.user!.first_name)}`, `<p>Hello ${escapeHtml(g.recipient_name)}, a reminder that a ${fmtNGN(g.amount)} harvest trade is waiting for you.</p>`, { label: 'Claim your gift', url }));
  if (g.recipient_phone) queueSms(g.recipient_phone, `ComboTrader: ${c.user!.first_name} sent you a ${fmtNGN(g.amount)} Harvest gift. Claim it: ${url}`);
  c.redirect('/app/gifts', ['ok', c.t('gift.resent_ok')]);
});
get('/gift/:token', 'public', (c) => render(c, <M.GiftClaim g={giftByToken(c.params.token)} token={c.params.token} />));
post('/gift/:token/claim', 'auth', (c) => {
  try {
    const tradeId = claimGift(c.user!, c.params.token);
    c.redirect(`/app/trades/${tradeId}`, ['ok', c.t('gift.claimed_ok')]);
  } catch (e) { render(c, <M.GiftClaim g={giftByToken(c.params.token)} token={c.params.token} error={err(c, e)} />, 422); }
});

// ---------- Keep Growing ----------
post('/app/trades/:id/rollover', 'auth', (c) => {
  const v = c.body.rollover;
  if (!isRollover(v)) throw new HttpError(400, 'Bad value');
  const r = q.run("UPDATE trades SET rollover=? WHERE id=? AND user_id=? AND status IN ('active','matured')", v, Number(c.params.id), c.user!.id);
  if (!r.changes) throw new HttpError(404, 'Not found');
  c.redirect(`/app/trades/${c.params.id}`, ['ok', c.t('roll.saved')]);
});
post('/app/profile/preferences', 'auth', (c) => {
  const v = isRollover(c.body.rollover_default) ? c.body.rollover_default : 'off';
  q.run('UPDATE users SET rollover_default=?, whatsapp_opt_in=? WHERE id=?', v, c.bool('whatsapp_opt_in') ? 1 : 0, c.user!.id);
  c.redirect('/app/profile#growing', ['ok', c.t('profile.saved')]);
});

// ---------- Impact receipt (public) ----------
get('/receipt/:token', 'public', (c) => {
  const r = q.get<any>(`SELECT t.amount, t.certificate_no, t.status, u.first_name, u.referral_code, l.tonnage, l.target_amount, l.farmers, l.region, c.name AS commodity,
      (SELECT stage FROM trail_events WHERE lot_id=l.id ORDER BY happened_at DESC, id DESC LIMIT 1) AS stage
    FROM trades t JOIN users u ON u.id=t.user_id JOIN lots l ON l.id=t.lot_id JOIN commodities c ON c.code=l.commodity WHERE t.share_token=? AND u.status='active'`, c.params.token);
  if (!r) throw new HttpError(404, 'Not found');
  render(c, <M.ImpactReceipt r={r} token={c.params.token} />);
});

// ---------- Data rights and statements ----------
get('/app/profile/export.json', 'auth', (c) => {
  if (!rateLimit(`export:${c.user!.id}`, 5, 3600)) throw new HttpError(429, c.t('auth.too_many'));
  audit(c.user!.id, 'data.export', `user:${c.user!.id}`, undefined, c.ip);
  c.send(200, JSON.stringify(exportUserData(c.user!.id), null, 2), 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="combotrader-my-data-${now().slice(0, 10)}.json"` });
});
post('/app/profile/close', 'auth', (c) => {
  const u = c.user!;
  if (c.isAdmin) return c.redirect('/app/profile#data', ['error', 'Admins cannot close their account here.']);
  if (c.str('confirm', 20).toUpperCase() !== 'CLOSE') return c.redirect('/app/profile#data', ['error', c.t('close.type_hint')]);
  try {
    closeAccount(u, c.str('reason', 300));
    destroySession(c);
    c.redirect('/', ['ok', c.t('close.done')]);
  } catch (e) { c.redirect('/app/profile#data', ['error', err(c, e)]); }
});
get('/app/wallet/statement.pdf', 'auth', async (c) => {
  const y = Number(c.query.year) || new Date().getUTCFullYear();
  if (y < 2020 || y > 2100) throw new HttpError(400, 'Bad year');
  const pdf = await statementPdf(c.user!, y);
  c.send(200, pdf, 'application/pdf', { 'Content-Disposition': `inline; filename="ComboTrader-statement-${y}.pdf"` });
});

// ---------- WhatsApp Cloud API webhook ----------
// Facebook Page + Instagram webhooks: lead forms, comments, DMs (Social agent).
get('/webhooks/meta', 'public', (c) => {
  const qy = c.query;
  if (qy['hub.mode'] === 'subscribe' && config.metaVerifyToken && qy['hub.verify_token'] === config.metaVerifyToken) return c.send(200, String(qy['hub.challenge'] || ''));
  c.send(403, 'forbidden');
});
post('/webhooks/meta', 'public', async (c) => {
  if (!metaSignatureValid(c.rawBody, c.req.headers['x-hub-signature-256'] as string)) return c.send(401, 'bad signature');
  let body: any;
  try { body = JSON.parse(c.rawBody.toString()); } catch { return c.send(400, 'bad json'); }
  c.send(200, 'ok');
  handleMetaWebhook(body).catch((e) => audit(null, 'social.webhook_error', undefined, String(e?.message || e)));
});
get('/webhooks/whatsapp', 'public', (c) => {
  const qy = c.query;
  if (qy['hub.mode'] === 'subscribe' && config.waVerifyToken && qy['hub.verify_token'] === config.waVerifyToken) return c.send(200, String(qy['hub.challenge'] || ''));
  c.send(403, 'forbidden');
});
post('/webhooks/whatsapp', 'public', async (c) => {
  if (!signatureValid(c.rawBody, c.req.headers['x-hub-signature-256'] as string)) return c.send(401, 'bad signature');
  let body: any;
  try { body = JSON.parse(c.rawBody.toString()); } catch { return c.send(400, 'bad json'); }
  c.send(200, 'ok'); // acknowledge fast; Meta retries slow webhooks
  processWebhook(body).catch((e) => audit(null, 'whatsapp.error', undefined, String(e?.message || e)));
});
