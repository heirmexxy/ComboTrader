// Email health: what happened to each marketing email after it left (delivered, delayed, opened, bounced), from
// the email provider's webhook, reported by kind of mailbox and by campaign.
import { q, now } from './db';
import { dropAddress } from './notify';

export type EmailEvent = 'delivered' | 'delayed' | 'opened' | 'bounced';
const COL: Record<EmailEvent, string> = { delivered: 'delivered_at', delayed: 'delayed_at', opened: 'opened_at', bounced: 'bounced_at' };

/** Turns one Resend or Brevo webhook event into what we track. Returns null for events we don't use. */
export function parseProviderEvent(ev: any): { event: EmailEvent; id: string | null; emails: string[]; drop: boolean; reason: string } | null {
  if (typeof ev?.type === 'string') { // Resend
    const t = ev.type, id = ev.data?.email_id ? String(ev.data.email_id) : null;
    const emails: string[] = [].concat(ev.data?.to || ev.data?.email || []).filter((x: unknown) => typeof x === 'string');
    if (t === 'email.delivered') return { event: 'delivered', id, emails, drop: false, reason: t };
    if (t === 'email.delivery_delayed') return { event: 'delayed', id, emails, drop: false, reason: t };
    if (t === 'email.opened') return { event: 'opened', id, emails, drop: false, reason: t };
    if (/^(email\.(bounced|complained|failed|suppressed)|suppression\.added)$/.test(t)) return { event: 'bounced', id, emails, drop: true, reason: t };
    return null;
  }
  if (typeof ev?.event === 'string') { // Brevo
    const t = ev.event, id = ev['message-id'] ? String(ev['message-id']) : null, emails = typeof ev.email === 'string' ? [ev.email] : [];
    if (t === 'delivered') return { event: 'delivered', id, emails, drop: false, reason: t };
    if (t === 'deferred') return { event: 'delayed', id, emails, drop: false, reason: t };
    if (t === 'opened' || t === 'unique_opened') return { event: 'opened', id, emails, drop: false, reason: t };
    if (/^(hard_bounce|soft_bounce|blocked|invalid_email|spam|complaint|error)$/.test(t)) return { event: 'bounced', id, emails, drop: true, reason: `brevo ${t}` };
  }
  return null;
}

/** Records events; bounces and complaints also remove the address for good. Returns how many were recorded. */
export function recordProviderEvents(body: unknown) {
  let n = 0, dropped = 0;
  for (const ev of Array.isArray(body) ? body : [body]) {
    const e = parseProviderEvent(ev);
    if (!e) continue;
    if (e.id) { q.run(`UPDATE outbox SET ${COL[e.event]}=COALESCE(${COL[e.event]}, ?) WHERE provider_id=?`, now(), e.id); n++; }
    if (e.drop) for (const a of e.emails) if (a.includes('@')) { dropAddress(a, e.reason); dropped++; }
  }
  return { recorded: n, dropped };
}

/** Campaign families for the report: sequence, newsletter, article, invitation, outreach, lot alert, Champion campaign. */
export function campaignFamily(c: string | null) {
  const s = String(c || '');
  if (s.startsWith('seq-')) return `Sequence: ${s.split('-')[1]}`;
  if (s.startsWith('nl-')) return 'Newsletter';
  if (s.startsWith('campaign-')) return `Champion email: ${s.slice(9).replace(/_/g, ' ')}`;
  return ({ blog: 'New article', invite: 'Invitation', outreach: 'Partner outreach', 'lot-alert': 'New lot alert' } as Record<string, string>)[s] || 'Other';
}

export interface HealthRow { name: string; sent: number; tracked: number; delivered: number; delayed: number; opened: number; bounced: number }
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
// Delivery is judged only on emails whose fate is known (delivered or bounced), so emails still in transit, or sent
// before the provider's webhook was set up, don't look like failures.
export const rates = (r: HealthRow) => ({ delivery: pct(r.delivered, r.delivered + r.bounced), open: pct(r.opened, r.delivered), bounce: pct(r.bounced, r.sent), delay: pct(r.delayed, r.tracked) });

/** Marketing email over the last N days: totals, by kind of mailbox and by campaign. "Tracked" = has a provider id. */
export function emailHealth(days = 7) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = q.all<any>(`SELECT rgroup, campaign, (provider_id IS NOT NULL) tracked, delivered_at IS NOT NULL delivered, delayed_at IS NOT NULL delayed, opened_at IS NOT NULL opened,
    (bounced_at IS NOT NULL OR status='failed') bounced FROM outbox WHERE kind='marketing' AND status IN ('sent','failed') AND COALESCE(sent_at, send_after)>=?`, since);
  const add = (m: Map<string, HealthRow>, k: string, r: any) => { const x = m.get(k) || { name: k, sent: 0, tracked: 0, delivered: 0, delayed: 0, opened: 0, bounced: 0 }; x.sent++; x.tracked += r.tracked; x.delivered += r.delivered; x.delayed += r.delayed; x.opened += r.opened; x.bounced += r.bounced; m.set(k, x); };
  const total = new Map<string, HealthRow>(), byGroup = new Map<string, HealthRow>(), byCampaign = new Map<string, HealthRow>();
  for (const r of rows) { add(total, 'All marketing email', r); add(byGroup, r.rgroup || 'company', r); add(byCampaign, campaignFamily(r.campaign), r); }
  const t = total.get('All marketing email') || { name: 'All marketing email', sent: 0, tracked: 0, delivered: 0, delayed: 0, opened: 0, bounced: 0 };
  const sort = (m: Map<string, HealthRow>) => [...m.values()].sort((a, b) => b.sent - a.sent);
  return { days, total: t, rates: rates(t), byGroup: sort(byGroup), byCampaign: sort(byCampaign) };
}
