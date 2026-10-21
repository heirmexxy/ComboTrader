// Paystack integration. Without PAYSTACK_SECRET_KEY the platform runs in DEMO mode:
// payments go to a clearly-labelled simulated checkout, and transfers succeed instantly.
import crypto from 'node:crypto';
import { config } from './config';

const API = 'https://api.paystack.co';

async function ps<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${config.paystackSecret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) throw new Error(json.message || `Paystack ${res.status}`);
  return json.data as T;
}

export const isDemo = () => config.paystackDemo;
function demoAllowed() { if (!config.demoMode) throw new Error('Payments are not configured. Set PAYSTACK_SECRET_KEY.'); return true; }

export async function initialize(o: { email: string; amount: number; reference: string; metadata?: Record<string, unknown> }) {
  if (isDemo() && demoAllowed()) return { authorization_url: `/pay/demo/${o.reference}` };
  return ps<{ authorization_url: string }>('POST', '/transaction/initialize', {
    email: o.email, amount: o.amount, reference: o.reference, currency: 'NGN',
    callback_url: `${config.baseUrl}/pay/callback`, metadata: o.metadata,
    channels: ['card', 'bank', 'ussd', 'bank_transfer', 'apple_pay'],
  });
}

export interface Verified { status: 'success' | 'failed' | 'abandoned' | 'pending'; amount: number; fees: number; channel: string; paid_at: string | null; currency: string; raw: unknown }
export async function verify(reference: string): Promise<Verified> {
  const d: any = await ps('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  return { status: d.status, amount: d.amount, fees: d.fees || 0, channel: d.channel, paid_at: d.paid_at, currency: d.currency, raw: d };
}

export function webhookValid(raw: Buffer, signature: string | undefined) {
  if (!config.paystackSecret || !signature) return false;
  const h = crypto.createHmac('sha512', config.paystackSecret).update(raw).digest('hex');
  return h.length === signature.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(signature));
}

const DEMO_BANKS = [
  ['044', 'Access Bank'], ['058', 'Guaranty Trust Bank'], ['011', 'First Bank of Nigeria'], ['033', 'United Bank For Africa'],
  ['057', 'Zenith Bank'], ['070', 'Fidelity Bank'], ['232', 'Sterling Bank'], ['50515', 'Moniepoint MFB'], ['999992', 'OPay'], ['999991', 'PalmPay'],
].map(([code, name]) => ({ code, name }));
let bankCache: { at: number; list: { code: string; name: string }[] } | null = null;
export async function banks() {
  if (isDemo()) return DEMO_BANKS;
  if (bankCache && Date.now() - bankCache.at < 86400e3) return bankCache.list;
  const d: any[] = await ps('GET', '/bank?country=nigeria&perPage=200');
  bankCache = { at: Date.now(), list: d.map((b) => ({ code: b.code, name: b.name })) };
  return bankCache.list;
}

export async function resolveAccount(accountNumber: string, bankCode: string, demoName: string) {
  if (isDemo()) return { account_name: demoName.toUpperCase() };
  return ps<{ account_name: string }>('GET', `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
}

export async function createRecipient(name: string, accountNumber: string, bankCode: string) {
  if (isDemo()) return { recipient_code: `RCP_demo_${accountNumber}` };
  return ps<{ recipient_code: string }>('POST', '/transferrecipient', { type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' });
}

export async function transfer(o: { amount: number; recipient: string; reference: string; reason: string }) {
  if (isDemo() && demoAllowed()) return { status: 'success', transfer_code: `TRF_demo_${o.reference}` };
  return ps<{ status: string; transfer_code: string }>('POST', '/transfer', { source: 'balance', amount: o.amount, recipient: o.recipient, reference: o.reference, reason: o.reason });
}

/** Starts BVN + bank account identity validation. Result arrives by webhook (customeridentification.*). */
export async function validateIdentity(o: { email: string; first_name: string; last_name: string; phone?: string | null; bvn: string; account_number: string; bank_code: string; customerCode?: string | null }) {
  if (isDemo()) return { customer_code: o.customerCode || `CUS_demo_${o.email}`, instant: true };
  let code = o.customerCode;
  if (!code) {
    const c: any = await ps('POST', '/customer', { email: o.email, first_name: o.first_name, last_name: o.last_name, phone: o.phone || undefined });
    code = c.customer_code;
  }
  await ps('POST', `/customer/${code}/identification`, {
    country: 'NG', type: 'bank_account', account_number: o.account_number, bvn: o.bvn, bank_code: o.bank_code, first_name: o.first_name, last_name: o.last_name,
  });
  return { customer_code: code!, instant: false };
}

export async function transactionsBetween(fromIso: string, toIso: string) {
  if (isDemo()) return null;
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const d: any[] = await ps('GET', `/transaction?status=success&from=${fromIso}&to=${toIso}&perPage=100&page=${page}`);
    out.push(...d);
    if (d.length < 100) break;
  }
  return out.map((t) => ({ reference: t.reference as string, amount: t.amount as number }));
}
