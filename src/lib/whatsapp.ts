// WhatsApp companion (Meta WhatsApp Cloud API). Anyone can ask general questions; Champions link their number once
// (an emailed code) to check balance, trades, payout dates, Harvest Trail updates and open lots, or ask a question (answered by the
// support agent, with hand-over to a person). Nothing on WhatsApp can move money.
import crypto from 'node:crypto';
import { GRAPH } from './meta';
import { q, now } from './db';
import { config } from './config';
import { settings } from './settings';
import { walletBalance, reservedBalance } from './ledger';
import { openLots, lotRemaining, stageLabel, lotPeriods, rateFor } from './trading';
import { userPlans } from './plans';
import { supportAnswer } from './agents';
import { translate, isLang, detectLang, type Lang } from './i18n';
import { fmtNGN } from './util';
import { fmtDate } from './i18n';
import { audit } from './audit';
import { rateLimit } from './auth';
import { sendEmailCode, checkEmailCode, maskEmail } from './emailcode';
import { queueEmail, emailShell, escapeHtml } from './notify';
import { openLotsForAgents } from './chat';
import type { User } from './http';

export const waLive = () => !!(config.waToken && config.waPhoneId);

export function signatureValid(raw: Buffer, header: string | undefined) {
  if (!config.waAppSecret) return !config.production; // signatures are required in production
  if (!header?.startsWith('sha256=')) return false;
  const h = 'sha256=' + crypto.createHmac('sha256', config.waAppSecret).update(raw).digest('hex');
  return h.length === header.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(header));
}

