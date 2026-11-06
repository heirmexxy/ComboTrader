// Marketing agents (RevOps): Social media and Email marketing.
// Both work in rules mode (templates + what they have learned) and in AI mode (Claude writes, rules learn from it).
// Every post and email carries tracked links, so each template is scored by clicks and sign-ups and the best ones win.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { q, now } from './db';
import { config } from './config';
import { settings } from './settings';
import { completeJson, useAI, AiUnavailable, POLICY, logRun } from './ai';
import { propose, registerExecutors, agentOn, supportAnswer, AGENT_JOBS, executeAction } from './agents';
import { learn, bestLesson, lessonsFor, parseLesson, used, scoreLesson, trackOutcome, fill, lessonScore, type Lesson } from './learning';
import { trackedLink, forRecipient, signupsFor } from './tracking';
import { queueEmail, emailShell, escapeHtml } from './notify';
import { audit } from './audit';
import { translate, isLang, type Lang } from './i18n';
import { fmtNGN, randomToken, hmac, lagosNow } from './util';
import { siteStats, rateFor, lotPeriods, stageLabel } from './trading';
import { walletBalance } from './ledger';
import { marketOn, openListings, quote } from './market';
import { BRAND, MARK_SVG, BRAND_VOICE, useBrandFonts } from './brand';
import { botLink } from './telegram';
import { playbookFor, offMessage } from '../content/playbook';
import { CHAMPION_EMAILS } from '../content/library/emails';
import { liReady, liPost } from './linkedin';
import { GRAPH, fbPageId, fbPageToken, igUserId } from './meta';

