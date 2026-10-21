# ComboTrader 2.0

The Harvest Champions platform by Kitovu Technology Company Limited. Champions back real commodity trades that already have a signed buyer, follow each trade on its Harvest Trail, and are paid principal plus earnings into their wallet.

- **Stack:** Node.js 22 (no framework), server-rendered React views, SQLite (WAL), a small progressive-enhancement script.
- **Runtime packages:** `react`, `react-dom`, `react-icons`, `marked`, `pdf-lib`, `sharp`. Build tool: `esbuild`.
- **Languages:** English, French, Swahili, Portuguese and Arabic (right-to-left).
- **Tests:** `npm test` runs 34 automated checks covering the ledger, payouts, withdrawals, Harvest Circles, referrals, two-step codes, push encryption, price parsers and translations.

---

## 1. Run it locally (10 minutes)

```bash
npm install
npm run build
npm run seed            # demo data: an admin, a Champion, 4 lots, prices, blog posts
npm start               # http://localhost:3000
```

Demo logins (local only):

| Role | Email | Password |
| --- | --- | --- |
| Admin | admin@combotrader.local | Harvest2026! |
| Champion | ada@example.com | Harvest2026! |

Without a Paystack key the site runs in **demo mode**. Payments go to a clearly labelled simulated checkout, and phone codes and email links are shown on screen. Demo mode is switched off automatically in production unless `DEMO_MODE=true`.

---

## 2. Go live

### 2.1 Server
Any Linux VPS with Node 22.13+ works: DigitalOcean, Hetzner, AWS Lightsail, or a Nigerian host. Use 1 vCPU and 1–2 GB RAM to start. The database is a single file in `data/`, so the server must have a **persistent disk**.

```bash
git clone <your repo> combotrader && cd combotrader
cp .env.example .env    # fill in every value
npm install && npm run build
npm run make-admin -- you@kitovu.com.ng super   # after signing up on the site with that email
```

Run it as a service (systemd example):

```ini
# /etc/systemd/system/combotrader.service
[Unit]
Description=ComboTrader
After=network.target
[Service]
WorkingDirectory=/srv/combotrader
EnvironmentFile=/srv/combotrader/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/server.mjs
Restart=always
User=combotrader
[Install]
WantedBy=multi-user.target
```

Put Caddy or Nginx in front for HTTPS (Caddy: `www.combotrader.com.ng { reverse_proxy localhost:3000 }`).

Docker alternative: `docker build -t combotrader . && docker run -d -p 3000:3000 --env-file .env -v /srv/combotrader-data:/app/data combotrader`

### 2.2 Paystack
1. Set `PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY` (test keys first, then live keys).
2. In the Paystack dashboard, set the webhook URL to `https://www.combotrader.com.ng/webhooks/paystack`.
3. For automatic withdrawals, enable **Transfers** on the Paystack account and turn off the transfer OTP (Settings → Preferences). Otherwise approvals will wait for an OTP.
4. Identity checks use Paystack customer validation (BVN plus bank account). Results arrive by webhook.

### 2.3 Messages
- **Email:** set `EMAIL_PROVIDER` (`resend` or `brevo`), `EMAIL_API_KEY` and a verified `EMAIL_FROM` domain.
- **SMS / WhatsApp:** set `TERMII_API_KEY` and a registered sender ID.
- Until providers are set, outgoing messages are kept in Admin → Messages & tickets.

### 2.4 Live chat, Google sign-in, push alerts
- **tawk.to:** copy the property and widget IDs from your tawk.to direct chat link (`https://tawk.to/chat/<PROPERTY>/<WIDGET>`). Add `TAWK_API_KEY` to verify logged-in Champions in chat.
- **Google:** create an OAuth client with redirect URI `https://www.combotrader.com.ng/auth/google/callback`.
- **Push:** run `node dist/cli.mjs vapid` once and paste the two keys into `.env`.

### 2.5 Backups (do this on day one)
```bash
# crontab -e   — nightly consistent copy, keep 30 days
15 2 * * * cd /srv/combotrader && npm run backup -- data/backups/ct-$(date +\%F).db && find data/backups -mtime +30 -delete
```
Copy `data/backups` and `data/uploads` off the server as well (S3, Backblaze or Google Drive).

### 2.6 Scheduled work
With `RUN_SCHEDULER=true` (the default), the server runs these jobs itself:

| Job | When (Lagos) | What it does |
| --- | --- | --- |
| outbox | every minute | sends queued email, SMS and WhatsApp |
| publish | every minute | publishes scheduled blog posts and newsletters |
| lifecycle | every 10 min | closes expired lots, marks matured trades, releases expired circles, auto-sends small withdrawals |
| prices | 06:00 daily | runs the crawler (skipped when the crawler is off) |
| nudges | 09:00 daily | automatic reminders (no deposit, no trade, payout in 7 days, inactive 60 days) |
| reconcile | 02:00 daily | checks the ledger balances and matches payments against Paystack |
| weekly | Monday 08:00 | summary email to super and finance admins |

You can also run any job by hand: `npm run job -- prices`, or `POST /api/cron/<job>` with `Authorization: Bearer $CRON_SECRET`.

### 2.7 Kitovu eProcure prices (optional)
```
POST /api/prices/ingest
Authorization: Bearer <CRON_SECRET>
{"prices":[{"commodity":"maize","price_per_kg":690,"market":"Iseyin","date":"2026-10-21"}]}
```

---

## 3. Before launch checklist
- [ ] Draft Terms, Privacy, Risk and Cookie notices reviewed by Kitovu's lawyer, and the [bracketed] items filled in (Admin → FAQs & page text → Legal pages). Drafts follow the NDPA 2023, the NDPC GAID and the FCCPA 2018.
- [ ] Late-payment policy in the FAQs confirmed: notice at least 7 days ahead, up to 30 days' delay, earnings continue for the extra days (Admin → Trade Lots → lot → "Buyer paying late?").
- [ ] French, Swahili, Portuguese and Arabic money and legal wording reviewed by native speakers (Admin → FAQs & page text lets you fix any line without a developer).
- [ ] Exchange rates set (Admin → Settings) for Champions outside Nigeria.
- [ ] Public baselines confirmed (Admin → Settings → Public figures): 1,000 Champions, 5,000 t, ₦50M payouts, 25,000 farmers.
- [ ] Support phone, WhatsApp and email set (Admin → Settings).
- [ ] Harvest Circles mode chosen (Admin → Settings → Features). The default is invite-only pilot.
- [ ] Every admin has two-step verification on (enforced when `ADMIN_REQUIRE_2FA=true`).
- [ ] A test payment, payout and withdrawal run end to end with Paystack **test** keys.
- [ ] Existing users migrated or invited (see section 5).

---

## 4. How the money works

All amounts are stored as integer kobo in a **double-entry ledger** (`ledger_accounts`, `journals`, `entries`). Balances are never edited; each one is the sum of its entries, and every journal sums to zero.

| Event | Money moves |
| --- | --- |
| Fund wallet (Paystack confirmed) | external → wallet |
| Join a lot | wallet → lot |
| Take circle slots | wallet → reserved |
| Circle fills | reserved → lot (all members, same moment) |
| Circle expires or slots released | reserved → wallet |
| Payout (admin credits a matured trade) | lot → wallet (principal) + Kitovu earnings → wallet |
| Withdrawal requested | wallet → reserved |
| Withdrawal paid / failed | reserved → external / reserved → wallet |
| Referral reward | Kitovu referrals → wallet |
| Manual adjustment (two admins) | Kitovu adjustments → wallet |

Safeguards:
- Payments are always re-verified with Paystack, and the webhook signature is checked.
- Every posting is idempotent by reference, so a repeated webhook can't double-credit.
- Champion accounts can never go negative.
- Withdrawals go only to a bank account whose resolved name matches the Champion. A changed bank account is held for 24 hours.
- Withdrawals above the threshold need two different admins.
- Every admin action is written to the audit log.

---

## 5. Moving existing users across
The current site's database wasn't available. Two options:
1. **Invite (simplest):** export names and emails from the old site, then send them a newsletter issue (Admin → Newsletter) linking to `/signup`.
2. **Migrate balances:** import users with a script into `users`, then credit each opening balance as an approved manual adjustment, so the ledger records where every naira came from. A developer can do this in about an hour once the export is in hand.

---

## 6. Project layout
```
src/server.ts            HTTP server, security headers, routing, guards
src/lib/                 db, ledger, wallet, trading, circles, prices (crawler), jobs, auth, i18n, paystack, notify, webpush, cards
src/routes/              public, auth, pay (webhooks, cards, machine endpoints), app (Champion), admin
src/views/               server-rendered pages (public, Champion app, admin)
src/locales/             en, fr, sw, pt, ar
src/client/main.ts       ticker, live feed, calculator, install prompt, push, tawk.to
public/                  styles.css, sw.js (installable app + offline), manifest, icons
tests/run.ts             automated checks (npm test)
```
