// Minimal HTTP context: parsing, cookies, CSRF, flash, responses.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config';
import { hmac, randomToken, safeEqual } from './util';
import type { Lang } from './i18n';

export interface Upload { filename: string; type: string; data: Buffer }
export interface User {
  id: number; email: string; phone: string | null; first_name: string; last_name: string; country: string; city: string | null;
  lang: Lang; role: string; admin_roles: string; email_verified_at: string | null; phone_verified_at: string | null;
  totp_enabled: number; totp_secret: string | null; kyc_status: string; referral_code: string; feed_opt_in: number;
  circle_pilot: number; status: string; onboarded: number; notif_email: number; notif_sms: number;
  next_of_kin_name: string | null; next_of_kin_phone: string | null; created_at: string; referred_by: number | null;
  paystack_customer_code: string | null; kyc_method: string | null; kyc_note: string | null; google_id: string | null;
  rollover_default?: string; whatsapp_opt_in?: number; closed_at?: string | null; id_doc_path?: string | null;
}

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export class Ctx {
  url: URL;
  method: string;
  params: Record<string, string> = {};
  body: Record<string, any> = {};
  files: Record<string, Upload> = {};
  rawBody: Buffer = Buffer.alloc(0);
  cookies: Record<string, string>;
  user: User | null = null;
  sessionId: number | null = null;
  pending2fa = false;
  /** The account waiting to finish a two-step sign-in (c.user stays empty on public pages until it does). */
  pendingUser: User | null = null;
  lang: Lang = 'en';
  t!: (key: string, vars?: Record<string, string | number>) => string;
  ip: string;
  csrf: string;
  flash: { type: 'ok' | 'error' | 'info'; msg: string } | null = null;
  done = false;
  private outCookies: string[] = [];

  constructor(public req: IncomingMessage, public res: ServerResponse) {
    this.url = new URL(req.url || '/', config.baseUrl);
    this.method = (req.method || 'GET').toUpperCase();
    this.cookies = parseCookies(req.headers.cookie || '');
    this.ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    this.csrf = this.cookies.csrf && /^[\w-]{20,}$/.test(this.cookies.csrf) ? this.cookies.csrf : '';
    if (!this.csrf) { this.csrf = randomToken(24); this.setCookie('csrf', this.csrf, { httpOnly: true, maxAge: 60 * 60 * 24 * 30 }); }
    const f = this.cookies.flash;
    if (f) {
      const [data, sig] = f.split('.');
      if (sig && safeEqual(hmac(data), sig)) { try { this.flash = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch {} }
      this.setCookie('flash', '', { maxAge: 0 });
    }
  }

  get query() { return Object.fromEntries(this.url.searchParams); }
  get path() { return this.url.pathname; }
  get isAdmin() { return this.user?.role === 'admin'; }
  can(perm: string) {
    if (!this.user || this.user.role !== 'admin') return false;
    const roles = this.user.admin_roles.split(',').map((s) => s.trim());
    return roles.includes('super') || roles.includes(perm);
  }

  setCookie(name: string, value: string, o: { maxAge?: number; httpOnly?: boolean; path?: string } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path || '/'}`, 'SameSite=Lax'];
    if (o.httpOnly !== false) parts.push('HttpOnly');
    if (config.production) parts.push('Secure');
    if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
    this.outCookies.push(parts.join('; '));
  }
  setFlash(type: 'ok' | 'error' | 'info', msg: string) {
    const data = Buffer.from(JSON.stringify({ type, msg })).toString('base64url');
    this.setCookie('flash', `${data}.${hmac(data)}`, { maxAge: 60 });
  }

  private head(status: number, headers: Record<string, string>) {
    if (this.done) return false;
    this.done = true;
    if (this.outCookies.length) this.res.setHeader('Set-Cookie', this.outCookies);
    this.res.writeHead(status, headers);
    return true;
  }
  send(status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
    if (this.head(status, { 'Content-Type': type, ...extra })) this.res.end(body);
  }
  html(body: string, status = 200) { this.send(status, body, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' }); }
  json(obj: unknown, status = 200) { this.send(status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' }); }
  redirect(to: string, flash?: [type: 'ok' | 'error' | 'info', msg: string]) {
    if (flash) this.setFlash(flash[0], flash[1]);
    const safe = to.startsWith('/') && !to.startsWith('//') ? to : to.startsWith(config.baseUrl) || to.startsWith('https://') ? to : '/';
    if (this.head(303, { Location: safe })) this.res.end();
  }
  back(fallback: string, flash?: [type: 'ok' | 'error' | 'info', msg: string]) {
    const ref = String(this.req.headers.referer || '');
    let to = fallback;
    try { const u = new URL(ref); if (u.origin === new URL(config.baseUrl).origin || u.host === this.req.headers.host) to = u.pathname + u.search; } catch {}
    this.redirect(to, flash);
  }

  async readBody(limit = 8 * 1024 * 1024) {
    if (this.method === 'GET' || this.method === 'HEAD') return;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of this.req) {
      size += (c as Buffer).length;
      if (size > limit) throw new HttpError(413, 'Upload too large');
      chunks.push(c as Buffer);
    }
    this.rawBody = Buffer.concat(chunks);
    const type = String(this.req.headers['content-type'] || '');
    if (type.includes('application/json')) { try { this.body = JSON.parse(this.rawBody.toString() || '{}'); } catch { this.body = {}; } }
    else if (type.includes('application/x-www-form-urlencoded')) this.body = parseForm(this.rawBody.toString());
    else if (type.includes('multipart/form-data')) {
      const b = type.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (b) { const r = parseMultipart(this.rawBody, b[1] || b[2]); this.body = r.fields; this.files = r.files; }
    }
  }
  checkCsrf() {
    const tok = String(this.body._csrf || this.req.headers['x-csrf-token'] || '');
    if (!tok || !safeEqual(tok, this.csrf)) throw new HttpError(403, 'Your session expired. Please go back, refresh the page and try again.');
  }
  str(k: string, max = 2000) { return String(this.body[k] ?? '').trim().slice(0, max); }
  int(k: string) { const n = parseInt(String(this.body[k] ?? ''), 10); return Number.isFinite(n) ? n : 0; }
  bool(k: string) { const v = this.body[k]; return v === 'on' || v === '1' || v === 'true' || v === true; }
}

function parseCookies(h: string) {
  const out: Record<string, string> = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}
function parseForm(s: string) {
  const out: Record<string, any> = {};
  for (const [k, v] of new URLSearchParams(s)) {
    if (k.endsWith('[]')) (out[k.slice(0, -2)] ||= []).push(v);
    else out[k] = v;
  }
  return out;
}
function parseMultipart(buf: Buffer, boundary: string) {
  const fields: Record<string, any> = {}, files: Record<string, Upload> = {};
  const delim = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = buf.slice(start + 2, headEnd).toString();
    const next = buf.indexOf(delim, headEnd);
    if (next === -1) break;
    const data = buf.slice(headEnd + 4, next - 2);
    const name = head.match(/name="([^"]*)"/)?.[1];
    const filename = head.match(/filename="([^"]*)"/)?.[1];
    const ctype = head.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || 'application/octet-stream';
    if (name) {
      if (filename !== undefined) { if (filename && data.length) files[name] = { filename, type: ctype, data }; }
      else if (name.endsWith('[]')) (fields[name.slice(0, -2)] ||= []).push(data.toString());
      else fields[name] = data.toString();
    }
    pos = next;
  }
  return { fields, files };
}
