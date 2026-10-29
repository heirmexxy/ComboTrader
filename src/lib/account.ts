// Champion data rights (NDPA 2023): download my data, close my account. Annual statement PDF. Admin user import.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { q, tx, now } from './db';
import { walletBalance, reservedBalance, balance } from './ledger';
import { TradeError } from './trading';
import { audit } from './audit';
import { createUser, userByEmail, issueToken, userById } from './auth';
import { queueEmail, emailShell, escapeHtml } from './notify';
import { config } from './config';
import { fmtNGN, isEmail, normalizePhone } from './util';
import { COUNTRY_CODES } from './geo';
import { translate, type Lang } from './i18n';
import type { User } from './http';

const pick = (rows: any[], drop: string[] = []) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))));

/** Everything we hold about a Champion, as JSON (secrets and hashes left out). */
export function exportUserData(uid: number) {
  const u = q.get<any>('SELECT * FROM users WHERE id=?', uid)!;
  const SECRET = ['password_hash', 'totp_secret', 'token_hash', 'recipient_code', 'authorization_code', 'id_doc_path'];
  return {
    exported_at: now(),
    note: 'ComboTrader (Kitovu Technology Company Limited) — your personal data export. Amounts are in kobo (₦1 = 100 kobo).',
    profile: pick([u], SECRET)[0],
    wallet: { available: walletBalance(uid), reserved: reservedBalance(uid) },
    trades: q.all('SELECT * FROM trades WHERE user_id=?', uid),
    plans: pick(q.all('SELECT * FROM plans WHERE user_id=?', uid), SECRET),
    gifts_sent: pick(q.all('SELECT * FROM gifts WHERE giver_id=?', uid), ['token_hash']),
    gifts_received: pick(q.all('SELECT * FROM gifts WHERE recipient_id=?', uid), ['token_hash']),
    payments: pick(q.all('SELECT id, reference, amount, fee, status, channel, purpose, paid_at, created_at FROM payments WHERE user_id=?', uid)),
    withdrawals: q.all('SELECT id, amount, route, status, reference, created_at, updated_at FROM withdrawals WHERE user_id=?', uid),
    bank_accounts: pick(q.all('SELECT * FROM bank_accounts WHERE user_id=?', uid), SECRET),
    ledger: q.all(`SELECT j.kind, j.memo, j.ref, e.amount, e.created_at, a.code AS account FROM entries e JOIN journals j ON j.id=e.journal_id JOIN ledger_accounts a ON a.id=e.account_id WHERE a.user_id=? ORDER BY e.id`, uid),
    circles: q.all('SELECT * FROM circle_slots WHERE user_id=?', uid),
    referrals: q.all('SELECT referred_id, amount, status, created_at FROM referral_rewards WHERE referrer_id=?', uid),
    notifications: q.all('SELECT title, body, created_at, read_at FROM notifications WHERE user_id=?', uid),
    support_tickets: q.all('SELECT subject, body, reply, status, created_at FROM tickets WHERE user_id=?', uid),
    logins: q.all('SELECT ip, ua, success, created_at FROM login_events WHERE user_id=? ORDER BY id DESC LIMIT 500', uid),
    whatsapp: q.all('SELECT direction, body, created_at FROM wa_messages WHERE user_id=?', uid),
  };
}

/** What stops an account from closing right now (money still on the platform). */
export function closureBlockers(uid: number) {
  const b: string[] = [];
  if (walletBalance(uid) > 0) b.push('close.wallet');
  if (reservedBalance(uid) > 0) b.push('close.reserved');
  if (q.get("SELECT 1 FROM trades WHERE user_id=? AND status IN ('active','matured')", uid)) b.push('close.trades');
  if (q.get("SELECT 1 FROM plans p WHERE p.user_id=? AND p.status IN ('active','paused','ready')", uid)) b.push('close.plans');
  if (q.all<any>("SELECT id FROM plans WHERE user_id=?", uid).some((p) => balance(`plan:${p.id}`) > 0)) b.push('close.plans');
  if (q.get("SELECT 1 FROM withdrawals WHERE user_id=? AND status IN ('requested','approved','processing','manual')", uid)) b.push('close.withdrawals');
  return [...new Set(b)];
}

/**
 * Closes the account. Financial records are kept for the period the law requires (anti-money-laundering rules),
 * but sign-in, messages, push, newsletter and the public feed stop at once.
 */
