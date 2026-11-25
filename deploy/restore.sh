#!/usr/bin/env bash
# Restore a backup made by deploy/backup.sh (docs/deploy.md, "Restoring").
#   deploy/restore.sh /srv/hatchery/backups/hatchery-20270101T031500Z.sql.gz
# Stops the services that write to the database, restores, and starts them again.
# Proof files in lean/Proofs/ are never deleted by a restore: the desk only removes a proof that
# the restored database explicitly says is not checked.
set -euo pipefail

file="${1:?usage: deploy/restore.sh <backup.sql.gz>}"
COMPOSE=(docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml)

[ -f "$file.sha256" ] && sha256sum -c "$file.sha256"
gzip -t "$file"
read -r -p "Restore $file into the live database? This replaces its contents. Type 'restore': " ok
[ "$ok" = "restore" ] || { echo "cancelled"; exit 1; }

"${COMPOSE[@]}" stop desk worker decomposer indexer web 2>/dev/null || true
gzip -dc "$file" | "${COMPOSE[@]}" exec -T postgres psql -U hatchery -d hatchery -v ON_ERROR_STOP=1 -q
"${COMPOSE[@]}" up -d desk web
echo "restored. Start the agents again yourself when you are ready (see docs/deploy.md)."
