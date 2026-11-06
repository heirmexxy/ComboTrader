// Telegram bot: the front door on Telegram. Anyone who opens the bot (from a channel post, a Champion's invite link,
// an ad or a QR code) can ask questions and see open lots; Champions link their account once (an emailed code) to see
// their wallet, trades and payout dates. Answers come from Adaeze (as on WhatsApp). Nothing here can move money.
// A bot can only reply to people who message it first, so it never contacts anyone uninvited.
import crypto from 'node:crypto';
import { q, now } from './db';
import { config } from './config';
import { settings, setSetting } from './settings';
import { walletBalance, reservedBalance } from './ledger';
import { openLots, lotRemaining, lotPeriods, rateFor } from './trading';
import { supportAnswer } from './agents';
import { translate, isLang, type Lang } from './i18n';
import { fmtNGN } from './util';
import { fmtDate } from './i18n';
import { audit } from './audit';
import { rateLimit } from './auth';
import { sendEmailCode, checkEmailCode, maskEmail } from './emailcode';
import { queueEmail, emailShell, escapeHtml } from './notify';
import { openLotsForAgents } from './chat';
import type { User } from './http';

export const tgLive = () => !!config.telegramBotToken;
/** The secret Telegram sends with every webhook call (derived from the bot token, so nothing extra to configure). */
export const tgSecret = () => crypto.createHash('sha256').update(`tg-webhook:${config.telegramBotToken}`).digest('hex').slice(0, 48);
export const channelUrl = () => { const c = String(config.telegramChannel || '').replace(/^@/, ''); return c && !/^-?\d+$/.test(c) ? `https://t.me/${c}` : ''; };
/** t.me link to the bot, optionally with a start code (r_<referral code>, ad_<n>, post_<id>, qr…) to see where people came from. */
export function botLink(start?: string) { const u = String(settings().telegram_bot_username || ''); return u ? `https://t.me/${u}${start ? `?start=${encodeURIComponent(start)}` : ''}` : ''; }

