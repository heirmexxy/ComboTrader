#!/usr/bin/env bash
# Pulls the latest main branch, rebuilds, restarts ComboTrader and checks its health.
# Rolls back automatically if the new version does not start. Touches nothing outside /srv/combotrader.
# Run as the combotrader user (GitHub Actions does this on every push to main).
set -euo pipefail
APP_DIR=/srv/combotrader
cd "$APP_DIR"
[ -x /opt/combotrader-node/bin/node ] && export PATH="/opt/combotrader-node/bin:$PATH"
PORT=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d ' "'"'" || true); PORT=${PORT:-3000}
BIND=$(grep -E '^HOST_BIND=' .env | cut -d= -f2 | tr -d ' "'"'" || true); [ -z "$BIND" ] || [ "$BIND" = 0.0.0.0 ] && BIND=127.0.0.1
healthy() { for i in $(seq 1 20); do sleep 2; curl -fsS "http://$BIND:$PORT/healthz" >/dev/null 2>&1 && return 0; done; return 1; }

PREV=$(git rev-parse HEAD)
git fetch --quiet origin main
NEW=$(git rev-parse origin/main)
[ "$PREV" = "$NEW" ] && { echo "Already up to date ($PREV)."; exit 0; }
node --disable-warning=ExperimentalWarning dist/cli.mjs backup "data/backups/pre-deploy-$(date +%F-%H%M%S).db" >/dev/null 2>&1 || true
git reset --hard --quiet "$NEW"
npm install --no-audit --no-fund --silent
npm run build --silent
sudo /usr/bin/systemctl restart combotrader
if healthy; then echo "Deployed $NEW"; exit 0; fi
echo "New version failed its health check — rolling back to $PREV"
git reset --hard --quiet "$PREV"
npm install --no-audit --no-fund --silent && npm run build --silent
sudo /usr/bin/systemctl restart combotrader
healthy && echo "Rolled back to $PREV" || echo "Rollback did not come up either: journalctl -u combotrader -n 100"
exit 1
