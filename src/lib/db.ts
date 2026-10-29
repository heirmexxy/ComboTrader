// SQLite data layer. Money is always stored as integer kobo (₦1 = 100 kobo).
// Queries use plain, portable SQL so the store can move to PostgreSQL later.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

type Param = string | number | bigint | null | Uint8Array | boolean | undefined;

let db: DatabaseSync;
const stmts = new Map<string, StatementSync>();

function norm(p: Param[]) {
  return p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) as any[];
}
function stmt(sql: string) {
  let s = stmts.get(sql);
  if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
  return s;
}

export const q = {
  get<T = any>(sql: string, ...p: Param[]): T | undefined { return stmt(sql).get(...norm(p)) as T | undefined; },
  all<T = any>(sql: string, ...p: Param[]): T[] { return stmt(sql).all(...norm(p)) as T[]; },
  run(sql: string, ...p: Param[]) {
    const r = stmt(sql).run(...norm(p));
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  },
  val<T = any>(sql: string, ...p: Param[]): T | undefined {
    const row = stmt(sql).get(...norm(p)) as any;
    return row ? (Object.values(row)[0] as T) : undefined;
  },
  insert(table: string, data: Record<string, Param>) {
    const keys = Object.keys(data);
    return q.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => data[k]));
  },
  update(table: string, id: number, data: Record<string, Param>) {
    const keys = Object.keys(data);
    return q.run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => data[k]), id);
  },
};

let depth = 0;
/** Runs fn atomically. Nested calls use savepoints. */
export function tx<T>(fn: () => T): T {
  const sp = `sp${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE'); else db.exec(`SAVEPOINT ${sp}`);
  depth++;
  try {
    const r = fn();
    depth--;
    if (depth === 0) db.exec('COMMIT'); else db.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth--;
    if (depth === 0) db.exec('ROLLBACK'); else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export const now = () => new Date().toISOString();

const MIGRATIONS: string[] = [
`
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'NG',
  city TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  role TEXT NOT NULL DEFAULT 'champion',
  admin_roles TEXT NOT NULL DEFAULT '',
  email_verified_at TEXT,
  phone_verified_at TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  kyc_status TEXT NOT NULL DEFAULT 'none',
  kyc_method TEXT,
  kyc_note TEXT,
  id_doc_path TEXT,
  paystack_customer_code TEXT,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by INTEGER REFERENCES users(id),
  feed_opt_in INTEGER NOT NULL DEFAULT 1,
  circle_pilot INTEGER NOT NULL DEFAULT 0,
  google_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  notif_email INTEGER NOT NULL DEFAULT 1,
  notif_sms INTEGER NOT NULL DEFAULT 1,
  next_of_kin_name TEXT,
  next_of_kin_phone TEXT,
  onboarded INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  last_active_at TEXT
);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  twofa_ok INTEGER NOT NULL DEFAULT 1,
  ip TEXT, ua TEXT,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  data TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX tokens_lookup ON tokens(kind, token_hash);
