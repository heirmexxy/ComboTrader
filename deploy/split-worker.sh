#!/usr/bin/env bash
# One-time (as root): run ComboTrader as two services, so a slow or stuck background job can never take the website down.
#   combotrader         = the website only (CT_ROLE=web)
#   combotrader-worker  = all background jobs: emails, payment checks, agents, Adaeze, sequences, covers
# Both restart themselves if they ever get stuck. Safe to run again.
set -euo pipefail
APP_DIR=/srv/combotrader
APP_USER=combotrader
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
[ -f "$APP_DIR/dist/worker.mjs" ] || { echo "The update with the background worker has not arrived yet: wait 2 minutes and run this again."; exit 1; }
NODE=$(grep -oP '^ExecStart=\K\S+(?= --disable-warning)' /etc/systemd/system/combotrader.service || command -v node)
NODE_DIR=$(dirname "$NODE")

# The website: same service as before, told to run the website only.
mkdir -p /etc/systemd/system/combotrader.service.d
cat > /etc/systemd/system/combotrader.service.d/role.conf <<CONF
[Service]
Environment=CT_ROLE=web
CONF

# The background worker.
cat > /etc/systemd/system/combotrader-worker.service <<UNIT
[Unit]
Description=ComboTrader background worker (emails, payments checks, agents)
After=network-online.target combotrader.service
Wants=network-online.target
[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PATH=$NODE_DIR:/usr/bin:/bin
ExecStart=$NODE --disable-warning=ExperimentalWarning dist/worker.mjs
Restart=always
RestartSec=5
MemoryHigh=900M
MemoryMax=1200M
CPUWeight=30
Nice=10
TasksMax=256
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT

# Let the auto-update restart both.
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart combotrader, /usr/bin/systemctl status combotrader, /usr/bin/systemctl restart combotrader-worker, /usr/bin/systemctl status combotrader-worker" > /etc/sudoers.d/combotrader
chmod 440 /etc/sudoers.d/combotrader
# Jobs must not be switched off for the worker.
sed -i '/^RUN_SCHEDULER=/d' "$APP_DIR/.env"

systemctl daemon-reload
systemctl enable combotrader-worker >/dev/null 2>&1
systemctl restart combotrader
systemctl restart combotrader-worker
sleep 8
systemctl is-active combotrader >/dev/null && echo "Website: running" || echo "Website: NOT running (journalctl -u combotrader -n 50)"
systemctl is-active combotrader-worker >/dev/null && echo "Background worker: running" || echo "Background worker: NOT running (journalctl -u combotrader-worker -n 50)"
