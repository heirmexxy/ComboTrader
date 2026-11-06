// Email pre-scan (run by Chidi, the email agent) before anything is sent to imported contacts.
// For each address on a company or organisation domain, it asks DNS whether the domain still exists and still
// has a mail server (an MX record). Addresses whose domain is gone, or no longer takes email, are removed for good
// (only a hash is kept, so they are never re-imported). Free webmail domains (Gmail, Yahoo…) are always up, so
// they are not looked up. Nothing is sent to a contact until it has passed.
import { promises as dnsp } from 'node:dns';
import { q, now } from './db';
import { dropAddress, queueEmail, emailShell, escapeHtml } from './notify';
import { config } from './config';
import { audit } from './audit';

export const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru']);
export type DomainVerdict = 'ok' | 'dead' | 'unknown';
type Resolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;
let resolveMx: Resolver = (d) => dnsp.resolveMx(d);
/** Tests swap in a fake resolver. */
export function _setResolver(r: Resolver) { resolveMx = r; }

/** ok = has a working mail server; dead = the domain does not exist or says it takes no email; unknown = DNS did not answer. */
export async function checkDomain(domain: string): Promise<DomainVerdict> {
  try {
    const mx = await Promise.race([resolveMx(domain), new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 8000))]);
    const real = mx.filter((m) => m.exchange && m.exchange !== '.');
    return real.length ? 'ok' : 'dead'; // "." is a "null MX": the domain says it accepts no email
  } catch (e: any) {
    // ENOTFOUND: the domain is gone. ENODATA: it exists but has no mail server.
    if (e?.code === 'ENOTFOUND' || e?.code === 'ENODATA') return 'dead';
    return 'unknown';
  }
}

const domainOf = (email: string) => String(email).split('@')[1]?.trim().toLowerCase() || '';

/** Checks contacts that have not been checked yet (a batch at a time; one lookup per domain, remembered for 30 days). */
export async function scanContacts(limit = 400) {
  const d0 = dedupeContacts();
  // General company inboxes (info@, admin@, inquiries@…) are not people who asked to hear from us: purge them.
  let general = 0;
  for (const l of q.all<any>("SELECT id, email, import_id FROM leads WHERE email IS NOT NULL AND status NOT IN ('signed_up')")) {
    if (!isGeneralAddress(l.email)) continue;
    if (l.import_id) { q.run('UPDATE contact_imports SET removed_general=removed_general+1 WHERE id=?', l.import_id); q.run("UPDATE contact_import_rows SET outcome='removed: general company address (not a person)' WHERE import_id=? AND email=?", l.import_id, l.email); }
    dropAddress(l.email, 'general company address'); general++;
  }
  const rows = q.all<any>("SELECT id, email, email_tries, import_id FROM leads WHERE email IS NOT NULL AND email_check IS NULL ORDER BY id LIMIT ?", limit);
  const dup = (d0.merged + d0.subs ? `${d0.merged + d0.subs} duplicates merged; ` : '') + (general ? `${general} general company addresses removed; ` : '');
  if (!rows.length) { finishImports(); return `${dup}nothing to check`; }
  // Safety: if DNS on this server is not working, every domain would look dead. Check two domains that certainly take
  // email first; if either fails, stop without changing anything and try again next hour.
  const control = [await checkDomain('gmail.com'), await checkDomain('outlook.com')];
  if (control.some((v) => v !== 'ok')) { audit(null, 'email.prescan_dns_down', undefined, { control }); return `${dup}DNS is not answering on this server, so nothing was checked or removed; trying again next hour`; }
  const res = { ok: 0, public: 0, removed: 0, retry: 0 };
  const seen = new Map<string, DomainVerdict>();
  for (const r of rows) {
    const d = domainOf(r.email);
    if (PUBLIC_DOMAINS.has(d)) { q.run("UPDATE leads SET email_check='public', email_checked_at=? WHERE id=?", now(), r.id); res.public++; continue; }
    let v = seen.get(d);
    if (!v) {
      const cached = q.get<any>('SELECT verdict FROM email_domains WHERE domain=? AND checked_at>=?', d, new Date(Date.now() - 30 * 864e5).toISOString());
      v = cached?.verdict as DomainVerdict | undefined;
      if (!v || v === 'unknown') { v = d ? await checkDomain(d) : 'dead'; q.run('INSERT INTO email_domains (domain, verdict, checked_at) VALUES (?,?,?) ON CONFLICT(domain) DO UPDATE SET verdict=excluded.verdict, checked_at=excluded.checked_at', d, v, now()); }
      seen.set(d, v);
    }
    if (v === 'ok') { q.run("UPDATE leads SET email_check='ok', email_checked_at=? WHERE id=?", now(), r.id); res.ok++; if (r.import_id) { q.run('UPDATE contact_imports SET cleared=cleared+1 WHERE id=?', r.import_id); q.run("UPDATE contact_import_rows SET outcome='cleared: the domain takes email' WHERE import_id=? AND email=? AND outcome LIKE 'imported: company%'", r.import_id, r.email); } }
    else if (v === 'dead' || Number(r.email_tries || 0) >= 2) {
      dropAddress(r.email, v === 'dead' ? 'domain no longer takes email' : 'domain could not be checked 3 times'); res.removed++;
      if (r.import_id) {
        q.run(`UPDATE contact_imports SET ${v === 'dead' ? 'removed_domain=removed_domain+1' : 'removed_no_answer=removed_no_answer+1'} WHERE id=?`, r.import_id);
        q.run("UPDATE contact_import_rows SET outcome=? WHERE import_id=? AND email=? AND outcome LIKE 'imported: company%'", v === 'dead' ? `removed: ${d} no longer exists or takes no email` : `removed: ${d} did not answer 3 checks`, r.import_id, r.email);
      }
    }
    else { q.run('UPDATE leads SET email_tries=COALESCE(email_tries,0)+1 WHERE id=?', r.id); res.retry++; } // DNS did not answer: try again next hour (contact stays on hold)
  }
  // Organisations the Prospector found or you imported: clear emails on dead domains so no outreach is drafted to them.
  for (const p of q.all<any>("SELECT id, email FROM prospects WHERE email IS NOT NULL AND email_check IS NULL LIMIT 200")) {
    const d = domainOf(p.email);
    const v = PUBLIC_DOMAINS.has(d) ? 'ok' : (seen.get(d) || await checkDomain(d));
    seen.set(d, v);
    if (v === 'dead') { dropAddress(p.email, 'domain no longer takes email'); res.removed++; }
    else if (v === 'ok') q.run("UPDATE prospects SET email_check='ok' WHERE id=?", p.id);
  }
  audit(null, 'email.prescan', undefined, res);
  finishImports();
  return `${dup}checked ${rows.length}: ${res.ok} company domains fine, ${res.public} webmail, ${res.removed} removed, ${res.retry} to retry`;
}

