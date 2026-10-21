// Admin-editable settings with typed defaults.
import { q } from './db';

export const DEFAULTS = {
  circles_mode: 'pilot' as 'off' | 'pilot' | 'on',
  circle_deadline_days: 14,
  circle_max_share_pct: 40,
  referral_reward: 500000, // kobo: ₦5,000
  min_withdrawal: 100000, // ₦1,000
  auto_withdraw_limit: 0, // kobo; withdrawals at or below this are sent without manual approval (0 = all manual)
  dual_approval_threshold: 500000000, // ₦5,000,000 needs a second approver
  kyc_required_above: 200000000, // ₦2,000,000 cumulative funding before an identity check is required
  pass_card_fees: false,
  feed_enabled: true,
  price_hold_threshold_pct: 15,
  price_crawler_enabled: true,
  baseline_champions: 1000,
  baseline_tons: 5000,
  baseline_payouts: 5000000000, // ₦50M
  baseline_farmers: 25000,
  rank_thresholds: '1,5,20', // tons for Sprout, Harvester, Granary Keeper
  support_phone: '+234 000 000 0000',
  support_email: 'hello@combotrader.com.ng',
  support_whatsapp: '',
  maintenance_banner: '',
};
export type SettingKey = keyof typeof DEFAULTS;

let cache: Record<string, any> | null = null;

export function settings(): typeof DEFAULTS {
  if (!cache) {
    cache = { ...DEFAULTS };
    for (const r of q.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
      try { cache[r.key] = JSON.parse(r.value); } catch { cache[r.key] = r.value; }
    }
  }
  return cache as typeof DEFAULTS;
}
export function setSetting(key: SettingKey, value: unknown) {
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  cache = null;
}
export function resetSettingsCache() { cache = null; }
