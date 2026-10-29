import { get, post } from '../lib/router';
import { render } from '../views/render';
import { createElement as h } from 'react';
import * as A from '../views/public/auth';
import { q, now } from '../lib/db';
import { createSession, destroySession, issueToken, consumeToken, createUser, userByEmail, rateLimit, passwordProblem, userById } from '../lib/auth';
import { verifyTotp } from '../lib/totp';
import { hashPassword, verifyPassword, isEmail, normalizePhone, randomToken, safeEqual, hmac } from '../lib/util';
import { queueEmail, queueSms, emailShell, notify } from '../lib/notify';
import { translate, isLang } from '../lib/i18n';
import { COUNTRY_CODES } from '../lib/geo';
import { config } from '../lib/config';
import { HttpError, type Ctx, type User } from '../lib/http';
import { audit } from '../lib/audit';
import { sourceOf } from '../lib/tracking';

const safeNext = (n: unknown) => { const s = String(n || ''); return s.startsWith('/') && !s.startsWith('//') ? s : ''; };
const demoMessaging = () => config.demoMode && !(config.emailProvider && config.emailApiKey);
const demoSms = () => config.demoMode && !config.termiiKey;

function sendVerifyEmail(u: User) {
  const token = issueToken('email_verify', u.id, { minutes: 60 * 48 });
  const t = (k: string) => translate(u.lang, k);
  const url = `${config.baseUrl}/verify-email/${token}`;
  queueEmail(u.email, t('auth.verify_subject'), emailShell(t('auth.verify_subject'), `<p>${t('auth.verify_body')}</p>`, { label: t('auth.verify'), url }));
  return url;
}

function logLogin(c: Ctx, userId: number | null, email: string, success: boolean) {
  q.insert('login_events', { user_id: userId, email, ip: c.ip, ua: String(c.req.headers['user-agent'] || '').slice(0, 300), success: success ? 1 : 0, created_at: now() });
}
function newDeviceCheck(c: Ctx, u: User) {
  const seen = q.get('SELECT 1 FROM login_events WHERE user_id=? AND success=1 AND ua=? LIMIT 1', u.id, String(c.req.headers['user-agent'] || '').slice(0, 300));
  const any = q.get('SELECT 1 FROM login_events WHERE user_id=? AND success=1 LIMIT 1', u.id);
  if (any && !seen) notify(u, 'new_device', {}, { link: '/app/security', sms: true });
}
function afterLogin(c: Ctx, u: User, next?: string) {
  q.run('UPDATE users SET last_login_at=? WHERE id=?', now(), u.id);
  c.setCookie('lang', u.lang, { maxAge: 365 * 86400 });
  if (u.role === 'admin' && !next) return c.redirect('/admin');
  c.redirect(next || '/app');
}

/** Records where a new Champion came from (first tracked link or UTM source, else referral or direct). */
function attribute(c: Ctx, id: number) {
  const src = sourceOf(c);
  const u = userById(id);
  q.run('UPDATE users SET acq_source=?, acq_campaign=? WHERE id=?', src?.source || (u?.referred_by ? 'referral' : 'direct'), src?.campaign || null, id);
  q.run("UPDATE leads SET status='signed_up', user_id=? WHERE email=? AND status!='unsubscribed'", id, u?.email || '');
}

