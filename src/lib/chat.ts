// Website chat. The "Ask ComboTrader" assistant (the Support agent) answers first, 24/7; when it cannot
// help, or the visitor asks for a person, a human takes over in Tawk.to, or by ticket/email when Tawk.to
// is not available. Tawk.to chats and offline messages come back here by webhook, and the Support agent
// drafts an email follow-up for any that no person answered.
import crypto from 'node:crypto';
import { q, now } from './db';
import { config } from './config';
import { settings } from './settings';
import { supportAnswer, propose, registerExecutors, agentOn } from './agents';
import { lotPeriods, rateFor, lotRemaining } from './trading';
import { queueEmail, emailShell, escapeHtml } from './notify';
import { audit } from './audit';
import { randomToken, fmtNGN } from './util';
import { translate, isLang, type Lang } from './i18n';
import type { User } from './http';

export const assistantOn = () => !!settings().assistant_enabled;

const PERSON_WORDS = /\b(human|person|agent|someone|staff|representative|call me|speak to|talk to|customer care|real person)\b/i;

function addMessage(chatId: number, sender: string, body: string) {
  q.insert('chat_messages', { chat_id: chatId, sender, body: body.slice(0, 4000), created_at: now() });
  q.run('UPDATE chats SET updated_at=? WHERE id=?', now(), chatId);
}
export const chatMessages = (chatId: number) => q.all<any>('SELECT * FROM chat_messages WHERE chat_id=? ORDER BY id', chatId);
const chatByToken = (token: string) => (token ? q.get<any>("SELECT * FROM chats WHERE token=? AND source='assistant'", token) : null);

/** Open lots in plain words, so the assistant can answer "what can I join now?". */
export function openLotsForAgents() { return openLots(); }
function openLots() {
  return q.all<any>("SELECT l.*, c.name AS commodity_name FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.status='open' AND l.closes_at>? ORDER BY l.closes_at LIMIT 8", now())
    .map((l) => {
      const p = lotPeriods(l);
      const r = p.map((m) => rateFor(m) / 100);
      return { code: l.code, title: l.title, commodity: l.commodity_name, region: l.region, periods_months: p, rates_per_annum: p.map((m) => `${rateFor(m) / 100}% for ${m} months`), rates_short: r.length > 1 ? `${r[0]}%–${r[r.length - 1]}% p.a.` : `${r[0]}% p.a.`, periods_short: p.length > 1 ? `${p[0]}–${p[p.length - 1]} months` : `${p[0]} months`, closes: new Date(l.closes_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), still_open_naira: fmtNGN(lotRemaining(l)), link: `${config.baseUrl}/lots/${l.code}` };
    });
}

function transcriptText(chatId: number, last = 12) {
  return chatMessages(chatId).slice(-last).map((m) => `${m.sender === 'visitor' ? 'Visitor' : m.sender === 'assistant' ? 'Assistant' : m.sender === 'person' ? 'Kitovu team' : 'Note'}: ${m.body}`).join('\n');
}

/** One turn of the on-site assistant. */
export async function assistantTurn(o: { token?: string; message: string; user: User | null; lang: Lang; page?: string }) {
  let chat = chatByToken(o.token || '');
  if (chat && chat.user_id && o.user && chat.user_id !== o.user.id) chat = null; // never continue someone else's chat
  if (!chat) {
    const token = randomToken(18);
    const id = q.insert('chats', { token, source: 'assistant', user_id: o.user?.id ?? null, name: o.user ? `${o.user.first_name} ${o.user.last_name}` : null, email: o.user?.email ?? null, lang: o.lang, page: (o.page || '').slice(0, 200), status: 'open', created_at: now(), updated_at: now() }).id;
    chat = q.get<any>('SELECT * FROM chats WHERE id=?', id);
  } else if (o.user && !chat.user_id) {
    q.run('UPDATE chats SET user_id=?, name=?, email=? WHERE id=?', o.user.id, `${o.user.first_name} ${o.user.last_name}`, o.user.email, chat.id);
  }
  const message = o.message.trim().slice(0, 1000);
  const history = transcriptText(chat.id, 8);
  addMessage(chat.id, 'visitor', message);
  if (PERSON_WORDS.test(message)) {
    const reply = translate(o.lang, 'chat.offer_person');
    addMessage(chat.id, 'assistant', reply);
    return { token: chat.token, reply, person: true };
  }
  const question = history ? `Earlier in this website chat:\n${history}\n\nThe visitor now writes: ${message}` : message;
  const r = await supportAnswer(o.user, question, o.lang, `chat:${chat.id}`, { channel: 'website chat (keep it short and friendly; link to pages on the site when useful)', open_trade_lots: openLots(), page_they_are_on: o.page || '', latest_message: message });
  addMessage(chat.id, 'assistant', r.reply);
  if (r.escalate) q.run("UPDATE chats SET status='needs_person' WHERE id=? AND status='open'", chat.id);
  return { token: chat.token, reply: r.reply, person: r.escalate };
}

