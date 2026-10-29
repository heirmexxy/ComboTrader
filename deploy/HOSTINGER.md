# Putting ComboTrader live on a Hostinger VPS

About 45 minutes of work, plus waiting time for DNS to update. You need: your Hostinger login, your GitHub login, and a computer with a terminal (on Windows, use PowerShell; on a Mac, use Terminal).

## Step 1 — Buy the VPS
1. In Hostinger, go to **VPS → KVM 2** (2 vCPU, 8 GB RAM, 100 GB disk). KVM 1 works for launch; KVM 2 gives headroom for the agents and image processing.
2. **Location:** pick a European data centre (United Kingdom, France, Germany, the Netherlands or Lithuania). These are usually the fastest from Nigeria.
3. **Operating system:** choose **Plain OS → Ubuntu 24.04 LTS** (not a control-panel template).
4. Set a strong **root password** and save it in your password manager.
5. When it is ready, open **VPS → Overview** and copy the **IPv4 address**. You will use it below; we call it `YOUR_IP`.

## Step 2 — Run the setup script (one time)
1. Open a terminal on your computer and connect: `ssh root@YOUR_IP` (type `yes`, then the root password). Hostinger also has a **Browser terminal** button on the VPS page if you prefer.
2. Paste these two lines:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/heirmexxy/ComboTrader/main/deploy/setup.sh -o setup.sh
   bash setup.sh
   ```
   If the GitHub repository is private, the download in the first line will fail. In that case, open `deploy/setup.sh` on GitHub, click **Raw**, copy everything, run `nano setup.sh` on the server, paste, save (Ctrl+O, Enter, Ctrl+X), then `bash setup.sh`.
3. The script pauses once and shows a key starting with `ssh-ed25519`. Copy that whole line, then in GitHub open **heirmexxy/ComboTrader → Settings → Deploy keys → Add deploy key**, give it the title `Hostinger VPS`, paste, leave "Allow write access" **unticked**, and save. Go back to the terminal and press **Enter**.
4. The script installs everything (Node.js, the Caddy web server with free HTTPS, firewall, automatic security updates, nightly database backups) and starts ComboTrader. It ends by printing your IP, next steps, and a **private key** for automatic deploys. Leave the window open; you need that key in Step 5.

## Step 3 — Point combotrader.com.ng at the VPS
1. In Hostinger **hPanel → Domains → combotrader.com.ng → DNS / Nameservers → DNS records**.
2. **Delete** any existing **A**, **AAAA** or **CNAME** records whose name is `@` or `www` (these point at the old site).
   **Do not delete MX or TXT records** — they carry your email.
3. **Add** two A records, TTL default:
   | Type | Name | Points to |
   |---|---|---|
   | A | @ | YOUR_IP |
   | A | www | YOUR_IP |
4. Wait. Usually 5–30 minutes, occasionally up to 24 hours. When `https://www.combotrader.com.ng` shows the new site with a padlock, HTTPS is working (Caddy gets the certificate by itself).

> Switching DNS takes the old site offline. Export the old site's user list first (you will import it in Step 7).

## Step 4 — Create your admin account
1. On the live site, **Become a Harvest Champion** with your Kitovu email and finish phone and email verification.
2. On the server: `sudo -u combotrader bash -c "cd /srv/combotrader && npm run make-admin -- e.nwachinemere@kitovu.com.ng super"`
3. Sign in again. Admins must turn on two-step verification (Security page) before the admin area opens.
4. Add colleagues the same way, with the roles they need: `finance`, `operations`, `support`, `content` (comma-separated).

## Step 5 — Turn on automatic deploys
In GitHub, **heirmexxy/ComboTrader → Settings → Secrets and variables → Actions → New repository secret**:
- `VPS_HOST` = YOUR_IP
- `VPS_SSH_KEY` = the private key printed at the end of setup, from `-----BEGIN OPENSSH PRIVATE KEY-----` to `-----END OPENSSH PRIVATE KEY-----`, inclusive.