// ================= Channels =================
export const CHANNELS = ['facebook', 'instagram', 'linkedin', 'x', 'telegram'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_NAMES: Record<Channel, string> = { facebook: 'Facebook Page', instagram: 'Instagram', linkedin: 'LinkedIn Page', x: 'X (Twitter)', telegram: 'Telegram channel' };
export const CHANNEL_SETUP: Record<Channel, string> = {
  facebook: 'FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN (a long-lived Page token with pages_manage_posts, pages_read_engagement, pages_messaging, leads_retrieval)',
  instagram: 'INSTAGRAM_BUSINESS_ID (the Instagram professional account linked to the Facebook Page; uses the Page token, needs instagram_content_publish)',
  linkedin: 'LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET, then click Connect LinkedIn (the app needs LinkedIn’s Community Management API)',
  x: 'X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET (an X developer app with write access; posting needs a paid X API tier)',
  telegram: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL (make the bot an admin of the channel)',
};
export function channelReady(ch: string) {
  switch (ch) {
    case 'facebook': return !!(fbPageId() && fbPageToken());
    case 'instagram': return !!(igUserId() && fbPageToken());
    case 'linkedin': return liReady();
    case 'x': return !!(config.xApiKey && config.xApiSecret && config.xAccessToken && config.xAccessSecret);
    case 'telegram': return !!(config.telegramBotToken && config.telegramChannel);
    default: return false;
  }
}
export const wantedChannels = () => String(settings().social_channels).split(',').map((x) => x.trim()).filter((x): x is Channel => (CHANNELS as readonly string[]).includes(x));

async function graph(p: string, params: Record<string, string>, method: 'GET' | 'POST' = 'POST') {
  const body = new URLSearchParams({ ...params, access_token: fbPageToken() });
  const res = method === 'GET' ? await fetch(`${GRAPH}/${p}?${body}`, { signal: AbortSignal.timeout(30_000) }) : await fetch(`${GRAPH}/${p}`, { method, body, signal: AbortSignal.timeout(60_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j?.error?.message || `Meta ${res.status}`);
  return j;
}
const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** OAuth 1.0a header for X (JSON bodies are not part of the signature). */
export function xAuthHeader(method: string, url: string, k = { key: config.xApiKey, secret: config.xApiSecret, token: config.xAccessToken, tokenSecret: config.xAccessSecret }, nonce = randomToken(16), ts = String(Math.floor(Date.now() / 1000))) {
  const p: Record<string, string> = { oauth_consumer_key: k.key, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: ts, oauth_token: k.token, oauth_version: '1.0' };
  const base = [method.toUpperCase(), pct(url), pct(Object.keys(p).sort().map((x) => `${pct(x)}=${pct(p[x])}`).join('&'))].join('&');
  p.oauth_signature = crypto.createHmac('sha1', `${pct(k.secret)}&${pct(k.tokenSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).sort().map((x) => `${pct(x)}="${pct(p[x])}"`).join(', ');
}
const imageUrl = (rel: string | null) => (rel ? `${config.baseUrl}/uploads/${rel}` : null);

/** Publishes to one channel. Returns the post id on that channel. */
async function publishTo(ch: Channel, text: string, short: string, image: string | null): Promise<string> {
  const img = imageUrl(image);
  if (ch === 'facebook') return (img ? await graph(`${fbPageId()}/photos`, { url: img, caption: text }) : await graph(`${fbPageId()}/feed`, { message: text })).id;
  if (ch === 'instagram') {
    if (!img) throw new Error('Instagram needs an image');
    const c = await graph(`${igUserId()}/media`, { image_url: img, caption: text });
    return (await graph(`${igUserId()}/media_publish`, { creation_id: c.id })).id;
  }
  if (ch === 'linkedin') return liPost(text, image ? path.resolve(config.uploadsDir, 'public', image) : null);
  if (ch === 'x') {
    const url = 'https://api.x.com/2/tweets';
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: xAuthHeader('POST', url), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: short }) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`X ${res.status}: ${j?.detail || j?.title || ''}`);
    return j?.data?.id || 'ok';
  }
  if (ch === 'telegram') {
    // Every channel post invites readers to the bot, where Adaeze answers questions and Champions link their account.
    const bot = botLink('channel');
    if (bot && !text.includes(bot)) text = `${text}\n\n💬 Questions? Ask our assistant: ${bot}`;
    const method = img ? 'sendPhoto' : 'sendMessage';
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(img ? { chat_id: config.telegramChannel, photo: img, caption: text.slice(0, 1024) } : { chat_id: config.telegramChannel, text }) });
    const j: any = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram: ${j.description || res.status}`);
    return String(j.result?.message_id || 'ok');
  }
  throw new Error('Unknown channel');
}

// ================= Images =================
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function wrap(s: string, width: number, max: number) {
  const out: string[] = []; let line = '';
  for (const w of s.split(/\s+/)) { if ((line + ' ' + w).trim().length > width && line) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); }
  if (line) out.push(line);
  if (out.length > max) { out.length = max; out[max - 1] = out[max - 1].replace(/\s*\S*$/, '') + '…'; }
  return out;
}
function saveSocialImage(buf: Buffer) {
  const rel = path.posix.join('social', `${randomToken(10)}.jpg`);
  const abs = path.resolve(config.uploadsDir, 'public', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return rel;
}
/** 1080×1080 JPEG card in ComboTrader colours (Instagram needs JPEG). */
export async function postCard(o: { eyebrow: string; headline: string; lines: string[]; photo?: string | null }) {
  useBrandFonts();
  const B = BRAND;
  const host = config.baseUrl.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const head = wrap(o.headline, o.photo ? 24 : 19, 3);
  const hs = o.photo ? 58 : 80, lh = o.photo ? 66 : 88;
  const top = o.photo ? 590 : 330;
  // Field rows sweeping in from the right, as on the ComboTrader banners.
  const furrows = Array.from({ length: 14 }, (_, i) => { const y = 1080 * (0.15 + i * 0.075); return `<path d="M454,1120 C670,${(y + 378).toFixed(0)} 864,${y.toFixed(0)} 1120,${(y - 216).toFixed(0)}" fill="none" stroke="${B.green2}" stroke-width="9" opacity=".5"/>`; }).join('');
  const heading = `font-family="${B.headingFont}, Fraunces, Georgia, serif"`, body = `font-family="${B.bodyFont}, Arial, sans-serif"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  ${o.photo ? `<rect y="500" width="1080" height="580" fill="${B.green}" opacity="0.96"/>` : `<rect width="1080" height="1080" fill="${B.green}"/>${furrows}<g transform="translate(860,250) scale(3.4)" opacity=".10">${MARK_SVG}</g>`}
  <g transform="translate(80,${o.photo ? 70 : 80})">
    ${o.photo ? `<rect x="-24" y="-20" width="420" height="104" rx="52" fill="${B.green}" opacity=".92"/>` : ''}
    <g transform="translate(32,32) scale(.32)">${MARK_SVG}</g>
    <text x="84" y="46" ${heading} font-size="46" fill="${B.cream}">Combo<tspan fill="${B.gold}">Trader</tspan></text>
  </g>
  <text x="80" y="${top - 46}" ${body} font-size="30" font-weight="700" fill="${B.gold}" letter-spacing="5">${xml(o.eyebrow.toUpperCase())}</text>
  ${head.map((l, i) => `<text x="80" y="${top + 34 + i * lh}" ${heading} font-size="${hs}" fill="${B.cream}">${xml(l)}</text>`).join('')}
  ${o.lines.slice(0, 3).map((l, i) => `<text x="80" y="${top + 34 + head.length * lh + 34 + i * 50}" ${body} font-size="36" fill="#DCE7DA">${xml(l)}</text>`).join('')}
  <rect x="80" y="930" width="${Math.max(420, host.length * 21 + 150)}" height="84" rx="42" fill="${B.gold}"/>
  <text x="${80 + Math.max(420, host.length * 21 + 150) / 2}" y="985" ${body} font-size="34" font-weight="700" fill="${B.green}" text-anchor="middle">${xml(host)}/join</text>
</svg>`;
  let base = sharp(Buffer.from(svg));
  if (o.photo) {
    const src = path.resolve(config.uploadsDir, 'public', o.photo);
    if (fs.existsSync(src)) {
      const bg = await sharp(src).resize(1080, 1080, { fit: 'cover' }).toBuffer();
      base = sharp(bg).composite([{ input: Buffer.from(svg) }]);
    }
  }
  return saveSocialImage(await base.jpeg({ quality: 88 }).toBuffer());
}

// ================= Social: planning =================
export type Plan = { kind: string; ref: string; key: string; url: string; facts: Record<string, string | number>; card: { eyebrow: string; headline: string; lines: string[]; photo?: string | null } };
const LEARN_TOPICS = ['how', 'periods', 'trail', 'circles', 'plans', 'verify', 'risk'];
const posted = (ref: string) => !!q.get('SELECT 1 FROM social_posts WHERE ref=?', ref);
const isoWeek = () => { const d = lagosNow(); const y = d.getUTCFullYear(); const start = Date.UTC(y, 0, 1); return `${y}-W${String(Math.ceil(((d.getTime() - start) / 864e5 + new Date(start).getUTCDay() + 1) / 7)).padStart(2, '0')}`; };
function rangeOf(l: any) { const p = lotPeriods(l); const a = p[0], b = p[p.length - 1]; return a === b ? { periods: `${a} months`, rates: `${rateFor(a) / 100}%` } : { periods: `${a}–${b} months`, rates: `${rateFor(a) / 100}%–${rateFor(b) / 100}%` }; }

/** What to post next: a new lot first, then fresh Trail news, milestones, weekly prices, then how-to topics in turn. */
/** A post about one lot (used when the Chief of Staff asks Social to push a lot that is behind). */
export function planForLot(code: string): Plan | null {
  const lot = q.get<any>("SELECT l.*, c.name AS commodity_name FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.code=? AND l.status='open'", code);
  if (!lot) return null;
  const r = rangeOf(lot);
  const closes = new Date(lot.closes_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  return { kind: 'lot', ref: `lot:${lot.code}:push:${now().slice(0, 10)}`, key: 'post:lot', url: `/lots/${lot.code}`, facts: { title: lot.title, commodity: lot.commodity_name, region: lot.region || 'Nigeria', periods: r.periods, rates: r.rates, closes },
    card: { eyebrow: `Closes ${closes}`, headline: lot.title, lines: [`Earn ${r.rates} per annum`, `Stay ${r.periods}`, 'Signed buyer · Harvest Trail'] } };
}
const socialPaused = () => { const u = String(settings().social_paused_until || ''); return !!u && u > now(); };
/** The introduction series: the first posts on every page explain who we are before any lot is promoted. */
export const INTRO_TOPICS = ['welcome', 'how', 'kitovu', 'buyer', 'trail', 'risk', 'start', 'circles'] as const;
const INTRO_HEAD: Record<string, [string, string[]]> = {
  welcome: ['Meet ComboTrader', ['Fund real farm produce deals', 'Every lot has a named buyer']],
  kitovu: ['Who is behind ComboTrader', ['Kitovu Technology, since 2016', 'Farm inputs, storage, trade']],
  buyer: ['The buyer comes first', ['Every lot starts with a buyer order', 'Then we source the produce']],
  start: ['How to start', ['Sign up free · verify', 'Pick a lot · follow the Trail']],
};
/** Educational posts since the last lot post (lot posts need at least 2 in between, so the feed stays mostly useful). */
function learnSinceLastLot() {
  const lastLot = String(q.val("SELECT MAX(created_at) FROM social_posts WHERE kind='lot'") || '');
  if (!lastLot) return 99; // no lot post yet
  return Number(q.val("SELECT COUNT(*) FROM social_posts WHERE kind IN ('learn','intro','prices','trail','milestone') AND created_at>?", lastLot) ?? 0);
}
export function planNextPost(): Plan {
  // 1) Introduction first: until every intro topic has been posted, explain ComboTrader before promoting lots.
  const nextIntro = INTRO_TOPICS.find((tp) => !posted(`intro:${tp}`));
  if (nextIntro && settings().social_intro_series) return introPlan(nextIntro);
  return planAfterIntro();
}
/** The post plan for one introduction topic. */
export function introPlan(nextIntro: string): Plan {
  {
    const head = INTRO_HEAD[nextIntro] || ({ how: ['How ComboTrader works', ['Pick a lot with a named buyer', 'Choose 4 to 12 months', 'Follow it on the Harvest Trail']], trail: ['Follow your money', ['Sourcing · Warehouse · Delivery', 'Dated updates and photos']], risk: ['Straight talk on risk', ['Trades are not bank deposits', 'Read the risk statement']], circles: ['Back a trade together', ['Harvest Circles for groups', 'Small slots, own certificate']] } as Record<string, [string, string[]]>)[nextIntro];
    return { kind: 'intro', ref: `intro:${nextIntro}`, key: `post:intro:${nextIntro}`, url: nextIntro === 'risk' ? '/legal/risk' : nextIntro === 'circles' ? '/circles' : nextIntro === 'kitovu' ? '/why-kitovu' : nextIntro === 'how' || nextIntro === 'buyer' ? '/how-it-works' : '/join',
      // "about" tells the AI what this introduction post must explain (the built-in text, without the link).
      facts: { topic: `introduction: ${nextIntro}`, about: (DEFAULT_POSTS[`post:intro:${nextIntro}`]?.[0] || '').replace('{link}', '').trim(), rate4: rateFor(4) / 100, rate12: rateFor(12) / 100 }, card: { eyebrow: 'Welcome', headline: head[0], lines: head[1] } };
  }
}
/** Posts the whole introduction series now: one post every few hours, quiet overnight (22:00–07:00 Lagos). The
 * posts are approved for publishing at once (built-in or AI wording, checked against the playbook). */
export async function postIntroSeries(hours = 2, by: number | null = null) {
  const todo = INTRO_TOPICS.filter((tp) => !posted(`intro:${tp}`));
  if (!todo.length) return 'the introduction series has already been posted';
  const lagosHour = (t: number) => new Date(t + 3600e3).getUTCHours();
  let t = Date.now() + 5 * 60e3;
  const done: string[] = [];
  for (const tp of todo) {
    while (lagosHour(t) >= 22 || lagosHour(t) < 7) t += 30 * 60e3; // quiet hours: next slot from 7:00
    const r = await createPost(true, introPlan(tp));
    const postId = Number(/post #(\d+)/.exec(r)?.[1]);
    const action = postId ? q.get<any>("SELECT * FROM agent_actions WHERE kind='publish_social' AND status='proposed' AND payload LIKE ?", `%"post_id":${postId},%`) : null;
    if (!action) { done.push(`${tp}: ${r}`); continue; }
    const payload = JSON.parse(action.payload || '{}'); payload.when = new Date(t).toISOString();
    q.run('UPDATE agent_actions SET payload=? WHERE id=?', JSON.stringify(payload), action.id);
    if (action.risk === 'low') { executeAction(action.id, by); done.push(`${tp} at ${new Date(t + 3600e3).toISOString().slice(11, 16)}`); }
    else done.push(`${tp}: held for your review (wording)`);
    t += hours * 3600e3;
  }
  return `introduction series scheduled: ${done.join(', ')}`;
}
function planAfterIntro(): Plan {
  // 2) Lots, but never two lot posts in a row: at least two useful posts between them (the Chief of Staff can still push a lot that is behind).
  const lot = socialPaused() || learnSinceLastLot() < 2 ? null : q.get<any>("SELECT l.*, c.name AS commodity_name FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.status='open' AND l.closes_at>? AND NOT EXISTS (SELECT 1 FROM social_posts s WHERE s.ref='lot:' || l.code) ORDER BY COALESCE(l.opened_at, l.created_at) DESC", now());
  if (lot) {
    const r = rangeOf(lot);
    return { kind: 'lot', ref: `lot:${lot.code}`, key: 'post:lot', url: `/lots/${lot.code}`, facts: { title: lot.title, commodity: lot.commodity_name, region: lot.region || 'Nigeria', periods: r.periods, rates: r.rates, closes: new Date(lot.closes_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) },
      card: { eyebrow: 'New Trade Lot', headline: lot.title, lines: [`Earn ${r.rates} per annum`, `Stay ${r.periods}`, 'Signed buyer · Harvest Trail'] } };
  }
  const ev = q.get<any>("SELECT e.*, l.title AS lot FROM trail_events e JOIN lots l ON l.id=e.lot_id WHERE e.happened_at>=? AND NOT EXISTS (SELECT 1 FROM social_posts s WHERE s.ref='trail:' || e.id) ORDER BY (e.photo_path IS NOT NULL) DESC, e.happened_at DESC", new Date(Date.now() - 14 * 864e5).toISOString());
  if (ev) {
    const stage = stageLabel('en', ev.stage);
    return { kind: 'trail', ref: `trail:${ev.id}`, key: 'post:trail', url: '/join', facts: { lot: ev.lot, stage, note: String(ev.note || '').replace(/\.*$/, '.') },
      card: { eyebrow: 'Harvest Trail', headline: `${stage}: ${ev.lot}`, lines: wrap(String(ev.note || ''), 40, 2), photo: ev.photo_path } };
  }
  const st = siteStats();
  const step = st.champions >= 1000 ? 500 : 100;
  const mark = Math.floor(st.champions / step) * step;
  if (mark >= step && !posted(`milestone:champions:${mark}`)) {
    return { kind: 'milestone', ref: `milestone:champions:${mark}`, key: 'post:milestone', url: '/join', facts: { champions: mark.toLocaleString('en'), tons: Math.round(st.tons).toLocaleString('en'), farmers: st.farmers.toLocaleString('en'), payouts: fmtNGN(st.payouts) },
      card: { eyebrow: 'Thank you, Champions', headline: `${mark.toLocaleString('en')}+ Harvest Champions`, lines: [`${Math.round(st.tons).toLocaleString('en')} tons moved`, `${st.farmers.toLocaleString('en')} farmers served`] } };
  }
  const week = isoWeek();
  const prices = q.all<any>("SELECT c.name, p.price_per_kg FROM prices p JOIN commodities c ON c.code=p.commodity WHERE p.status='published' AND p.id IN (SELECT MAX(id) FROM prices WHERE status='published' GROUP BY commodity) ORDER BY c.sort LIMIT 5");
  if (prices.length >= 3 && !posted(`prices:${week}`)) {
    const list = prices.map((p) => `${p.name} ${fmtNGN(p.price_per_kg)}/kg`);
    return { kind: 'prices', ref: `prices:${week}`, key: 'post:prices', url: '/prices', facts: { prices: list.join(', ') }, card: { eyebrow: 'Prices this week', headline: 'Farm-gate prices', lines: list.slice(0, 3) } };
  }
  const lastByTopic = (t: string) => String(q.val("SELECT MAX(created_at) FROM social_posts WHERE ref LIKE ?", `learn:${t}:%`) || '');
  // The Chief of Staff can ask Social to favour a topic that is working (settings.social_boost = {"topic","until"}).
  let boost = ''; try { const b = JSON.parse(String(settings().social_boost || '{}')); if (b.topic && LEARN_TOPICS.includes(b.topic) && String(b.until) > now() && !lastByTopic(b.topic).startsWith(now().slice(0, 10))) boost = b.topic; } catch { /* none */ }
  const topic = boost || LEARN_TOPICS.slice().sort((a, b) => lastByTopic(a).localeCompare(lastByTopic(b)))[0];
  const HEAD: Record<string, [string, string[]]> = {
    how: ['How ComboTrader works', ['Pick a lot with a signed buyer', 'Choose 4 to 12 months', 'Get paid on your payout date']],
    periods: ['Stay longer, earn more', [`${rateFor(4) / 100}% a year for 4 months`, `${rateFor(12) / 100}% a year for 12 months`]],
    trail: ['Follow your money', ['Sourcing · Warehouse · Delivery', 'Dated updates and photos']],
    circles: ['Back a trade together', ['Harvest Circles for groups', 'Small slots, own certificate']],
    plans: ['Start small', [`Save from ${fmtNGN(settings().plan_min_monthly)} a month`, 'Join a lot at your target']],
    verify: ['Check any certificate', ['Every Trade Certificate', 'can be verified online']],
    risk: ['Straight talk on risk', ['Trades are not bank deposits', 'Read the risk statement']],
  };
  return { kind: 'learn', ref: `learn:${topic}:${week}`, key: `post:learn:${topic}`, url: topic === 'risk' ? '/legal/risk' : topic === 'circles' ? '/circles' : '/join',
    facts: { topic, rate4: rateFor(4) / 100, rate12: rateFor(12) / 100, plan_min: fmtNGN(settings().plan_min_monthly) }, card: { eyebrow: 'Good to know', headline: HEAD[topic][0], lines: HEAD[topic][1] } };
}

/** Built-in post templates (rules). They become lessons, so their clicks are measured and better ones take over. */
const DEFAULT_POSTS: Record<string, string[]> = {
  'post:lot': [
    'New Trade Lot: {title}. Back a real {commodity} order with a signed buyer and earn {rates} per annum, depending on how long you stay ({periods}). Follow every step on the Harvest Trail. Closes {closes}. {link}',
    '{commodity} from {region} is on its way to a buyer, and Harvest Champions can fund it now: {rates} per annum for {periods}. Trades carry risk; read the terms before you join. {link}',
  ],
  'post:trail': ['Harvest Trail update, {lot}: {stage}. {note} This is what your money does on ComboTrader: every step dated, with photos. {link}'],
  'post:milestone': ['{champions}+ Harvest Champions have now backed real farm trades with Kitovu, moving {tons} tons for {farmers} farmers. Thank you. Join them: {link}'],
  'post:prices': ['This week’s farm-gate prices from our field teams: {prices}. See the trends and the open Trade Lots: {link}'],
  'post:intro:welcome': ['Welcome to ComboTrader, by Kitovu Technology. We let you fund real farm produce deals in Nigeria: your money buys crops that a named buyer has already agreed to purchase, and you can follow every lot from farm to buyer. Follow this page to learn how it works. {link}'],
  'post:intro:how': ['How ComboTrader works, in four steps: 1) pick a Trade Lot that already has a signed buyer, 2) choose how long you stay, 4 to 12 months, 3) follow the trade on the Harvest Trail, 4) receive your money and earnings on the payout date. {link}'],
  'post:intro:kitovu': ['Who is behind ComboTrader? Kitovu Technology Company, an agri-infrastructure company working with Nigerian farmers since 2016: farm inputs, storage and trade. ComboTrader lets you take part in that trade. {link}'],
  'post:intro:buyer': ['Every ComboTrader lot starts with a buyer, not a guess: a processor or exporter orders the produce first, then we source it from farmers. Your money funds that order, and the buyer’s payment is what you earn from. {link}'],
  'post:intro:trail': ['You can see exactly where your money goes. Each trade has a Harvest Trail with dated updates and photos: sourcing from farmers, the warehouse, delivery to the buyer. {link}'],
  'post:intro:risk': ['Straight talk before you start: trades are not bank deposits and are not NDIC-insured. Read how we manage risk, and only use money you can set aside for the whole period. {link}'],
  'post:intro:start': ['Getting started takes a few minutes: sign up free, verify your identity, add money to your wallet, then pick a Trade Lot. Questions? Ask our assistant any time. {link}'],
  'post:intro:circles': ['Harvest Circles let a cooperative, office, church or family group back a trade together, each person from a small amount, each with their own Trade Certificate. {link}'],
  'post:learn:how': ['How ComboTrader works: 1) pick a Trade Lot that already has a signed buyer, 2) choose 4, 6, 9 or 12 months, 3) follow the trade on the Harvest Trail, 4) receive your principal and earnings on the payout date. {link}'],
  'post:learn:periods': ['The longer you stay, the more you earn: {rate4}% a year for 4 months, rising to {rate12}% a year for 12 months. You choose when you join. {link}'],
  'post:learn:trail': ['Every ComboTrader trade has a Harvest Trail: dated updates and photos from sourcing to warehouse to delivery. You always know where your money is. {link}'],
  'post:learn:circles': ['Harvest Circles let friends, family, church or office groups fill part of a Trade Lot together from small slots. Everyone gets their own Trade Certificate. {link}'],
  'post:learn:plans': ['Not ready for a full Trade Lot? A Harvest Plan saves from {plan_min} a month and joins a lot when you reach your target. {link}'],
  'post:learn:verify': ['Every ComboTrader Trade Certificate can be checked by anyone on our website. Openness is how we work. {link}'],
  'post:learn:risk': ['Straight talk: trades are not bank deposits. Kitovu pays Champions on the payout date from its own balance sheet even if a buyer pays late, but that depends on Kitovu staying able to pay. Read the risk statement before you join: {link}'],
};
function shorten(text: string, max = 250) {
  const body = text.replace('{link}', '').trim();
  if (body.length + 25 <= max) return text.includes('{link}') ? text : `${text} {link}`;
  const cut = body.slice(0, max - 26);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(': '));
  return `${(end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…').trim()} {link}`;
}

/** Writes and proposes the next post. Returns a status line. */
export async function createPost(force = false, override: Plan | null = null): Promise<string> {
  const s = settings();
  const plan = override || planNextPost();
  const day = lagosNow().getUTCDay();
  const perWeek = Math.max(0, Math.min(14, Number(s.social_posts_per_week) || 0));
  const days = [1, 3, 5, 2, 4, 6, 0].slice(0, Math.min(7, perWeek));
  const today = lagosNow().toISOString().slice(0, 10);
  const postedToday = Number(q.val("SELECT COUNT(*) FROM social_posts WHERE substr(created_at,1,10)=?", today) ?? 0);
  if (!force && !override && (postedToday > 0 || (!days.includes(day) && plan.kind !== 'lot'))) return 'not a posting day';
  let text = '', short = '', template: string | null = null, lessonId: number | null = null, runId: number | null = null;
  if (useAI('social')) {
    try {
      const examples = lessonsFor('social', 'post', { key: plan.key }).filter((l) => l.wins + l.losses >= 2).sort((a, b) => lessonScore(b) - lessonScore(a)).slice(0, 3).map((l) => ({ ...parseLesson(l), clicks_result: `${l.wins} of ${l.wins + l.losses} worked` }));
      const r = await completeJson<{ text: string; x_text: string; template: string }>('social', { trigger: `post:${plan.kind}`, maxTokens: 1500,
        system: `${POLICY}\n${BRAND_VOICE}\n${playbookFor('social')}\nYou write ComboTrader's social media posts for Nigerian and diaspora audiences on Facebook, Instagram, LinkedIn, X and Telegram. Using ONLY the facts given, write "text" (≤ 450 characters, warm and concrete, at most 2 emojis, at most 3 hashtags, end with a clear next step) and "x_text" (≤ 240 characters). Both must contain the placeholder {link} exactly once (we put the tracked link there). No earnings promises beyond the rates given; never say guaranteed or investment. ` +
          `Also give "template": the text with the specific facts replaced by these placeholders where they appear: ${Object.keys(plan.facts).map((k) => `{${k}}`).join(', ')}, {link}. Learn from the examples that worked. Return {"text":string,"x_text":string,"template":string}.`,
        input: { post_type: plan.kind, facts: plan.facts, examples_that_worked: examples } });
      if (String(r.data.text || '').includes('{link}')) { text = r.data.text; short = String(r.data.x_text || '').includes('{link}') ? r.data.x_text : shorten(text); template = String(r.data.template || '').includes('{link}') ? r.data.template : null; runId = r.runId; }
    } catch (e) { if (!(e instanceof AiUnavailable)) audit(null, 'agent.social_error', undefined, String((e as Error).message)); }
  }
  if (!text) {
    for (const t of DEFAULT_POSTS[plan.key] || []) learn({ agent: 'social', kind: 'post', key: plan.key, content: { text: t }, source: 'rules' });
    const l = pickVariant('social', 'post', plan.key, 'en', 3);
    const t = parseLesson<{ text: string }>(l)?.text || DEFAULT_POSTS['post:learn:how'][0];
    text = fill(t, plan.facts); short = shorten(text); lessonId = l?.id ?? null;
    runId = logRun('social', `post:${plan.kind}`, JSON.stringify(plan.facts), text, 'rules');
  }
  const image = await postCard(plan.card).catch(() => null);
  const id = q.insert('social_posts', { kind: plan.kind, ref: plan.ref, text, text_short: short, image_path: image, channels: wantedChannels().join(','), status: 'draft', lesson_id: lessonId, created_at: now(),
    results: JSON.stringify({ _url: plan.url, _key: plan.key, ...(template ? { _template: template } : {}) }) }).id;
  const flagged = offMessage(text);
  propose({ agent: 'social', kind: 'publish_social', risk: flagged.length ? 'medium' : 'low', title: `${plan.kind === 'lot' ? 'New lot post' : `Post: ${plan.kind}`} for ${wantedChannels().map((c) => CHANNEL_NAMES[c]).join(', ') || 'copy and post'}`,
    summary: `${flagged.length ? `Check wording (playbook): ${flagged.join(', ')}. ` : ''}${text.replace('{link}', '🔗')}`, payload: { post_id: id, text, when: nextSlot() }, runId });
  return `post #${id} drafted (${plan.kind})`;
}
/** Next posting time today or tomorrow at the configured Lagos hour. */
function nextSlot() {
  const h = Math.max(0, Math.min(23, Number(settings().social_post_hour) || 10));
  const l = lagosNow(); const d = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), h - 1)); // Lagos is UTC+1
  if (d.getTime() < Date.now()) return now();
  return d.toISOString();
}
/** A/B choice between variants: try each one ~15 times, then use the best (smoothed) one. */
export function pickVariant(agent: string, kind: Lesson['kind'], key: string, lang: string, explore = 15) {
  const rows = q.all<Lesson>("SELECT * FROM agent_lessons WHERE agent=? AND kind=? AND key=? AND active=1 AND lang IN (?, 'en')", agent, kind, key, lang)
    .sort((a, b) => Number(b.lang === lang) - Number(a.lang === lang));
  const own = rows.filter((r) => r.lang === rows[0]?.lang);
  if (!own.length) return null;
  const fresh = own.filter((r) => r.uses < explore).sort((a, b) => a.uses - b.uses);
  if (fresh.length) return fresh[0];
  return own.sort((a, b) => lessonScore(b) - lessonScore(a))[0];
}

