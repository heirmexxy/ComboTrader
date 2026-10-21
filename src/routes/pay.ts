// Payments, webhooks, share cards, certificate checks and machine endpoints.
import { get, post } from '../lib/router';
import { render, useC } from '../views/render';
import { createElement as h } from 'react';
import { AuthLayout, PublicLayout } from '../views/layout';
import { Csrf, Money } from '../views/components';
import { q, now } from '../lib/db';
import { confirmPayment, completeWithdrawal } from '../lib/wallet';
import * as paystack from '../lib/paystack';
import { harvestCardPng } from '../lib/cards';
import { fmtNGN, safeEqual } from '../lib/util';
import { config } from '../lib/config';
import { HttpError, type Ctx } from '../lib/http';
import { audit } from '../lib/audit';
import { notify } from '../lib/notify';
import { userById } from '../lib/auth';
import { runJob, JOBS } from '../lib/jobs';
import { recordPrice } from '../lib/prices';
import { translate } from '../lib/i18n';
import { PageHead } from '../views/public/pages';
import { fmtDate } from '../lib/i18n';

get('/pay/callback', 'public', async (c) => {
  const ref = String(c.query.reference || c.query.trxref || '');
  const r = await confirmPayment(ref).catch(() => ({ ok: false as const, reason: 'error' }));
  if (r.ok) return c.redirect('/app/wallet', ['ok', c.t('wallet.funded', { amount: fmtNGN(r.payment.amount - r.payment.fee) })]);
  c.redirect('/app/wallet', ['error', r.reason === 'pending' || r.reason === 'error' ? c.t('wallet.payment_pending') : c.t('wallet.payment_failed')]);
});

// Simulated checkout, only when no Paystack key is configured and demo mode is allowed.
function DemoCheckout({ p }: { p: any }) {
  const c = useC();
  return h(AuthLayout, { title: c.t('wallet.demo_pay') },
    h('h1', null, c.t('wallet.demo_pay')),
    h('p', { className: 'demo-banner' }, c.t('app.demo_banner')),
    h('p', { className: 'price-big' }, h(Money, { kobo: p.amount })),
    h('p', { className: 'muted small' }, p.reference),
    h('form', { method: 'post', action: `/pay/demo/${p.reference}` }, h(Csrf),
      h('button', { className: 'btn btn-primary btn-block', name: 'result', value: 'success', type: 'submit' }, 'Simulate successful payment'),
      h('button', { className: 'btn btn-ghost btn-block mt', name: 'result', value: 'failed', type: 'submit' }, 'Simulate failed payment')));
}
get('/pay/demo/:ref', 'auth', (c) => {
  if (!paystack.isDemo() || !config.demoMode) throw new HttpError(404, 'Not found');
  const p = q.get<any>('SELECT * FROM payments WHERE reference=? AND user_id=?', c.params.ref, c.user!.id);
  if (!p) throw new HttpError(404, 'Not found');
  render(c, h(DemoCheckout, { p }));
});
post('/pay/demo/:ref', 'auth', async (c) => {
  if (!paystack.isDemo() || !config.demoMode) throw new HttpError(404, 'Not found');
  const p = q.get<any>('SELECT * FROM payments WHERE reference=? AND user_id=?', c.params.ref, c.user!.id);
  if (!p) throw new HttpError(404, 'Not found');
  if (c.body.result === 'success') {
    await confirmPayment(p.reference, { demoSuccess: true });
    return c.redirect('/app/wallet', ['ok', c.t('wallet.funded', { amount: fmtNGN(p.amount - p.fee) })]);
  }
  q.run("UPDATE payments SET status='failed' WHERE id=? AND status='pending'", p.id);
  c.redirect('/app/wallet', ['error', c.t('wallet.payment_failed')]);
});

// Paystack webhook: signature-checked, idempotent, always re-verifies with Paystack.
post('/webhooks/paystack', 'public', async (c) => {
  if (!paystack.webhookValid(c.rawBody, c.req.headers['x-paystack-signature'] as string)) return c.send(401, 'bad signature');
  let evt: any;
  try { evt = JSON.parse(c.rawBody.toString()); } catch { return c.send(400, 'bad json'); }
  const d = evt.data || {};
  try {
    switch (evt.event) {
      case 'charge.success': await confirmPayment(d.reference); break;
      case 'transfer.success': completeWithdrawal(d.reference, true); break;
      case 'transfer.failed':
      case 'transfer.reversed': completeWithdrawal(d.reference, false, evt.event); break;
      case 'customeridentification.success':
      case 'customeridentification.failed': {
        const u = q.get<any>('SELECT * FROM users WHERE paystack_customer_code=?', d.customer_code);
        if (u) {
          const ok = evt.event.endsWith('success');
          q.run('UPDATE users SET kyc_status=?, kyc_method=?, kyc_note=? WHERE id=?', ok ? 'verified' : 'rejected', 'bvn', ok ? null : String(d.reason || '').slice(0, 300), u.id);
          notify(u, ok ? 'kyc_verified' : 'kyc_rejected', { reason: String(d.reason || '') }, { link: '/app/profile', sms: true });
        }
        break;
      }
    }
    audit(null, `webhook.${evt.event}`, d.reference || d.customer_code);
  } catch (e: any) {
    audit(null, 'webhook.error', d.reference, String(e?.message || e));
    return c.send(500, 'error'); // Paystack retries
  }
  c.send(200, 'ok');
});

