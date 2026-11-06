// Email pre-scan (run by Chidi, the email agent) before anything is sent to imported contacts.
// For each address on a company or organisation domain, it asks DNS whether the domain still exists and still
// has a mail server (an MX record). Addresses whose domain is gone, or no longer takes email, are removed for good
// (only a hash is kept, so they are never re-imported). Free webmail domains (Gmail, Yahoo…) are always up, so
// they are not looked up. Nothing is sent to a contact until it has passed.
import { promises as dnsp } from 'node:dns';
import { q, now } from './db';
import { dropAddress } from './notify';
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
  const rows = q.all<any>("SELECT id, email, email_tries FROM leads WHERE email IS NOT NULL AND email_check IS NULL ORDER BY id LIMIT ?", limit);
  if (!rows.length) return 'nothing to check';
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
    if (v === 'ok') { q.run("UPDATE leads SET email_check='ok', email_checked_at=? WHERE id=?", now(), r.id); res.ok++; }
    else if (v === 'dead' || Number(r.email_tries || 0) >= 2) { dropAddress(r.email, v === 'dead' ? 'domain no longer takes email' : 'domain could not be checked 3 times'); res.removed++; }
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
  return `checked ${rows.length}: ${res.ok} company domains fine, ${res.public} webmail, ${res.removed} removed, ${res.retry} to retry`;
}

export function scanStats() {
  return {
    waiting: Number(q.val("SELECT COUNT(*) FROM leads WHERE email IS NOT NULL AND email_check IS NULL") ?? 0),
    ok: Number(q.val("SELECT COUNT(*) FROM leads WHERE email_check IN ('ok','public')") ?? 0),
    removed: Number(q.val("SELECT COUNT(*) FROM email_suppress WHERE reason LIKE 'domain%'") ?? 0),
  };
}