/** Publishes posts whose time has come. Channels without a connection are prepared for copy-and-post. */
export async function publishDueSocial() {
  let n = 0;
  for (const p of q.all<any>("SELECT * FROM social_posts WHERE status='scheduled' AND scheduled_at<=? ORDER BY id LIMIT 5", now())) {
    const res: Record<string, any> = JSON.parse(p.results || '{}');
    let ok = 0, manual = 0, failed = 0;
    for (const ch of String(p.channels).split(',').filter(Boolean) as Channel[]) {
      if (res[ch]?.id || res[ch]?.manual) continue;
      const link = trackedLink(res._url || '/join', { channel: ch, campaign: `post-${p.id}`, lessonId: p.lesson_id });
      const text = String(p.text).split('{link}').join(link.url), short = String(p.text_short || shorten(p.text)).split('{link}').join(link.url);
      if (!channelReady(ch)) { res[ch] = { manual: true, link: link.url, text: ch === 'x' ? short : text }; manual++; continue; }
      try { res[ch] = { id: await publishTo(ch, text, short, p.image_path), link: link.url, at: now() }; ok++; }
      catch (e: any) { res[ch] = { error: String(e.message).slice(0, 300), link: link.url, text }; failed++; audit(null, 'social.publish_failed', ch, String(e.message)); }
    }
    const status = failed && !ok ? 'failed' : manual || failed ? 'partly' : 'published';
    q.run('UPDATE social_posts SET status=?, published_at=?, results=? WHERE id=?', status, now(), JSON.stringify(res), p.id);
    if (p.lesson_id) used(p.lesson_id);
    n++;
  }
  return n;
}
/** A week after publishing: did the post bring clicks or sign-ups? */
function scorePosts() {
  const goal = Math.max(1, Number(settings().social_click_goal) || 10);
  let n = 0;
  for (const p of q.all<any>("SELECT * FROM social_posts WHERE scored=0 AND published_at IS NOT NULL AND published_at<=?", new Date(Date.now() - 7 * 864e5).toISOString())) {
    const links = q.all<any>('SELECT id, clicks FROM links WHERE campaign=?', `post-${p.id}`);
    const clicks = links.reduce((a, l) => a + l.clicks, 0), signups = links.reduce((a, l) => a + signupsFor(l.id), 0);
    if (p.lesson_id) scoreLesson(p.lesson_id, signups > 0 || clicks >= goal);
    q.run('UPDATE social_posts SET scored=1 WHERE id=?', p.id); n++;
  }
  return n;
}

