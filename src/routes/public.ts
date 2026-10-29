import { get, post } from '../lib/router';
import { render } from '../views/render';
import { createElement as h } from 'react';
import * as P from '../views/public/pages';
import { ChroniclesPage, PostPage, CATEGORIES } from '../views/public/blog';
import { q, now } from '../lib/db';
import { openLots, publicLots, getLotByCode, siteStats, trailFor } from '../lib/trading';
import { latestPrices, priceHistory } from '../lib/prices';
import { publicCircles, circlesVisibleTo } from '../lib/circles';
import { settings } from '../lib/settings';
import { faqsFor, postsFor, postBySlug, md } from '../lib/content';
import { feedItems } from '../lib/feed';
import { isLang, translate } from '../lib/i18n';
import { isEmail, randomToken, hmac, safeEqual } from '../lib/util';
import { followLink, sourceOf } from '../lib/tracking';
import { queueEmail, emailShell } from '../lib/notify';
import { config } from '../lib/config';
import { HttpError, type Ctx } from '../lib/http';
import { LEGAL } from '../content/legal';
import { rateLimit } from '../lib/auth';

const commodities = () => q.all<{ code: string; name: string }>('SELECT code, name FROM commodities WHERE active=1 ORDER BY sort, name');
const topRate = () => Number(q.val("SELECT MAX(rate_bps) FROM lots WHERE status='open'") || 2000);

get('/', 'public', (c) => {
  const lots = openLots(3);
  const heroDone = lots[0] ? trailFor(lots[0].id).map((e: any) => e.stage) : [];
  render(c, h(P.Home, { stats: siteStats(), lots, circles: settings().circles_mode === 'on', rateBps: topRate(), heroDone }));
});
get('/how-it-works', 'public', (c) => render(c, h(P.HowItWorks, { faqs: faqsFor(c.lang) })));
get('/lots', 'public', (c) => render(c, h(P.LotsPage, { lots: publicLots(), commodities: commodities() })));
get('/lots/:code', 'public', (c) => {
  const lot = getLotByCode(c.params.code);
  if (!lot || lot.status === 'draft') throw new HttpError(404, 'Not found');
  render(c, h(P.LotDetail, { lot, trail: trailFor(lot.id), commodities: commodities() }));
});
get('/circles', 'public', (c) => {
  const visible = circlesVisibleTo(c.user);
  render(c, h(P.CirclesPage, { circles: visible ? publicCircles() : [], visible, mode: settings().circles_mode }));
});
get('/prices', 'public', (c) => {
  const prices = latestPrices();
  const history: Record<string, number[]> = {};
  for (const p of prices) history[p.commodity] = priceHistory(p.commodity).map((x) => x.price_per_kg);
  render(c, h(P.PricesPage, { prices, history }));
});
get('/why-kitovu', 'public', (c) => render(c, h(P.WhyPage, { stats: siteStats() })));
get('/faqs', 'public', (c) => render(c, h(P.FaqsPage, { faqs: faqsFor(c.lang) })));
get('/install', 'public', (c) => render(c, h(P.InstallPage)));
get('/calculator', 'public', (c) => render(c, h(P.CalculatorPage)));
// Lead page for social posts and ads.
get('/join', 'public', (c) => render(c, h(P.JoinPage, { sent: c.query.sent === '1', commodities: q.all<any>('SELECT code, name FROM commodities WHERE active=1 ORDER BY sort') })));
post('/join', 'public', (c) => {
  if (c.str('website')) return c.redirect('/join?sent=1');
  if (!rateLimit(`join:${c.ip}`, 10, 3600)) throw new HttpError(429, c.t('auth.too_many'));
  const email = c.str('email', 200).toLowerCase();
  if (!isEmail(email) || !c.str('name') || !c.bool('consent')) return c.redirect('/join#join-form', ['error', c.t('auth.required')]);
  const src = sourceOf(c);
  const interest = c.str('interest', 40) || 'any';
  const existing = q.get<any>('SELECT * FROM leads WHERE email=?', email);
  if (existing) q.run("UPDATE leads SET consent=1, interest=?, status=CASE WHEN status='unsubscribed' THEN 'new' ELSE status END WHERE id=?", interest, existing.id);
  else q.insert('leads', { email, phone: c.str('phone', 30) || null, name: c.str('name', 60).split(' ')[0], lang: c.lang, source: src?.source || 'website', campaign: src?.campaign || null, interest, consent: 1, token: randomToken(16), created_at: now() });
  if (interest !== 'any' || !q.get("SELECT 1 FROM waitlist WHERE email=? AND notified_at IS NULL", email)) q.insert('waitlist', { email, commodity: interest, created_at: now() });
  c.redirect('/join?sent=1');
});
// Tracked links from posts and emails.
get('/go/:code', 'public', (c) => { const to = followLink(c, c.params.code.slice(0, 12)); c.redirect(to || '/'); });
// Marketing opt-out for Champions (service messages about their own trades still arrive).
get('/email/stop/:token', 'public', (c) => {
  const [id, s] = c.params.token.split('.');
  if (id && s && safeEqual(hmac(`stop:${id}`).slice(0, 16), s)) { q.run('UPDATE users SET marketing_opt_in=0 WHERE id=?', Number(id)); return c.redirect('/', ['ok', c.t('agent.unsubscribed')]); }
  c.redirect('/', ['error', c.t('agent.unsub_unknown')]);
});
get('/contact', 'public', (c) => render(c, h(P.ContactPage, { sent: c.query.sent === '1' })));
post('/contact', 'public', (c) => {
  if (c.str('website')) return c.redirect('/contact?sent=1'); // honeypot
  if (!rateLimit(`contact:${c.ip}`, 5, 3600)) throw new HttpError(429, c.t('auth.too_many'));
  const email = c.str('email', 200), message = c.str('message', 3000);
  if (!isEmail(email) || !message) return c.redirect('/contact', ['error', c.t('auth.required')]);
  q.insert('contact_messages', { name: c.str('name', 120), email, message, created_at: now() });
  c.redirect('/contact?sent=1');
});

