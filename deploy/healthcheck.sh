#!/usr/bin/env bash
# External-style health check, run by cron every 5 minutes (docs/deploy.md, "Monitoring"):
#   */5 * * * *  cd /srv/hatchery/app && deploy/healthcheck.sh
# Checks the public site, the desk, the judge, the event stream and the disk, and posts to
# ALERT_WEBHOOK_URL (from .env) when something changes from OK to failing (and back).
set -uo pipefail

[ -f .env ] && set -a && . ./.env && set +a
SITE="https://${SITE_DOMAIN:?SITE_DOMAIN not set}"
STATE_FILE="${HEALTH_STATE_FILE:-/srv/hatchery/health.state}"
problems=()

health="$(curl -fsS --max-time 15 "$SITE/api/health" 2>/dev/null)" || problems+=("desk /api/health does not answer")
if [ -n "${health:-}" ]; then
  echo "$health" | grep -q '"fresh":true' || problems+=("judge image is stale or unreachable: $(echo "$health" | head -c 300)")
fi
curl -fsS --max-time 15 -o /dev/null "$SITE/" || problems+=("site $SITE does not load")
curl -fsS --max-time 15 -o /dev/null "$SITE/join.txt" || problems+=("join.txt does not load")
# The live stream must answer with event-stream headers within a few seconds.
curl -sS --max-time 5 -D - -o /dev/null "$SITE/api/events/stream" 2>/dev/null | grep -qi 'content-type: text/event-stream' || problems+=("event stream does not open")
used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
[ "${used:-0}" -lt 90 ] || problems+=("disk is ${used}% full")
# Certificates are renewed by Caddy; warn if one is close to expiry anyway.
expiry="$(echo | openssl s_client -servername "$SITE_DOMAIN" -connect "$SITE_DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
if [ -n "$expiry" ] && [ "$(( ($(date -d "$expiry" +%s) - $(date +%s)) / 86400 ))" -lt 14 ]; then problems+=("TLS certificate expires $expiry"); fi

now="ok"; [ ${#problems[@]} -gt 0 ] && now="failing"
before="$(cat "$STATE_FILE" 2>/dev/null || echo ok)"
echo "$now" > "$STATE_FILE"
if [ "$now" != "$before" ]; then
  if [ "$now" = "failing" ]; then text="Hatchery health check FAILING on $SITE_DOMAIN: $(IFS='; '; echo "${problems[*]}")"; else text="Hatchery health check OK again on $SITE_DOMAIN"; fi
  echo "$(date -u +%FT%TZ) $text"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    payload="$(printf '%s' "$text" | python3 -c 'import json,sys; t=sys.stdin.read(); print(json.dumps({"text": t, "content": t}))')"
    curl -fsS --max-time 10 -H 'content-type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" > /dev/null || echo "webhook failed" >&2
  fi
fi
[ "$now" = "ok" ]