export function scanStats() {
  return {
    waiting: Number(q.val("SELECT COUNT(*) FROM leads WHERE email IS NOT NULL AND email_check IS NULL") ?? 0),
    ok: Number(q.val("SELECT COUNT(*) FROM leads WHERE email_check IN ('ok','public')") ?? 0),
    removed: Number(q.val("SELECT COUNT(*) FROM email_suppress WHERE reason LIKE 'domain%'") ?? 0),
    general: Number(q.val("SELECT COUNT(*) FROM email_suppress WHERE reason='general company address'") ?? 0),
    duplicates: Number(q.val("SELECT COALESCE(SUM(json_extract(detail,'$.merged') + json_extract(detail,'$.subs')),0) FROM audit_log WHERE action='contacts.dedupe'") ?? 0),
  };
}

// ---------- General (role) addresses ----------
// Strong role words: a shared inbox even with a suffix (info.lagos@, sales-ng@, contact2@).
const ROLE_STRONG = 'info|information|enquiry|enquiries|inquiry|inquiries|contact|contactus|contacts|sales|support|admin|administrator|administration|hello|office|mail|email|careers?|jobs?|recruitment|accounts?|accounting|billing|invoices?|payments?|noreply|no-reply|donotreply|do-not-reply|marketing|webmaster|postmaster|hostmaster|abuse|help|helpdesk|infodesk|customercare|customerservice|customersupport|customers?|service|services|feedback|reception|procurement|purchasing|headoffice|secretariat|admissions|registrar|newsletter|notifications?|alerts?|bookings?|reservations?';
// Weak role words: a role inbox only on their own (hr@, it@, team@), since hr.ade@ or tech.ola@ may be a person.
const ROLE_WEAK = 'hi|team|hr|recruit|finance|press|pr|media|general|ops|operations|hq|secretary|events|partners?|partnerships|business|news|orders?|shop|store|management|legal|compliance|it|tech|dev|security|privacy|investors?|ir|projects?|exports?|imports?|logistics|warehouse|quality';
const ROLE_RE = new RegExp(`^((${ROLE_STRONG})([._-][a-z0-9]+)*|(${ROLE_WEAK}))\\d*$`);
/** True for a shared company inbox (info@, admin@, sales@, inquiries@, contact.lagos@…) rather than a person. */
export function isGeneralAddress(email: string) {
  const local = String(email).trim().toLowerCase().split('@')[0].split('+')[0];
  return ROLE_RE.test(local);
}

// ---------- Duplicates ----------
/** One key per mailbox: lower case, no "+tag", and for Gmail no dots (j.doe@ and jdoe@ reach the same inbox). */
export function emailKey(email: string) {
  let [local, domain] = String(email).trim().toLowerCase().split('@');
  if (!local || !domain) return String(email).trim().toLowerCase();
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}
const RANK: Record<string, number> = { unsubscribed: 5, bounced: 4, signed_up: 3, contacted: 2, new: 1 };
/** Merges contacts that are the same mailbox into one (keeps the oldest; an opt-out on any copy wins), removes
 * duplicate newsletter subscribers, and cancels a marketing email queued twice to the same person. */