// ---------- Sign up ----------
get('/signup', 'guest', (c) => render(c, h(A.SignupPage, { v: { ref: c.cookies.ref || '' }, next: safeNext(c.query.next) })));
post('/signup', 'guest', (c) => {
  const v = {
    first_name: c.str('first_name', 60), last_name: c.str('last_name', 60), email: c.str('email', 200).toLowerCase(),
    country: c.str('country', 2).toUpperCase(), city: c.str('city', 60), phone: c.str('phone', 30), ref: c.str('ref', 12).toUpperCase(),
    feed_opt_in: c.bool('feed_opt_in') ? 'on' : 'off',
  };
  const next = safeNext(c.body.next);
  const fail = (key: string) => render(c, h(A.SignupPage, { v, error: c.t(key), next }), 422);
  if (!rateLimit(`signup:${c.ip}`, 10, 3600)) return fail('auth.too_many');
  if (!v.first_name || !v.last_name || !v.email || !v.phone) return fail('auth.required');
  if (!isEmail(v.email)) return fail('auth.bad_email');
  if (!c.bool('agree')) return fail('auth.must_agree');
  const pw = String(c.body.password || '');
  const prob = passwordProblem(pw);
  if (prob) return fail(prob);
  if (userByEmail(v.email)) return fail('auth.email_taken');
  const referrer = v.ref ? q.get<{ id: number }>('SELECT id FROM users WHERE referral_code=?', v.ref) : undefined;
  const id = createUser({
    email: v.email, password: pw, first_name: v.first_name, last_name: v.last_name, country: COUNTRY_CODES.includes(v.country) ? v.country : 'NG',
    city: v.city, phone: normalizePhone(v.phone, v.country), lang: isLang(c.body.lang) ? c.body.lang : c.lang, referredBy: referrer?.id ?? null,
    feedOptIn: v.feed_opt_in === 'on',
  });
  attribute(c, id);
  const u = userById(id)!;
  createSession(c, id, { remember: true });
  logLogin(c, id, u.email, true);
  const url = sendVerifyEmail(u);
  notify(u, 'welcome', {}, { link: '/app', email: false });
  c.setCookie('ref', '', { maxAge: 0 });
  if (next) c.setCookie('next', next, { maxAge: 3600 });
  if (demoMessaging()) c.setCookie('demo_verify', url, { maxAge: 3600 });
  c.redirect('/verify-phone');
});

// Referral link: /r/CODE
get('/r/:code', 'public', (c) => {
  const code = c.params.code.toUpperCase().slice(0, 12);
  if (q.get('SELECT 1 FROM users WHERE referral_code=?', code)) c.setCookie('ref', code, { maxAge: 30 * 86400 });
  c.redirect(c.user ? '/app' : '/signup');
});

// ---------- Email verification ----------
get('/verify-email', 'auth', (c) => {
  if (c.user!.email_verified_at) return c.redirect('/app', ['ok', c.t('auth.email_verified')]);
  render(c, h(A.VerifyEmailPage, { email: c.user!.email, demoLink: demoMessaging() ? c.cookies.demo_verify : undefined }));
});
post('/verify-email/resend', 'auth', (c) => {
  if (!rateLimit(`verify:${c.user!.id}`, 5, 3600)) throw new HttpError(429, c.t('auth.too_many'));
  const url = sendVerifyEmail(c.user!);
  if (demoMessaging()) c.setCookie('demo_verify', url, { maxAge: 3600 });
  c.redirect('/verify-email', ['ok', c.t('auth.resent')]);
});
get('/verify-email/:token', 'public', (c) => {
  const t = consumeToken('email_verify', c.params.token);
  if (!t) return c.redirect(c.user ? '/app' : '/login', ['error', c.t('auth.bad_link')]);
  q.run('UPDATE users SET email_verified_at=COALESCE(email_verified_at, ?) WHERE id=?', now(), t.user_id);
  c.setCookie('demo_verify', '', { maxAge: 0 });
  c.redirect(c.user ? '/app' : '/login', ['ok', c.t('auth.email_verified')]);
});

// ---------- Phone verification ----------
get('/verify-phone', 'auth', (c) => {
  const u = c.user!;
  if (u.phone_verified_at) return c.redirect(u.onboarded ? '/app' : '/welcome');
  const pending = c.cookies.otp_phone;
  render(c, h(A.VerifyPhonePage, { phone: pending || u.phone || '', sent: !!pending, demoCode: demoSms() ? c.cookies.demo_otp : undefined }));
});
post('/verify-phone/send', 'auth', (c) => {
  const u = c.user!;
  const phone = normalizePhone(c.str('phone', 30) || u.phone || '', u.country);
  if (!/^\+\d{8,15}$/.test(phone)) return c.redirect('/verify-phone', ['error', c.t('auth.required')]);
  if (!rateLimit(`otp:${u.id}`, 5, 3600)) return c.redirect('/verify-phone', ['error', c.t('auth.too_many')]);
  const code = issueToken('phone_otp', u.id, { minutes: 10, digits: true, data: phone });
  queueSms(phone, translate(u.lang, 'auth.sms_code', { code }));
  c.setCookie('otp_phone', phone, { maxAge: 600 });
  if (demoSms()) c.setCookie('demo_otp', code, { maxAge: 600 });
  c.redirect('/verify-phone');
});
post('/verify-phone', 'auth', (c) => {
  const u = c.user!;
  const t = consumeToken('phone_otp', c.str('code', 6), u.id);
  if (!t) return render(c, h(A.VerifyPhonePage, { phone: c.cookies.otp_phone || u.phone || '', sent: true, error: c.t('auth.bad_code'), demoCode: demoSms() ? c.cookies.demo_otp : undefined }), 422);
  q.run('UPDATE users SET phone=?, phone_verified_at=? WHERE id=?', t.data, now(), u.id);
  c.setCookie('otp_phone', '', { maxAge: 0 });
  c.setCookie('demo_otp', '', { maxAge: 0 });
  c.redirect(u.onboarded ? '/app/profile' : '/welcome', ['ok', c.t('auth.phone_verified')]);
});