/** The visitor asked for a person. With Tawk.to the team picks it up there; otherwise we take a message. */
export function handOver(o: { token: string; user: User | null; via: 'tawk' | 'message'; name?: string; email?: string; note?: string }) {
  const chat = chatByToken(o.token);
  if (!chat) throw new Error('chat not found');
  if (o.user && chat.user_id && chat.user_id !== o.user.id) throw new Error('chat not found');
  const name = (o.user ? `${o.user.first_name} ${o.user.last_name}` : o.name || chat.name || '').slice(0, 120);
  const email = (o.user?.email || o.email || chat.email || '').slice(0, 200).trim();
  if (o.via === 'message' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('email');
  q.run("UPDATE chats SET status=?, name=COALESCE(NULLIF(?, ''), name), email=COALESCE(NULLIF(?, ''), email), updated_at=? WHERE id=?", o.via === 'tawk' ? 'with_person' : 'needs_person', name, email, now(), chat.id);
  if (o.note) addMessage(chat.id, 'visitor', o.note.slice(0, 2000));
  addMessage(chat.id, 'system', o.via === 'tawk' ? 'Handed over to the team in Tawk.to live chat.' : `Asked for a person; reply by email to ${email}.`);
  if (o.via === 'message') {
    if (o.user) q.insert('tickets', { user_id: o.user.id, subject: 'Website chat: asked for a person', body: transcriptText(chat.id, 20).slice(0, 4000), status: 'open', created_at: now() });
    const subject = `Website chat needs a person${name ? `: ${name}` : ''}`;
    const html = `<p>${escapeHtml(name || 'A visitor')} (${escapeHtml(email)}) asked to talk to someone.</p><pre style="white-space:pre-wrap;font:14px/1.5 sans-serif">${escapeHtml(transcriptText(chat.id, 20))}</pre>`;
    for (const a of q.all<any>("SELECT email FROM users WHERE role='admin' AND status='active' AND (admin_roles LIKE '%super%' OR admin_roles LIKE '%support%')"))
      queueEmail(a.email, subject, emailShell(subject, html, { label: 'Open the chat', url: `${config.baseUrl}/admin/chats/${chat.id}` }));
  }
  audit(o.user?.id ?? null, 'chat.handover', `chat:${chat.id}`, o.via);
  return chat.id;
}

/** A reply from the team by email (from Admin → Chats, or an approved agent draft). */
export function replyByEmail(chatId: number, reply: string, by: number | null) {
  const chat = q.get<any>('SELECT * FROM chats WHERE id=?', chatId);
  if (!chat) throw new Error('Chat not found');
  if (!chat.email) throw new Error('This visitor left no email address.');
  const lang: Lang = isLang(chat.lang) ? chat.lang : 'en';
  const subject = translate(lang, 'chat.reply_subject');
  queueEmail(chat.email, subject, emailShell(subject, `<p>${escapeHtml(chat.name ? translate(lang, 'chat.reply_hi', { name: String(chat.name).split(' ')[0] }) : translate(lang, 'chat.reply_hi_anon'))}</p><p>${escapeHtml(reply).replace(/\n/g, '<br>')}</p>`, { label: translate(lang, 'chat.reply_cta'), url: config.baseUrl }));
  addMessage(chat.id, 'person', reply);
  q.run("UPDATE chats SET status='answered', updated_at=? WHERE id=?", now(), chat.id);
  audit(by, 'chat.reply', `chat:${chat.id}`);
  return `emailed ${chat.email}`;
}

registerExecutors({
  /** Emails a follow-up to a website / Tawk.to visitor. */
  reply_chat(p, by) {
    const chat = q.get<any>('SELECT status FROM chats WHERE id=?', Number(p.chat_id));
    if (!chat) throw new Error('Chat not found');
    if (chat.status === 'answered') return 'already answered';
    return replyByEmail(Number(p.chat_id), String(p.reply || '').slice(0, 3000), by);
  },
});

/** Drafts an email follow-up for a chat nobody answered (approved in Admin → Agents). */
async function draftFollowUp(chatId: number) {
  if (!agentOn('support')) return;
  const chat = q.get<any>('SELECT * FROM chats WHERE id=?', chatId);
  if (!chat?.email) return;
  const user = chat.user_id ? q.get<any>('SELECT * FROM users WHERE id=?', chat.user_id) : null;
  const lang: Lang = isLang(chat.lang) ? chat.lang : 'en';
  const r = await supportAnswer(user, `A visitor wrote to ComboTrader through live chat and nobody from the team answered. Write the email reply.\n\n${transcriptText(chat.id, 20)}`, lang, `tawk:${chat.id}`, { channel: 'email follow-up to a chat nobody answered', open_trade_lots: openLots() });
  propose({ agent: 'support', kind: 'reply_chat', risk: r.escalate ? 'medium' : 'low', title: `Email reply to ${chat.name || chat.email} (${chat.source === 'tawk_ticket' ? 'offline message' : 'unanswered chat'})`.slice(0, 200),
    summary: r.escalate ? `Needs a person: ${r.reason}` : r.reason, payload: { chat_id: chat.id, reply: r.reply, email: chat.email }, targetUserId: chat.user_id ?? undefined, runId: r.runId });
}

// ---------- Tawk.to webhook ----------
export function tawkSignatureValid(raw: Buffer, sig: string | undefined) {
  if (!config.tawkWebhookSecret || !sig) return false;
  const h = crypto.createHmac('sha1', config.tawkWebhookSecret).update(raw).digest('hex');
  return h.length === sig.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(sig));
}