export function closeAccount(u: User, reason: string) {
  const blockers = closureBlockers(u.id);
  if (blockers.length) throw new TradeError(blockers[0]);
  tx(() => {
    q.run("UPDATE users SET status='closed', closed_at=?, notif_email=0, notif_sms=0, feed_opt_in=0, whatsapp_opt_in=0, totp_secret=NULL, totp_enabled=0, google_id=NULL WHERE id=?", now(), u.id);
    q.run('DELETE FROM sessions WHERE user_id=?', u.id);
    q.run('DELETE FROM push_subscriptions WHERE user_id=?', u.id);
    q.run("UPDATE subscribers SET status='unsubscribed' WHERE user_id=? OR email=?", u.id, u.email);
    q.run('UPDATE activity SET hidden=1 WHERE user_id=?', u.id);
    q.run('UPDATE bank_accounts SET active=0 WHERE user_id=?', u.id);
  });
  audit(u.id, 'account.close', `user:${u.id}`, reason.slice(0, 300));
  const t = (k: string) => translate(u.lang, k);
  queueEmail(u.email, t('close.email_subject'), emailShell(t('close.email_subject'), `<p>${escapeHtml(t('close.email_body'))}</p>`));
}

// ---------- Annual statement ----------
export function statementData(uid: number, year: number) {
  const from = `${year}-01-01T00:00:00.000Z`, to = `${year + 1}-01-01T00:00:00.000Z`;
  const acct = `wallet:${uid}`;
  const opening = Number(q.val('SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.code=? AND e.created_at<?', acct, from));
  const closing = Number(q.val('SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.code=? AND e.created_at<?', acct, to));
  const sum = (where: string) => Number(q.val(`SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN journals j ON j.id=e.journal_id JOIN ledger_accounts a ON a.id=e.account_id WHERE a.code=? AND e.created_at>=? AND e.created_at<? ${where}`, acct, from, to));
  const funded = sum("AND j.kind='fund'");
  const traded = -sum("AND j.kind='trade'");
  const withdrawn = -sum("AND j.kind='withdraw_hold'") - sum("AND j.kind='withdraw_reversed'");
  const paidTrades = q.all<any>(`SELECT t.certificate_no, t.amount, t.earnings, t.paid_at, l.title FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? AND t.status='paid' AND t.paid_at>=? AND t.paid_at<? ORDER BY t.paid_at`, uid, from, to);
  const earnings = paidTrades.reduce((s, t) => s + (t.earnings || 0), 0);
  const principalBack = paidTrades.reduce((s, t) => s + t.amount, 0);
  const referrals = sum("AND j.kind='referral'");
  const marketSold = sum("AND j.kind='market' AND e.amount>0");
  const marketBought = -sum("AND j.kind='market' AND e.amount<0");
  const adjustments = sum("AND j.kind='adjust'");
  const active = q.all<any>(`SELECT t.certificate_no, t.amount, t.matures_at, l.title FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? AND t.start_at<? AND (t.paid_at IS NULL OR t.paid_at>=?) AND t.status!='cancelled' ORDER BY t.matures_at`, uid, to, to);
  return { year, opening, closing, funded, traded, withdrawn: Math.max(0, withdrawn), earnings, principalBack, referrals, adjustments, marketSold, marketBought, paidTrades, active };
}

export async function statementPdf(u: User, year: number) {
  const d = statementData(u.id, year);
  const t = (k: string, v?: any) => translate('en' as Lang, k, v);
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0.12, 0.3, 0.17), grey = rgb(0.4, 0.4, 0.4);
  const N = (k: number) => `NGN ${(k / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  let y = 790;
  const text = (s: string, x: number, size = 10, f = font, color = rgb(0.15, 0.15, 0.15)) => page.drawText(s.replace(/[^\x20-\x7E]/g, ''), { x, y, size, font: f, color });
  page.drawRectangle({ x: 0, y: 770, width: 595, height: 72, color: green });
  y = 800; text('COMBOTRADER', 40, 20, bold, rgb(1, 1, 1));
  y = 782; text(`Annual statement ${year}`, 40, 11, font, rgb(0.83, 0.63, 0.09));
  y = 740; text(`${u.first_name} ${u.last_name}`, 40, 13, bold);
  y -= 16; text(`${u.email}  ·  Champion ID ${u.id}  ·  issued ${now().slice(0, 10)}`, 40, 9, font, grey);
  y -= 30;
  const row = (label: string, v: string, b = false) => { text(label, 40, 10, b ? bold : font); page.drawText(v, { x: 555 - (b ? bold : font).widthOfTextAtSize(v, 10), y, size: 10, font: b ? bold : font }); y -= 18; };
  text('Wallet summary', 40, 12, bold, green); y -= 22;
  row('Opening wallet balance (1 January)', N(d.opening));
  row('Money added to wallet', N(d.funded));
  row('Committed to trades', `- ${N(d.traded)}`);
  row('Principal returned from trades', N(d.principalBack));
  row('Earnings paid', N(d.earnings), true);
  if (d.referrals) row('Referral rewards', N(d.referrals));
  if (d.marketBought) row('Paid for trades bought from other Champions', `- ${N(d.marketBought)}`);
  if (d.marketSold) row('Received for trades sold to other Champions (after fee)', N(d.marketSold));
  if (d.adjustments) row('Adjustments', N(d.adjustments));
  row('Withdrawn to bank', `- ${N(d.withdrawn)}`);
  row('Closing wallet balance (31 December)', N(d.closing), true);
  y -= 12; text('Trades paid out this year', 40, 12, bold, green); y -= 20;
  if (!d.paidTrades.length) { text('None', 40, 10, font, grey); y -= 18; }
  for (const p of d.paidTrades.slice(0, 14)) { text(`${p.paid_at.slice(0, 10)}  ${p.certificate_no}  ${p.title}`.slice(0, 70), 40, 9); page.drawText(`${N(p.amount)} + ${N(p.earnings || 0)}`, { x: 555 - font.widthOfTextAtSize(`${N(p.amount)} + ${N(p.earnings || 0)}`, 9), y, size: 9, font }); y -= 15; }
  y -= 12; text('Trades still running at year end', 40, 12, bold, green); y -= 20;
  if (!d.active.length) { text('None', 40, 10, font, grey); y -= 18; }
  for (const a of d.active.slice(0, 12)) { text(`${a.certificate_no}  ${a.title}  (pays ${a.matures_at.slice(0, 10)})`.slice(0, 75), 40, 9); page.drawText(N(a.amount), { x: 555 - font.widthOfTextAtSize(N(a.amount), 9), y, size: 9, font }); y -= 15; }
  y = 90;
  for (const line of [
    'Earnings may be taxable income where you live. This statement is for your records and your tax adviser; it is not tax advice.',
    'Kitovu Technology Company Limited (RC 1348965), Iseyin, Oyo State, Nigeria · combotrader.com.ng · ' + t('footer.risk'),
    `Verify any certificate at ${config.baseUrl.replace(/^https?:\/\//, '')}/verify`,
  ]) { text(line, 40, 7.5, font, grey); y -= 12; }
  return Buffer.from(await doc.save());
}