get('/legal/:kind', 'public', (c) => {
  const kind = c.params.kind;
  if (!LEGAL[kind]) throw new HttpError(404, 'Not found');
  const override = q.get<{ value: string }>("SELECT value FROM page_text WHERE key=? AND lang='en'", `legal.${kind}.body`);
  render(c, h(P.LegalPage, { kind, html: md(override?.value || LEGAL[kind]) }));
});

// Language switch: remembered in a cookie and on the Champion's profile.
get('/lang/:code', 'public', (c) => {
  const code = c.params.code;
  if (isLang(code)) {
    c.setCookie('lang', code, { maxAge: 365 * 86400 });
    if (c.user) q.run('UPDATE users SET lang=? WHERE id=?', code, c.user.id);
  }
  const back = String(c.query.back || '/');
  c.redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/');
});

// Waitlist for the next lot of a commodity.
post('/waitlist', 'public', (c) => {
  const commodity = c.str('commodity', 40);
  if (commodity !== 'any' && !q.get('SELECT 1 FROM commodities WHERE code=?', commodity)) return c.back('/lots');
  const email = c.user ? null : c.str('email', 200).toLowerCase();
  if (!c.user && !isEmail(email || '')) return c.back('/lots', ['error', c.t('auth.bad_email')]);
  const exists = c.user
    ? q.get('SELECT 1 FROM waitlist WHERE user_id=? AND commodity=? AND notified_at IS NULL', c.user.id, commodity)
    : q.get('SELECT 1 FROM waitlist WHERE email=? AND commodity=? AND notified_at IS NULL', email, commodity);
  if (!exists) q.insert('waitlist', { user_id: c.user?.id ?? null, email, commodity, created_at: now() });
  const name = commodity === 'any' ? c.t('lot.any_commodity').toLowerCase() : q.val<string>('SELECT name FROM commodities WHERE code=?', commodity) || commodity;
  c.back('/lots', ['ok', commodity === 'any' ? c.t('lot.waitlist_ok_any') : c.t('lot.waitlist_ok', { commodity: name })]);
});

// ---------- Chronicles ----------
get('/chronicles', 'public', (c) => {
  const cat = CATEGORIES.includes(String(c.query.cat)) ? String(c.query.cat) : undefined;
  const search = String(c.query.q || '').slice(0, 80) || undefined;
  render(c, h(ChroniclesPage, { posts: postsFor(c.lang, { cat, search }), cat, search }));
});
get('/chronicles/:slug', 'public', (c) => {
  const r = postBySlug(c.params.slug, c.lang);
  if (!r) throw new HttpError(404, 'Not found');
  const related = postsFor(c.lang, { cat: r.post.category, limit: 4 }).filter((p) => p.slug !== r.post.slug).slice(0, 3);
  render(c, h(PostPage, { post: r.post, html: md(r.post.body), related, fallback: r.fallback }));
});
get('/chronicles.rss', 'public', (c) => {
  const items = postsFor('en', { limit: 20 }).map((p) => `<item><title>${xml(p.title)}</title><link>${config.baseUrl}/chronicles/${p.slug}</link><guid>${config.baseUrl}/chronicles/${p.slug}</guid><pubDate>${new Date(p.publish_at || p.created_at).toUTCString()}</pubDate><description>${xml(p.excerpt || '')}</description></item>`).join('');
  c.send(200, `<?xml version="1.0"?><rss version="2.0"><channel><title>Harvest Champions Chronicles</title><link>${config.baseUrl}/chronicles</link><description>ComboTrader</description>${items}</channel></rss>`, 'application/rss+xml; charset=utf-8');
});
const xml = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]!));

