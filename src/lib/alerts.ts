// Operational alerts: server errors are emailed to super admins (at most once an hour), and /healthz serves uptime monitors.
import { q, now } from './db';
import { queueEmail, emailShell, escapeHtml } from './notify';
import { config } from './config';

let lastAlert = 0;
let pending: string[] = [];
export function reportError(where: string, err: unknown) {
  pending.push(`${now()} ${where}: ${String((err as any)?.message || err).slice(0, 300)}`);
  if (pending.length > 50) pending = pending.slice(-50);
  if (Date.now() - lastAlert < 3600e3) return;
  lastAlert = Date.now();
  const lines = pending.splice(0);
  try {
    for (const a of q.all<any>("SELECT email FROM users WHERE role='admin' AND admin_roles LIKE '%super%' AND status='active'")) {
      queueEmail(a.email, `ComboTrader: ${lines.length} server error${lines.length > 1 ? 's' : ''}`, emailShell('Server errors',
        `<p>The site logged these errors. Details are in Admin → Audit log (action “error”).</p><pre style="white-space:pre-wrap;font-size:12px">${escapeHtml(lines.join('\n'))}</pre>`,
        { label: 'Open the audit log', url: `${config.baseUrl}/admin/audit` }));
    }
  } catch { /* never let alerting break a request */ }
}

/** Health for uptime monitors: database answers and the scheduler ran recently. */
export function health() {
  let db = false;
  try { db = q.val('SELECT 1') === 1; } catch {}
  const last = q.val<string>("SELECT last_run FROM job_runs WHERE name='outbox'");
  const schedulerOk = !config.runScheduler || (!!last && Date.now() - new Date(last).getTime() < 10 * 60e3);
  return { ok: db && schedulerOk, db, scheduler: schedulerOk ? 'ok' : 'stale', time: now() };
}
