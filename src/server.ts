import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { config } from './lib/config';
import { openDb, q } from './lib/db';
import { Ctx, HttpError } from './lib/http';
import { match } from './lib/router';
import { loadSession } from './lib/auth';
import { detectLang, isLang, translate, setOverrideLoader } from './lib/i18n';
import { render } from './views/render';
import { ErrorPage } from './views/public/pages';
import { startScheduler } from './lib/jobs';
import { audit } from './lib/audit';
import { bootstrap } from './lib/bootstrap';
import { reportError, health } from './lib/alerts';
import './routes/public';
import './routes/auth';
import './routes/pay';
import './routes/app';
import './routes/more';
import './routes/admin-more'; // before admin: /admin/champions/import must match before /admin/champions/:id
import './routes/admin';

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const PUBLIC_DIR = path.resolve('public');
const UPLOADS_DIR = path.resolve(config.uploadsDir, 'public');

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://embed.tawk.to https://*.tawk.to https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.tawk.to https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com https://*.tawk.to https://cdn.jsdelivr.net data:",
  "img-src 'self' data: blob: https://*.tawk.to https://cdn.jsdelivr.net https://tawk.link",
  "connect-src 'self' https://*.tawk.to wss://*.tawk.to",
  "frame-src https://*.tawk.to",
  "media-src 'self' https://*.tawk.to",
  "form-action 'self' https://checkout.paystack.com https://accounts.google.com",
  "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'",
].join('; ');

function serveFile(c: Ctx, root: string, rel: string, cache: string) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(root + path.sep)) return false;
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
  if (c.req.headers['if-none-match'] === etag) { c.res.writeHead(304); c.res.end(); c.done = true; return true; }
  c.done = true;
  c.res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, ETag: etag, 'X-Content-Type-Options': 'nosniff' });
  if (c.method === 'HEAD') c.res.end(); else fs.createReadStream(file).pipe(c.res);
  return true;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const c = new Ctx(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  try {
    const p = c.path;
    // Static assets
    if ((c.method === 'GET' || c.method === 'HEAD') && /\.(css|js|png|jpe?g|webp|svg|ico|webmanifest|json|txt|woff2)$/.test(p) && !p.startsWith('/api/')) {
      const cache = p === '/sw.js' || p === '/manifest.webmanifest' ? 'no-cache' : /\?v=/.test(c.url.search) || p.startsWith('/icons/') || p.startsWith('/img/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
      if (p.startsWith('/uploads/') ? serveFile(c, UPLOADS_DIR, p.slice('/uploads/'.length), 'public, max-age=604800') : serveFile(c, PUBLIC_DIR, p, cache)) return;
    }
    if (p === '/healthz') { const h0 = health(); return c.json(h0, h0.ok ? 200 : 503); }
    res.setHeader('Content-Security-Policy', CSP);
    loadSession(c);
    const cookieLang = c.cookies.lang;
    c.lang = c.user?.lang && isLang(c.user.lang) ? c.user.lang : isLang(cookieLang) ? cookieLang : detectLang(req.headers['accept-language']);
    c.t = (k, v) => translate(c.lang, k, v);

    const m = match(c.method, p);
    if (m === 'method') throw new HttpError(405, 'Method not allowed');
    if (!m) throw new HttpError(404, 'Not found');
    c.params = m.params;
    await c.readBody(p.startsWith('/admin') || p.startsWith('/app/profile') ? 12 * 1024 * 1024 : 1024 * 1024);
    const machine = p.startsWith('/webhooks/') || p.startsWith('/api/cron/') || p === '/api/prices/ingest';
    if (c.method === 'POST' && !machine) c.checkCsrf();

    // Pending two-step sign-in can only finish or log out.
    if (c.pending2fa && !['/login/2fa', '/logout'].includes(p) && m.route.guard !== 'public') return c.redirect('/login/2fa');
    if (c.pending2fa && m.route.guard === 'public') c.user = null;

    const g = m.route.guard;
    if (g === 'guest' && c.user) return c.redirect(c.isAdmin ? '/admin' : '/app');
    if (g === 'auth' && !c.user) return c.redirect(`/login?next=${encodeURIComponent(p + c.url.search)}`);
    if (g.startsWith('admin:')) {
      if (!c.user) return c.redirect(`/login?next=${encodeURIComponent(p)}`);
      if (!c.isAdmin) throw new HttpError(403, 'Forbidden');
      if (config.adminRequire2fa && !c.user.totp_enabled && p !== '/app/security') return c.redirect('/app/security', ['info', 'Admins must turn on two-step verification before using the admin area.']);
      const perm = g.slice(6);
      if (perm !== 'any' && !c.can(perm)) throw new HttpError(403, 'Forbidden');
    }
    await m.route.handler(c);
    if (!c.done) throw new Error(`No response from ${c.method} ${p}`);
  } catch (e: any) {
    if (c.done) { console.error(e); return; }
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) {
      console.error(e);
      try { audit(c.user?.id, 'error', `${c.method} ${c.path}`, String(e?.stack || e).slice(0, 1500), c.ip); } catch {}
      reportError(`${c.method} ${c.path}`, e);
    }
    if (!c.t) { c.lang = 'en'; c.t = (k, v) => translate('en', k, v); }
    if (c.path.startsWith('/api/') || c.path.startsWith('/webhooks/') || String(c.req.headers.accept || '').includes('application/json')) return c.json({ error: e.message }, status);
    try { render(c, h(ErrorPage, { status, message: status < 500 ? e.message : undefined }), status); } catch { c.send(status, 'Error'); }
  }
}

export function start() {
  openDb();
  bootstrap();
  setOverrideLoader(() => q.all('SELECT key, lang, value FROM page_text'));
  const server = http.createServer((req, res) => { handle(req, res); });
  server.listen(config.port, config.bindHost, () => console.log(`ComboTrader listening on ${config.baseUrl} (port ${config.port})${config.paystackDemo ? ' — Paystack DEMO mode' : ''}`));
  if (config.runScheduler) startScheduler();
  return server;
}

if (!process.env.NO_AUTOSTART) start();
