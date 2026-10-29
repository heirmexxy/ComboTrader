#!/usr/bin/env bash
# Removes ComboTrader's web-server entry and stops its service. Your other sites are not touched.
# The app folder and its data stay in /srv/combotrader (delete it yourself once you have a copy of data/).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
systemctl disable --now combotrader 2>/dev/null || true
rm -f /etc/systemd/system/combotrader.service /etc/sudoers.d/combotrader && systemctl daemon-reload
if [ -f /etc/nginx/sites-available/combotrader.conf ] || [ -f /etc/nginx/conf.d/combotrader.conf ]; then
  rm -f /etc/nginx/sites-enabled/combotrader.conf /etc/nginx/sites-available/combotrader.conf /etc/nginx/conf.d/combotrader.conf
  nginx -t && systemctl reload nginx
fi
if [ -f /etc/apache2/sites-available/combotrader.conf ]; then
  a2dissite -q combotrader || true; rm -f /etc/apache2/sites-available/combotrader.conf
  apachectl configtest && systemctl reload apache2
fi
if [ -f /etc/caddy/Caddyfile ] && grep -q '# BEGIN combotrader' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
  sed -i '/# BEGIN combotrader/,/# END combotrader/d' /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
fi
crontab -u combotrader -r 2>/dev/null || true
echo "ComboTrader is stopped and removed from the web server. Data kept in /srv/combotrader/data."
