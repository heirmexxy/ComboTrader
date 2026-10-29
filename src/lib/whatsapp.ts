// WhatsApp companion (Meta WhatsApp Cloud API). Champions message the ComboTrader number from their verified phone
// to check balance, trades, payout dates, Harvest Trail updates and open lots, or ask a question (answered by the
// support agent, with hand-over to a person). Nothing on WhatsApp can move money.
import crypto from 'node:crypto';
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
  const res = await fetch(`https://graph.facebook.com/v21.0/${config.waPhoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.waToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: digits, type: 'text', text: { preview_url: true, body: body.slice(0, 4000) } }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export function userByPhone(digits: string) {
  return q.get<User>("SELECT * FROM users WHERE REPLACE(phone,'+','')=? AND phone_verified_at IS NOT NULL AND status='active' ORDER BY id LIMIT 1", digits.replace(/\D/g, ''));
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
export async function handleInbound(from: string, text: string, waId?: string | null, profileLang?: string): Promise<string> {
  const digits = from.replace(/\D/g, '');
  if (waId && q.get('SELECT 1 FROM wa_messages WHERE wa_id=?', waId)) return ''; // Meta retries; answer once
  const u = userByPhone(digits);
  q.insert('wa_messages', { wa_id: waId ?? null, phone: digits, user_id: u?.id ?? null, direction: 'in', body: text.slice(0, 4000), created_at: now() });
  const lang: Lang = u?.lang && isLang(u.lang) ? u.lang : isLang(profileLang) ? profileLang : detectLang(undefined);
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  if (!settings().whatsapp_enabled) return t('wa.off');
  if (!u) return t('wa.unknown', { url: `${config.baseUrl}/signup` });
  const cmd = commandFor(text);
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
    case 'lots': {
      const lots = openLots(4);
      if (!lots.length) return t('wa.no_lots', { url: `${config.baseUrl}/lots` });
      return `${t('wa.lots_head')}\n${lots.map((l) => `• ${l.title}: ${lotPeriods(l).join('/')} mo · ${rateFor(lotPeriods(l)[0]) / 100}–${rateFor(lotPeriods(l).slice(-1)[0]) / 100}% p.a. · ${t('wa.left', { amount: fmtNGN(lotRemaining(l)) })}\n  ${config.baseUrl}/lots/${l.code}`).join('\n')}\n${t('wa.join_web')}`;
    }
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
  const r = await supportAnswer(u, text, lang, `whatsapp:${digits}`);
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
      const reply = text ? await handleInbound(m.from, String(text), m.id) : translate('en', 'wa.text_only');
      if (reply) { await sendWhatsApp(m.from, reply).catch((e) => audit(null, 'whatsapp.send_failed', m.from, String(e.message))); n++; }
    }
  }
  return n;
}
