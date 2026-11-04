#!/usr/bin/env bash
# Moves ComboTrader to its live address (nginx). Run as root on the VPS once the domain's DNS points here:
#   sudo bash /srv/combotrader/deploy/move-domain.sh
# Defaults: main address www.combotrader.com.ng; combotrader.com.ng and beta.combotrader.com.ng forward to it.
# Only ComboTrader's own nginx file and BASE_URL in /srv/combotrader/.env are changed. A backup is taken first.
set -euo pipefail
HOST=${1:-www.combotrader.com.ng}
APEX=${2:-combotrader.com.ng}
OLD=${3:-beta.combotrader.com.ng}
APP_DIR=/srv/combotrader
LE_EMAIL=${LE_EMAIL:-kitovu.tech@gmail.com}
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Run with sudo."
command -v nginx >/dev/null || die "nginx is not installed here."
PORT=$(grep -E '^PORT=' $APP_DIR/.env | cut -d= -f2 | tr -d ' "'"'" || true); PORT=${PORT:-3100}

say "1/5 Checking that the domain points at this server"
PUBIP=$(curl -s4 --max-time 10 https://api.ipify.org || true); [ -n "$PUBIP" ] || PUBIP=$(hostname -I | awk '{print $1}')
points() { getent ahostsv4 "$1" | awk '{print $1}' | grep -qx "$PUBIP"; }
for n in "$HOST" "$APEX"; do
  if points "$n"; then echo "  $n → $PUBIP ✓"; else die "$n does not point at this server ($PUBIP) yet. Add an A record for it with value $PUBIP in Hostinger DNS, wait 10–30 minutes, then run this again."; fi
done
points "$OLD" && echo "  $OLD → $PUBIP ✓ (will forward to $HOST)" || { echo "  $OLD does not point here; it will be left out."; OLD=""; }

say "2/5 Backing up nginx"
STAMP=$(date +%F-%H%M%S); tar -czf "/root/nginx-backup-$STAMP.tgz" /etc/nginx 2>/dev/null; echo "  /root/nginx-backup-$STAMP.tgz"

say "3/5 Writing ComboTrader's nginx file"
if [ -d /etc/nginx/sites-available ]; then F=/etc/nginx/sites-available/combotrader.conf; else F=/etc/nginx/conf.d/combotrader.conf; fi
cp -a "$F" "/root/combotrader.conf.before-move-$STAMP" 2>/dev/null || true
cat > "$F" <<NGX
# ComboTrader — written by deploy/move-domain.sh on $STAMP. Only this file belongs to ComboTrader.
server {
    listen 80;
    listen [::]:80;
    server_name $APEX ${OLD};
    return 301 https://$HOST\$request_uri;
}
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    client_max_body_size 15m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90s;
    }
}
NGX
[ "$F" = /etc/nginx/sites-available/combotrader.conf ] && ln -sf "$F" /etc/nginx/sites-enabled/combotrader.conf
if ! nginx -t 2>/tmp/nginx-test.log; then
  cat /tmp/nginx-test.log
  cp -a "/root/combotrader.conf.before-move-$STAMP" "$F" 2>/dev/null || true
  die "nginx rejected the new file, so I put the old one back. Nothing else changed."
fi
systemctl reload nginx

say "4/5 Security certificate (Let's Encrypt)"
command -v certbot >/dev/null || apt-get install -y --no-upgrade certbot python3-certbot-nginx
ARGS=(-d "$HOST" -d "$APEX"); [ -n "$OLD" ] && ARGS+=(-d "$OLD")
certbot --nginx "${ARGS[@]}" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect --expand --keep-until-expiring

say "5/5 Switching ComboTrader to https://$HOST"
sed -i '/^BASE_URL=/d' $APP_DIR/.env && echo "BASE_URL=https://$HOST" >> $APP_DIR/.env
systemctl restart combotrader
for i in $(seq 1 20); do sleep 2; curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; done
curl -fsS "https://$HOST/healthz" >/dev/null && echo "  https://$HOST is up ✓" || echo "  Started, but https://$HOST did not answer yet — try it in a browser in a minute."
echo
echo "Done. https://$APEX${OLD:+ and https://$OLD} now forward to https://$HOST."
echo "To undo: cp /root/combotrader.conf.before-move-$STAMP $F && systemctl reload nginx, and set BASE_URL back in $APP_DIR/.env."