// ---------- Welcome tour ----------
get('/welcome', 'auth', (c) => render(c, h(A.WelcomeTour)));
post('/welcome', 'auth', (c) => {
  q.run('UPDATE users SET onboarded=1 WHERE id=?', c.user!.id);
  const next = safeNext(c.cookies.next);
  c.setCookie('next', '', { maxAge: 0 });
  c.redirect(next || '/app');
});

// ---------- Log in / out ----------
get('/login', 'guest', (c) => render(c, h(A.LoginPage, { next: safeNext(c.query.next) })));
post('/login', 'guest', (c) => {
  const email = c.str('email', 200).toLowerCase();
  const next = safeNext(c.body.next);
  const fail = (key: string) => render(c, h(A.LoginPage, { email, error: c.t(key), next }), 401);
  if (!rateLimit(`login:${c.ip}`, 20, 900) || !rateLimit(`login:${email}`, 8, 900)) return fail('auth.too_many');
  const u = userByEmail(email);
  if (!u || !verifyPassword(String(c.body.password || ''), (q.get<any>('SELECT password_hash FROM users WHERE id=?', u.id) || {}).password_hash)) {
    logLogin(c, u?.id ?? null, email, false);
    return fail('auth.bad_login');
  }
  if (u.status !== 'active') return fail('auth.suspended');
  if (u.totp_enabled) {
    createSession(c, u.id, { remember: c.bool('remember'), twofaOk: false });
    if (next) c.setCookie('next', next, { maxAge: 600 });
    return c.redirect('/login/2fa');
  }
  newDeviceCheck(c, u);
  createSession(c, u.id, { remember: c.bool('remember') });
  logLogin(c, u.id, email, true);
  afterLogin(c, u, next);
});
get('/login/2fa', 'public', (c) => {
  if (!c.pending2fa) return c.redirect(c.user ? '/app' : '/login');
  render(c, h(A.TwoFactorPage, {}));
});
post('/login/2fa', 'public', (c) => {
  if (!c.pending2fa || !c.user) return c.redirect('/login');
  const u = c.user;
  if (!rateLimit(`2fa:${u.id}`, 6, 900)) return render(c, h(A.TwoFactorPage, { error: c.t('auth.too_many') }), 429);
  const secret = q.val<string>('SELECT totp_secret FROM users WHERE id=?', u.id);
  if (!verifyTotp(secret, c.str('code', 8))) { logLogin(c, u.id, u.email, false); return render(c, h(A.TwoFactorPage, { error: c.t('auth.bad_code') }), 401); }
  q.run('UPDATE sessions SET twofa_ok=1 WHERE id=?', c.sessionId);
  newDeviceCheck(c, u);
  logLogin(c, u.id, u.email, true);
  const next = safeNext(c.cookies.next);
  c.setCookie('next', '', { maxAge: 0 });
  afterLogin(c, u, next);
});
post('/logout', 'public', (c) => { destroySession(c); c.redirect('/', ['info', c.t('auth.logged_out')]); });

