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
COMPOSE="docker compose -p synap-backend -f $CD/docker-compose.yml"

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

# Fatal: report the failure to the CP and exit non-zero. A restore that
# "completed" over a half-restored pod is worse than one that says it failed.
fatal() {
  log "ERROR: $1"
  report "failed" "\"$1\""
  exit 1
}

# Extract
TMPDIR=$(mktemp -d)
tar xzf /tmp/pod-archive.tar.gz -C "$TMPDIR" 2>&1 || fatal "archive extraction failed"
rm -f /tmp/pod-archive.tar.gz
log "Archive extracted"

# Restore PostgreSQL
if [ -f "$TMPDIR/database.sql.gz" ]; then
  log "Restoring database..."
  gzip -t "$TMPDIR/database.sql.gz" 2>/dev/null || fatal "database dump is corrupt"
  [ -s "$TMPDIR/database.sql.gz" ] || fatal "database dump is empty"
  $COMPOSE up -d postgres 2>&1 || fatal "could not start postgres for restore"
  sleep "${RESTORE_PG_WAIT_SECS:-10}"
  PSQL_ERR="$TMPDIR/psql.err"
  # psql keeps going past SQL errors, so a non-zero exit means the replay could
  # not run at all (connection lost, etc.) — fatal.
  zcat "$TMPDIR/database.sql.gz" | $COMPOSE exec -T postgres psql -U synap >/dev/null 2>"$PSQL_ERR" \
    || fatal "database replay failed"
  # Allow-list: a pg_dumpall replay onto an initialised postgres always emits
  # "already exists" for the built-in role/database (e.g. role "synap"). That is
  # harmless. Any OTHER ERROR line means data did not land — fatal.
  if grep 'ERROR' "$PSQL_ERR" | grep -v 'already exists' | grep -q .; then
    fatal "database replay reported errors: $(grep 'ERROR' "$PSQL_ERR" | grep -v 'already exists' | head -1 | tr -d '"\\')"
  fi
  log "Database restored"
fi

# Restore volumes
if [ -f "$TMPDIR/volumes.tar.gz" ]; then
  if [ -s "$TMPDIR/volumes.tar.gz" ]; then
    log "Restoring volumes..."
    tar xzf "$TMPDIR/volumes.tar.gz" -C / 2>&1 || fatal "volume restore failed"
    log "Volumes restored"
  else
    # archive-pod.sh writes a zero-byte volumes.tar.gz when the pod had no
    # minio/typesense volumes: nothing to restore, not an error.
    log "Volume archive is empty (pod had no volumes) — skipping"
  fi
fi

rm -rf "$TMPDIR"

# Start all services
log "Starting services..."
$COMPOSE up -d --remove-orphans 2>&1 || fatal "could not start services"

# Health check
log "Waiting for health..."
OK=false
for i in $(seq 1 "${RESTORE_HEALTH_TRIES:-30}"); do
  sleep "${RESTORE_HEALTH_INTERVAL:-10}"
  wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null && OK=true && break
done

if [ "$OK" = "true" ]; then
  log "=== Restore complete ==="
  report "completed"
else
  fatal "health check failed after restore"
fi
