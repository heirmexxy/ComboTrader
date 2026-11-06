// Messages: in-app inbox, email, SMS/WhatsApp and push.
// Email/SMS go through an outbox table; a worker sends them. Without provider keys,
// messages stay visible in Admin → Messages (demo mode) so nothing is lost.
import { createHash } from 'node:crypto';
import { audit } from './audit';
import { q, now, tx } from './db';
import { config } from './config';
import { settings, setSetting } from './settings';
import { sendPush } from './webpush';
import type { User } from './http';
import { translate } from './i18n';

/** Queues an email. Marketing emails (sequences, newsletters, campaigns, outreach, blog and lot announcements) are
 * not sent at once: each gets its own slot, spread evenly over the sending window, so the domain never sends a burst. */
export function queueEmail(to: string, subject: string, html: string, o: { marketing?: boolean; campaign?: string; lessonId?: number | null; sendAfter?: string } = {}) {
  const group = o.marketing ? mailGroup(to) : null;
  q.insert('outbox', { channel: 'email', recipient: to, subject, body: html, created_at: now(), kind: o.marketing ? 'marketing' : 'tx', send_after: o.marketing ? (o.sendAfter || nextMarketingSlot(group!)) : null, campaign: o.campaign || null, rgroup: group, lesson_id: o.lessonId ?? null });
}
/** Which kind of mailbox an address is, for delivery reports and per-provider pacing. */
export function mailGroup(email: string) {
  const d = String(email).split('@')[1]?.toLowerCase() || '';
  if (d === 'gmail.com' || d === 'googlemail.com') return 'gmail';
  if (/^(yahoo\.|ymail\.com$|rocketmail\.com$)/.test(d)) return 'yahoo';
  if (/^(outlook|hotmail|live|msn)\./.test(d)) return 'microsoft';
  if (/^(icloud|me|mac)\.com$/.test(d)) return 'apple';
  if (/^(aol|protonmail|proton|gmx|mail|zoho|yandex)\./.test(d)) return 'other webmail';
  return 'company';
}
const slowGroups = (): Record<string, string> => { try { return JSON.parse(String(settings().email_slow_groups || '{}')) || {}; } catch { return {}; } };

// ---------- Failed addresses ----------
/** The provider refused this address (not an outage, a bad key or a rate limit, which say nothing about the address). */
export function addressRefused(err: string) {
  const code = Number(/Email (\d{3})/.exec(err)?.[1] || 0);
  if ([401, 403, 429].includes(code) || code >= 500 || !code) return false;
  return true;
}
const hashEmail = (e: string) => createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex');
/** True if this address failed or bounced before; it is never added again. */
export const emailSuppressed = (e: string) => !!q.get('SELECT 1 FROM email_suppress WHERE hash=?', hashEmail(e));
/** Removes a failed or bounced address from every marketing list. Only a one-way hash is kept, so it is never re-added.
 * Champions keep their account (and account emails); they just stop getting marketing. */
export function dropAddress(email: string, reason: string) {
  const e = String(email).trim().toLowerCase();
  if (!e) return;
  q.run('INSERT OR IGNORE INTO email_suppress (hash, reason, created_at) VALUES (?,?,?)', hashEmail(e), reason.slice(0, 100), now());
  q.run('DELETE FROM leads WHERE lower(email)=?', e);
  q.run('DELETE FROM subscribers WHERE lower(email)=?', e);
  q.run('UPDATE prospects SET email=NULL WHERE lower(email)=?', e);
  q.run('UPDATE users SET marketing_opt_in=0 WHERE lower(email)=?', e);
  q.run("UPDATE outbox SET status='cancelled', send_after=NULL, error=? WHERE kind='marketing' AND status='queued' AND lower(recipient)=?", `address removed: ${reason}`.slice(0, 200), e);
}