// ---------- Password reset ----------
get('/forgot-password', 'public', (c) => render(c, h(A.ForgotPage, { sent: c.query.sent === '1' })));
post('/forgot-password', 'public', (c) => {
  const email = c.str('email', 200).toLowerCase();
  if (rateLimit(`reset:${c.ip}`, 5, 3600) && isEmail(email)) {
    const u = userByEmail(email);
    if (u) {
      const token = issueToken('reset', u.id, { minutes: 60 });
      const t = (k: string) => translate(u.lang, k);
      queueEmail(u.email, t('auth.reset_subject'), emailShell(t('auth.reset_subject'), `<p>${t('auth.reset_body')}</p>`, { label: t('auth.reset_title'), url: `${config.baseUrl}/reset-password/${token}` }));
    }
  }
  c.redirect('/forgot-password?sent=1');
});
get('/reset-password/:token', 'public', (c) => render(c, h(A.ResetPage, { token: c.params.token })));
post('/reset-password/:token', 'public', (c) => {
  const pw = String(c.body.password || '');
  const prob = passwordProblem(pw);
  if (prob) return render(c, h(A.ResetPage, { token: c.params.token, error: c.t(prob) }), 422);
  const t = consumeToken('reset', c.params.token);
  if (!t) return c.redirect('/forgot-password', ['error', c.t('auth.bad_link')]);
  // A reset link proves the person controls the email address.
  q.run('UPDATE users SET password_hash=?, email_verified_at=COALESCE(email_verified_at, ?) WHERE id=?', hashPassword(pw), now(), t.user_id);
  q.run('DELETE FROM sessions WHERE user_id=?', t.user_id);
  audit(t.user_id, 'password.reset', `user:${t.user_id}`, undefined, c.ip);
  c.redirect('/login', ['ok', c.t('auth.reset_done')]);
});

// ---------- Google sign-in (enabled when GOOGLE_CLIENT_ID is set) ----------
get('/auth/google', 'public', (c) => {
  if (!config.googleClientId) throw new HttpError(404, 'Not found');
  const state = randomToken(16);
  c.setCookie('g_state', `${state}.${hmac(state)}`, { maxAge: 600 });
  const next = safeNext(c.query.next);
  if (next) c.setCookie('next', next, { maxAge: 3600 });
  const p = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: `${config.baseUrl}/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
  c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
});
get('/auth/google/callback', 'public', async (c) => {
  const [state, sig] = String(c.cookies.g_state || '').split('.');
  if (!state || !sig || !safeEqual(hmac(state), sig) || state !== c.query.state) return c.redirect('/login', ['error', c.t('auth.bad_link')]);
  c.setCookie('g_state', '', { maxAge: 0 });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: String(c.query.code || ''), client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: `${config.baseUrl}/auth/google/callback`, grant_type: 'authorization_code' }),
  });
  const tok: any = await res.json().catch(() => ({}));
  if (!tok.id_token) return c.redirect('/login', ['error', c.t('err.generic')]);
  const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
  if (claims.aud !== config.googleClientId || !claims.email_verified) return c.redirect('/login', ['error', c.t('err.generic')]);
  let u = q.get<User>('SELECT * FROM users WHERE google_id=?', claims.sub) || userByEmail(claims.email);
  if (u && !u.google_id) q.run('UPDATE users SET google_id=?, email_verified_at=COALESCE(email_verified_at, ?) WHERE id=?', claims.sub, now(), u.id);
  let fresh = false;
  if (!u) {
    const ref = c.cookies.ref ? q.get<{ id: number }>('SELECT id FROM users WHERE referral_code=?', c.cookies.ref) : undefined;
    const id = createUser({ email: claims.email, first_name: claims.given_name || 'Champion', last_name: claims.family_name || '', country: 'NG', lang: c.lang, googleId: claims.sub, referredBy: ref?.id ?? null });
    attribute(c, id);
    u = userById(id)!;
    notify(u, 'welcome', {}, { link: '/app', email: false });
    fresh = true;
  }
  if (u.status !== 'active') return c.redirect('/login', ['error', c.t('auth.suspended')]);
  if (u.totp_enabled) { createSession(c, u.id, { remember: true, twofaOk: false }); return c.redirect('/login/2fa'); }
  createSession(c, u.id, { remember: true });
  logLogin(c, u.id, u.email, true);
  if (fresh || !u.phone_verified_at) return c.redirect('/verify-phone');
  const next = safeNext(c.cookies.next);
  c.setCookie('next', '', { maxAge: 0 });
  afterLogin(c, u, next);
});
