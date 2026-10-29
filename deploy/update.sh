#!/usr/bin/env bash
# Pulls the latest main branch, rebuilds, restarts and checks health. Rolls back automatically if the new version fails.
# Run as the combotrader user (GitHub Actions does this on every push to main).
set -euo pipefail
APP_DIR=/srv/combotrader
cd "$APP_DIR"
PREV=$(git rev-parse HEAD)
echo "Current version: $PREV"
node --disable-warning=ExperimentalWarning dist/cli.mjs backup "data/backups/pre-deploy-$(date +%F-%H%M%S).db" >/dev/null 2>&1 || true
git fetch --quiet origin main
git reset --hard origin/main
NEW=$(git rev-parse HEAD)
[ "$PREV" = "$NEW" ] && { echo "Already up to date."; exit 0; }
npm install --no-audit --no-fund --silent
npm run build --silent
sudo /usr/bin/systemctl restart combotrader
for i in $(seq 1 20); do
  sleep 2
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then echo "Deployed $NEW"; exit 0; fi
done
echo "New version failed its health check — rolling back to $PREV"
git reset --hard "$PREV"
npm install --no-audit --no-fund --silent && npm run build --silent
sudo /usr/bin/systemctl restart combotrader
exit 1
