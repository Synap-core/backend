#!/bin/sh
#
# Pod Self-Update Script — Near-Zero Downtime
#
# Called by the pod-agent. The old backend keeps serving while:
# 1. New image is pulled (no downtime)
# 2. Migrations run (backward-compatible, old backend still serves)
# 3. New containers start alongside old ones
# 4. Health check on new containers
# 5. Old containers stopped (Caddy auto-detects via Docker network)
# 6. Old images cleaned up (keep last 3)
#
# Usage: update-pod.sh <version-tag>
#
set -e

VERSION="$1"
CD="$(dirname "$0")"
COMPOSE="docker compose -p synap -f $CD/docker-compose.yml"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [update] $*"; }

[ -z "$VERSION" ] && { log "ERROR: version required"; exit 1; }
log "=== Updating to ${VERSION} ==="

# Save current version for rollback
PREV_VERSION=$(grep "^BACKEND_VERSION=" "$CD/.env" 2>/dev/null | cut -d= -f2 || echo "")

# ─── Step 1: Set version and pull (old backend still serving) ──────────────
# Map version tag to Docker image tag:
#   main-<sha>  → "main" (SHA-specific tags are for audit; :main is the pull target)
#   v1.2.3      → "v1.2.3" (exact release tag)
#   latest/main → "main" (safe default)
case "$VERSION" in
  main-*|main) DOCKER_TAG="main" ;;
  v*)          DOCKER_TAG="$VERSION" ;;
  *)           DOCKER_TAG="main" ;;
esac

log "Setting BACKEND_VERSION=${DOCKER_TAG} (from version=${VERSION})"
grep -q "^BACKEND_VERSION=" "$CD/.env" \
  && sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${DOCKER_TAG}/" "$CD/.env" \
  || echo "BACKEND_VERSION=${DOCKER_TAG}" >> "$CD/.env"

log "Pulling new images (backend still serving)..."
$COMPOSE pull backend realtime backend-migrate 2>&1 || {
  log "ERROR: Image pull failed"
  exit 1
}

# ─── Step 2: Run migrations (old backend still serving) ────────────────────
# Migrations MUST be backward-compatible (additive only: new columns, new tables).
# The old backend continues serving while migrations run.
log "Running migrations (old backend still serving)..."
$COMPOSE run --rm backend-migrate 2>&1 || log "WARN: migration non-zero"

# ─── Step 3: Recreate containers with new image ───────────────────────────
# --force-recreate ensures Docker replaces the container even if the compose
# definition hasn't changed (only the image digest changed).
# There's a brief ~2-3s gap while the container restarts. Caddy will return
# 502 during this window. For true zero-downtime we'd need Docker Swarm or
# a sidecar, but this is good enough for single-pod deployments.
log "Restarting with new image (force-recreate)..."
$COMPOSE up -d --force-recreate --remove-orphans backend realtime 2>&1

# ─── Step 4: Health check ─────────────────────────────────────────────────
log "Waiting for health check..."
OK=false
for i in $(seq 1 30); do
  sleep 10
  if wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null; then
    OK=true
    log "Health check passed after ${i}0 seconds"
    break
  fi
  log "Health check attempt $i/30..."
done

if [ "$OK" != "true" ]; then
  log "ERROR: Health check failed after 5 minutes"

  if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" != "$DOCKER_TAG" ]; then
    log "Rolling back to previous version: $PREV_VERSION"
    sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${PREV_VERSION}/" "$CD/.env"
    $COMPOSE up -d --force-recreate --remove-orphans backend realtime 2>&1

    # Wait for rollback health
    ROLLBACK_OK=false
    for j in $(seq 1 12); do
      sleep 10
      if wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null; then
        ROLLBACK_OK=true
        log "Rollback health check passed"
        break
      fi
    done

    if [ "$ROLLBACK_OK" = "true" ]; then
      log "=== Rolled back to ${PREV_VERSION} ==="
    else
      log "ERROR: Rollback also failed — pod may be down"
    fi
  fi

  exit 1
fi

# ─── Step 5: Clean up old images (keep last 3) ────────────────────────────
log "Cleaning up old images..."
# List all backend images sorted by creation date, skip the 3 newest, remove the rest
docker images "ghcr.io/synap-core/backend" --format "{{.ID}} {{.CreatedAt}}" \
  | sort -k2 -r \
  | tail -n +4 \
  | awk '{print $1}' \
  | xargs -r docker rmi 2>/dev/null || true

# Also prune dangling images from the pull
docker image prune -f 2>/dev/null || true

FREED=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -1)
log "Cleanup done (reclaimable: ${FREED:-unknown})"

log "=== Update to ${VERSION} complete ==="
exit 0

