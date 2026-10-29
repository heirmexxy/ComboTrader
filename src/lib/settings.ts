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
  figures_mode: 'add' as 'add' | 'exact', // add: number typed + live platform activity; exact: show exactly the number typed
  rank_thresholds: '1,5,20', // tons for Sprout, Harvester, Granary Keeper
  support_phone: '+234 000 000 0000',
  support_email: 'hello@combotrader.com.ng',
  support_whatsapp: '',
  maintenance_banner: '',
  // Earnings rate by how long a Champion stays (% per annum). The longer you stay, the more you earn.
  rate_4: 20,
  rate_6: 22.5,
  rate_9: 26.25,
  rate_12: 30,
  min_commit_default: 25000000, // ₦250,000 — default minimum for new lots
  // Payouts and treasury (Kitovu pays Champions on time from its own balance sheet)
  auto_payouts: true, // credit matured trades automatically on the payout date
  coverage_warn_ratio: 1.2, // warn when (cash + credit line + buyer money due) / payouts due falls below this
  // Harvest Plan and gifts
  plans_enabled: true,
  plan_min_monthly: 2000000, // ₦20,000
  plan_max_failures: 3,
  gifts_enabled: true,
  // WhatsApp companion
  whatsapp_enabled: true,
  // AI agents
  agents_enabled: 'support,onboarding,treasury,risk,growth,ops,prospector,social,email',
  social_posts_per_week: 3, // the Social agent plans this many posts a week (Mon, Wed, Fri…)
  social_post_hour: 10, // Lagos time
  social_channels: 'facebook,instagram,linkedin,x,telegram', // where posts go (connected channels publish; others become copy-ready)
  social_auto_reply: true, // answer comments/DMs that ask how to join, with the /join link
  social_click_goal: 10, // a post "worked" if it gets this many clicks (or one sign-up) in a week
  email_campaigns: 'welcome,maturity,paid_out,winback,new_lot', // lifecycle emails the Email agent may send
  newsletter_ab: true, // test two subject lines on every newsletter
  agent_mode: 'ai' as 'ai' | 'rules', // ai: use Claude when ANTHROPIC_API_KEY is set; rules: learned rules and templates only
  agent_modes: '{}', // per-agent override, e.g. {"growth":"rules"}
  prospect_segments: 'Staff cooperative societies,Church and mosque groups,Diaspora associations,Alumni associations,Investment clubs,Professional associations,Market and trade associations',
  prospect_regions: 'Lagos,Abuja,Port Harcourt,Ibadan,Enugu,Kano,UK Nigerian diaspora,US Nigerian diaspora',
  prospect_daily_limit: 15, // most outreach drafts the prospector prepares per day
  agent_autonomy: 'review' as 'review' | 'auto_low', // auto_low: low-risk messages send without a human click
  agent_daily_limit: 300, // max model calls per day across all agents
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
