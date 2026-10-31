import { q, now } from './db';
import { config } from './config';
import type { Ctx, User } from './http';
import { randomToken, sha256, randomCode, randomDigits, hashPassword, addDays } from './util';
import { activity } from './audit';
import type { Lang } from './i18n';

// ---------- Sessions ----------
export function createSession(c: Ctx, userId: number, o: { remember?: boolean; twofaOk?: boolean } = {}) {
  const token = randomToken(32);
  const days = o.remember ? 30 : 1;
  const t = now();
  const r = q.insert('sessions', {
    token_hash: sha256(token), user_id: userId, twofa_ok: o.twofaOk === false ? 0 : 1,
    ip: c.ip, ua: String(c.req.headers['user-agent'] || '').slice(0, 300), created_at: t, last_seen: t, expires_at: addDays(t, days),
  });
  c.setCookie('sid', token, { maxAge: o.remember ? days * 86400 : undefined });
  c.sessionId = r.id;
  return r.id;
}
export function loadSession(c: Ctx) {
  const tok = c.cookies.sid;
  if (!tok) return;
  const s = q.get<{ id: number; user_id: number; twofa_ok: number; expires_at: string; last_seen: string }>(
    'SELECT id, user_id, twofa_ok, expires_at, last_seen FROM sessions WHERE token_hash=?', sha256(tok));
  if (!s || s.expires_at < now()) { c.setCookie('sid', '', { maxAge: 0 }); return; }
  const u = q.get<User>('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u || u.status !== 'active') { q.run('DELETE FROM sessions WHERE id=?', s.id); c.setCookie('sid', '', { maxAge: 0 }); return; }
  c.sessionId = s.id;
  if (!s.twofa_ok) { c.pending2fa = true; c.user = u; return; }
  c.user = u;
  if (Date.now() - new Date(s.last_seen).getTime() > 5 * 60e3) {
    q.run('UPDATE sessions SET last_seen=? WHERE id=?', now(), s.id);
    q.run('UPDATE users SET last_active_at=? WHERE id=?', now(), u.id);
  }
}
export function destroySession(c: Ctx) {
  if (c.sessionId) q.run('DELETE FROM sessions WHERE id=?', c.sessionId);
  c.setCookie('sid', '', { maxAge: 0 });
}

// ---------- One-time tokens ----------
export function issueToken(kind: 'email_verify' | 'phone_otp' | 'reset' | 'newsletter' | `code_${string}`, userId: number | null, o: { minutes?: number; digits?: boolean; data?: string } = {}) {
  const raw = o.digits ? randomDigits(6) : randomToken(24);
  q.run('UPDATE tokens SET used_at=? WHERE kind=? AND user_id IS ? AND used_at IS NULL', now(), kind, userId);
  q.insert('tokens', {
    user_id: userId, kind, token_hash: sha256(raw), data: o.data ?? null,
    expires_at: addDays(now(), (o.minutes ?? 60 * 24) / 1440), created_at: now(),
  });
  return raw;
}
export function consumeToken(kind: string, raw: string, userId?: number) {
  const row = userId
    ? q.get<any>('SELECT * FROM tokens WHERE kind=? AND user_id=? AND used_at IS NULL ORDER BY id DESC LIMIT 1', kind, userId)
    : q.get<any>('SELECT * FROM tokens WHERE kind=? AND token_hash=? AND used_at IS NULL', kind, sha256(raw));
  if (!row || row.expires_at < now()) return null;
  if (userId) {
    if (row.attempts >= 5) return null;
    if (row.token_hash !== sha256(String(raw).trim())) { q.run('UPDATE tokens SET attempts=attempts+1 WHERE id=?', row.id); return null; }
  }
  q.run('UPDATE tokens SET used_at=? WHERE id=?', now(), row.id);
  return row as { user_id: number; data: string | null };
}

// ---------- Users ----------
export interface NewUser { email: string; password?: string; first_name: string; last_name: string; phone?: string; country: string; city?: string; lang: Lang; referredBy?: number | null; googleId?: string; feedOptIn?: boolean }
export function createUser(n: NewUser) {
  let code = randomCode(7);
  while (q.get('SELECT 1 FROM users WHERE referral_code=?', code)) code = randomCode(7);
  const r = q.insert('users', {
    email: n.email.toLowerCase(), password_hash: n.password ? hashPassword(n.password) : null,
    first_name: n.first_name, last_name: n.last_name, phone: n.phone || null, country: n.country || 'NG', city: n.city || null,
    lang: n.lang, referral_code: code, referred_by: n.referredBy ?? null, google_id: n.googleId ?? null,
    email_verified_at: n.googleId ? now() : null, feed_opt_in: n.feedOptIn === false ? 0 : 1, created_at: now(),
  });
  activity('signup', r.id, {});
  return r.id;
}
export const userById = (id: number) => q.get<User>('SELECT * FROM users WHERE id=?', id);
export const userByEmail = (email: string) => q.get<User>('SELECT * FROM users WHERE email=?', email.toLowerCase().trim());
export const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`;

// ---------- Rate limiting (in-memory, per key) ----------
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowSec: number) {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowSec * 1000 }); return true; }
  b.n++;
  return b.n <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60e3).unref();

export function passwordProblem(pw: string) {
  if (pw.length < 8) return 'auth.pw_short';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'auth.pw_mix';
  return null;
}
export const isProduction = () => config.production;
