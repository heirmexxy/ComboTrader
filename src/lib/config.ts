// All configuration comes from environment variables (see .env.example).
import fs from 'node:fs';

// Minimal .env loader (no dependency).
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
}

const e = process.env;
const production = e.NODE_ENV === 'production';

export const config = {
  production,
  port: Number(e.PORT || 3000),
  /** 127.0.0.1 behind a reverse proxy (recommended on a shared server); 0.0.0.0 to listen on every interface. */
  bindHost: e.HOST_BIND || '0.0.0.0',
  baseUrl: (e.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  secret: e.APP_SECRET || (production ? '' : 'dev-secret-change-me'),
  dbFile: e.DATABASE_FILE || 'data/combotrader.db',
  uploadsDir: e.UPLOADS_DIR || 'data/uploads',

  paystackSecret: e.PAYSTACK_SECRET_KEY || '',
  paystackPublic: e.PAYSTACK_PUBLIC_KEY || '',
  get paystackDemo() { return !this.paystackSecret; },

  emailProvider: (e.EMAIL_PROVIDER || '').toLowerCase(), // 'resend' | 'brevo' | ''
  emailApiKey: e.EMAIL_API_KEY || '',
  emailFrom: e.EMAIL_FROM || 'ComboTrader <hello@combotrader.com.ng>',
  termiiKey: e.TERMII_API_KEY || '',
  termiiSender: e.TERMII_SENDER_ID || 'ComboTrader',

  googleClientId: e.GOOGLE_CLIENT_ID || '',
  googleClientSecret: e.GOOGLE_CLIENT_SECRET || '',

  tawkPropertyId: e.TAWK_PROPERTY_ID || '',
  tawkWidgetId: e.TAWK_WIDGET_ID || 'default',
  tawkApiKey: e.TAWK_API_KEY || '',

  vapidPublic: e.VAPID_PUBLIC_KEY || '',
  vapidPrivate: e.VAPID_PRIVATE_KEY || '',
  vapidSubject: e.VAPID_SUBJECT || 'mailto:hello@combotrader.com.ng',

  // AI agents (Claude API)
  anthropicKey: e.ANTHROPIC_API_KEY || '',
  aiModel: e.AI_MODEL || 'claude-sonnet-5-5',
  aiModelFast: e.AI_MODEL_FAST || 'claude-haiku-5-5',

  // WhatsApp Cloud API (Meta)
  waToken: e.WHATSAPP_TOKEN || '',
  waPhoneId: e.WHATSAPP_PHONE_NUMBER_ID || '',
  waVerifyToken: e.WHATSAPP_VERIFY_TOKEN || '',
  waAppSecret: e.WHATSAPP_APP_SECRET || '',
  waNumber: e.WHATSAPP_NUMBER || '', // public number shown to Champions, e.g. 2348012345678

  // Social channels (each one is optional; without it, posts for that channel are prepared for copy-and-post)
  fbPageId: e.FACEBOOK_PAGE_ID || '',
  fbPageToken: e.FACEBOOK_PAGE_TOKEN || '', // long-lived Page access token (also used for Instagram, Messenger and Lead Ads)
  igUserId: e.INSTAGRAM_BUSINESS_ID || '',
  metaAppSecret: e.META_APP_SECRET || e.WHATSAPP_APP_SECRET || '',
  metaVerifyToken: e.META_VERIFY_TOKEN || e.WHATSAPP_VERIFY_TOKEN || '',
  linkedinToken: e.LINKEDIN_TOKEN || '',
  linkedinOrg: e.LINKEDIN_ORG_URN || '', // e.g. urn:li:organization:12345678
  linkedinVersion: e.LINKEDIN_VERSION || '202509',
  xApiKey: e.X_API_KEY || '', xApiSecret: e.X_API_SECRET || '', xAccessToken: e.X_ACCESS_TOKEN || '', xAccessSecret: e.X_ACCESS_SECRET || '',
  telegramBotToken: e.TELEGRAM_BOT_TOKEN || '', telegramChannel: e.TELEGRAM_CHANNEL || '', // e.g. @combotrader

  /** Demo helpers (codes shown on screen, simulated checkout) are never shown in production unless DEMO_MODE=true. */
  demoMode: !production || e.DEMO_MODE === 'true',
  cronSecret: e.CRON_SECRET || '',
  adminRequire2fa: e.ADMIN_REQUIRE_2FA ? e.ADMIN_REQUIRE_2FA === 'true' : production,
  runScheduler: e.RUN_SCHEDULER !== 'false',

  social: {
    x: e.SOCIAL_X || 'https://x.com/KitovuT',
    facebook: e.SOCIAL_FACEBOOK || 'https://www.facebook.com/KitovuT',
    linkedin: e.SOCIAL_LINKEDIN || 'https://www.linkedin.com/company/kitovu',
    instagram: e.SOCIAL_INSTAGRAM || 'https://www.instagram.com/combotrader',
  },
};

if (production && !config.secret) {
  throw new Error('APP_SECRET must be set in production');
}
