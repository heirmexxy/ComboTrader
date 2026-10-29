// Inside watchdog: every 10 minutes the server checks things it can see before they become outages, and emails super admins
// once when a problem starts, a reminder every 12 hours while it lasts, and once when it clears.
// (Whole-server outages are caught from outside by the GitHub uptime check.)
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { q, now } from './db';
import { config } from './config';
import { settings, setSetting } from './settings';
import { queueEmail, emailShell, escapeHtml } from './notify';

export interface Check { key: string; name: string; ok: boolean; detail: string }
let certCache: { at: number; days: number | null; error?: string } | null = null;

function certDaysLeft(): Promise<{ days: number | null; error?: string }> {
  const u = new URL(config.baseUrl);
  if (u.protocol !== 'https:') return Promise.resolve({ days: null });
  if (certCache && Date.now() - certCache.at < 12 * 3600e3) return Promise.resolve(certCache);
  return new Promise((resolve) => {
    const s = tls.connect({ host: u.hostname, port: 443, servername: u.hostname, timeout: 10_000 }, () => {
      const c = s.getPeerCertificate(); s.end();
      const days = c?.valid_to ? Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 864e5) : null;
      certCache = { at: Date.now(), days }; resolve(certCache);
    });
    s.on('error', (e) => { certCache = { at: Date.now(), days: null, error: e.message }; resolve(certCache); });
    s.on('timeout', () => { s.destroy(); certCache = { at: Date.now(), days: null, error: 'timed out' }; resolve(certCache); });
  });
}
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

export async function runChecks(): Promise<Check[]> {
  const out: Check[] = [];
  const dataDir = path.resolve(path.dirname(config.dbFile === ':memory:' ? 'data/x' : config.dbFile));
  // Disk
  try {
    const st = fs.statfsSync(fs.existsSync(dataDir) ? dataDir : '.');
    const free = st.bavail * st.bsize, total = st.blocks * st.bsize;
    out.push({ key: 'disk', name: 'Disk space', ok: free > 2 * 1024 ** 3 && free / total > 0.1, detail: `${gb(free)} free of ${gb(total)}` });
  } catch (e: any) { out.push({ key: 'disk', name: 'Disk space', ok: true, detail: `could not read (${e.message})` }); }
  // Memory (systemd caps the service; default cap 1536 MB)
  const cap = Number(process.env.MEMORY_LIMIT_MB || 1536) * 1024 ** 2, rss = process.memoryUsage().rss;
  out.push({ key: 'memory', name: 'Memory', ok: rss < cap * 0.85, detail: `${Math.round(rss / 1024 ** 2)} MB used of ${Math.round(cap / 1024 ** 2)} MB allowed` });
  // Nightly backup
  if (config.production) {
    const dir = path.join(dataDir, 'backups');
    let newest = 0;
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.db')) newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* none */ }
    const hours = newest ? (Date.now() - newest) / 3600e3 : Infinity;
    out.push({ key: 'backup', name: 'Nightly backup', ok: hours < 27, detail: newest ? `last backup ${Math.round(hours)} hours ago` : 'no backup found in data/backups' });
  }
  // Email and SMS delivery
  const stuck = q.get<any>("SELECT COUNT(*) n, MAX(error) err FROM outbox WHERE status='queued' AND (attempts >= 3 OR created_at <= ?)", new Date(Date.now() - 30 * 60e3).toISOString());
  out.push({ key: 'outbox', name: 'Email and SMS sending', ok: !(config.emailProvider && config.emailApiKey) || !stuck?.n, detail: stuck?.n ? `${stuck.n} messages not sent; last error: ${String(stuck.err || 'waiting').slice(0, 200)}` : 'sending normally' });
  // Scheduled jobs
  const failed = q.all<any>("SELECT name, last_status FROM job_runs WHERE last_status LIKE 'error%' AND last_run >= ?", new Date(Date.now() - 864e5).toISOString());
  out.push({ key: 'jobs', name: 'Scheduled jobs', ok: !failed.length, detail: failed.length ? failed.map((j) => `${j.name}: ${String(j.last_status).slice(0, 120)}`).join('; ') : 'all ran without errors' });
  // Security certificate
  const cert = await certDaysLeft();
  if (cert.days !== null || cert.error) out.push({ key: 'cert', name: 'Security certificate (https)', ok: cert.days !== null && cert.days >= 14, detail: cert.days !== null ? `expires in ${cert.days} days` : `could not check: ${cert.error}` });
  return out;
}

/** Runs the checks and emails super admins about changes. */
export async function watchdog() {
  const checks = await runChecks();
  let state: Record<string, { since: string; alerted: string }> = {};
  try { state = JSON.parse(String(settings().watchdog_state || '{}')); } catch { state = {}; }
  const news: Check[] = [], reminders: Check[] = [], cleared: string[] = [];
  for (const c of checks) {
    const s = state[c.key];
    if (!c.ok && !s) { news.push(c); state[c.key] = { since: now(), alerted: now() }; }
    else if (!c.ok && s && Date.now() - new Date(s.alerted).getTime() > 12 * 3600e3) { reminders.push(c); s.alerted = now(); }
    else if (c.ok && s) { cleared.push(`${c.name}: ${c.detail}`); delete state[c.key]; }
  }
  setSetting('watchdog_state', JSON.stringify(state));
  const send = (subject: string, html: string) => {
    for (const a of q.all<any>("SELECT email FROM users WHERE role='admin' AND admin_roles LIKE '%super%' AND status='active'")) queueEmail(a.email, subject, emailShell(subject, html, { label: 'Open the admin', url: `${config.baseUrl}/admin` }));
  };
  const list = (cs: Check[]) => `<ul>${cs.map((c) => `<li><b>${escapeHtml(c.name)}</b>: ${escapeHtml(c.detail)}</li>`).join('')}</ul>`;
  if (news.length || reminders.length) send(`ComboTrader health: ${[...news, ...reminders].map((c) => c.name).join(', ')} needs attention`, `${news.length ? `<p>New problem${news.length > 1 ? 's' : ''}:</p>${list(news)}` : ''}${reminders.length ? `<p>Still not fixed:</p>${list(reminders)}` : ''}<p>Tell Claude what this says, or check Admin → Overview → System health.</p>`);
  if (cleared.length) send('ComboTrader health: resolved', `<p>These are fine again:</p><ul>${cleared.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
  const bad = checks.filter((c) => !c.ok).length;
  return bad ? `${bad} problem${bad > 1 ? 's' : ''}: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}` : 'all healthy';
}