// ---------- Newsletter (double opt-in) ----------
get('/newsletter', 'public', (c) => render(c, h(P.NewsletterPage, { state: c.query.s as any })));
post('/newsletter', 'public', (c) => {
  const email = c.str('email', 200).toLowerCase();
  if (!isEmail(email)) return c.back('/newsletter', ['error', c.t('auth.bad_email')]);
  if (!rateLimit(`nl:${c.ip}`, 10, 3600)) throw new HttpError(429, c.t('auth.too_many'));
  const ex = q.get<any>('SELECT * FROM subscribers WHERE email=?', email);
  if (ex?.status === 'confirmed') return c.redirect('/newsletter?s=already');
  const token = ex?.token || randomToken(18);
  const userId = q.val<number>('SELECT id FROM users WHERE email=?', email) ?? null;
  if (ex) q.run("UPDATE subscribers SET status='pending', lang=? WHERE id=?", c.lang, ex.id);
  else q.insert('subscribers', { email, lang: c.lang, user_id: userId, status: 'pending', token, created_at: now() });
  const t = (k: string) => translate(c.lang, k);
  queueEmail(email, t('nl.confirm_subject'), emailShell(t('nl.confirm_subject'), `<p>${t('nl.confirm_body')}</p>`, { label: t('nl.confirm_btn'), url: `${config.baseUrl}/newsletter/confirm/${token}` }));
  c.redirect('/newsletter?s=check');
});
get('/newsletter/confirm/:token', 'public', (c) => {
  const r = q.run("UPDATE subscribers SET status='confirmed', confirmed_at=? WHERE token=? AND status!='unsubscribed'", now(), c.params.token);
  c.redirect(r.changes ? '/newsletter?s=confirmed' : '/newsletter');
});
// One-click opt-out from invitations (leads) and partnership emails (organisations).
get('/u/:token', 'public', (c) => {
  const t = c.params.token;
  const l = q.run("UPDATE leads SET status='unsubscribed' WHERE token=?", t).changes;
  const o = q.run("UPDATE prospects SET status='do_not_contact' WHERE token=?", t).changes;
  if (l) { const e = q.val<string>('SELECT email FROM leads WHERE token=?', t); if (e) q.run("UPDATE subscribers SET status='unsubscribed' WHERE email=?", e); }
  c.redirect('/', ['ok', l || o ? c.t('agent.unsubscribed') : c.t('agent.unsub_unknown')]);
});
get('/newsletter/unsubscribe/:token', 'public', (c) => {
  q.run("UPDATE subscribers SET status='unsubscribed' WHERE token=?", c.params.token);
  c.redirect('/newsletter?s=unsubscribed');
});

// ---------- Public JSON ----------
get('/api/feed', 'public', (c) => c.json(feedItems(c.lang)));
get('/api/prices', 'public', (c) => c.json({ prices: latestPrices().map((p) => ({ ...p, price_per_kg: p.price_per_kg / 100 })) }));

// ---------- SEO ----------
get('/robots.txt', 'public', (c) => c.send(200, `User-agent: *\nDisallow: /app\nDisallow: /admin\nDisallow: /api\nSitemap: ${config.baseUrl}/sitemap.xml\n`));
get('/sitemap.xml', 'public', (c) => {
  const paths = ['/', '/how-it-works', '/lots', '/prices', '/why-kitovu', '/chronicles', '/faqs', '/contact', '/newsletter', '/install', '/calculator',
    ...publicLots().map((l) => `/lots/${l.code}`), ...postsFor('en', { limit: 500 }).map((p) => `/chronicles/${p.slug}`)];
  c.send(200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${config.baseUrl}${p}</loc></url>`).join('')}</urlset>`, 'application/xml');
});

export const _ = (c: Ctx) => c;
