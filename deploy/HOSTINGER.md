# Putting ComboTrader on your existing Hostinger VPS (shared with other platforms)

The setup script is built for a server that already runs other sites. It looks first and changes nothing until you type YES. It never upgrades packages, changes the firewall, replaces your Node.js, restarts your web server (it only reloads it after a successful config test), or edits another site's configuration. ComboTrader runs as its own Linux user in `/srv/combotrader`, on an internal port, capped at 1.5 GB of memory with low CPU priority.

The safe path: **snapshot → look → install on beta.combotrader.com.ng → check your other platforms → move www when you're ready.**

## Step 1 — Take a snapshot (2 minutes)
hPanel → **VPS → Snapshots & backups → Create snapshot**. If anything goes wrong, you can restore the whole server to this moment.

## Step 2 — Look before touching anything (5 minutes)
1. Connect: `ssh root@YOUR_VPS_IP` (or the **Browser terminal** button in hPanel).
2. Download the script and run it in look-only mode:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/heirmexxy/ComboTrader/main/deploy/setup.sh -o setup.sh
   bash setup.sh --check
   ```
   (Private repository? Open `deploy/setup.sh` on GitHub → **Raw**, copy, `nano setup.sh` on the server, paste, Ctrl+O, Enter, Ctrl+X.)
3. Read the report. It shows free memory and disk, what owns ports 80/443 (nginx, Apache, Caddy, a Docker proxy or a control panel), your Node.js version, the firewall, and exactly what it would do. **Nothing is changed.** If anything in it looks surprising, send it to me before going on.

What it does for each kind of server:

| Your server has | What the script does |
|---|---|
| nginx | Adds one new file for ComboTrader, runs `nginx -t`; if the test fails it deletes the file and stops. Then reloads nginx. HTTPS with certbot for ComboTrader's address only. |
| Apache | Adds one new site, runs `apachectl configtest`; removes it again if the test fails. Then reloads Apache. |
| Caddy | Backs up the Caddyfile, adds a block between `# BEGIN combotrader` and `# END combotrader`, validates; restores the backup if invalid. |
| A control panel (CloudPanel, aaPanel, CyberPanel, Coolify, Dokploy, Easypanel…) or a Docker proxy (Traefik, Nginx Proxy Manager) | Does **not** touch the web server. It prints the one reverse-proxy entry you add in your panel. |
| Nothing on ports 80/443 | Installs Caddy for ComboTrader. |

If ComboTrader's address is already used by another site on the server, the script stops.

## Step 3 — Install on a test address first (20 minutes)
Using `beta.combotrader.com.ng` first means your old site and your other platforms keep running exactly as they are.

1. **DNS:** hPanel → Domains → combotrader.com.ng → DNS / Nameservers → DNS records → **Add record**: type **A**, name **beta**, points to **YOUR_VPS_IP**. Don't change anything else.
2. **Install:**
   ```bash
   HOST=beta.combotrader.com.ng bash setup.sh
   ```
   Type `YES` when asked. It pauses once to show a key starting with `ssh-ed25519`: add it in GitHub → heirmexxy/ComboTrader → Settings → **Deploy keys** → Add deploy key (title "Hostinger VPS", write access **off**), then press Enter.
3. **HTTPS:**
   - nginx or Apache: once `beta.combotrader.com.ng` opens (http), run `bash /srv/combotrader/deploy/setup.sh --https`.
   - Caddy: automatic.
   - Panel or Docker proxy: add the reverse proxy the script printed (`beta.combotrader.com.ng → http://ADDRESS:PORT`) and switch on Let's Encrypt in the panel.
4. Keep the private key printed at the end (for Step 6).

## Step 4 — Check your other platforms (5 minutes)
- Open each of your other sites and apps in a browser.
- On the server: `systemctl --failed` (should list nothing new) and `free -m` (memory still comfortable).
- ComboTrader itself: `systemctl status combotrader` and https://beta.combotrader.com.ng/healthz shows `"ok":true`.

If anything else misbehaves: `bash /srv/combotrader/deploy/uninstall.sh` removes ComboTrader's web-server entry and stops it (data is kept), or restore the snapshot from Step 1.

## Step 5 — Admin account and keys
1. On https://beta.combotrader.com.ng, sign up with your Kitovu email and verify phone and email.
2. Make yourself admin:
   ```bash
   sudo -u combotrader bash -c 'PATH=/opt/combotrader-node/bin:$PATH; cd /srv/combotrader && npm run make-admin -- e.nwachinemere@kitovu.com.ng super'
   ```
   Sign in again and turn on two-step verification (Security page).