async function api(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || res.status}`);
  return j.result;
}
/** Points Telegram at our webhook and remembers the bot's username (safe to run at every start). */
export async function setupTelegramBot() {
  if (!tgLive()) return 'no TELEGRAM_BOT_TOKEN';
  const me = await api('getMe', {});
  if (me?.username && me.username !== settings().telegram_bot_username) setSetting('telegram_bot_username', me.username);
  await api('setWebhook', { url: `${config.baseUrl}/webhooks/telegram`, secret_token: tgSecret(), allowed_updates: ['message'], drop_pending_updates: false });
  await api('setMyCommands', { commands: [{ command: 'menu', description: 'What I can do' }, { command: 'lots', description: 'Open Trade Lots' }, { command: 'link', description: 'Link your ComboTrader account' }, { command: 'person', description: 'Talk to a person' }] }).catch(() => undefined);
  return `@${me?.username} connected`;
}

export async function sendTelegram(chatId: string | number, text: string) {
  q.insert('tg_messages', { chat_id: String(chatId), direction: 'out', body: text.slice(0, 4000), created_at: now() });
  if (!tgLive()) return false;
  await api('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: false });
  return true;
}

const userByChat = (chatId: string) => q.get<User>("SELECT * FROM users WHERE telegram_chat_id=? AND status='active'", chatId) || null;
function lotsReply(t: (k: string, v?: Record<string, string | number>) => string) {
  const lots = openLots(4);
  if (!lots.length) return t('wa.no_lots', { url: `${config.baseUrl}/lots` });
  return `${t('wa.lots_head')}\n${lots.map((l) => `• ${l.title}: ${lotPeriods(l).join('/')} mo · ${rateFor(lotPeriods(l)[0]) / 100}–${rateFor(lotPeriods(l).slice(-1)[0]) / 100}% p.a. · ${t('wa.left', { amount: fmtNGN(lotRemaining(l)) })}\n  ${config.baseUrl}/lots/${l.code}?utm_source=telegram`).join('\n')}\n${t('wa.join_web')}`;
}
function flagForTeam(chatId: string, name: string, text: string, userId: number | null) {
  const ex = q.get<any>("SELECT * FROM chats WHERE source='telegram' AND external_id=?", chatId);
  const id = ex ? ex.id : q.insert('chats', { token: crypto.randomBytes(12).toString('hex'), source: 'telegram', external_id: chatId, user_id: userId, name: name || null, lang: 'en', page: 'Telegram', status: 'needs_person', created_at: now(), updated_at: now() }).id;
  q.insert('chat_messages', { chat_id: id, sender: 'visitor', body: text.slice(0, 2000), created_at: now() });
  q.run("UPDATE chats SET status='needs_person', updated_at=? WHERE id=?", now(), id);
  if (ex && ex.status === 'needs_person' && Date.now() - new Date(ex.updated_at).getTime() < 6 * 3600e3) return;
  const subject = `Telegram needs a person: ${name || chatId}`;
  for (const a of q.all<any>("SELECT email FROM users WHERE role='admin' AND status='active' AND (admin_roles LIKE '%super%' OR admin_roles LIKE '%support%')"))
    queueEmail(a.email, subject, emailShell(subject, `<p>${escapeHtml(name || 'Someone')} on Telegram:</p><p>${escapeHtml(text.slice(0, 600))}</p>`, { label: 'Open website chats', url: `${config.baseUrl}/admin/chats` }));
}

const CMD: Record<string, RegExp> = {
  menu: /^\/?(start|menu|help|hi|hello|hey|0)$/i, lots: /^\/?(lots|5|open lots)$/i, person: /^\/?(person|human|7|support)$/i,
  balance: /^\/?(balance|wallet|1)$/i, trades: /^\/?(trades|2)$/i, payout: /^\/?(payout|3)$/i, stop: /^\/?(stop|unsubscribe)$/i,
};

/** Replies to one message from Telegram. */
export async function handleTelegram(msg: any): Promise<string> {
  const chatId = String(msg?.chat?.id ?? ''), text = String(msg?.text || '').trim();
  if (!chatId || msg?.chat?.type !== 'private') return ''; // only one-to-one chats with the bot
  if (q.get('SELECT 1 FROM tg_messages WHERE chat_id=? AND tg_id=?', chatId, String(msg.message_id))) return ''; // retries: answer once
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ');
  q.insert('tg_messages', { chat_id: chatId, tg_id: String(msg.message_id), direction: 'in', body: text.slice(0, 4000), created_at: now() });
  const ex = q.get<any>('SELECT * FROM tg_chats WHERE chat_id=?', chatId);
  if (!ex) q.insert('tg_chats', { chat_id: chatId, name: name || null, username: msg.from?.username || null, lang: String(msg.from?.language_code || '').slice(0, 2) || null, created_at: now(), last_at: now() });
  else q.run('UPDATE tg_chats SET last_at=?, name=COALESCE(?, name) WHERE chat_id=?', now(), name || null, chatId);
  const u = userByChat(chatId);
  const tl = (u?.lang && isLang(u.lang) ? u.lang : isLang(String(msg.from?.language_code || '').slice(0, 2)) ? String(msg.from.language_code).slice(0, 2) : 'en') as Lang;
  const t = (k: string, v?: Record<string, string | number>) => translate(tl, k, v);
  if (!text) return t('wa.text_only');

  // Deep links: /start r_<code> (a Champion's invite), ad_<n> (an ad), post_<id>, qr… Remembered for attribution.
  const start = /^\/start\s+(\S+)/i.exec(text)?.[1];
  if (start) {
    q.run('UPDATE tg_chats SET start_code=COALESCE(start_code, ?) WHERE chat_id=?', start.slice(0, 64), chatId);
    const ref = /^r_([A-Za-z0-9]+)$/.exec(start)?.[1];
    const signup = `${config.baseUrl}/signup?utm_source=telegram&utm_campaign=${encodeURIComponent(start)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
    return `${t('tg.welcome')}\n\n${t('tg.join', { url: signup })}`;
  }
  // Linking: "/link email" sends a code to that address (if it has an account); the 6-digit reply confirms it.
  const link = /^\/link(?:\s+(\S+@\S+))?$/i.exec(text);
  if (link) {
    if (u) return t('tg.already_linked', { name: u.first_name });
    if (!link[1]) return t('tg.link_ask');
    const cand = q.get<User>("SELECT * FROM users WHERE lower(email)=lower(?) AND status='active'", link[1]);
    if (cand && rateLimit(`tglink:${chatId}`, 3, 3600)) { sendEmailCode(cand, 'telegram'); q.run('UPDATE tg_chats SET link_user_id=? WHERE chat_id=?', cand.id, chatId); }
    return t('tg.link_sent', { email: maskEmail(link[1]) }); // same reply whether or not the email has an account
  }
  if (!u && /^\d{6}$/.test(text) && ex?.link_user_id) {
    const cand = q.get<User>('SELECT * FROM users WHERE id=?', ex.link_user_id);
    if (!cand || !checkEmailCode(cand, 'telegram', text)) return t('wa.link_bad');
    q.run('UPDATE users SET telegram_chat_id=? WHERE id=?', chatId, cand.id);
    q.run('UPDATE tg_chats SET user_id=?, link_user_id=NULL WHERE chat_id=?', cand.id, chatId);
    audit(cand.id, 'telegram.linked', chatId);
    return `${t('tg.linked', { name: cand.first_name })}\n\n${t('wa.menu', { name: cand.first_name })}`;
  }

  const cmd = Object.entries(CMD).find(([, re]) => re.test(text))?.[0];
  if (cmd === 'stop') { q.run('UPDATE tg_chats SET opted_out=1 WHERE chat_id=?', chatId); return t('wa.stopped'); }
  if (cmd === 'menu') return u ? t('wa.menu', { name: u.first_name }) : t('tg.welcome');
  if (cmd === 'lots') return lotsReply(t);
  if (cmd === 'person') { flagForTeam(chatId, name, text, u?.id ?? null); return t('wa.human'); }
  if (cmd && ['balance', 'trades', 'payout'].includes(cmd)) {
    if (!u) return t('tg.link_ask');
    if (cmd === 'balance') return t('wa.balance', { amount: fmtNGN(walletBalance(u.id)), reserved: fmtNGN(reservedBalance(u.id)) });
    const rows = q.all<any>("SELECT t.*, l.title FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? AND t.status IN ('active','matured') ORDER BY t.matures_at LIMIT 6", u.id);
    if (!rows.length) return t('wa.no_trades', { url: `${config.baseUrl}/app/lots` });
    if (cmd === 'payout') return t('wa.next_payout', { lot: rows[0].title, date: fmtDate(tl, rows[0].matures_at), amount: fmtNGN(rows[0].amount) });
    return `${t('wa.trades_head')}\n${rows.map((r) => `• ${r.title} — ${fmtNGN(r.amount)} · ${t('wa.pays_on', { date: fmtDate(tl, r.matures_at) })} (${r.certificate_no})`).join('\n')}`;
  }
  // Anything else: Adaeze answers.
  const r = await supportAnswer(u, text, tl, `telegram:${chatId}`, { channel: 'Telegram (plain text, short, no markdown)', persona: 'chief', open_trade_lots: openLotsForAgents(), latest_message: text, sender_name: name });
  if (r.escalate) flagForTeam(chatId, name, text, u?.id ?? null);
  return `${r.reply}\n\n${t(u ? 'wa.menu_hint' : 'tg.guest_hint')}`;
}

