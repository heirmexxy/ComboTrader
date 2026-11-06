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
  linkedin_auth: '',
  meta_auth: '', // set by Admin → Marketing → Connect Facebook & Instagram (Page, Page token, Instagram account) // set by Admin → Marketing → Connect LinkedIn (token, page)
  library_blog: true, // propose the next library article every week (Growth agent)
  library_newsletter: true, // propose the next library newsletter every two weeks (Email agent)
  library_newsletter_next: 1,
  library_newsletter_at: '',
  sequences_enabled: true, // send email sequences to opted-in contacts
  sequence_daily_cap: 2000, // most marketing emails per day once warmed up (sequences, newsletters, campaigns, outreach)
  email_warmup_start: '', // when the email warm-up started (see email_warmup_steps)
  email_warmup_steps: '300,600,1000,2000', // marketing emails per sending day during warm-up (weekdays), then the last number
  email_gap_seconds: 150, // time between marketing emails (at most; a bigger day is spread evenly from 9:00 to 19:00 Lagos time, Monday to Friday)
  marketing_paused_until: '', // set automatically if too many marketing emails fail
  worker_heartbeat: '', // set every 30 seconds by the background worker
  ai_provider: 'anthropic', // which AI the agents use: anthropic (Claude) | openai (or the OpenAI-compatible service in OPENAI_BASE_URL)
  ai_fallback: true, // if the chosen provider fails (no credit, outage), try the other one
  ai_credit_usd: 0, // Claude credit balance (USD) as shown in the Claude Console when last recorded
  ai_credit_at: '', // when it was recorded
  ai_credit_low_days: 7, // warn when credit will run out within this many days
  email_slowdown_until: '', // set by the Chief of Staff when delivery drops: marketing goes at half pace
  email_slow_groups: '{}', // providers (gmail, yahoo…) that are delaying our mail, with when the slow-down ends
  social_paused_until: '', // Chief of Staff: pause promoting new lots (e.g. when Treasury is short)
  social_boost: '', // Chief of Staff: {"topic":"how","until":"…"} favour a topic that is working
  chief_start_at: '', // day 1 of the 90-day plan (set on the first Chief of Staff run)
  chief_assign: true, // Chief of Staff may assign tasks to agents directly (their outputs still follow your approval rules)
  contact_cap_week: 2, // most marketing emails a Champion gets in 7 days, across all agents
  assistant_enabled: true, // the 'Ask ComboTrader' chat on the website (Support agent; humans take over in Tawk.to)
  paystack_low_balance: 10000000, // kobo: ₦100,000 — alert when the Paystack balance falls below this (or below withdrawals waiting)
  feed_enabled: true,
  price_hold_threshold_pct: 15,
  price_crawler_enabled: true,
  baseline_champions: 1000,
  baseline_tons: 5000,
  baseline_payouts: 5000000000, // ₦50M
  baseline_farmers: 25000,
  watchdog_state: '{}', // internal: problems the watchdog has already emailed about
  test_mode: false,
  marketplace_mode: 'off' as 'off' | 'on', // Champions selling trades to each other before term (test mode turns it on for testing)
  market_unit: 25000000, // kobo: ₦250,000 — smallest piece of a trade that can be sold
  market_fee_bps: 100, // 1% of the sale price, paid by the seller
  market_max_discount_pct: 5, // sellers may price up to this much below value to date
  market_min_hold_days: 30, // days a trade must be held before it can be listed
  market_cutoff_days: 14, // no listing (or buying) in the last days before the payout date // simulated payments + sample lots on a real server, only while no live Paystack key is set
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
  agents_enabled: 'chief,support,onboarding,treasury,risk,growth,ops,prospector,social,email',
  social_posts_per_week: 3, // the Social agent plans this many posts a week (Mon, Wed, Fri…)
  social_post_hour: 10, // Lagos time
  social_channels: 'facebook,instagram,linkedin,x,telegram', // where posts go (connected channels publish; others become copy-ready)
  social_auto_reply: true, // answer comments/DMs that ask how to join, with the /join link
  social_click_goal: 10, // a post "worked" if it gets this many clicks (or one sign-up) in a week
  email_campaigns: 'welcome,maturity,paid_out,winback,new_lot,market,verify_reminder,fund_reminder,lot_closing', // lifecycle emails the Email agent may send
  newsletter_ab: true, // test two subject lines on every newsletter
  agent_mode: 'ai' as 'ai' | 'rules', // ai: use Claude when ANTHROPIC_API_KEY is set; rules: learned rules and templates only
  agent_modes: '{}', // per-agent override, e.g. {"growth":"rules"}
  prospect_segments: 'Staff cooperative societies,Professional associations (state branches),University alumni associations,Church and mosque welfare or cooperative arms,Thrift and credit societies,Nigerian diaspora professional associations', // from the playbook
  prospect_regions: 'Lagos,Abuja,Ibadan,Port Harcourt,Enugu,Benin City,Abeokuta,Ilorin,London,Houston,Toronto',
  prospect_daily_limit: 15, // most outreach drafts the prospector prepares per day
  agent_autonomy: 'review' as 'review' | 'auto_low', // auto_low: low-risk messages send without a human click
  agent_daily_limit: 300, // max model calls per day across all agents
};
export type SettingKey = keyof typeof DEFAULTS;

let cache: Record<string, any> | null = null, cachedAt = 0;

/** Settings are re-read every 2 seconds, so a change made in the website reaches the background worker (a separate
 * process) almost at once. */
export function settings(): typeof DEFAULTS {
  if (!cache || Date.now() - cachedAt > 2000) {
    cachedAt = Date.now();
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