3. Keys: `sudo nano /srv/combotrader/.env`, fill in (table below), save, `sudo systemctl restart combotrader`. Payments stay off until Paystack keys are in.

| What | Where to get it | Lines in `.env` |
|---|---|---|
| Paystack (required to take money) | Dashboard → Settings → API Keys & Webhooks. Webhook URL: `https://<your address>/webhooks/paystack`. Enable Transfers, turn off transfer OTP. | `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` |
| Email | resend.com or Brevo: verify combotrader.com.ng by adding their DNS records in hPanel | `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` |
| SMS | termii.com: register sender ID ComboTrader (takes days — start now) | `TERMII_API_KEY`, `TERMII_SENDER_ID` |
| Live chat | tawk.to → Administration → Chat Widget → Direct chat link | `TAWK_PROPERTY_ID`, `TAWK_WIDGET_ID` |
| AI agents | console.anthropic.com → API keys (set a monthly spend limit) | `ANTHROPIC_API_KEY` |
| WhatsApp | Meta Business → WhatsApp → API setup. Webhook `https://<your address>/webhooks/whatsapp`, verify token from `.env`, subscribe to messages | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_NUMBER` |
| Push alerts | `sudo -u combotrader bash -c 'cd /srv/combotrader && /opt/combotrader-node/bin/node dist/cli.mjs vapid'` (use `node` if setup reused your system Node.js) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` |

## Step 6 — Automatic deploys
GitHub → heirmexxy/ComboTrader → Settings → Secrets and variables → Actions → New repository secret:
- `VPS_HOST` = YOUR_VPS_IP
- `VPS_SSH_KEY` = the private key from the end of setup (all lines). To print it again: `sudo cat /home/combotrader/.ssh/github_actions`

Every push to `main` is tested, deployed, health-checked and rolled back automatically if it fails. The key can only run ComboTrader's update; it cannot open a shell or reach your other platforms.

## Step 7 — Move to www.combotrader.com.ng (when you're ready)
1. Export the old site's user list first; this switch takes the old site offline.
2. On the server:
   ```bash
   bash /srv/combotrader/deploy/setup.sh            # serves www.combotrader.com.ng and redirects combotrader.com.ng
   ```
   This replaces ComboTrader's own web-server entry (beta → www) and updates its address; other sites are untouched.
3. DNS in hPanel: delete the A, AAAA and CNAME records named `@` and `www`, then add A `@` → YOUR_VPS_IP and A `www` → YOUR_VPS_IP. **Keep MX and TXT records (your email).** You can delete the `beta` record.
4. HTTPS: nginx/Apache → `bash /srv/combotrader/deploy/setup.sh --https`; Caddy → automatic; panel → add www and the bare domain to the proxy entry.
5. Update the Paystack and WhatsApp webhook URLs to `https://www.combotrader.com.ng/...`.
6. Import existing users: Admin → Champions → Import users (CSV).

## Before you announce
- [ ] Securities lawyer has reviewed the payout model and the Terms, Privacy, Risk and Cookie pages.
- [ ] Treasury: cash position, credit line, buyer contract value and due date on every lot.
- [ ] One real ₦1,000 payment, one payout, one withdrawal to your own bank.
- [ ] Uptime monitor (uptimerobot.com) on `https://www.combotrader.com.ng/healthz`.
- [ ] Weekly copy of `/srv/combotrader/data/backups` and `/srv/combotrader/data/uploads` off the server.
- [ ] AI agents on "Review everything" for the first month.

## Everyday commands
| Task | Command |
|---|---|
| Is it running? | `sudo systemctl status combotrader` |
| Live logs | `sudo journalctl -u combotrader -f` |
| Restart after editing `.env` | `sudo systemctl restart combotrader` |
| Update by hand | `sudo -u combotrader /srv/combotrader/deploy/update.sh` |
| Memory used by ComboTrader | `systemctl status combotrader \| grep Memory` |
| Remove ComboTrader from the web server | `bash /srv/combotrader/deploy/uninstall.sh` |
| Restore a backup | `sudo systemctl stop combotrader && cd /srv/combotrader/data && sudo -u combotrader rm -f combotrader.db-wal combotrader.db-shm && sudo -u combotrader cp backups/ct-DATE.db combotrader.db && sudo systemctl start combotrader` |