// ================= Social: inbound (comments, DMs, lead forms) =================
const INTEREST = /\b(how|join|interested|interest|details?|info|price|minimum|start|sign ?up|register|link|where|invest|apply|dm|more)\b|\?/i;
function replyTemplate(key: string, fallback: string) {
  const l = bestLesson('social', 'template', key);
  if (l) { used(l.id); return parseLesson<{ body: string }>(l)?.body || fallback; }
  learn({ agent: 'social', kind: 'template', key, content: { title: key, body: fallback }, source: 'rules' });
  return fallback;
}
async function sendDm(recipient: string, text: string) { if (!fbPageToken()) return false; await graph('me/messages', { recipient: JSON.stringify({ id: recipient }), message: JSON.stringify({ text: text.slice(0, 1900) }), messaging_type: 'RESPONSE' }); return true; }
/** Handles a Meta webhook for the Page and Instagram: lead forms, comments and direct messages. */
export async function handleMetaWebhook(body: any) {
  let n = 0;
  const s = settings();
  for (const entry of body?.entry || []) {
    const isIg = body.object === 'instagram';
    // Lead Ads and comments arrive as "changes"
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'leadgen' && v.leadgen_id) {
        if (q.get('SELECT 1 FROM social_inbox WHERE external_id=?', `lead:${v.leadgen_id}`)) continue;
        let fields: Record<string, string> = {};
        try { const lead = await graph(String(v.leadgen_id), { fields: 'field_data,ad_id,form_id' }, 'GET'); for (const f of lead.field_data || []) fields[f.name] = String((f.values || [])[0] || ''); } catch (e: any) { audit(null, 'social.lead_fetch_failed', String(v.leadgen_id), e.message); }
        const email = String(fields.email || '').toLowerCase(), name = String(fields.full_name || fields.first_name || '').split(' ')[0] || null, phone = fields.phone_number || null;
        let leadId: number | null = null;
        if (email) { q.run('INSERT OR IGNORE INTO leads (email, phone, name, lang, source, consent, campaign, token, created_at) VALUES (?,?,?,?,?,1,?,?,?)', email, phone, name, 'en', 'facebook_ads', `ad:${v.ad_id || v.form_id || ''}`, randomToken(16), now()); leadId = Number(q.val('SELECT id FROM leads WHERE email=?', email)) || null; }
        q.insert('social_inbox', { channel: 'facebook_ads', kind: 'lead_form', external_id: `lead:${v.leadgen_id}`, author: name, text: email || phone || '', lead_id: leadId, created_at: now() });
        n++; continue;
      }
      const isComment = (ch.field === 'feed' && v.item === 'comment' && v.verb === 'add') || (isIg && ch.field === 'comments');
      if (!isComment) continue;
      const cid = String(v.comment_id || v.id || ''); const text = String(v.message || v.text || '');
      const from = String(v.from?.id || ''); if (!cid || from === fbPageId() || from === igUserId()) continue;
      if (q.get('SELECT 1 FROM social_inbox WHERE external_id=?', `c:${cid}`)) continue;
      let reply: string | null = null;
      if (s.social_auto_reply && agentOn('social') && INTEREST.test(text)) {
        const link = trackedLink('/join', { channel: isIg ? 'instagram' : 'facebook', campaign: 'comment-reply' }).url;
        reply = fill(replyTemplate('reply:comment', 'Thanks for asking! How it works, the open Trade Lots and how to start are all here: {link}'), { link });
        try { if (fbPageToken()) { if (isIg) await graph(`${cid}/replies`, { message: reply }); else await graph(`${cid}/private_replies`, { message: reply }); } }
        catch (e: any) { audit(null, 'social.reply_failed', cid, e.message); reply = null; }
      }
      q.insert('social_inbox', { channel: isIg ? 'instagram' : 'facebook', kind: 'comment', external_id: `c:${cid}`, author: v.from?.name || v.from?.username || null, text: text.slice(0, 2000), reply, replied_at: reply ? now() : null, created_at: now() });
      n++;
    }
    // Direct messages (Messenger and Instagram)
    for (const m of entry.messaging || []) {
      const mid = String(m.message?.mid || ''); const text = String(m.message?.text || '');
      const sender = String(m.sender?.id || '');
      if (!mid || !text || m.message?.is_echo || sender === fbPageId() || sender === igUserId()) continue;
      if (q.get('SELECT 1 FROM social_inbox WHERE external_id=?', `m:${mid}`)) continue;
      let reply: string | null = null;
      if (s.social_auto_reply && agentOn('social')) {
        const link = trackedLink('/join', { channel: isIg ? 'instagram' : 'facebook', campaign: 'dm-reply' }).url;
        const a = await supportAnswer(null, text, 'en', `social:${isIg ? 'ig' : 'fb'}`);
        reply = a.escalate ? `${translate('en', 'agent.handover')}` : `${a.reply}\n\n${fill(replyTemplate('reply:dm', 'You can see the open Trade Lots and create your account here: {link}'), { link })}`;
        try { await sendDm(sender, reply); } catch (e: any) { audit(null, 'social.dm_failed', sender, e.message); reply = null; }
        if (a.escalate) q.insert('contact_messages', { name: `${isIg ? 'Instagram' : 'Facebook'} DM`, email: null, message: `${text}\n\n(sender ${sender})`, created_at: now() });
      }
      q.insert('social_inbox', { channel: isIg ? 'instagram' : 'facebook', kind: 'message', external_id: `m:${mid}`, author: sender, text: text.slice(0, 2000), reply, replied_at: reply ? now() : null, created_at: now() });
      n++;
    }
  }
  return n;
}
export function metaSignatureValid(raw: Buffer, header: string | undefined) {
  if (!config.metaAppSecret) return !config.production;
  if (!header?.startsWith('sha256=')) return false;
  const h = 'sha256=' + crypto.createHmac('sha256', config.metaAppSecret).update(raw).digest('hex');
  return h.length === header.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(header));
}

