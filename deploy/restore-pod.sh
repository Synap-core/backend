#!/bin/sh
#
# Restore Pod — starts all services back up
#
# Usage: restore-pod.sh <callback-url> <callback-jwt>
#
set -e

CALLBACK_URL="$1"
CALLBACK_JWT="$2"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="docker compose -p synap -f ${DEPLOY_DIR}/docker-compose.yml"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [restore] $*"; }

report() {
  STATUS="$1"
  ERROR="$2"
  if [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ]; then
    wget -q -O - --timeout=10 \
      --header="Authorization: Bearer ${CALLBACK_JWT}" \
      --header="Content-Type: application/json" \
      --post-data="{\"command\":\"restore\",\"status\":\"${STATUS}\",\"error\":$(printf '%s' "${ERROR:-null}" | sed 's/"/\\"/g; s/^/"/; s/$/"/' | sed 's/^"null"$/null/')}" \
      "$CALLBACK_URL" 2>/dev/null || log "WARN: callback failed (non-fatal)"
  fi
}

log "=== Restoring pod services ==="

# Start all core services
$COMPOSE up -d --remove-orphans 2>&1

# Wait for backend health (up to 3 minutes)
log "Waiting for health check..."
HEALTHY=false
for i in $(seq 1 18); do
  sleep 10
  if wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null; then
    HEALTHY=true
    log "Health check passed after ${i}0 seconds"
    break
  fi
  log "Health check attempt $i/18..."
done

if [ "$HEALTHY" = "true" ]; then
  log "=== Pod restored successfully ==="
  report "completed" ""
  exit 0
fi

log "ERROR: Health check failed after 3 minutes"
report "failed" "Health check failed after restore"
exit 1
