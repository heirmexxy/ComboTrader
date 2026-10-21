import crypto from 'node:crypto';
import { config } from './config';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s: string, key = config.secret) => crypto.createHmac('sha256', key).update(s).digest('base64url');
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const randomDigits = (n = 6) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
export function randomCode(len = 8) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[crypto.randomInt(0, abc.length)];
  return s;
}

/** scrypt password hashing: scrypt$N$r$p$salt$hash */
export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string | null | undefined) {
  if (!stored) return false;
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'base64'));
}

/** Kobo helpers */
export const naira = (n: number) => Math.round(n * 100);
export const toNaira = (k: number) => k / 100;
export function parseNaira(input: unknown): number {
  const n = Number(String(input ?? '').replace(/[₦,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}
export function fmtNGN(kobo: number, opts: { decimals?: boolean } = {}) {
  const v = kobo / 100;
  const s = new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: opts.decimals ? 2 : 0,
    maximumFractionDigits: opts.decimals ? 2 : 0,
  }).format(v);
  return `₦${s}`;
}
/** Earnings for a trade: simple interest pro-rated by months. */
export function earningsFor(amount: number, rateBps: number, months: number) {
  return Math.round((amount * rateBps * months) / (10000 * 12));
}
export function addMonths(iso: string, months: number) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString();
}
export function addDays(iso: string | Date, days: number) {
  return new Date(new Date(iso).getTime() + days * 864e5).toISOString();
}
export const daysBetween = (a: string | Date, b: string | Date) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 864e5);
export const today = () => new Date().toISOString().slice(0, 10);
/** Date in Africa/Lagos (UTC+1, no DST). */
export function lagosNow() { return new Date(Date.now() + 3600e3); }

export function slugify(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 80);
}
export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
export function normalizePhone(raw: string, country = 'NG') {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return '';
  if (p.startsWith('+')) return p;
  if (country === 'NG' && p.startsWith('0')) return '+234' + p.slice(1);
  if (country === 'NG' && p.startsWith('234')) return '+' + p;
  return '+' + p;
}
export function plusFormat(n: number) {
  // Friendly public figures: 1,001 -> "1,000+", 5,080 -> "5,000+", 51,234,000 -> "51M+"
  if (n >= 1e9) return `${Math.floor(n / 1e8) / 10}B+`;
  if (n >= 1e6) return `${Math.floor(n / 1e5) / 10}M+`;
  if (n >= 1000) { const mag = 10 ** (Math.floor(Math.log10(n)) - 1); return `${(Math.floor(n / mag) * mag).toLocaleString('en')}+`; }
  return `${Math.floor(n).toLocaleString('en')}+`;
}
