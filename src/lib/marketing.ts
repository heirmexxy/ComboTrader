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
import { propose, registerExecutors, agentOn, supportAnswer, AGENT_JOBS } from './agents';
import { learn, bestLesson, lessonsFor, parseLesson, used, scoreLesson, trackOutcome, fill, lessonScore, type Lesson } from './learning';
import { trackedLink, forRecipient, signupsFor } from './tracking';
import { queueEmail, emailShell, escapeHtml } from './notify';
import { audit } from './audit';
import { translate, isLang, type Lang } from './i18n';
import { fmtNGN, randomToken, hmac, lagosNow } from './util';
import { siteStats, rateFor, lotPeriods, stageLabel } from './trading';
import { walletBalance } from './ledger';

// ================= Channels =================
export const CHANNELS = ['facebook', 'instagram', 'linkedin', 'x', 'telegram'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_NAMES: Record<Channel, string> = { facebook: 'Facebook Page', instagram: 'Instagram', linkedin: 'LinkedIn Page', x: 'X (Twitter)', telegram: 'Telegram channel' };
export const CHANNEL_SETUP: Record<Channel, string> = {
  facebook: 'FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN (a long-lived Page token with pages_manage_posts, pages_read_engagement, pages_messaging, leads_retrieval)',
  instagram: 'INSTAGRAM_BUSINESS_ID (the Instagram professional account linked to the Facebook Page; uses the Page token, needs instagram_content_publish)',
  linkedin: 'LINKEDIN_TOKEN and LINKEDIN_ORG_URN (needs the w_organization_social permission from LinkedIn’s Community Management API)',
  x: 'X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET (an X developer app with write access; posting needs a paid X API tier)',
  telegram: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL (make the bot an admin of the channel)',
};
export function channelReady(ch: string) {
  switch (ch) {
    case 'facebook': return !!(config.fbPageId && config.fbPageToken);
    case 'instagram': return !!(config.igUserId && config.fbPageToken);
    case 'linkedin': return !!(config.linkedinToken && config.linkedinOrg);
    case 'x': return !!(config.xApiKey && config.xApiSecret && config.xAccessToken && config.xAccessSecret);
    case 'telegram': return !!(config.telegramBotToken && config.telegramChannel);
    default: return false;
  }
}
export const wantedChannels = () => String(settings().social_channels).split(',').map((x) => x.trim()).filter((x): x is Channel => (CHANNELS as readonly string[]).includes(x));

const GRAPH = 'https://graph.facebook.com/v21.0';
async function graph(p: string, params: Record<string, string>, method: 'GET' | 'POST' = 'POST') {
  const body = new URLSearchParams({ ...params, access_token: config.fbPageToken });
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
  if (ch === 'facebook') return (img ? await graph(`${config.fbPageId}/photos`, { url: img, caption: text }) : await graph(`${config.fbPageId}/feed`, { message: text })).id;
  if (ch === 'instagram') {
    if (!img) throw new Error('Instagram needs an image');
    const c = await graph(`${config.igUserId}/media`, { image_url: img, caption: text });
    return (await graph(`${config.igUserId}/media_publish`, { creation_id: c.id })).id;
  }
  if (ch === 'linkedin') {
    const res = await fetch('https://api.linkedin.com/rest/posts', { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${config.linkedinToken}`, 'LinkedIn-Version': config.linkedinVersion, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: config.linkedinOrg, commentary: text.replace(/[(){}\[\]<>@|~_*#]/g, (m) => `\\${m}`), visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false }) });
    if (!res.ok) throw new Error(`LinkedIn ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.headers.get('x-restli-id') || 'ok';
  }
  if (ch === 'x') {
    const url = 'https://api.x.com/2/tweets';
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: xAuthHeader('POST', url), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: short }) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`X ${res.status}: ${j?.detail || j?.title || ''}`);
    return j?.data?.id || 'ok';
  }
  if (ch === 'telegram') {
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
  const host = config.baseUrl.replace(/^https?:\/\//, '');
  const head = wrap(o.headline, 20, 3);
  const top = o.photo ? 560 : 300;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  ${o.photo ? '' : '<rect width="1080" height="1080" fill="#1F4D2B"/><circle cx="930" cy="150" r="250" fill="#2E6B3D"/><circle cx="120" cy="980" r="210" fill="#24573A"/>'}
  ${o.photo ? '<rect y="470" width="1080" height="610" fill="#1F4D2B" opacity="0.94"/>' : ''}
  <g font-family="Arial, Helvetica, sans-serif">
    <text x="80" y="${o.photo ? 120 : 130}" font-size="40" font-weight="700" fill="#FFFFFF" ${o.photo ? 'stroke="#1F4D2B" stroke-width="6" paint-order="stroke"' : ''}>COMBO<tspan fill="#D4A017">TRADER</tspan></text>
    <text x="80" y="${top - 40}" font-size="34" font-weight="700" fill="#D4A017" letter-spacing="2">${xml(o.eyebrow.toUpperCase())}</text>
    ${head.map((l, i) => `<text x="80" y="${top + 30 + i * (o.photo ? 62 : 84)}" font-size="${o.photo ? 56 : 76}" font-weight="700" fill="#FFFFFF">${xml(l)}</text>`).join('')}
    ${o.lines.slice(0, 3).map((l, i) => `<text x="80" y="${top + 30 + head.length * (o.photo ? 62 : 84) + 40 + i * 52}" font-size="38" fill="#F7F1E3">${xml(l)}</text>`).join('')}
    <rect x="80" y="930" width="560" height="84" rx="42" fill="#C0603A"/>
    <text x="360" y="985" font-size="34" font-weight="700" fill="#FFFFFF" text-anchor="middle">${xml(host)}/join</text>
  </g></svg>`;
  let base = sharp(Buffer.from(svg));
  if (o.photo) {
    const src = path.resolve(config.uploadsDir, 'public', o.photo);
    if (fs.existsSync(src)) {
      const bg = await sharp(src).resize(1080, 1080, { fit: 'cover' }).toBuffer();
      base = sharp(bg).composite([{ input: Buffer.from(svg) }]);
    }
  }
  return saveSocialImage(await base.jpeg({ quality: 86 }).toBuffer());
}

// ================= Social: planning =================
type Plan = { kind: string; ref: string; key: string; url: string; facts: Record<string, string | number>; card: { eyebrow: string; headline: string; lines: string[]; photo?: string | null } };
const LEARN_TOPICS = ['how', 'periods', 'trail', 'circles', 'plans', 'verify', 'risk'];
const posted = (ref: string) => !!q.get('SELECT 1 FROM social_posts WHERE ref=?', ref);
const isoWeek = () => { const d = lagosNow(); const y = d.getUTCFullYear(); const start = Date.UTC(y, 0, 1); return `${y}-W${String(Math.ceil(((d.getTime() - start) / 864e5 + new Date(start).getUTCDay() + 1) / 7)).padStart(2, '0')}`; };
function rangeOf(l: any) { const p = lotPeriods(l); const a = p[0], b = p[p.length - 1]; return a === b ? { periods: `${a} months`, rates: `${rateFor(a) / 100}%` } : { periods: `${a}–${b} months`, rates: `${rateFor(a) / 100}%–${rateFor(b) / 100}%` }; }

/** What to post next: a new lot first, then fresh Trail news, milestones, weekly prices, then how-to topics in turn. */
export function planNextPost(): Plan {
  const lot = q.get<any>("SELECT l.*, c.name AS commodity_name FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.status='open' AND l.closes_at>? AND NOT EXISTS (SELECT 1 FROM social_posts s WHERE s.ref='lot:' || l.code) ORDER BY COALESCE(l.opened_at, l.created_at) DESC", now());
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
  const topic = LEARN_TOPICS.slice().sort((a, b) => lastByTopic(a).localeCompare(lastByTopic(b)))[0];
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
export async function createPost(force = false): Promise<string> {
  const s = settings();
  const plan = planNextPost();
  const day = lagosNow().getUTCDay();
  const perWeek = Math.max(0, Math.min(14, Number(s.social_posts_per_week) || 0));
  const days = [1, 3, 5, 2, 4, 6, 0].slice(0, Math.min(7, perWeek));
  const today = lagosNow().toISOString().slice(0, 10);
  const postedToday = Number(q.val("SELECT COUNT(*) FROM social_posts WHERE substr(created_at,1,10)=?", today) ?? 0);
  if (!force && (postedToday > 0 || (!days.includes(day) && plan.kind !== 'lot'))) return 'not a posting day';
  let text = '', short = '', template: string | null = null, lessonId: number | null = null, runId: number | null = null;
  if (useAI('social')) {
    try {
      const examples = lessonsFor('social', 'post', { key: plan.key }).filter((l) => l.wins + l.losses >= 2).sort((a, b) => lessonScore(b) - lessonScore(a)).slice(0, 3).map((l) => ({ ...parseLesson(l), clicks_result: `${l.wins} of ${l.wins + l.losses} worked` }));
      const r = await completeJson<{ text: string; x_text: string; template: string }>('social', { trigger: `post:${plan.kind}`, maxTokens: 1500,
        system: `${POLICY}\nYou write ComboTrader's social media posts for Nigerian and diaspora audiences on Facebook, Instagram, LinkedIn, X and Telegram. Using ONLY the facts given, write "text" (≤ 450 characters, warm and concrete, at most 2 emojis, at most 3 hashtags, end with a clear next step) and "x_text" (≤ 240 characters). Both must contain the placeholder {link} exactly once (we put the tracked link there). No earnings promises beyond the rates given; never say guaranteed or investment. ` +
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
  propose({ agent: 'social', kind: 'publish_social', risk: 'low', title: `${plan.kind === 'lot' ? 'New lot post' : `Post: ${plan.kind}`} for ${wantedChannels().map((c) => CHANNEL_NAMES[c]).join(', ') || 'copy and post'}`,
    summary: text.replace('{link}', '🔗'), payload: { post_id: id, text, when: nextSlot() }, runId });
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
async function sendDm(recipient: string, text: string) { if (!config.fbPageToken) return false; await graph('me/messages', { recipient: JSON.stringify({ id: recipient }), message: JSON.stringify({ text: text.slice(0, 1900) }), messaging_type: 'RESPONSE' }); return true; }
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
      const from = String(v.from?.id || ''); if (!cid || from === config.fbPageId || from === config.igUserId) continue;
      if (q.get('SELECT 1 FROM social_inbox WHERE external_id=?', `c:${cid}`)) continue;
      let reply: string | null = null;
      if (s.social_auto_reply && agentOn('social') && INTEREST.test(text)) {
        const link = trackedLink('/join', { channel: isIg ? 'instagram' : 'facebook', campaign: 'comment-reply' }).url;
        reply = fill(replyTemplate('reply:comment', 'Thanks for asking! How it works, the open Trade Lots and how to start are all here: {link}'), { link });
        try { if (config.fbPageToken) { if (isIg) await graph(`${cid}/replies`, { message: reply }); else await graph(`${cid}/private_replies`, { message: reply }); } }
        catch (e: any) { audit(null, 'social.reply_failed', cid, e.message); reply = null; }
      }
      q.insert('social_inbox', { channel: isIg ? 'instagram' : 'facebook', kind: 'comment', external_id: `c:${cid}`, author: v.from?.name || v.from?.username || null, text: text.slice(0, 2000), reply, replied_at: reply ? now() : null, created_at: now() });
      n++;
    }
    // Direct messages (Messenger and Instagram)
    for (const m of entry.messaging || []) {
      const mid = String(m.message?.mid || ''); const text = String(m.message?.text || '');
      const sender = String(m.sender?.id || '');
      if (!mid || !text || m.message?.is_echo || sender === config.fbPageId || sender === config.igUserId) continue;
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
export const CAMPAIGN_KEYS = ['welcome_1', 'welcome_2', 'welcome_3', 'maturity', 'paid_out', 'winback', 'new_lot'] as const;
type Recipient = { user_id: number; ref: string; vars: Record<string, string> };
const campaignOn = (c: string) => String(settings().email_campaigns).split(',').map((x) => x.trim()).includes(c.replace(/_\d$/, ''));
const CAMPAIGN_LINK: Record<string, (r: Recipient) => string> = {
  welcome_1: () => '/how-it-works', welcome_2: () => '/app/lots', welcome_3: () => '/app/circles',
  maturity: (r) => `/app/trades/${r.ref}`, paid_out: () => '/app/lots', winback: () => '/app/lots', new_lot: (r) => `/lots/${r.ref}`,
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
    case 'new_lot': {
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
      learn({ agent: 'email', kind: 'template', key, lang, content: { title: translate(lang as Lang, `mkt.${c}.subject`), body: translate(lang as Lang, `mkt.${c}.body`) }, source: 'rules' });
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
    system: `${POLICY}\nYou improve ComboTrader lifecycle emails. Write ONE alternative version of this email in ${lang} to test against the current one: a different subject angle and a clearer, warmer body (≤ 110 words). Keep exactly these placeholders: ${[...new Set(placeholders)].join(', ') || 'none'}. Do not add links (a button is added). Return {"title":string,"body":string}.`,
    input: { campaign: c, current } });
  const ok = [...new Set(placeholders)].every((p) => `${r.data.title} ${r.data.body}`.includes(p));
  if (ok && r.data.title && r.data.body) learn({ agent: 'email', kind: 'template', key: `email:${c}`, lang, content: { title: r.data.title, body: r.data.body }, source: 'ai' });
}
/** After 3 days: which newsletter subject got more clicks? */
function scoreNewsletterAB() {
  let n = 0;
  for (const nl of q.all<any>("SELECT * FROM newsletters WHERE status='sent' AND subject_b IS NOT NULL AND ab_scored=0 AND send_at<=?", d(-3))) {
    const clicks = (v: string) => Number(q.val('SELECT COALESCE(SUM(clicks),0) FROM links WHERE campaign=?', `nl-${nl.id}-${v}`) ?? 0);
    const a = clicks('a'), b = clicks('b');
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
      if (q.run('INSERT OR IGNORE INTO campaign_sends (campaign, ref, user_id, lesson_id, sent_at) VALUES (?,?,?,?,?)', p.campaign, r.ref || '', u.id, lessonId, now()).changes === 0) continue;
      const title = fill(String(p.title), r.vars), body = fill(String(p.body), r.vars);
      const link = forRecipient(trackedLink(CAMPAIGN_LINK[p.campaign]?.(r) || '/app', { channel: 'email', campaign: `email-${p.campaign}`, lessonId }).url, { userId: u.id });
      queueEmail(u.email, title, emailShell(escapeHtml(title), `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p><p style="font-size:12px;color:#777;margin-top:24px">${escapeHtml(translate(u.lang, 'agent.unsub'))} <a href="${unsubLink(u.id)}">${unsubLink(u.id)}</a></p>`,
        { label: translate(u.lang, `mkt.${p.campaign}.cta`), url: link }));
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