// ---------- Harvest Card (shareable image) ----------
const cardCache = new Map<string, Buffer>();
get('/card/:token', 'public', async (c) => {
  const token = c.params.token.replace(/\.png$/, '');
  const t = q.get<any>(`SELECT t.*, u.first_name, u.referral_code, u.lang, l.tonnage, l.target_amount, l.farmers, l.code, c.name AS commodity
    FROM trades t JOIN users u ON u.id=t.user_id JOIN lots l ON l.id=t.lot_id JOIN commodities c ON c.code=l.commodity WHERE t.share_token=?`, token);
  if (!t) throw new HttpError(404, 'Not found');
  const lang = (c.query.lang as any) || t.lang;
  const key = `${token}:${lang}`;
  let png = cardCache.get(key);
  if (!png) {
    png = await harvestCardPng({ firstName: t.first_name, tons: (t.amount / t.target_amount) * t.tonnage, commodity: t.commodity, farmers: Math.max(1, Math.round((t.amount / t.target_amount) * t.farmers)), code: t.certificate_no, refCode: t.referral_code, lang });
    if (cardCache.size > 500) cardCache.clear();
    cardCache.set(key, png);
  }
  c.send(200, png, 'image/png', { 'Cache-Control': 'public, max-age=86400' });
});

// ---------- Public certificate check ----------
function VerifyPage({ cert }: { cert: any }) {
  const c = useC();
  return h(PublicLayout, { title: c.t('verify.title'), noindex: true },
    h(PageHead, { title: c.t('verify.title') }),
    h('section', { className: 'section' }, h('div', { className: 'container narrow' }, h('div', { className: 'card' },
      cert ? [
        h('p', { key: 'v', className: 'flash flash-ok' }, c.t('verify.valid')),
        h('dl', { key: 'd', className: 'kv' },
          h('dt', null, c.t('trades.cert_no')), h('dd', null, cert.certificate_no),
          h('dt', null, c.t('verify.holder')), h('dd', null, `${cert.first_name} ${String(cert.last_name).slice(0, 1)}.`),
          h('dt', null, c.t('nav.lots')), h('dd', null, `${cert.title} (${cert.code})`),
          h('dt', null, c.t('trades.started')), h('dd', null, fmtDate(c.lang, cert.start_at)),
          h('dt', null, c.t('trades.matures')), h('dd', null, fmtDate(c.lang, cert.matures_at)),
          h('dt', null, c.t('common.status')), h('dd', null, c.t(`trades.status.${cert.status}`))),
      ] : h('p', { className: 'flash flash-error' }, c.t('verify.invalid'))))));
}
get('/verify/:cert', 'public', (c) => {
  const cert = q.get<any>('SELECT t.*, u.first_name, u.last_name, l.title, l.code FROM trades t JOIN users u ON u.id=t.user_id JOIN lots l ON l.id=t.lot_id WHERE t.certificate_no=?', c.params.cert.toUpperCase());
  render(c, h(VerifyPage, { cert }));
});

// ---------- Machine endpoints (Bearer CRON_SECRET) ----------
function machine(c: Ctx) {
  const auth = String(c.req.headers.authorization || '');
  if (!config.cronSecret || !safeEqual(auth, `Bearer ${config.cronSecret}`)) throw new HttpError(401, 'Unauthorized');
}
post('/api/cron/:job', 'public', async (c) => {
  machine(c);
  if (!JOBS[c.params.job]) throw new HttpError(404, 'Unknown job');
  c.json({ job: c.params.job, status: await runJob(c.params.job) });
});
/** Kitovu's own buying prices from eProcure: { prices: [{ commodity, price_per_kg (naira), market?, date? }] } */
post('/api/prices/ingest', 'public', (c) => {
  machine(c);
  const items = Array.isArray(c.body.prices) ? c.body.prices : [];
  const out = items.slice(0, 200).map((p: any) => recordPrice({ commodity: String(p.commodity), pricePerKg: Math.round(Number(p.price_per_kg) * 100), market: p.market ? String(p.market) : null, sourceName: 'Kitovu eProcure', observedOn: p.date ? String(p.date) : undefined }));
  c.json({ recorded: out.filter(Boolean).length, held: out.filter((x: any) => x?.held).length });
});

export const _ = { translate, userById, now };