export async function runSocial(force = false) {
  if (!agentOn('social')) return 'off';
  const out = [`${scorePosts()} posts scored`];
  out.push(await createPost(force));
  return out.join('; ');
}

// ================= Email marketing =================
export const CAMPAIGN_KEYS = ['welcome_1', 'welcome_2', 'welcome_3', 'maturity', 'paid_out', 'winback', 'new_lot', 'market', 'verify_reminder', 'fund_reminder', 'lot_closing', 'follow_us'] as const;
type Recipient = { user_id: number; ref: string; vars: Record<string, string> };
const campaignOn = (c: string) => String(settings().email_campaigns).split(',').map((x) => x.trim()).includes(c.replace(/_\d$/, ''));
const CAMPAIGN_LINK: Record<string, (r: Recipient) => string> = {
  welcome_1: () => '/how-it-works', welcome_2: () => '/app/lots', welcome_3: () => '/app/circles',
  maturity: (r) => `/app/trades/${r.ref}`, paid_out: () => '/app/lots', winback: () => '/app/lots', new_lot: (r) => `/lots/${r.ref}`, market: () => '/app/market',
  verify_reminder: () => '/app/profile#kyc', fund_reminder: () => '/app/wallet', lot_closing: (r) => `/lots/${r.ref}`, follow_us: () => '/app/referrals',
};
const d = (days: number) => new Date(Date.now() + days * 864e5).toISOString();
/** Who each lifecycle email goes to today (each person gets each email once per trade, lot or quarter). */
export function campaignAudience(c: string): Recipient[] {
  const base = "u.status='active' AND u.role='champion' AND u.marketing_opt_in=1 AND u.email_verified_at IS NOT NULL";
  const notSent = (ref: string) => `NOT EXISTS (SELECT 1 FROM campaign_sends s WHERE s.campaign='${c}' AND s.user_id=u.id AND s.ref=${ref})`;
  const name = (u: any) => ({ name: u.first_name });
  switch (c) {
    case 'welcome_1': case 'welcome_2': case 'welcome_3': {
      const [from, to] = c === 'welcome_1' ? [1, 3] : c === 'welcome_2' ? [4, 6] : [8, 10];
      return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND u.created_at<=? AND u.created_at>=? AND ${notSent("''")} LIMIT 300`, d(-from), d(-to)).map((u) => ({ user_id: u.id, ref: '', vars: { ...name(u), low: String(rateFor(4) / 100), high: String(rateFor(12) / 100) } }));
    }
    case 'maturity':
      return q.all<any>(`SELECT u.*, t.id AS tid, t.matures_at, l.title FROM trades t JOIN users u ON u.id=t.user_id JOIN lots l ON l.id=t.lot_id WHERE ${base} AND t.status='active' AND t.matures_at BETWEEN ? AND ? AND ${notSent('CAST(t.id AS TEXT)')} LIMIT 300`, d(6), d(10))
        .map((u) => ({ user_id: u.id, ref: String(u.tid), vars: { ...name(u), lot: u.title, date: new Date(u.matures_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) } }));
    case 'paid_out':
      return q.all<any>(`SELECT u.*, t.id AS tid, l.title FROM trades t JOIN users u ON u.id=t.user_id JOIN lots l ON l.id=t.lot_id WHERE ${base} AND t.status='paid' AND t.paid_at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM trades n WHERE n.user_id=u.id AND n.created_at>t.paid_at) AND ${notSent('CAST(t.id AS TEXT)')} LIMIT 300`, d(-6), d(-2))
        .filter((u) => walletBalance(u.id) > 0 && !!q.get("SELECT 1 FROM lots WHERE status='open' AND closes_at>?", now())).map((u) => ({ user_id: u.id, ref: String(u.tid), vars: { ...name(u), lot: u.title } }));
    case 'winback': {
      const qtr = `${new Date().getUTCFullYear()}-Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
      if (!q.get("SELECT 1 FROM lots WHERE status='open' AND closes_at>?", now())) return [];
      return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND EXISTS (SELECT 1 FROM trades t WHERE t.user_id=u.id) AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.user_id=u.id AND (t.status IN ('active','matured') OR t.created_at>=?)) AND ${notSent(`'${qtr}'`)} LIMIT 300`, d(-60))
        .map((u) => ({ user_id: u.id, ref: qtr, vars: { ...name(u), low: String(rateFor(4) / 100), high: String(rateFor(12) / 100) } }));
    }
    case 'market': {
      // Every two weeks at most: Champions with enough idle money to buy at least one unit for sale.
      if (!marketOn()) return [];
      const offers = openListings().map((l) => quote(l, l, 1));
      if (!offers.length) return [];
      const cheapest = Math.min(...offers.map((o) => o.price)), best = Math.max(...offers.map((o) => o.annualPct));
      const period = String(Math.floor(Date.now() / (14 * 864e5)));
      return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND ${notSent(`'${period}'`)} LIMIT 500`).filter((u) => walletBalance(u.id) >= cheapest && !q.get("SELECT 1 FROM trade_listings WHERE seller_id=? AND status='listed'", u.id))
        .map((u) => ({ user_id: u.id, ref: period, vars: { ...name(u), n: String(offers.length), pct: String(best) } }));
    }
    case 'verify_reminder':
      return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND u.kyc_status IN ('none','rejected') AND u.created_at<=? AND u.created_at>=? AND ${notSent("''")} LIMIT 300`, d(-2), d(-9))
        .map((u) => ({ user_id: u.id, ref: '', vars: name(u) }));
    case 'fund_reminder':
      return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND u.kyc_status='verified' AND u.created_at<=? AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id=u.id AND p.status='success') AND ${notSent("''")} LIMIT 300`, d(-3))
        .map((u) => ({ user_id: u.id, ref: '', vars: name(u) }));
    case 'follow_us': {
      // Once per Champion: invite them to follow the pages (sent after the introduction posts are up).
      if (Number(q.val("SELECT COUNT(*) FROM social_posts WHERE kind='intro' AND status IN ('published','partly')") ?? 0) < 3) return [];
      const so = config.social;
      return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND ${notSent("''")} LIMIT 500`).map((u) => ({ user_id: u.id, ref: '', vars: { ...name(u), facebook: so.facebook, instagram: so.instagram, linkedin: so.linkedin, telegram: so.telegram } }));
    }
    case 'lot_closing': {
      if (String(settings().social_paused_until || '') > now()) return [];
      const lot = q.get<any>("SELECT l.* FROM lots l WHERE l.status='open' AND l.closes_at BETWEEN ? AND ? AND (SELECT COALESCE(SUM(t.amount),0) FROM trades t WHERE t.lot_id=l.id AND t.status!='cancelled') < l.target_amount * 0.9 ORDER BY l.closes_at", d(1), d(3));
      if (!lot) return [];
      const date = new Date(lot.closes_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
      return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id=u.id AND p.status='success') AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.user_id=u.id AND t.lot_id=?) AND ${notSent(`'${lot.code}'`)} LIMIT 500`, lot.id)
        .map((u) => ({ user_id: u.id, ref: lot.code, vars: { ...name(u), lot: lot.title, date } }));
    }
    case 'new_lot': {
      if (String(settings().social_paused_until || '') > now()) return [];
      const lot = q.get<any>("SELECT * FROM lots WHERE status='open' AND closes_at>? AND COALESCE(opened_at, created_at)>=? ORDER BY COALESCE(opened_at, created_at) DESC", now(), d(-3));
      if (!lot) return [];
      const r = rangeOf(lot);
      return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id=u.id AND p.status='success') AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.user_id=u.id AND t.lot_id=?) AND ${notSent(`'${lot.code}'`)} LIMIT 500`, lot.id)
        .map((u) => ({ user_id: u.id, ref: lot.code, vars: { ...name(u), lot: lot.title, rates: r.rates, periods: r.periods } }));
    }
  }
  return [];
}
const unsubLink = (uid: number) => `${config.baseUrl}/email/stop/${uid}.${hmac(`stop:${uid}`).slice(0, 16)}`;

/** Champions who funded before and aren't in this lot yet (Chief of Staff: push a lot that is behind). */
export function lotPushAudience(code: string): Recipient[] {
  const lot = q.get<any>("SELECT * FROM lots WHERE code=? AND status='open'", code);
  if (!lot || String(settings().social_paused_until || '') > now()) return [];
  const date = new Date(lot.closes_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  const base = "u.status='active' AND u.role='champion' AND u.marketing_opt_in=1 AND u.email_verified_at IS NOT NULL";
  return q.all<any>(`SELECT u.* FROM users u WHERE ${base} AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id=u.id AND p.status='success') AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.user_id=u.id AND t.lot_id=?) AND NOT EXISTS (SELECT 1 FROM campaign_sends s WHERE s.campaign='lot_closing' AND s.user_id=u.id AND s.ref=?) LIMIT 500`, lot.id, lot.code)
    .map((u) => ({ user_id: u.id, ref: lot.code, vars: { name: u.first_name, lot: lot.title, date } }));
}
/** Proposes one campaign to a given audience (same path as the daily run). */
export async function proposeCampaign(c: typeof CAMPAIGN_KEYS[number], people: Recipient[]) {
  if (!people.length) return 0;
  const lib = (CHAMPION_EMAILS as Record<string, { subject: string; body: string }>)[c];
  const v = pickVariant('email', 'template', `email:${c}`, 'en') || (lib ? (() => { const id = learn({ agent: 'email', kind: 'template', key: `email:${c}`, lang: 'en', content: { title: lib.subject, body: lib.body }, source: 'rules' }); return q.get<any>('SELECT * FROM agent_lessons WHERE id=?', id); })() : null);
  if (!v) return 0;
  const t = parseLesson<{ title: string; body: string }>(v)!;
  propose({ agent: 'email', kind: 'send_campaign', risk: 'low', title: `Email “${c.replace('_', ' ')}” to ${people.length} Champion${people.length === 1 ? '' : 's'} (requested by Chief of Staff)`,
    summary: `${fill(t.title, people[0].vars)} — ${fill(t.body, people[0].vars).slice(0, 300)}`, payload: { campaign: c, lang: 'en', lesson_id: v.id, title: t.title, body: t.body, recipients: people } });
  return people.length;
}

/** Proposes this run's lifecycle emails: one batch per campaign and language. */
export async function runEmail() {
  if (!agentOn('email')) return 'off';
  const out: string[] = [];
  const ab = scoreNewsletterAB(); if (ab) out.push(ab);
  for (const c of CAMPAIGN_KEYS) {
    if (!campaignOn(c)) continue;
    const people = campaignAudience(c).filter((r) => !q.get("SELECT 1 FROM agent_actions WHERE kind='send_campaign' AND status='proposed' AND payload LIKE ?", `%"campaign":"${c}"%"user_id":${r.user_id},%`));
    if (!people.length) continue;
    const byLang = new Map<string, Recipient[]>();
    for (const r of people) { const lang = String(q.val('SELECT lang FROM users WHERE id=?', r.user_id) || 'en'); byLang.set(lang, [...(byLang.get(lang) || []), r]); }
    for (const [lang, rs] of byLang) {
      const key = `email:${c}`;
      // Built-in wording is the first variant; in AI mode Claude adds a challenger until there are two to compare.
      const lib = (CHAMPION_EMAILS as Record<string, { subject: string; body: string }>)[c];
      const hasLocale = translate(lang as Lang, `mkt.${c}.subject`) !== `mkt.${c}.subject`;
      learn({ agent: 'email', kind: 'template', key, lang, content: hasLocale ? { title: translate(lang as Lang, `mkt.${c}.subject`), body: translate(lang as Lang, `mkt.${c}.body`) } : { title: lib.subject, body: lib.body }, source: 'rules' });
      if (useAI('email') && lessonsFor('email', 'template', { key, lang }).length < 2) await challenger(c, lang as Lang).catch((e) => { if (!(e instanceof AiUnavailable)) audit(null, 'agent.email_error', c, String(e.message)); });
      const v = pickVariant('email', 'template', key, lang)!;
      const t = parseLesson<{ title: string; body: string }>(v)!;
      const sample = rs[0];
      propose({ agent: 'email', kind: 'send_campaign', risk: 'low', title: `Email “${c.replace('_', ' ')}” to ${rs.length} Champion${rs.length === 1 ? '' : 's'} (${lang})`,
        summary: `${fill(t.title, sample.vars)} — ${fill(t.body, sample.vars).slice(0, 300)}`,
        payload: { campaign: c, lang, lesson_id: v.id, title: t.title, body: t.body, recipients: rs } });
      out.push(`${c}/${lang}: ${rs.length}`);
    }
  }
  return out.length ? out.join('; ') : 'no emails due today';
}
async function challenger(c: string, lang: Lang) {
  const current = lessonsFor('email', 'template', { key: `email:${c}`, lang }).map((l) => parseLesson(l));
  const placeholders: string[] = [...(translate(lang, `mkt.${c}.body`).match(/\{\w+\}/g) || [])].concat(translate(lang, `mkt.${c}.subject`).match(/\{\w+\}/g) || []);
  const r = await completeJson<{ title: string; body: string }>('email', { fast: true, trigger: `challenger:${c}:${lang}`,
    system: `${POLICY}\n${BRAND_VOICE}\n${playbookFor('email')}\nYou improve ComboTrader lifecycle emails. Write ONE alternative version of this email in ${lang} to test against the current one: a different subject angle and a clearer, warmer body (≤ 110 words). Keep exactly these placeholders: ${[...new Set(placeholders)].join(', ') || 'none'}. Do not add links (a button is added). Return {"title":string,"body":string}.`,
    input: { campaign: c, current } });
  const ok = [...new Set(placeholders)].every((p) => `${r.data.title} ${r.data.body}`.includes(p));
  if (ok && r.data.title && r.data.body) learn({ agent: 'email', kind: 'template', key: `email:${c}`, lang, content: { title: r.data.title, body: r.data.body }, source: 'ai' });
}
/** After 3 days (and once every copy is sent): which newsletter subject got more opens and clicks per email? */
function scoreNewsletterAB() {
  let n = 0;
  for (const nl of q.all<any>("SELECT * FROM newsletters WHERE status='sent' AND subject_b IS NOT NULL AND ab_scored=0 AND send_at<=?", d(-3))) {
    // Wait until every copy has gone out (marketing email is paced over several days for big lists).
    if (q.get("SELECT 1 FROM outbox WHERE status='queued' AND campaign IN (?, ?)", `nl-${nl.id}-a`, `nl-${nl.id}-b`)) continue;
    const clicks = (v: string) => Number(q.val('SELECT COALESCE(SUM(clicks),0) FROM links WHERE campaign=?', `nl-${nl.id}-${v}`) ?? 0);
    const half = (v: string) => q.get<any>("SELECT COUNT(*) sent, SUM(opened_at IS NOT NULL) opened FROM outbox WHERE campaign=? AND status='sent'", `nl-${nl.id}-${v}`);
    // Score = (opens + 3 × clicks) per email sent: opens show the subject line worked, clicks count more.
    const score = (v: string) => { const h = half(v); return h?.sent ? (Number(h.opened || 0) + 3 * clicks(v)) / h.sent : clicks(v); };
    const sa = score('a'), sb = score('b');
    const a = Math.abs(sa - sb) < 0.01 ? 0 : sa, b = Math.abs(sa - sb) < 0.01 ? 0 : sb;
    const la = learn({ agent: 'growth', kind: 'post', key: 'subject', content: { text: nl.subject }, source: 'human', active: true });
    const lb = learn({ agent: 'growth', kind: 'post', key: 'subject', content: { text: nl.subject_b }, source: 'ai', active: true });
    if (a !== b) { scoreLesson(a > b ? la : lb, true); scoreLesson(a > b ? lb : la, false); }
    q.run('UPDATE newsletters SET ab_scored=1 WHERE id=?', nl.id); n++;
  }
  return n ? `${n} newsletter subject tests scored` : '';
}

// ================= Executors =================
registerExecutors({
  /** Schedules a social post (publishing happens on the next minute's run). */
  publish_social(p) {
    const post = q.get<any>('SELECT * FROM social_posts WHERE id=?', Number(p.post_id));
    if (!post) throw new Error('Post not found');
    if (post.status !== 'draft') return `already ${post.status}`;
    const text = String(p.text || post.text);
    const res = JSON.parse(post.results || '{}');
    let lessonId = post.lesson_id;
    if (!p._edited && res._template && !lessonId) lessonId = learn({ agent: 'social', kind: 'post', key: res._key || `post:${post.kind}`, content: { text: res._template }, source: 'ai' });
    const when = p.when && p.when > now() ? p.when : now();
    q.run("UPDATE social_posts SET status='scheduled', text=?, text_short=?, scheduled_at=?, lesson_id=? WHERE id=?", text.includes('{link}') ? text : `${text} {link}`, shorten(text.includes('{link}') ? text : `${text} {link}`), when, lessonId, post.id);
    return `scheduled for ${when.slice(0, 16).replace('T', ' ')} UTC`;
  },
  /** Sends one lifecycle email batch. */
  send_campaign(p) {
    let lessonId = Number(p.lesson_id) || null;
    if (p._edited) lessonId = learn({ agent: 'email', kind: 'template', key: `email:${p.campaign}`, lang: p.lang || 'en', content: { title: p.title, body: p.body }, source: 'human' });
    let sent = 0;
    for (const r of (p.recipients || []) as Recipient[]) {
      const u = q.get<any>('SELECT * FROM users WHERE id=?', r.user_id);
      if (!u || u.status !== 'active' || !u.marketing_opt_in) continue;
      // One contact limit across all agents: promotional emails stop once someone has had enough this week.
      if (!['maturity', 'paid_out'].includes(p.campaign) && Number(q.val("SELECT COUNT(*) FROM campaign_sends WHERE user_id=? AND sent_at>=? AND campaign NOT IN ('maturity','paid_out')", u.id, new Date(Date.now() - 7 * 864e5).toISOString()) ?? 0) >= Number(settings().contact_cap_week || 2)) continue;
      if (q.run('INSERT OR IGNORE INTO campaign_sends (campaign, ref, user_id, lesson_id, sent_at) VALUES (?,?,?,?,?)', p.campaign, r.ref || '', u.id, lessonId, now()).changes === 0) continue;
      const title = fill(String(p.title), r.vars), body = fill(String(p.body), r.vars);
      const link = forRecipient(trackedLink(CAMPAIGN_LINK[p.campaign]?.(r) || '/app', { channel: 'email', campaign: `email-${p.campaign}`, lessonId }).url, { userId: u.id });
      queueEmail(u.email, title, emailShell(escapeHtml(title), `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p><p style="font-size:12px;color:#777;margin-top:24px">${escapeHtml(translate(u.lang, 'agent.unsub'))} <a href="${unsubLink(u.id)}">${unsubLink(u.id)}</a></p>`,
        { label: translate(u.lang, `mkt.${p.campaign}.cta`) !== `mkt.${p.campaign}.cta` ? translate(u.lang, `mkt.${p.campaign}.cta`) : ({ follow_us: 'Invite a friend', verify_reminder: 'Verify now', fund_reminder: 'Fund your wallet', lot_closing: 'See the lot' } as Record<string, string>)[p.campaign] || 'Open ComboTrader', url: link }), { marketing: true, campaign: `campaign-${p.campaign}`, lessonId });
      trackOutcome(lessonId, `email:${p.campaign}`, { userId: u.id });
      sent++;
    }
    if (lessonId) q.run('UPDATE agent_lessons SET uses=uses+?, last_used_at=? WHERE id=?', sent, now(), lessonId);
    return `${sent} emails sent`;
  },
});
// "Run now" buttons and the daily job reach these through AGENT_JOBS.
AGENT_JOBS.social = () => runSocial(true);
AGENT_JOBS.email = runEmail;
export const _keep = { isLang, lessonsFor };
