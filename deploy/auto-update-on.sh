#!/usr/bin/env bash
# Makes the server update itself: every 2 minutes it checks GitHub for a new version of main and, if there is one,
# runs deploy/update.sh (backup, build, restart, health check, automatic rollback). No keys need copying anywhere.
# Run once as the combotrader user:  sudo -u combotrader /srv/combotrader/deploy/auto-update-on.sh
# Turn off with:                     sudo -u combotrader /srv/combotrader/deploy/auto-update-on.sh off
set -euo pipefail
LINE='*/2 * * * * flock -n /tmp/combotrader-update.lock /srv/combotrader/deploy/update.sh >> /srv/combotrader/data/deploy.log 2>&1'
CURRENT=$(crontab -l 2>/dev/null | grep -v 'deploy/update.sh' || true)
if [ "${1:-on}" = "off" ]; then
  printf '%s\n' "$CURRENT" | crontab -
  echo "Automatic updates are OFF."
else
  { printf '%s\n' "$CURRENT"; echo "$LINE"; } | grep -v '^$' | crontab -
  echo "Automatic updates are ON: the server checks GitHub every 2 minutes. Log: /srv/combotrader/data/deploy.log"
fi