// ---------- Pacing marketing email (protects the sending domain's reputation) ----------
const WINDOW = { start: 9, end: 19 }; // Lagos time (UTC+1, no daylight saving), Monday to Friday only
const LAGOS = 3600e3;
/** Most marketing emails per day: starts at 50 and grows by half each day (warm-up) up to the set daily cap. */
export function marketingDailyCap() {
  const s = settings();
  let start = String(s.email_warmup_start || '');
  if (!start) { start = now(); setSetting('email_warmup_start', start); }
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 864e5));
  const cap = Math.max(1, Math.min(Number(s.sequence_daily_cap || 200), Math.round(Number(s.email_warmup_first_day || 50) * Math.pow(1.5, days))));
  // Delivery trouble: the Chief of Staff halves the pace for a few days.
  return String(s.email_slowdown_until || '') > now() ? Math.max(1, Math.ceil(cap / 2)) : cap;
}
function fitWindow(t: number) {
  const d = new Date(t + LAGOS), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h >= WINDOW.end) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(WINDOW.start, 0, 0, 0); }
  else if (h < WINDOW.start) d.setUTCHours(WINDOW.start, 0, 0, 0);
  else if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return t;
  // Weekends: move to Monday 9:00.
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(WINDOW.start, 0, 0, 0); }
  return d.getTime() - LAGOS;
}
const lagosDay = (t: number) => new Date(t + LAGOS).toISOString().slice(0, 10);
/** A slot planner for marketing email: a steady trickle from 9:00 Lagos time, Monday to Friday (2 every 5 minutes by
 * default), at most the day's warm-up cap per day; whatever doesn't fit moves to the next weekday morning. It reads the
 * outbox once and then works in memory, so planning 10,000 emails takes milliseconds. */
export function marketingPlanner(o: { ignoreQueued?: boolean } = {}) {
  const gap = Math.max(30, Number(settings().email_gap_seconds || 150)) * 1000;
  const cap = marketingDailyCap();
  const slow = slowGroups();
  const paused = Date.parse(String(settings().marketing_paused_until || '')) || 0;
  const todayStart = new Date(Date.now() - 864e5).toISOString();
  // What is already planned from today on (sent emails today count towards today's cap).
  const rows = q.all<any>(`SELECT send_after, rgroup FROM outbox WHERE kind='marketing' AND send_after>=? AND status NOT IN ('cancelled'${o.ignoreQueued ? ",'queued'" : ''})`, todayStart);
  const perDay = new Map<string, number>(), lastByGroup = new Map<string, number>();
  let last = 0;
  for (const r of rows) {
    const t = Date.parse(r.send_after); if (!t) continue;
    perDay.set(lagosDay(t), (perDay.get(lagosDay(t)) || 0) + 1);
    if (t > last) last = t;
    if (t > (lastByGroup.get(r.rgroup) || 0)) lastByGroup.set(r.rgroup, t);
  }
  return (group = 'company') => {
    let t = Math.max(Date.now(), last ? last + gap : 0);
    // A provider that is delaying our mail gets it four times more slowly until it recovers.
    if (String(slow[group] || '') > now() && lastByGroup.get(group)) t = Math.max(t, lastByGroup.get(group)! + 4 * gap);
    if (paused > t) t = paused;
    t = fitWindow(t);
    for (let i = 0; i < 400 && (perDay.get(lagosDay(t)) || 0) >= cap; i++) {
      const d = new Date(t + LAGOS); d.setUTCHours(0, 0, 0, 0);
      t = fitWindow(d.getTime() - LAGOS + 864e5 + WINDOW.start * 3600e3 - 1);
    }
    perDay.set(lagosDay(t), (perDay.get(lagosDay(t)) || 0) + 1);
    last = t; lastByGroup.set(group, t);
    return new Date(t + Math.floor(Math.random() * 15e3)).toISOString();
  };
}
/** The next send time for one marketing email. */
export function nextMarketingSlot(group = 'company') { return marketingPlanner()(group); }
/** Re-plans every waiting marketing email from scratch (after a pace change, a big newsletter or removed duplicates):
 * webmail addresses first, then company addresses, oldest first. */