export function dedupeContacts() {
  for (const l of q.all<any>('SELECT id, email FROM leads WHERE email IS NOT NULL AND email_key IS NULL')) q.run('UPDATE leads SET email_key=? WHERE id=?', emailKey(l.email), l.id);
  let merged = 0;
  for (const g of q.all<any>('SELECT email_key FROM leads WHERE email_key IS NOT NULL GROUP BY email_key HAVING COUNT(*)>1')) {
    const rows = q.all<any>('SELECT * FROM leads WHERE email_key=? ORDER BY id', g.email_key);
    const keep = rows[0], rest = rows.slice(1);
    const status = rows.reduce((a, r) => ((RANK[r.status] || 0) > (RANK[a] || 0) ? r.status : a), keep.status);
    const lists = [...new Set(rows.flatMap((r) => String(r.lists || '').split(',').filter(Boolean)))].join(',');
    const furthest = rows.reduce((a, r) => (r.seq && (!a.seq || r.seq_step > a.seq_step) ? r : a), keep);
    const stop = ['unsubscribed', 'bounced', 'signed_up'].includes(status);
    q.run(`UPDATE leads SET status=?, lists=?, consent=?, touches=?, name=COALESCE(name, ?), phone=COALESCE(phone, ?), user_id=COALESCE(user_id, ?),
      seq=?, seq_step=?, seq_next_at=?, email_check=COALESCE(email_check, ?) WHERE id=?`,
      status, lists || null, Math.max(...rows.map((r) => Number(r.consent || 0))), Math.max(...rows.map((r) => Number(r.touches || 0))),
      rows.find((r) => r.name)?.name ?? null, rows.find((r) => r.phone)?.phone ?? null, rows.find((r) => r.user_id)?.user_id ?? null,
      stop ? null : furthest.seq, stop ? 0 : furthest.seq_step, stop ? null : furthest.seq_next_at, rows.find((r) => r.email_check)?.email_check ?? null, keep.id);
    for (const r of rest) q.run('DELETE FROM leads WHERE id=?', r.id);
    merged += rest.length;
  }
  let subs = 0;
  const byKey = new Map<string, any[]>();
  for (const s of q.all<any>('SELECT id, email, status FROM subscribers ORDER BY id')) { const k = emailKey(s.email); byKey.set(k, [...(byKey.get(k) || []), s]); }
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const keep = list.find((s) => s.status === 'unsubscribed') || list.find((s) => s.status === 'confirmed') || list[0];
    for (const s of list) if (s.id !== keep.id) { q.run('DELETE FROM subscribers WHERE id=?', s.id); subs++; }
  }
  const dupMail = q.run(`UPDATE outbox SET status='cancelled', send_after=NULL, error='duplicate' WHERE kind='marketing' AND status='queued' AND id NOT IN (
    SELECT MIN(id) FROM outbox WHERE kind='marketing' AND status IN ('queued','sent') GROUP BY lower(recipient), subject)`).changes;
  if (merged || subs || dupMail) audit(null, 'contacts.dedupe', undefined, { merged, subs, dupMail });
  return { merged, subs, dupMail: Number(dupMail) };
}

/** Imports whose company addresses have all been checked: mark done and email the person who imported the final report. */
export function finishImports() {
  for (const im of q.all<any>("SELECT * FROM contact_imports WHERE status='checking'")) {
    if (q.get('SELECT 1 FROM leads WHERE import_id=? AND email_check IS NULL', im.id)) continue;
    q.run("UPDATE contact_imports SET status='done', finished_at=? WHERE id=?", now(), im.id);
    const u = im.created_by ? q.get<any>('SELECT email, first_name FROM users WHERE id=?', im.created_by) : null;
    if (u) queueEmail(u.email, `Contact import #${im.id} checked: ${im.public_added + im.cleared} ready, ${im.removed_domain + im.removed_no_answer} removed`, emailShell(`Import #${im.id} is checked`, importReportHtml(im), { label: 'Open contacts', url: `${config.baseUrl}/admin/audience` }));
  }
}
export function importReportLines(im: any) {
  return [
    ['Rows in the file', im.file_rows],
    ['Imported as new contacts', im.imported],
    ['  Public email (Gmail, Yahoo…): added straight away', im.public_added],
    ['  Company or organisation email: checked by Chidi', im.to_check],
    ['    Cleared (domain takes email)', im.cleared],
    ['    Removed: domain gone or takes no email', im.removed_domain],
    ['    Removed: domain did not answer 3 times', im.removed_no_answer],
    ['General company addresses (info@, admin@…): removed', im.removed_general],
    ['Duplicates in the file (removed)', im.dup_in_file],
    ['Already in your contacts (updated, not added twice)', im.already_contacts],
    ['Removed before (bounced or failed) — not re-added', im.removed_before],
    ['Unsubscribed before — not re-added', im.opted_out],
    ['Ready to receive email', im.public_added + im.cleared],
  ] as [string, number][];
}
const importReportHtml = (im: any) => `<p>Chidi has finished checking import #${im.id}${im.source ? ` (${escapeHtml(im.source)})` : ''}.</p><table style="border-collapse:collapse">${importReportLines(im).map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;white-space:pre">${escapeHtml(k)}</td><td style="text-align:right"><b>${v}</b></td></tr>`).join('')}</table>`;
