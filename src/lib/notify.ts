// Messages: in-app inbox, email, SMS/WhatsApp and push.
// Email/SMS go through an outbox table; a worker sends them. Without provider keys,
// messages stay visible in Admin → Messages (demo mode) so nothing is lost.
import { q, now } from './db';
import { config } from './config';
import { sendPush } from './webpush';
import type { User } from './http';
import { translate } from './i18n';

export function queueEmail(to: string, subject: string, html: string) {
  q.insert('outbox', { channel: 'email', recipient: to, subject, body: html, created_at: now() });
}
export function queueSms(to: string, text: string, channel: 'sms' | 'whatsapp' = 'sms') {
  if (!to) return;
  q.insert('outbox', { channel, recipient: to, body: text, created_at: now() });
}

export function emailShell(title: string, bodyHtml: string, cta?: { label: string; url: string }) {
  return `<!doctype html><html><body style="margin:0;background:#F7F1E3;font-family:Arial,Helvetica,sans-serif;color:#2B2B2B">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#1F4D2B;padding:20px 28px;font-size:20px;font-weight:bold;color:#fff">COMBO<span style="color:#D4A017">TRADER</span></td></tr>
<tr><td style="padding:28px"><h1 style="font-size:20px;color:#1F4D2B;margin:0 0 12px">${title}</h1>
<div style="font-size:15px;line-height:1.6">${bodyHtml}</div>
${cta ? `<p style="margin:24px 0 0"><a href="${cta.url}" style="background:#C0603A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">${cta.label}</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;font-size:12px;color:#777;border-top:1px solid #eee">ComboTrader is a platform of Kitovu Technology Company Limited · Iseyin, Oyo State, Nigeria</td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * Notify a Champion in their language. `key` points at locale strings `msg.<key>.title` and `msg.<key>.body`.
 */
export function notify(user: User, key: string, vars: Record<string, string | number> = {}, o: { link?: string; email?: boolean; sms?: boolean } = {}) {
  const t = (k: string) => translate(user.lang, k, { name: user.first_name, ...vars });
  const title = t(`msg.${key}.title`);
  const body = t(`msg.${key}.body`);
  const link = o.link ? config.baseUrl + o.link : undefined;
  q.insert('notifications', { user_id: user.id, title, body, link: o.link ?? null, created_at: now() });
  if (o.email !== false && user.notif_email) {
    queueEmail(user.email, title, emailShell(title, `<p>${escapeHtml(body)}</p>`, link ? { label: t('msg.open'), url: link } : undefined));
  }
  if (o.sms && user.notif_sms && user.phone && user.phone_verified_at) queueSms(user.phone, `ComboTrader: ${body}${link ? ' ' + link : ''}`);
  pushTo(user.id, { title, body, url: o.link || '/app' }).catch(() => {});
}

export async function pushTo(userId: number, data: { title: string; body?: string; url?: string }) {
  if (!config.vapidPublic) return;
  for (const s of q.all<any>('SELECT * FROM push_subscriptions WHERE user_id=?', userId)) {
    try {
      const r = await sendPush(s, data);
      if (r.gone) q.run('DELETE FROM push_subscriptions WHERE id=?', s.id);
    } catch { /* network errors are retried on the next message */ }
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** Sends queued messages through the configured providers. Called by the scheduler. */
export async function flushOutbox(limit = 50) {
  const rows = q.all<any>("SELECT * FROM outbox WHERE status='queued' AND attempts < 5 ORDER BY id LIMIT ?", limit);
  for (const m of rows) {
    try {
      let sent = false;
      if (m.channel === 'email' && config.emailProvider && config.emailApiKey) { await sendEmail(m.recipient, m.subject, m.body); sent = true; }
      else if ((m.channel === 'sms' || m.channel === 'whatsapp') && config.termiiKey) { await sendTermii(m.recipient, m.body, m.channel); sent = true; }
      if (sent) q.run("UPDATE outbox SET status='sent', sent_at=?, attempts=attempts+1 WHERE id=?", now(), m.id);
      else q.run("UPDATE outbox SET status='held', error='No provider configured (demo mode)' WHERE id=?", m.id);
    } catch (e: any) {
      q.run('UPDATE outbox SET attempts=attempts+1, error=? WHERE id=?', String(e?.message || e).slice(0, 500), m.id);
    }
  }
}

async function sendEmail(to: string, subject: string, html: string) {
  const from = config.emailFrom;
  let res: Response;
  if (config.emailProvider === 'resend') {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${config.emailApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
  } else if (config.emailProvider === 'brevo') {
    const m = from.match(/^(.*)<(.+)>$/);
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': config.emailApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: { name: (m?.[1] || 'ComboTrader').trim(), email: (m?.[2] || from).trim() }, to: [{ email: to }], subject, htmlContent: html }),
    });
  } else throw new Error(`Unknown EMAIL_PROVIDER ${config.emailProvider}`);
  if (!res.ok) throw new Error(`Email ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendTermii(to: string, sms: string, channel: string) {
  const res = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.termiiKey, to: to.replace('+', ''), from: config.termiiSender, sms, type: 'plain', channel: channel === 'whatsapp' ? 'whatsapp' : 'generic' }),
  });
  if (!res.ok) throw new Error(`Termii ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