// ---------- Admin import of existing users ----------
export interface ImportRow { first_name: string; last_name: string; email: string; phone?: string; country?: string; city?: string; opening_balance?: string }
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [], f = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') inQ = false; else f += ch; continue; }
    if (ch === '"') inQ = true;
    else if (ch === ',') { cur.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; cur.push(f); f = ''; if (cur.some((x) => x.trim())) rows.push(cur); cur = []; }
    else f += ch;
  }
  cur.push(f); if (cur.some((x) => x.trim())) rows.push(cur);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

/**
 * Creates accounts for existing users. Each gets a "set your password" email. Opening balances become
 * pending adjustments that a second admin must approve, so the ledger records where every naira came from.
 */
export function importUsers(rows: Record<string, string>[], adminId: number, o: { sendInvites: boolean }) {
  const out = { created: 0, skipped: [] as string[], balances: 0 };
  for (const [i, r] of rows.entries()) {
    const email = String(r.email || '').toLowerCase();
    const line = `row ${i + 2}`;
    if (!isEmail(email) || !r.first_name || !r.last_name) { out.skipped.push(`${line}: needs first_name, last_name and a valid email`); continue; }
    if (userByEmail(email)) { out.skipped.push(`${line}: ${email} already has an account`); continue; }
    const country = COUNTRY_CODES.includes(String(r.country || 'NG').toUpperCase()) ? String(r.country || 'NG').toUpperCase() : 'NG';
    const id = createUser({ email, first_name: r.first_name.slice(0, 60), last_name: r.last_name.slice(0, 60), phone: r.phone ? normalizePhone(r.phone, country) : undefined, country, city: r.city, lang: 'en' });
    q.run("UPDATE users SET notes=? WHERE id=?", `Imported from the previous ComboTrader site on ${now().slice(0, 10)}`, id);
    out.created++;
    const bal = Math.round(Number(String(r.opening_balance || '0').replace(/[₦,\s]/g, '')) * 100);
    if (bal > 0) {
      q.insert('adjustments', { user_id: id, amount: bal, reason: 'Opening balance moved from the previous ComboTrader site', created_by: adminId, created_at: now() });
      out.balances++;
    }
    if (o.sendInvites) {
      const u = userById(id)!;
      const tok = issueToken('reset', id, { minutes: 60 * 24 * 14 });
      queueEmail(u.email, 'Welcome to the new ComboTrader', emailShell('Your new ComboTrader account is ready',
        `<p>Hello ${escapeHtml(u.first_name)},</p><p>ComboTrader has moved to a new, faster platform with live Harvest Trail updates, Trade Certificates you can verify, and a wallet you control. Your account has been created with this email address${bal > 0 ? ` and your balance of ${fmtNGN(bal)} is being moved across` : ''}.</p><p>Set your password to sign in. The link works for 14 days.</p>`,
        { label: 'Set my password', url: `${config.baseUrl}/reset-password/${tok}` }));
    }
  }
  audit(adminId, 'users.import', undefined, out);
  return out;
}
