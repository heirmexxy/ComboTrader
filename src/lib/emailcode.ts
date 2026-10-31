// Two-step verification by email (no authenticator app): a 6-digit code, valid for 10 minutes and for one purpose only.
// Admins enter one at every sign-in; everyone enters one to withdraw money or change the bank account that receives it.
import { issueToken, consumeToken } from './auth';
import { queueEmail, emailShell, escapeHtml, flushOutbox } from './notify';
import { translate } from './i18n';
import { config } from './config';
import type { User } from './http';

/** k•••••a@gmail.com */
export const maskEmail = (e: string) => e.replace(/^(.)(.*)(.@.*)$/, (_m, a, b, d) => a + '•'.repeat(Math.min(6, b.length)) + d);
export type CodePurpose = 'login' | 'withdraw' | 'bank';
/** Shown on screen only on a development machine without an email provider. */
export const showCodeOnScreen = () => config.demoMode && !(config.emailProvider && config.emailApiKey);

export function sendEmailCode(u: Pick<User, 'id' | 'email' | 'lang' | 'first_name'>, purpose: CodePurpose) {
  const code = issueToken(`code_${purpose}`, u.id, { minutes: 10, digits: true });
  const t = (k: string, v?: Record<string, string>) => translate(u.lang, k, v);
  const subject = t('code.subject', { code });
  queueEmail(u.email, subject, emailShell(escapeHtml(t('code.title')), `<p>${escapeHtml(t(`code.body.${purpose}`, { name: u.first_name }))}</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:18px 0;color:#1F4D2B">${code}</p>
    <p style="font-size:13px;color:#666">${escapeHtml(t('code.expires'))} ${escapeHtml(t('code.ignore'))}</p>`));
  flushOutbox().catch(() => {}); // send now, not on the next scheduled run
  return code;
}
export function checkEmailCode(u: Pick<User, 'id'>, purpose: CodePurpose, code: string) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  return !!consumeToken(`code_${purpose}`, c, u.id);
}
