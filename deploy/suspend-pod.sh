#!/bin/sh
#
# Suspend Pod — stops all services except caddy and pod-agent
#
# Usage: suspend-pod.sh <callback-url> <callback-jwt>
#
set -e

CALLBACK_URL="$1"
CALLBACK_JWT="$2"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="docker compose -p synap-backend -f ${DEPLOY_DIR}/docker-compose.yml"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [suspend] $*"; }

report() {
  STATUS="$1"
  ERROR="$2"
  if [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ]; then
    wget -q -O - --timeout=10 \
      --header="Authorization: Bearer ${CALLBACK_JWT}" \
      --header="Content-Type: application/json" \
      --post-data="{\"command\":\"suspend\",\"status\":\"${STATUS}\",\"error\":$(printf '%s' "${ERROR:-null}" | sed 's/"/\\"/g; s/^/"/; s/$/"/' | sed 's/^"null"$/null/')}" \
      "$CALLBACK_URL" 2>/dev/null || log "WARN: callback failed (non-fatal)"
  fi
}

log "=== Suspending pod services ==="

# Stop data and application services, keep caddy + pod-agent running
$COMPOSE stop backend realtime postgres redis minio typesense kratos hydra 2>&1 || true

log "Services stopped"
report "completed" ""

log "=== Pod suspended ==="
