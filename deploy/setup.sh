#!/usr/bin/env bash
# ComboTrader — one-time setup of a fresh Hostinger VPS (Ubuntu 24.04).
# Run as root:  curl -fsSL https://raw.githubusercontent.com/heirmexxy/ComboTrader/main/deploy/setup.sh -o setup.sh && bash setup.sh
# Safe to run again: each step checks what is already there.
set -euo pipefail

DOMAIN="${DOMAIN:-combotrader.com.ng}"
REPO="${REPO:-git@github.com:heirmexxy/ComboTrader.git}"
APP_DIR=/srv/combotrader
APP_USER=combotrader
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run this as root (sudo -i)."; exit 1; }

say "1/9 System updates, firewall and automatic security patches"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get upgrade -y
apt-get install -y curl git ufw fail2ban unattended-upgrades sqlite3 ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
dpkg-reconfigure -f noninteractive unattended-upgrades
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
systemctl enable --now fail2ban
timedatectl set-timezone Africa/Lagos || true

say "2/9 Node.js 22"
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "3/9 Caddy (web server with automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

say "4/9 App user and GitHub deploy key"
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
sudo -u "$APP_USER" mkdir -p "/home/$APP_USER/.ssh"
if [ ! -f "/home/$APP_USER/.ssh/id_ed25519" ]; then
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N '' -C "combotrader-vps" -f "/home/$APP_USER/.ssh/id_ed25519" >/dev/null
fi
sudo -u "$APP_USER" bash -c 'ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u ~/.ssh/known_hosts -o ~/.ssh/known_hosts'
if [ ! -d "$APP_DIR/.git" ]; then
  echo
  echo "Add this key to GitHub → github.com/heirmexxy/ComboTrader → Settings → Deploy keys → Add deploy key (read access is enough):"
  echo
  cat "/home/$APP_USER/.ssh/id_ed25519.pub"
  echo
  read -r -p "Press Enter once the key is added on GitHub… " _
fi

say "5/9 Download ComboTrader"
mkdir -p "$APP_DIR" && chown "$APP_USER:$APP_USER" "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then sudo -u "$APP_USER" git clone "$REPO" "$APP_DIR"; else sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only; fi

say "6/9 Settings file (.env)"
if [ ! -f "$APP_DIR/.env" ]; then
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -hex 32)|" "$APP_DIR/.env"
  sed -i "s|^CRON_SECRET=.*|CRON_SECRET=$(openssl rand -hex 24)|" "$APP_DIR/.env"
  sed -i "s|^WHATSAPP_VERIFY_TOKEN=.*|WHATSAPP_VERIFY_TOKEN=$(openssl rand -hex 16)|" "$APP_DIR/.env"
  sed -i "s|^BASE_URL=.*|BASE_URL=https://www.$DOMAIN|" "$APP_DIR/.env"
  sed -i "s|^PAYSTACK_SECRET_KEY=.*|PAYSTACK_SECRET_KEY=|; s|^PAYSTACK_PUBLIC_KEY=.*|PAYSTACK_PUBLIC_KEY=|" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Created $APP_DIR/.env with fresh secrets. Add your Paystack, email and SMS keys later with: nano $APP_DIR/.env"
fi

say "7/9 Build"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm install --no-audit --no-fund && npm run build"
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data/backups"

say "8/9 Service, web server and backups"
cat > /etc/systemd/system/combotrader.service <<UNIT
[Unit]
Description=ComboTrader
After=network-online.target
Wants=network-online.target
[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
# The deploy user may restart the app (and nothing else) without a password.
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart combotrader, /usr/bin/systemctl status combotrader" > /etc/sudoers.d/combotrader
chmod 440 /etc/sudoers.d/combotrader
systemctl daemon-reload && systemctl enable --now combotrader

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	redir https://www.$DOMAIN{uri} permanent
}
www.$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
	header -Server
	request_body {
		max_size 15MB
	}
	log {
		output file /var/log/caddy/combotrader.log {
			roll_size 20MiB
			roll_keep 10
		}
	}
}
CADDY
systemctl reload caddy || systemctl restart caddy

# Nightly database backup at 02:15, keep 30 days. Copy data/backups off the server too (see the guide).
CRON="15 2 * * * cd $APP_DIR && /usr/bin/node --disable-warning=ExperimentalWarning dist/cli.mjs backup data/backups/ct-\$(date +\\%F).db >/dev/null 2>&1 && find data/backups -name '*.db' -mtime +30 -delete"
( crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'dist/cli.mjs backup' ; echo "$CRON" ) | crontab -u "$APP_USER" -

say "9/9 Key for automatic deploys from GitHub"
KEY=/home/$APP_USER/.ssh/github_actions
if [ ! -f "$KEY" ]; then
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N '' -C "github-actions-deploy" -f "$KEY" >/dev/null
  # This key can do exactly one thing: run the update script.
  echo "command=\"$APP_DIR/deploy/update.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat "$KEY.pub")" | sudo -u "$APP_USER" tee -a "/home/$APP_USER/.ssh/authorized_keys" >/dev/null
  chmod 600 "/home/$APP_USER/.ssh/authorized_keys"
fi

say "Check"
sleep 3
curl -fsS http://127.0.0.1:3000/healthz && echo
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
cat <<DONE

ComboTrader is running on this server.

Next:
  1. In Hostinger hPanel → Domains → $DOMAIN → DNS / Nameservers, point A records "@" and "www" to: $IP
     (delete any other A, AAAA or CNAME records for "@" and "www"). HTTPS switches on by itself once DNS points here.
  2. Create the first admin: sign up on https://www.$DOMAIN with your email, then run:
       sudo -u $APP_USER bash -c "cd $APP_DIR && npm run make-admin -- you@kitovu.com.ng super"
  3. Add live keys to $APP_DIR/.env, then: sudo systemctl restart combotrader
  4. Automatic deploys: in GitHub → Settings → Secrets and variables → Actions, add
       VPS_HOST    = $IP
       VPS_SSH_KEY = the whole private key printed below (including the BEGIN and END lines)
DONE
echo
cat "$KEY"