/** Telegram webhook body → reply. */
export async function processTelegramUpdate(body: any) {
  const msg = body?.message;
  if (!msg) return 0;
  const reply = await handleTelegram(msg);
  if (reply) await sendTelegram(msg.chat.id, reply).catch((e) => audit(null, 'telegram.send_failed', String(msg.chat.id), String(e.message)));
  return reply ? 1 : 0;
}

export function telegramStats() {
  return {
    people: Number(q.val('SELECT COUNT(*) FROM tg_chats') ?? 0),
    linked: Number(q.val('SELECT COUNT(*) FROM users WHERE telegram_chat_id IS NOT NULL') ?? 0),
    week: Number(q.val('SELECT COUNT(*) FROM tg_chats WHERE created_at>=?', new Date(Date.now() - 7 * 864e5).toISOString()) ?? 0),
    sources: q.all<any>("SELECT COALESCE(start_code, 'direct') code, COUNT(*) n FROM tg_chats GROUP BY code ORDER BY n DESC LIMIT 20"),
  };
}


// ---------- Telegram Ads (placed by a person at ads.telegram.org; paid ads need ARCON approval first) ----------
/** Ad texts are at most 160 characters. Each ad gets its own bot link (ad_<id>), so people and sign-ups per ad are counted. */
export async function draftTelegramAds(by: number | null) {
  const { useAI, completeJson, POLICY } = await import('./ai');
  const { offMessage, playbookFor } = await import('../content/playbook');
  const lots = openLots(3);
  let texts: string[] = [
    'Fund real farm produce deals in Nigeria. Every lot has a named buyer, and you follow your money from farm to buyer. Ask us anything.',
    'See exactly where your money goes: sesame, soybean and rice lots with named buyers and photo updates from the farm. Start with our assistant.',
    'Harvest Circles: save and fund farm trade lots together with your cooperative or staff group. Ask how it works.',
    ...lots.map((l) => `New Trade Lot: ${l.title}. ${lotPeriods(l).join('/')} months, named buyer, farm-to-buyer updates. Ask our assistant for details.`),
  ];
  if (useAI('social')) {
    try {
      const r = await completeJson<{ ads: string[] }>('social', { trigger: 'telegram_ads', fast: true,
        system: `${POLICY}\n${playbookFor('social')}\nWrite 5 Telegram Ads for ComboTrader. Each at most 160 characters (strict), plain text, no emoji, no links (the link is added separately), no promises of returns or "guaranteed"/"risk-free". Lead with the core promise or a concrete open lot. Return {"ads":[string]}.`,
        input: { open_lots: lots.map((l) => ({ title: l.title, months: lotPeriods(l) })) } });
      if (Array.isArray(r.data.ads)) texts = [...r.data.ads.map(String), ...texts];
    } catch { /* templates only */ }
  }
  let n = 0;
  for (const raw of texts) {
    const text = raw.trim().slice(0, 160);
    if (!text || offMessage(text).length || q.get('SELECT 1 FROM tg_ads WHERE text=?', text)) continue;
    const id = q.insert('tg_ads', { text, status: 'draft', created_by: by, created_at: now() }).id;
    q.run('UPDATE tg_ads SET code=? WHERE id=?', `ad_${id}`, id);
    if (++n >= 6) break;
  }
  return n;
}
export function telegramAds() {
  return q.all<any>(`SELECT a.*, (SELECT COUNT(*) FROM tg_chats c WHERE c.start_code=a.code) starts,
    (SELECT COUNT(*) FROM users u WHERE u.acq_source='telegram' AND u.acq_campaign=a.code) signups FROM tg_ads a WHERE a.status!='deleted' ORDER BY a.id DESC LIMIT 40`);
}