From now on every push to `main` runs the tests, then updates the server, checks `/healthz`, and rolls back by itself if the new version does not start. That key can only run the update script; it cannot open a shell. To print it again later: `sudo cat /home/combotrader/.ssh/github_actions`.

## Step 6 — Add live keys (whenever you are ready)
On the server: `sudo nano /srv/combotrader/.env`, fill in the values, save, then `sudo systemctl restart combotrader`. Until Paystack keys are in, payments are switched off on the live site.

| What | Where to get it | Lines in `.env` |
|---|---|---|
| Paystack (required to take money) | Paystack dashboard → Settings → API Keys & Webhooks. Set the webhook URL to `https://www.combotrader.com.ng/webhooks/paystack`. For automatic withdrawals enable Transfers and turn off the transfer OTP. | `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` |
| Email | resend.com (or Brevo): verify the combotrader.com.ng domain by adding the DNS records they give you in hPanel | `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` |
| SMS | termii.com: register the sender ID `ComboTrader` (takes a few days) | `TERMII_API_KEY`, `TERMII_SENDER_ID` |
| Live chat | tawk.to → Administration → Chat Widget → Direct chat link | `TAWK_PROPERTY_ID`, `TAWK_WIDGET_ID` |
| AI agents | console.anthropic.com → API keys (set a monthly spend limit there) | `ANTHROPIC_API_KEY` |
| WhatsApp | Meta Business → WhatsApp → API setup. Webhook URL `https://www.combotrader.com.ng/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN` from `.env`, subscribe to **messages** | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_NUMBER` |
| Push alerts | On the server: `cd /srv/combotrader && node dist/cli.mjs vapid` | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` |
| Google sign-in (optional) | console.cloud.google.com → Credentials → OAuth client, redirect `https://www.combotrader.com.ng/auth/google/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

Admin → Settings → Integrations shows which ones are connected.

## Step 7 — Bring existing users across
Admin → Champions → **Import users (CSV)**. Columns: `first_name, last_name, email, phone, country, city, opening_balance`. Each person gets an email to set a password. Opening balances wait for a second admin's approval in **Wallets & ledger**, so every naira has a record.

## Step 8 — Before you announce
- [ ] Lawyer has reviewed Terms, Privacy, Risk and Cookie pages (Admin → FAQs & page text → Legal pages) and the balance-sheet payout promise.
- [ ] Treasury: record Kitovu's cash position and credit line (Admin → Treasury), and add buyer contract value and due date on every lot.
- [ ] One real ₦1,000 card payment, a test payout, and a withdrawal to your own bank account.
- [ ] Uptime monitor: create a free monitor at uptimerobot.com for `https://www.combotrader.com.ng/healthz`, alerting your phone.
- [ ] Off-server backups: copy `/srv/combotrader/data/backups` and `/srv/combotrader/data/uploads` somewhere else at least weekly (e.g. `rclone` to Google Drive).
- [ ] AI agents: leave autonomy on **Review everything** for the first month (Admin → Settings → AI agents).

## Everyday commands (on the server)
| Task | Command |
|---|---|
| Is it running? | `sudo systemctl status combotrader` |
| Live logs | `sudo journalctl -u combotrader -f` |
| Restart after editing `.env` | `sudo systemctl restart combotrader` |
| Update by hand | `sudo -u combotrader /srv/combotrader/deploy/update.sh` |
| Backup now | `sudo -u combotrader bash -c "cd /srv/combotrader && npm run backup"` |
| Restore a backup | `sudo systemctl stop combotrader && cd /srv/combotrader/data && sudo -u combotrader rm -f combotrader.db-wal combotrader.db-shm && sudo -u combotrader cp backups/ct-DATE.db combotrader.db && sudo systemctl start combotrader` |

Hostinger also takes weekly VPS snapshots on most plans (VPS → Snapshots & backups); take a manual snapshot before any big change.
