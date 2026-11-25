#!/usr/bin/env bash
# Nightly database backup (docs/deploy.md, "Backups"). Run from the checkout, e.g. by cron:
#   15 3 * * *  cd /srv/hatchery/app && deploy/backup.sh >> /srv/hatchery/backups/backup.log 2>&1
# Writes a compressed pg_dump to BACKUP_DIR, keeps KEEP_DAYS days, and (optionally) copies it
# off the server with BACKUP_REMOTE (an rclone remote, e.g. "b2:hatchery-backups").
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/srv/hatchery/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
COMPOSE=(docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml)

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/hatchery-$stamp.sql.gz"
tmp="$file.partial"

# Custom-format dump would also work; plain SQL + gzip restores anywhere with psql.
"${COMPOSE[@]}" exec -T postgres pg_dump -U hatchery -d hatchery --no-owner --clean --if-exists | gzip -9 > "$tmp"
# A dump that is empty or cut off is not a backup.
gzip -t "$tmp"
if [ "$(gzip -dc "$tmp" | grep -c 'CREATE TABLE')" -lt 10 ]; then
  echo "backup $file looks incomplete; keeping the previous ones" >&2
  rm -f "$tmp"
  exit 1
fi
mv "$tmp" "$file"
sha256sum "$file" > "$file.sha256"
echo "$(date -u +%FT%TZ) backup ok: $file ($(du -h "$file" | cut -f1))"

find "$BACKUP_DIR" -name 'hatchery-*.sql.gz*' -mtime +"$KEEP_DAYS" -delete

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$file" "$BACKUP_REMOTE/" && rclone copy "$file.sha256" "$BACKUP_REMOTE/"
  echo "copied off-site to $BACKUP_REMOTE"
fi