export function replanMarketingQueue() {
  const plan = marketingPlanner({ ignoreQueued: true });
  const rows = q.all<any>("SELECT id, rgroup FROM outbox WHERE kind='marketing' AND status='queued' ORDER BY (rgroup='company'), id");
  tx(() => { for (const r of rows) q.run('UPDATE outbox SET send_after=? WHERE id=?', plan(r.rgroup || 'company'), r.id); });
  const lastSlot = rows.length ? q.val("SELECT MAX(send_after) FROM outbox WHERE kind='marketing' AND status='queued'") as string : null;
  return { planned: rows.length, last: lastSlot };
}
/** Marketing emails waiting for their slot (agents stop queueing more once a day's worth is waiting). */
export const marketingQueued = () => Number(q.val("SELECT COUNT(*) FROM outbox WHERE status='queued' AND kind='marketing'") ?? 0);
/** If more than 5% of marketing emails fail in a day (bad addresses), pause marketing for 48 hours and tell super admins. */
function guardMarketing() {
  const since = new Date(Date.now() - 864e5).toISOString();
  // Per provider: if 10% or more of what reached it in a day was delayed, slow down to it for 48 hours.
  const slow = slowGroups(); let changed = false;
  for (const g of q.all<any>("SELECT rgroup, COUNT(*) n, SUM(delayed_at IS NOT NULL) d FROM outbox WHERE kind='marketing' AND status='sent' AND sent_at>=? AND provider_id IS NOT NULL GROUP BY rgroup", since)) {
    if (g.rgroup && g.n >= 10 && g.d / g.n >= 0.1 && !(String(slow[g.rgroup] || '') > now())) { slow[g.rgroup] = new Date(Date.now() + 48 * 3600e3).toISOString(); changed = true; audit(null, 'email.slow_provider', g.rgroup, { sent: g.n, delayed: g.d }); }
  }
  if (changed) setSetting('email_slow_groups', JSON.stringify(slow));
  const tried = Number(q.val("SELECT COUNT(*) FROM outbox WHERE kind='marketing' AND attempts>0 AND send_after>=?", since) ?? 0);
  const failed = Number(q.val("SELECT COUNT(*) FROM outbox WHERE kind='marketing' AND status='failed' AND send_after>=?", since) ?? 0);
  const paused = String(settings().marketing_paused_until || '');
  if (tried < 20 || failed / tried <= 0.05 || (paused && Date.parse(paused) > Date.now())) return;
  const until = new Date(Date.now() + 48 * 3600e3).toISOString();
  setSetting('marketing_paused_until', until);
  for (const a of q.all<any>("SELECT email FROM users WHERE role='admin' AND status='active' AND admin_roles LIKE '%super%'")) q.insert('outbox', { channel: 'email', recipient: a.email, subject: 'Marketing emails paused for 48 hours', body: emailShell('Marketing emails paused', `<p>${failed} of ${tried} marketing emails in the last 24 hours failed (usually bad or closed addresses). To protect the sending domain, sequences, newsletters and campaigns are paused until ${until.slice(0, 16).replace('T', ' ')} UTC. Clean the contact list in Admin → Contacts &amp; sequences; you can resume earlier by clearing “marketing_paused_until” in Settings.</p>`), created_at: now(), kind: 'tx' });
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
  if (o.sms && user.notif_sms && user.phone) queueSms(user.phone, `ComboTrader: ${body}${link ? ' ' + link : ''}`);
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
  const paused = String(settings().marketing_paused_until || '');
  // Marketing only goes out inside the sending window (9:00–19:00 Lagos, Monday to Friday), even if queued earlier.
  const nowMs = Date.now();
  const mk = (paused && Date.parse(paused) > nowMs) || fitWindow(nowMs) !== nowMs ? 0 : 1;
  const rows = q.all<any>("SELECT * FROM outbox WHERE status='queued' AND attempts < 5 AND (send_after IS NULL OR send_after<=?) AND (kind!='marketing' OR ?=1) ORDER BY COALESCE(send_after, created_at) LIMIT ?", now(), mk, limit);
  for (const m of rows) {
    try {
      let sent = false;
      let pid: string | null = null;
      if (m.channel === 'email' && config.emailProvider && config.emailApiKey) { pid = await sendEmail(m.recipient, m.subject, m.body); sent = true; }
      else if ((m.channel === 'sms' || m.channel === 'whatsapp') && config.termiiKey) { await sendTermii(m.recipient, m.body, m.channel); sent = true; }
      if (sent) q.run("UPDATE outbox SET status='sent', sent_at=?, attempts=attempts+1, provider_id=? WHERE id=?", now(), pid, m.id);
      else q.run("UPDATE outbox SET status='held', error='No provider configured (demo mode)' WHERE id=?", m.id);
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      if (m.kind === 'marketing') {
        // Marketing email is tried once. If the address itself was refused, it is removed everywhere.
        q.run("UPDATE outbox SET status='failed', attempts=attempts+1, error=? WHERE id=?", err, m.id);
        if (addressRefused(err)) dropAddress(m.recipient, 'refused when sending');
      } else q.run('UPDATE outbox SET attempts=attempts+1, error=? WHERE id=?', err, m.id);
    }
  }
  guardMarketing();
}

export async function sendEmail(to: string, subject: string, html: string) {
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
  // The provider's id for this email, so delivery, delay, open and bounce reports can be matched to it.
  try { const j: any = await res.json(); return String(j?.id || j?.messageId || '') || null; } catch { return null; }
}

async function sendTermii(to: string, sms: string, channel: string) {
  const res = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.termiiKey, to: to.replace('+', ''), from: config.termiiSender, sms, type: 'plain', channel: channel === 'whatsapp' ? 'whatsapp' : 'generic' }),
  });
  if (!res.ok) throw new Error(`Termii ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