function upsertTawkChat(source: 'tawk' | 'tawk_ticket', externalId: string, visitor: { name?: string; email?: string } = {}) {
  const email = String(visitor.email || '').trim().toLowerCase().slice(0, 200) || null;
  const user = email ? q.get<any>('SELECT id, lang FROM users WHERE lower(email)=?', email) : null;
  const ex = q.get<any>('SELECT * FROM chats WHERE source=? AND external_id=?', source, externalId);
  if (ex) {
    q.run('UPDATE chats SET name=COALESCE(?, name), email=COALESCE(?, email), user_id=COALESCE(?, user_id), updated_at=? WHERE id=?', visitor.name || null, email, user?.id ?? null, now(), ex.id);
    return ex.id as number;
  }
  return q.insert('chats', { token: randomToken(18), source, external_id: externalId, user_id: user?.id ?? null, name: visitor.name ? String(visitor.name).slice(0, 120) : null, email, lang: user?.lang || 'en', status: 'open', created_at: now(), updated_at: now() }).id;
}

export async function handleTawk(evt: any) {
  const ev = String(evt?.event || '');
  if (ev === 'chat:start') {
    const id = upsertTawkChat('tawk', String(evt.chatId), evt.visitor);
    if (evt.message?.text) addMessage(id, evt.message.sender?.type === 'agent' ? 'person' : 'visitor', String(evt.message.text));
    q.run("UPDATE chats SET status='with_person' WHERE id=? AND status='open'", id);
    return `chat ${id} started`;
  }
  if (ev === 'chat:end') {
    const id = upsertTawkChat('tawk', String(evt.chatId), evt.visitor);
    return `chat ${id} ended`;
  }
  if (ev === 'chat:transcript_created' && evt.chat?.id) {
    const id = upsertTawkChat('tawk', String(evt.chat.id), evt.chat.visitor);
    const msgs: any[] = Array.isArray(evt.chat.messages) ? evt.chat.messages : [];
    q.run('DELETE FROM chat_messages WHERE chat_id=?', id);
    for (const m of msgs) {
      const t = m.sender?.t; const text = String(m.msg || '').trim() || (Array.isArray(m.attchs) && m.attchs.length ? `[file: ${m.attchs[0]?.content?.file?.name || 'attachment'}]` : '');
      if (text) addMessage(id, t === 'a' ? 'person' : t === 'v' ? 'visitor' : 'system', text);
    }
    const answered = msgs.some((m) => m.sender?.t === 'a');
    q.run('UPDATE chats SET status=? WHERE id=?', answered ? 'closed' : 'needs_person', id);
    if (!answered) await draftFollowUp(id);
    return `transcript for chat ${id} (${msgs.length} messages${answered ? '' : ', unanswered: follow-up drafted'})`;
  }
  if (ev === 'ticket:create' && evt.ticket?.id) {
    const id = upsertTawkChat('tawk_ticket', String(evt.ticket.id), evt.requester);
    if (!q.val('SELECT COUNT(*) FROM chat_messages WHERE chat_id=?', id)) addMessage(id, 'visitor', `${evt.ticket.subject ? `${evt.ticket.subject}\n` : ''}${evt.ticket.message || ''}`.trim() || '(no message)');
    q.run("UPDATE chats SET status='needs_person' WHERE id=?", id);
    await draftFollowUp(id);
    return `offline message ${id}`;
  }
  return `ignored ${ev}`;
}

