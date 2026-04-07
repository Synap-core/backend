#!/bin/sh
#
# Pod Self-Update Script
#
# Called by the pod-agent after receiving a CP-signed update command.
# Pulls latest :main images, runs migrations, restarts with --force-recreate.
# The pod-agent handles the callback to CP — this script just does the work.
#
# Usage: update-pod.sh <version-tag>
#
set -e

VERSION="$1"
CD="$(dirname "$0")"
COMPOSE="docker compose -f $CD/docker-compose.yml"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [update] $*"; }

[ -z "$VERSION" ] && { log "ERROR: version required"; exit 1; }
log "=== Updating to ${VERSION} ==="

# Always pull :main (latest) — version-specific tags may not exist for all services.
# The VERSION arg is for tracking/logging, not for the Docker tag.
log "Setting BACKEND_VERSION=main"
grep -q "^BACKEND_VERSION=" "$CD/.env" && sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=main/" "$CD/.env" || echo "BACKEND_VERSION=main" >> "$CD/.env"

# Pull fresh images
log "Pulling images..."
$COMPOSE pull backend realtime backend-migrate 2>&1 || { log "ERROR: pull failed"; exit 1; }

# Run migrations
log "Running migrations..."
$COMPOSE run --rm backend-migrate 2>&1 || log "WARN: migration non-zero"

# Restart with --force-recreate to ensure the new image is used.
# Without this, docker compose may keep the old container if the image
# digest changed but the service definition didn't.
log "Restarting (force-recreate)..."
$COMPOSE up -d --force-recreate --remove-orphans backend realtime 2>&1

# Health check (up to 5 min)
log "Health check..."
OK=false
for i in $(seq 1 30); do
  sleep 10
  wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null && OK=true && break
  log "Health check attempt $i/30..."
done

if [ "$OK" = "true" ]; then
  log "=== Update to ${VERSION} complete ==="
  exit 0
fi

log "ERROR: Health check failed after 5 minutes"
exit 1
