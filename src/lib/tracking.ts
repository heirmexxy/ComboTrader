// Tracked links and attribution: which post, email or campaign brought a click, a lead or a sign-up.
import crypto from 'node:crypto';
import { q, now } from './db';
import { config } from './config';
import { randomToken } from './util';
import type { Ctx } from './http';

const sig = (s: string) => crypto.createHmac('sha256', config.secret).update(`r:${s}`).digest('base64url').slice(0, 8);
/** Short link /go/<code> that counts clicks and remembers the campaign when the visitor signs up. */
export function trackedLink(url: string, o: { channel: string; campaign: string; lessonId?: number | null }) {
  const full = url.startsWith('http') ? url : config.baseUrl + url;
  let code = randomToken(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 7);
  while (q.get('SELECT 1 FROM links WHERE code=?', code)) code = randomToken(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 7);
  const id = q.insert('links', { code, url: full, channel: o.channel, campaign: o.campaign.slice(0, 80), lesson_id: o.lessonId ?? null, created_at: now() }).id;
  return { id, code, url: `${config.baseUrl}/go/${code}` };
}
/** Adds a signed recipient so clicks in emails are credited to that person. */
export const forRecipient = (link: string, who: { userId?: number; leadId?: number }) => {
  const r = who.userId ? `u${who.userId}` : who.leadId ? `l${who.leadId}` : '';
  return r ? `${link}?r=${r}.${sig(r)}` : link;
};
/** Rewrites every link in an email body into tracked links (one per URL). */
export function trackHtmlLinks(html: string, o: { channel: string; campaign: string; lessonId?: number | null }, who?: { userId?: number; leadId?: number }) {
  const cache = new Map<string, string>();
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (m, url: string) => {
    if (url.includes('/unsubscribe') || url.includes('/u/') || url.includes('/email/stop/')) return m;
    if (!cache.has(url)) cache.set(url, trackedLink(url, o).url);
    return `href="${who ? forRecipient(cache.get(url)!, who) : cache.get(url)}"`;
  });
}

const SRC_COOKIE = 'ct_src';
/** First touch wins for 90 days: remembers utm_source/utm_campaign (or a tracked link) until sign-up. */
export function captureSource(c: Ctx, src?: { source: string; campaign: string }) {
  if (c.cookies[SRC_COOKIE]) return;
  const s = src || (c.query.utm_source ? { source: String(c.query.utm_source).slice(0, 40), campaign: String(c.query.utm_campaign || '').slice(0, 80) } : null);
  if (!s) return;
  c.setCookie(SRC_COOKIE, encodeURIComponent(`${s.source}|${s.campaign}`).slice(0, 200), { httpOnly: true, maxAge: 90 * 864e2 });
}
export function sourceOf(c: Ctx) {
  const v = c.cookies[SRC_COOKIE]; if (!v) return null;
  const [source, campaign] = decodeURIComponent(v).split('|');
  return source ? { source, campaign: campaign || '' } : null;
}
export function visitorId(c: Ctx) {
  let v = c.cookies.ct_vid;
  if (!v || !/^[\w-]{10,}$/.test(v)) { v = randomToken(12); c.setCookie('ct_vid', v, { httpOnly: true, maxAge: 365 * 864e2 }); }
  return v;
}
/** /go/:code — count the click, remember the campaign, send the visitor on. */
export function followLink(c: Ctx, code: string) {
  const l = q.get<any>('SELECT * FROM links WHERE code=?', code);
  if (!l) return null;
  let userId: number | null = null, leadId: number | null = null;
  const r = String(c.query.r || ''); const [who, s] = r.split('.');
  if (who && s && sig(who) === s) { if (who[0] === 'u') userId = Number(who.slice(1)) || null; if (who[0] === 'l') leadId = Number(who.slice(1)) || null; }
  const vid = visitorId(c);
  // One click per visitor per link per day.
  if (!q.get('SELECT 1 FROM link_clicks WHERE link_id=? AND visitor=? AND created_at>=?', l.id, vid, new Date(Date.now() - 864e5).toISOString())) {
    q.insert('link_clicks', { link_id: l.id, user_id: userId ?? c.user?.id ?? null, lead_id: leadId, visitor: vid, created_at: now() });
    q.run('UPDATE links SET clicks=clicks+1 WHERE id=?', l.id);
  }
  captureSource(c, { source: l.channel, campaign: `${l.campaign}#${l.id}` });
  const u = new URL(l.url);
  if (u.origin === new URL(config.baseUrl).origin && !u.searchParams.has('utm_source')) { u.searchParams.set('utm_source', l.channel); u.searchParams.set('utm_campaign', l.campaign); }
  return u.toString();
}
/** Sign-ups credited to a tracked link (campaign ends with #<link id>). */
export const signupsFor = (linkId: number) => Number(q.val("SELECT COUNT(*) FROM users WHERE acq_campaign LIKE ?", `%#${linkId}`) ?? 0);