CREATE TABLE login_events (
  id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT, ip TEXT, ua TEXT, success INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE bank_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  country TEXT NOT NULL DEFAULT 'NG',
  bank_code TEXT, bank_name TEXT,
  account_number TEXT NOT NULL,
  account_name TEXT,
  recipient_code TEXT,
  name_match INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  hold_until TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

-- Double-entry ledger: every journal's entries sum to zero.
CREATE TABLE ledger_accounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE journals (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT,
  memo TEXT,
  user_id INTEGER,
  created_by INTEGER,
  approved_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX journals_kind_ref ON journals(kind, ref) WHERE ref IS NOT NULL;
CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX entries_account ON entries(account_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reference TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  channel TEXT, currency TEXT NOT NULL DEFAULT 'NGN',
  demo INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT, raw TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE withdrawals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  amount INTEGER NOT NULL,
  route TEXT NOT NULL DEFAULT 'paystack',
  status TEXT NOT NULL DEFAULT 'requested',
  reference TEXT NOT NULL UNIQUE,
  transfer_code TEXT,
  approved_by INTEGER, approved_at TEXT,
  second_approver INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE commodities (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bag_kg INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE lots (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  commodity TEXT NOT NULL REFERENCES commodities(code),
  title TEXT NOT NULL,
  description TEXT,
  region TEXT,
  buyer_type TEXT NOT NULL,
  buyer_name TEXT,
  contract_ref TEXT,
  contract_path TEXT,
  tonnage REAL NOT NULL,
  farmers INTEGER NOT NULL DEFAULT 0,
  target_amount INTEGER NOT NULL,
  min_commit INTEGER NOT NULL,
  period_months INTEGER NOT NULL,
  rate_bps INTEGER NOT NULL,
  closes_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  started_at TEXT,
  matures_at TEXT,
  circles_enabled INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  circle_id INTEGER,
  slots INTEGER,
  amount INTEGER NOT NULL,
  rate_bps INTEGER NOT NULL,
  period_months INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  start_at TEXT NOT NULL,
  matures_at TEXT NOT NULL,
  earnings INTEGER,
  paid_at TEXT,
  certificate_no TEXT NOT NULL UNIQUE,
  share_token TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX trades_user ON trades(user_id);
CREATE INDEX trades_lot ON trades(lot_id);
CREATE TABLE trail_events (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  stage TEXT NOT NULL,
  note TEXT,
  photo_path TEXT,
  happened_at TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE circles (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  name TEXT NOT NULL,
  creator_id INTEGER REFERENCES users(id),
  is_private INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT NOT NULL UNIQUE,
  slots INTEGER NOT NULL,
  slot_price INTEGER NOT NULL,
  max_slots_per_user INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'filling',
  filled_at TEXT,
  nudged80 INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE circle_slots (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  slots INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at TEXT NOT NULL
);
CREATE TABLE referral_rewards (
  id INTEGER PRIMARY KEY,
  referrer_id INTEGER NOT NULL REFERENCES users(id),
  referred_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  trade_id INTEGER,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'credited',
  flagged TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, email TEXT, commodity TEXT NOT NULL,
  notified_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE price_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT, last_status TEXT
);
CREATE TABLE prices (
  id INTEGER PRIMARY KEY,
  commodity TEXT NOT NULL REFERENCES commodities(code),
  price_per_kg INTEGER NOT NULL,
  market TEXT,
  source_id INTEGER REFERENCES price_sources(id),
  source_name TEXT,
  observed_on TEXT NOT NULL,
  change_pct REAL,
  status TEXT NOT NULL DEFAULT 'published',
  reviewed_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX prices_commodity ON prices(commodity, observed_on);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, body TEXT, link TEXT,
  read_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE nudges (
  user_id INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, ref)
);
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  title TEXT NOT NULL,
  excerpt TEXT,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  author TEXT NOT NULL,
  cover_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  publish_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (slug, lang)
);
CREATE TABLE faqs (
  id INTEGER PRIMARY KEY, lang TEXT NOT NULL DEFAULT 'en', q TEXT NOT NULL, a TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE page_text (
  key TEXT NOT NULL, lang TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key, lang)
);
CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL DEFAULT 'en',
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE TABLE newsletters (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL, body TEXT NOT NULL,
  segment TEXT NOT NULL DEFAULT 'all',
  lang TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  send_at TEXT, sent_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reply TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE job_runs (name TEXT PRIMARY KEY, last_run TEXT NOT NULL, last_status TEXT);
CREATE TABLE fx_rates (currency TEXT PRIMARY KEY, per_ngn REAL NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE contact_messages (
  id INTEGER PRIMARY KEY, name TEXT, email TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0
);
`,
`
CREATE TABLE adjustments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  approved_by INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
`,
`
ALTER TABLE trades ADD COLUMN original_matures_at TEXT;
ALTER TABLE trades ADD COLUMN delay_reason TEXT;
`,
`
-- Keep Growing (rollover), gifts, account closure, WhatsApp
ALTER TABLE users ADD COLUMN rollover_default TEXT NOT NULL DEFAULT 'off';
ALTER TABLE users ADD COLUMN closed_at TEXT;
ALTER TABLE users ADD COLUMN whatsapp_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN rollover TEXT NOT NULL DEFAULT 'off';
ALTER TABLE trades ADD COLUMN rolled_to INTEGER;
ALTER TABLE trades ADD COLUMN gift_id INTEGER;
CREATE TABLE rollovers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  from_trade_id INTEGER NOT NULL UNIQUE REFERENCES trades(id),
  amount INTEGER NOT NULL,
  commodity TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  to_trade_id INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Buyer receivables and Kitovu's cash position (Kitovu pays Champions on time from its balance sheet)
ALTER TABLE lots ADD COLUMN buyer_amount INTEGER;
ALTER TABLE lots ADD COLUMN buyer_due_at TEXT;
CREATE TABLE buyer_payments (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  amount INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE cash_positions (
  id INTEGER PRIMARY KEY,
  amount INTEGER NOT NULL,
  credit_line INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  as_of TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL
);

-- Harvest Plan: monthly saving toward a Trade Lot
ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'wallet';
ALTER TABLE payments ADD COLUMN plan_id INTEGER;
CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  target_amount INTEGER NOT NULL,
  monthly_amount INTEGER NOT NULL,
  day_of_month INTEGER NOT NULL,
  commodity TEXT,
  authorization_code TEXT,
  card_label TEXT,
  status TEXT NOT NULL DEFAULT 'setup',
  next_charge_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  trade_id INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX plans_user ON plans(user_id);

-- Gift a Harvest
CREATE TABLE gifts (
  id INTEGER PRIMARY KEY,
  giver_id INTEGER NOT NULL REFERENCES users(id),
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  recipient_name TEXT NOT NULL,
  recipient_email TEXT,
  recipient_phone TEXT,
  message TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'sent',
  recipient_id INTEGER REFERENCES users(id),
  claimed_at TEXT,
  created_at TEXT NOT NULL
);

-- AI agents: every run is logged; every action is a proposal until approved (or auto-run if low risk and allowed)
CREATE TABLE agent_runs (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  trigger TEXT,
  input TEXT,
  output TEXT,
  model TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL
);
CREATE TABLE agent_actions (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL,
  summary TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  target_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed',
  decided_by INTEGER,
  decided_at TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_actions_status ON agent_actions(status);

-- WhatsApp conversations (inbound messages and our replies)
CREATE TABLE wa_messages (
  id INTEGER PRIMARY KEY,
  wa_id TEXT,
  phone TEXT NOT NULL,
  user_id INTEGER,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX wa_messages_waid ON wa_messages(wa_id) WHERE wa_id IS NOT NULL;
`,
`
-- Champions choose how long they stay; the rate follows the period (Settings → rates). A lot lists the periods it offers.
ALTER TABLE lots ADD COLUMN periods TEXT NOT NULL DEFAULT '4,6,9,12';
UPDATE lots SET period_months = 12 WHERE status IN ('draft','open');
`,
];

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  stmts.clear();
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const v = Number((db.prepare('PRAGMA user_version').get() as any).user_version);
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
  return db;
}

export function rawDb() { return db; }
