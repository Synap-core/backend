#!/bin/sh
#
# Pod Self-Update Script
#
# Runs inside a detached one-shot container (docker:cli) spawned by the
# backend's trigger-update handler. This container survives the backend
# restart because it runs independently via Docker socket.
#
# Usage: update-pod.sh <version> <update-id> <callback-url> <callback-jwt>
#
# Steps:
#   1. Pull new images
#   2. Run database migrations
#   3. Restart backend + realtime services
#   4. Wait for health check (up to 5 min)
#   5. Report result to CP via callback
#   6. On failure: rollback to previous version
#
set -e

VERSION="$1"
UPDATE_ID="$2"
CALLBACK_URL="$3"
CALLBACK_JWT="$4"
DEPLOY_DIR="/deploy"
COMPOSE="docker compose -f ${DEPLOY_DIR}/docker-compose.yml"
LOG="/tmp/synap-update-${UPDATE_ID}.log"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }

report() {
  STATUS="$1"
  ERROR="$2"
  if [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ]; then
    wget -q -O - --timeout=10 \
      --header="Authorization: Bearer ${CALLBACK_JWT}" \
      --header="Content-Type: application/json" \
      --post-data="{\"updateId\":\"${UPDATE_ID}\",\"status\":\"${STATUS}\",\"version\":\"${VERSION}\",\"error\":$(printf '%s' "${ERROR:-null}" | sed 's/"/\\"/g; s/^/"/; s/$/"/' | sed 's/^"null"$/null/')}" \
      "$CALLBACK_URL" 2>/dev/null || log "WARN: callback failed (non-fatal)"
  fi
}

# Validate inputs
if [ -z "$VERSION" ]; then
  log "ERROR: version argument required"
  exit 1
fi

log "=== Starting pod update to ${VERSION} ==="

# Save current version for rollback
PREV_VERSION=$(grep "^BACKEND_VERSION=" "${DEPLOY_DIR}/.env" 2>/dev/null | cut -d= -f2 || echo "latest")
log "Previous version: ${PREV_VERSION}"

# ─── Step 1: Pull images ───
log "Pulling images..."
if ! $COMPOSE pull backend realtime backend-migrate 2>&1 | tee -a "$LOG"; then
  log "ERROR: Image pull failed"
  report "failed" "Image pull failed"
  exit 1
fi

# ─── Step 2: Update .env version ───
if [ "$VERSION" != "latest" ]; then
  if grep -q "^BACKEND_VERSION=" "${DEPLOY_DIR}/.env" 2>/dev/null; then
    sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${VERSION}/" "${DEPLOY_DIR}/.env"
  else
    echo "BACKEND_VERSION=${VERSION}" >> "${DEPLOY_DIR}/.env"
  fi
  log "Updated .env BACKEND_VERSION=${VERSION}"
fi

# ─── Step 3: Run migrations ───
log "Running migrations..."
$COMPOSE run --rm backend-migrate 2>&1 | tee -a "$LOG" || log "WARN: Migration exited non-zero (may be OK)"

# ─── Step 4: Restart services ───
log "Restarting backend + realtime..."
$COMPOSE up -d --remove-orphans backend realtime 2>&1 | tee -a "$LOG"

# ─── Step 5: Health check ───
log "Waiting for health check..."
HEALTHY=false
for i in $(seq 1 30); do
  sleep 10
  if wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null; then
    HEALTHY=true
    log "Health check passed after ${i}0 seconds"
    break
  fi
  log "Health check attempt $i/30..."
done

if [ "$HEALTHY" = "true" ]; then
  log "=== Update to ${VERSION} completed successfully ==="
  report "completed" ""
  exit 0
fi

# ─── Step 6: Rollback ───
log "ERROR: Health check failed after 5 minutes. Rolling back to ${PREV_VERSION}..."

if [ "$PREV_VERSION" != "latest" ] && [ -n "$PREV_VERSION" ]; then
  sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${PREV_VERSION}/" "${DEPLOY_DIR}/.env"
fi

$COMPOSE pull backend realtime 2>&1 | tee -a "$LOG"
$COMPOSE up -d --remove-orphans backend realtime 2>&1 | tee -a "$LOG"

# Wait for rollback health
ROLLBACK_OK=false
for i in $(seq 1 18); do
  sleep 10
  if wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null; then
    ROLLBACK_OK=true
    break
  fi
done

if [ "$ROLLBACK_OK" = "true" ]; then
  log "Rollback to ${PREV_VERSION} succeeded"
  report "rolled_back" "Health check failed after update. Rolled back to ${PREV_VERSION}."
else
  log "CRITICAL: Both update and rollback failed"
  report "failed" "Update and rollback both failed. Manual intervention required."
fi

exit 1
