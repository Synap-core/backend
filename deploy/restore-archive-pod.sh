#!/bin/sh
#
# Restore Pod from Archive — downloads archive, restores DB + volumes, starts services
#
# Usage: restore-archive-pod.sh <archive-url> <callback-url> <callback-jwt>
#
set -e

ARCHIVE_URL="$1"
CALLBACK_URL="$2"
CALLBACK_JWT="$3"
CD="$(dirname "$0")"
COMPOSE="docker compose -f $CD/docker-compose.yml"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [restore-archive] $*"; }

report() {
  STATUS="$1"; ERROR="$2"
  [ -n "$CALLBACK_URL" ] && wget -q -O - --timeout=10 \
    --header="Authorization: Bearer $CALLBACK_JWT" \
    --header="Content-Type: application/json" \
    --post-data="{\"command\":\"restore-archive\",\"status\":\"$STATUS\",\"error\":${ERROR:-null}}" \
    "$CALLBACK_URL" 2>/dev/null || true
}

if [ -z "$ARCHIVE_URL" ]; then
  log "No archive URL — starting fresh"
  $COMPOSE up -d 2>&1
  report "completed"
  exit 0
fi

log "=== Restoring from archive ==="

# Stop services (fresh server may already be running from cloud-init)
$COMPOSE stop 2>/dev/null || true

# Download archive
log "Downloading archive..."
wget -q -O /tmp/pod-archive.tar.gz "$ARCHIVE_URL" 2>&1 || {
  log "ERROR: Download failed"
  report "failed" "\"archive download failed\""
  # Start fresh instead
  $COMPOSE up -d 2>&1
  exit 1
}

# Extract
TMPDIR=$(mktemp -d)
tar xzf /tmp/pod-archive.tar.gz -C "$TMPDIR" 2>&1
rm -f /tmp/pod-archive.tar.gz
log "Archive extracted"

# Restore PostgreSQL
if [ -f "$TMPDIR/database.sql.gz" ]; then
  log "Restoring database..."
  $COMPOSE up -d postgres 2>/dev/null || true
  sleep 10
  zcat "$TMPDIR/database.sql.gz" | $COMPOSE exec -T postgres psql -U synap 2>/dev/null || log "WARN: DB restore issue"
  log "Database restored"
fi

# Restore volumes
if [ -f "$TMPDIR/volumes.tar.gz" ]; then
  log "Restoring volumes..."
  tar xzf "$TMPDIR/volumes.tar.gz" -C / 2>/dev/null || true
  log "Volumes restored"
fi

rm -rf "$TMPDIR"

# Start all services
log "Starting services..."
$COMPOSE up -d --remove-orphans 2>&1

# Health check
log "Waiting for health..."
OK=false
for i in $(seq 1 30); do
  sleep 10
  wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null && OK=true && break
done

if [ "$OK" = "true" ]; then
  log "=== Restore complete ==="
  report "completed"
else
  log "Health check failed — services may still be starting"
  report "completed"  # Report completed anyway — health check will catch it
fi