export async function sendWhatsApp(to: string, body: string) {
  const digits = to.replace(/\D/g, '');
  q.insert('wa_messages', { phone: digits, user_id: userByPhone(digits)?.id ?? null, direction: 'out', body: body.slice(0, 4000), created_at: now() });
  if (!waLive()) return false;
  const res = await fetch(`${GRAPH}/${config.waPhoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.waToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: digits, type: 'text', text: { preview_url: true, body: body.slice(0, 4000) } }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

/** 08012345678 / +234 801 234 5678 / 2348012345678 → 2348012345678 */
export function normPhone(p: string | null | undefined) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 11) d = `234${d.slice(1)}`;
  return d;
}
/** The Champion whose WhatsApp number is linked (confirmed once with an emailed code). */
export function userByPhone(digits: string) {
  const d = normPhone(digits);
  return q.all<User>("SELECT * FROM users WHERE phone IS NOT NULL AND phone_verified_at IS NOT NULL AND status='active' ORDER BY id").find((u) => normPhone(u.phone) === d) || null;
}
/** A Champion whose profile has this number but hasn't linked WhatsApp yet (only if exactly one). */
function unlinkedByPhone(digits: string) {
  const d = normPhone(digits);
  const rows = q.all<User>("SELECT * FROM users WHERE phone IS NOT NULL AND phone_verified_at IS NULL AND status='active'").filter((u) => normPhone(u.phone) === d);
  return rows.length === 1 ? rows[0] : null;
}
const ACCOUNT_CMDS = ['balance', 'trades', 'payout', 'trail', 'plan'];
/** Puts a WhatsApp conversation in front of the team (Admin → Website chats / WhatsApp), emailing once per 6 hours. */
function flagForTeam(digits: string, name: string | undefined, text: string, userId: number | null) {
  const ex = q.get<any>("SELECT * FROM chats WHERE source='whatsapp' AND external_id=?", digits);
  const id = ex ? ex.id : q.insert('chats', { token: crypto.randomBytes(12).toString('hex'), source: 'whatsapp', external_id: digits, user_id: userId, name: name || null, lang: 'en', page: `+${digits}`, status: 'needs_person', created_at: now(), updated_at: now() }).id;
  q.insert('chat_messages', { chat_id: id, sender: 'visitor', body: text.slice(0, 2000), created_at: now() });
  q.run("UPDATE chats SET status='needs_person', updated_at=? WHERE id=?", now(), id);
  if (ex && ex.status === 'needs_person' && Date.now() - new Date(ex.updated_at).getTime() < 6 * 3600e3) return;
  const subject = `WhatsApp needs a person: ${name || `+${digits}`}`;
  for (const a of q.all<any>("SELECT email FROM users WHERE role='admin' AND status='active' AND (admin_roles LIKE '%super%' OR admin_roles LIKE '%support%')"))
    queueEmail(a.email, subject, emailShell(subject, `<p>${escapeHtml(name || 'Someone')} (+${digits}) on WhatsApp:</p><p>${escapeHtml(text.slice(0, 600))}</p>`, { label: 'Open the conversation', url: `${config.baseUrl}/admin/whatsapp?phone=${digits}` }));
}
function lotsReply(t: (k: string, v?: Record<string, string | number>) => string) {
  const lots = openLots(4);
  if (!lots.length) return t('wa.no_lots', { url: `${config.baseUrl}/lots` });
  return `${t('wa.lots_head')}\n${lots.map((l) => `• ${l.title}: ${lotPeriods(l).join('/')} mo · ${rateFor(lotPeriods(l)[0]) / 100}–${rateFor(lotPeriods(l).slice(-1)[0]) / 100}% p.a. · ${t('wa.left', { amount: fmtNGN(lotRemaining(l)) })}\n  ${config.baseUrl}/lots/${l.code}`).join('\n')}\n${t('wa.join_web')}`;
}

const CMDS: Record<string, string[]> = {
  menu: ['menu', 'hi', 'hello', 'hey', 'start', '0', 'bonjour', 'salut', 'habari', 'jambo', 'olá', 'ola', 'oi', 'مرحبا', 'السلام', 'قائمة'],
  balance: ['1', 'balance', 'wallet', 'solde', 'portefeuille', 'salio', 'pochi', 'saldo', 'carteira', 'رصيد', 'المحفظة'],
  trades: ['2', 'trades', 'trade', 'certificates', 'transactions', 'biashara', 'transações', 'transacoes', 'صفقات', 'صفقاتي'],
  payout: ['3', 'payout', 'payouts', 'paid', 'paiement', 'malipo', 'pagamento', 'دفع', 'الدفع'],
  trail: ['4', 'trail', 'update', 'updates', 'piste', 'njia', 'percurso', 'مسار'],
  lots: ['5', 'lots', 'open', 'invest', 'join', 'makundi', 'lotes', 'دفعات'],
  plan: ['6', 'plan', 'plans', 'savings', 'épargne', 'akiba', 'poupança', 'خطة'],
  human: ['7', 'human', 'agent', 'person', 'support', 'help me', 'humain', 'binadamu', 'humano', 'موظف'],
  stop: ['stop', 'unsubscribe', 'arrêt', 'acha', 'parar', 'توقف'],
};
function commandFor(text: string) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  for (const [cmd, keys] of Object.entries(CMDS)) if (keys.includes(t)) return cmd;
  return null;
}

/** Builds the reply to one inbound message. Returns the text (also logged). */
export async function handleInbound(from: string, text: string, waId?: string | null, profileLang?: string, profileName?: string): Promise<string> {
  const digits = normPhone(from);
  if (waId && q.get('SELECT 1 FROM wa_messages WHERE wa_id=?', waId)) return ''; // Meta retries; answer once
  const u = userByPhone(digits);
  const cand = u ? null : unlinkedByPhone(digits);
  q.insert('wa_messages', { wa_id: waId ?? null, phone: digits, user_id: u?.id ?? null, direction: 'in', body: text.slice(0, 4000), created_at: now() });
  const lang: Lang = u?.lang && isLang(u.lang) ? u.lang : isLang(profileLang) ? profileLang : detectLang(undefined);
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  if (!settings().whatsapp_enabled) return t('wa.off');
  const cmd = commandFor(text);
  if (!u) {
    // Not linked: anyone can ask general questions; account details need the number linked to a ComboTrader account.
    if (cand && /^\s*\d{6}\s*$/.test(text)) {
      if (!checkEmailCode(cand, 'whatsapp', text)) return t('wa.link_bad');
      q.run('UPDATE users SET phone_verified_at=?, whatsapp_opt_in=1 WHERE id=?', now(), cand.id);
      q.run('UPDATE wa_messages SET user_id=? WHERE phone=? AND user_id IS NULL', cand.id, digits);
      audit(cand.id, 'whatsapp.linked', `+${digits}`);
      return `${t('wa.linked', { name: cand.first_name })}\n\n${t('wa.menu', { name: cand.first_name })}`;
    }
    if (cmd === 'stop') return t('wa.stopped');
    if (cmd === 'menu') return t('wa.menu_guest');
    if (cmd === 'lots') return lotsReply(t);
    if (cmd === 'human') { flagForTeam(digits, profileName, lastInbound(digits, 5).join('\n'), cand?.id ?? null); return t('wa.human'); }
    if (cmd && ACCOUNT_CMDS.includes(cmd)) {
      if (cand) {
        if (rateLimit(`walink:${cand.id}`, 3, 3600)) sendEmailCode(cand, 'whatsapp');
        return t('wa.link_code', { email: maskEmail(cand.email) });
      }
      return t('wa.link_needed', { signup: `${config.baseUrl}/signup`, profile: `${config.baseUrl}/app/profile` });
    }
    const r = await supportAnswer(null, text, lang, `whatsapp:${digits}`, { channel: 'WhatsApp (plain text, short, no markdown)', persona: 'chief', open_trade_lots: openLotsForAgents(), latest_message: text, sender_name: profileName || '' });
    if (r.escalate) flagForTeam(digits, profileName, text, cand?.id ?? null);
    return `${r.reply}\n\n${t(cand ? 'wa.guest_hint_link' : 'wa.guest_hint')}`;
  }
  if (cmd === 'stop') { q.run('UPDATE users SET whatsapp_opt_in=0 WHERE id=?', u.id); return t('wa.stopped'); }
  if (!u.whatsapp_opt_in) q.run('UPDATE users SET whatsapp_opt_in=1 WHERE id=?', u.id); // messaging us first is an opt-in to replies
  switch (cmd) {
    case 'menu': return t('wa.menu', { name: u.first_name });
    case 'balance': return t('wa.balance', { amount: fmtNGN(walletBalance(u.id)), reserved: fmtNGN(reservedBalance(u.id)) });
    case 'trades': {
      const rows = q.all<any>("SELECT t.*, l.title FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? AND t.status IN ('active','matured') ORDER BY t.matures_at LIMIT 6", u.id);
      if (!rows.length) return t('wa.no_trades', { url: `${config.baseUrl}/app/lots` });
      return `${t('wa.trades_head')}\n${rows.map((r) => `• ${r.title} — ${fmtNGN(r.amount)} · ${t('wa.pays_on', { date: fmtDate(lang, r.matures_at) })} (${r.certificate_no})`).join('\n')}`;
    }
    case 'payout': {
      const r = q.get<any>("SELECT t.*, l.title FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? AND t.status IN ('active','matured') ORDER BY t.matures_at LIMIT 1", u.id);
      return r ? t('wa.next_payout', { lot: r.title, date: fmtDate(lang, r.matures_at), amount: fmtNGN(r.amount) }) : t('wa.no_trades', { url: `${config.baseUrl}/app/lots` });
    }
    case 'trail': {
      const e = q.get<any>(`SELECT e.*, l.title FROM trail_events e JOIN lots l ON l.id=e.lot_id WHERE e.lot_id IN (SELECT lot_id FROM trades WHERE user_id=? AND status IN ('active','matured')) ORDER BY e.happened_at DESC, e.id DESC LIMIT 1`, u.id);
      if (!e) return t('wa.no_trail');
      return t('wa.trail', { lot: e.title, stage: stageLabel(lang, e.stage), date: fmtDate(lang, e.happened_at), note: e.note || '' }) + (e.photo_path ? `\n${config.baseUrl}/uploads/${e.photo_path}` : '');
    }
    case 'lots': return lotsReply(t);
    case 'plan': {
      const p = userPlans(u.id).find((x) => ['active', 'paused', 'ready'].includes(x.status));
      return p ? t('wa.plan', { plan: p.name, saved: fmtNGN(p.saved || 0), target: fmtNGN(p.target_amount), status: t(`plan.status.${p.status}`) }) : t('wa.no_plan', { url: `${config.baseUrl}/app/plans` });
    }
    case 'human': {
      q.insert('tickets', { user_id: u.id, subject: 'WhatsApp: asked for a person', body: lastInbound(digits, 5).join('\n'), created_at: now() });
      return t('wa.human');
    }
  }
  // Free text → support agent.
  const r = await supportAnswer(u, text, lang, `whatsapp:${digits}`, { channel: 'WhatsApp (plain text, short, no markdown)', persona: 'chief', open_trade_lots: openLotsForAgents(), latest_message: text });
  if (r.escalate) {
    q.insert('tickets', { user_id: u.id, subject: `WhatsApp: ${text.slice(0, 60)}`, body: `${text}\n\n[Assistant draft] ${r.reply}`, created_at: now() });
    audit(null, 'whatsapp.handover', `user:${u.id}`, r.reason);
  }
  return `${r.reply}\n\n${t('wa.menu_hint')}`;
}
function lastInbound(digits: string, n: number) {
  return q.all<any>("SELECT body, created_at FROM wa_messages WHERE phone=? AND direction='in' ORDER BY id DESC LIMIT ?", digits, n).reverse().map((m) => `${m.created_at.slice(0, 16)} ${m.body}`);
}

/** Processes a Meta webhook payload: replies to each text message. */
export async function processWebhook(body: any) {
  let n = 0;
  for (const entry of body?.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    for (const m of v.messages || []) {
      const text = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.type === 'interactive' ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title) : null;
      const name = (v.contacts || []).find((x: any) => x.wa_id === m.from)?.profile?.name;
      const reply = text ? await handleInbound(m.from, String(text), m.id, undefined, name) : translate('en', 'wa.text_only');
      if (reply) { await sendWhatsApp(m.from, reply).catch((e) => audit(null, 'whatsapp.send_failed', m.from, String(e.message))); n++; }
    }
  }
  return n;
}
