#!/usr/bin/env bash
# Off-server backups to Google Drive. Every night (after the 02:15 database backup) this encrypts
# the newest database backup together with uploaded files (ID documents, photos) and copies it to a
# Google Drive folder. Copies older than 30 days are removed from Drive. Run as root.
#
#   sudo bash /srv/combotrader/deploy/backup-offsite.sh setup     one-time: install rclone, connect Drive, schedule
#   sudo bash /srv/combotrader/deploy/backup-offsite.sh run       send a backup now
#   sudo bash /srv/combotrader/deploy/backup-offsite.sh restore   show how to download and decrypt a backup
#
# Touches only: rclone (installed if missing), /root/.config/rclone, /root/.combotrader-backup-key,
# root's crontab (one marked line), and data/backups/offsite.txt (status read by the admin health check).
set -euo pipefail
APP_DIR=/srv/combotrader
APP_USER=combotrader
REMOTE=ctdrive
FOLDER_ID=${FOLDER_ID:-10eMl3oEdXXa2QIgZ7ngka1msd-bOLCQ9}
KEY=/root/.combotrader-backup-key
STATUS="$APP_DIR/data/backups/offsite.txt"
KEEP_DAYS=30
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

status() { echo "$1 $(date -u +%FT%TZ) $2" > "$STATUS"; chown "$APP_USER":"$APP_USER" "$STATUS" 2>/dev/null || true; }

run() {
  command -v rclone >/dev/null && rclone listremotes | grep -qx "$REMOTE:" || { echo "Not set up yet: run with 'setup' first."; exit 1; }
  cd "$APP_DIR"
  local db; db=$(ls -1t data/backups/ct-*.db 2>/dev/null | head -1 || true)
  if [ -z "$db" ] || [ -n "$(find "$db" -mmin +1500)" ]; then
    db="data/backups/ct-$(date +%F).db"
    NODE=$( [ -x /opt/combotrader-node/bin/node ] && echo /opt/combotrader-node/bin/node || command -v node )
    sudo -u "$APP_USER" "$NODE" --disable-warning=ExperimentalWarning dist/cli.mjs backup "$db" >/dev/null
  fi
  local name="combotrader-$(date +%F-%H%M).tar.gz.enc" tmp; tmp=$(mktemp -d)
  trap 'rm -rf "${tmp:-}"; trap - RETURN' RETURN
  if ! tar -czf - -C "$APP_DIR" "$db" $( [ -d data/uploads ] && echo data/uploads ) | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY" -out "$tmp/$name"; then
    status error "could not create the encrypted file"; echo "Backup failed while encrypting."; exit 1
  fi
  local size; size=$(du -h "$tmp/$name" | cut -f1)
  if ! rclone copy "$tmp/$name" "$REMOTE:" --retries 3 --low-level-retries 5 2>"$tmp/err"; then
    status error "upload to Google Drive failed: $(tail -1 "$tmp/err" | cut -c1-200)"; echo "Upload failed:"; tail -3 "$tmp/err"; exit 1
  fi
  rclone delete "$REMOTE:" --min-age "${KEEP_DAYS}d" --include 'combotrader-*.tar.gz.enc' 2>/dev/null || true
  status ok "$name ($size)"
  echo "Sent $name ($size) to Google Drive."
}

setup() {
  echo "== 1. rclone"
  if ! command -v rclone >/dev/null; then curl -fsSL https://rclone.org/install.sh | bash >/dev/null; fi
  rclone version | head -1

  echo "== 2. Encryption key"
  if [ ! -s "$KEY" ]; then
    umask 077; openssl rand -base64 36 | tr -d '\n' > "$KEY"
    echo "A new key was created. SAVE IT NOW in your password manager — without it the backups cannot be opened:"
    echo; echo "    $(cat "$KEY")"; echo
    read -r -p "Type SAVED when you have stored it safely: " ok; [ "$ok" = SAVED ] || { echo "Stopped. Run setup again when ready (the same key will be kept)."; exit 1; }
  else
    echo "Using the existing key in $KEY (show it with: sudo cat $KEY)"
  fi

  echo "== 3. Google Drive"
  if rclone listremotes | grep -qx "$REMOTE:"; then
    echo "Already connected."
  else
    echo "On your own computer, run:   rclone authorize \"drive\""
    echo "Sign in with the Google account that owns the backup folder, allow access, then copy the"
    echo "whole token it prints (starts with {\"access_token\" and ends with }). Paste it below; it stays hidden."
    read -r -s -p "Token: " TOKEN; echo
    case "$TOKEN" in \{*access_token*\}) ;; *) echo "That does not look like the token. Run setup again."; exit 1;; esac
    rclone config create "$REMOTE" drive scope=drive root_folder_id="$FOLDER_ID" token="$TOKEN" config_is_local=false --non-interactive >/dev/null
    unset TOKEN
    rclone lsd "$REMOTE:" >/dev/null && echo "Connected to the Drive folder." || { echo "Could not open the folder. Check the folder belongs to the account you signed in with."; rclone config delete "$REMOTE"; exit 1; }
  fi

  echo "== 4. Nightly schedule (02:45, after the 02:15 database backup)"
  { crontab -l 2>/dev/null | grep -v 'backup-offsite.sh' || true; echo "45 2 * * * bash $APP_DIR/deploy/backup-offsite.sh run >/var/log/combotrader-offsite.log 2>&1"; } | crontab -
  echo "Scheduled."

  echo "== 5. First backup"
  run
  echo; echo "Done. Admin → Overview → System health now shows 'Off-server backup'."
}

restore() {
  cat <<EOF
To restore from Google Drive:
  1. List backups:      sudo rclone ls $REMOTE:
  2. Download one:      sudo rclone copy "$REMOTE:combotrader-YYYY-MM-DD-HHMM.tar.gz.enc" /root/restore/
  3. Decrypt + unpack:  cd /root/restore && openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:$KEY -in combotrader-*.enc | tar -xzf -
     (On another machine, use -pass pass:'THE-KEY-YOU-SAVED' instead of -pass file:...)
  4. You now have data/backups/ct-DATE.db and data/uploads/. Stop the service, copy the .db over
     $APP_DIR/data/combotrader.db (owned by $APP_USER), copy uploads back, and start the service.
EOF
}

case "${1:-}" in setup) setup;; run) run;; restore) restore;; *) echo "Usage: $0 setup | run | restore"; exit 1;; esac
