#!/bin/sh
#
# Archive Pod — dump DB + volumes, upload to presigned S3 URL, callback to CP
#
# Usage: archive-pod.sh <presigned-upload-url> <callback-url> <callback-jwt>
#
# Called by pod-agent when CP triggers the "archive" command.
# The script is intentionally defensive — it always reaches the callback step
# even if individual sub-steps fail, so the CP never gets stuck waiting.
#

UPLOAD_URL="$1"
CALLBACK_URL="$2"
CALLBACK_JWT="$3"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="docker compose -p synap -f ${DEPLOY_DIR}/docker-compose.yml"

ARCHIVE="/tmp/pod-archive.tar.gz"
DB_DUMP="/tmp/database.sql.gz"
VOL_ARCHIVE="/tmp/volumes.tar.gz"
UPLOAD_OK="false"
ERROR=""

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [archive] $*"; }

report() {
  STATUS="$1"; ERROR_MSG="$2"
  if [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ]; then
    BODY="{\"command\":\"archive\",\"status\":\"${STATUS}\",\"error\":${ERROR_MSG:-null}}"
    wget -q -O - --timeout=10 \
      --header="Authorization: Bearer ${CALLBACK_JWT}" \
      --header="Content-Type: application/json" \
      --post-data="$BODY" \
      "$CALLBACK_URL" 2>/dev/null || \
    curl -s -X POST -H "Authorization: Bearer ${CALLBACK_JWT}" \
      -H "Content-Type: application/json" -d "$BODY" \
      "$CALLBACK_URL" 2>/dev/null || \
    log "WARN: callback failed (non-fatal)"
  fi
}

cleanup() {
  rm -f "$DB_DUMP" "$VOL_ARCHIVE" "$ARCHIVE"
}

# Always clean up and callback, even on failure
trap 'cleanup; report "failed" "\"unexpected error\""; log "=== Archive aborted ==="' EXIT

log "=== Starting pod archive ==="

# ── Step 1: Stop application services (keep postgres for dump, keep caddy + pod-agent) ──
log "Stopping application services..."
$COMPOSE stop backend realtime redis minio typesense kratos hydra 2>&1 || true

# ── Step 2: Dump database ──
log "Dumping database..."
if $COMPOSE exec -T postgres pg_dumpall -U synap 2>/dev/null | gzip > "$DB_DUMP"; then
  DB_SIZE=$(wc -c < "$DB_DUMP" 2>/dev/null | tr -d ' ')
  log "Database dump complete (${DB_SIZE} bytes compressed)"
else
  log "WARN: Database dump failed — archive will not contain DB data"
  rm -f "$DB_DUMP"
  # Create empty placeholder so tar doesn't fail
  : > "$DB_DUMP"
fi

# ── Step 3: Archive Docker volumes (minio data, typesense data) ──
log "Archiving volumes..."
VOLUME_LIST=$(docker volume ls -q 2>/dev/null | grep -E "minio|typesense" | tr '\n' ' ')
if [ -n "$VOLUME_LIST" ]; then
  # Get volume mount points and tar their _data directories
  VOLUME_PATHS=""
  for vol in $VOLUME_LIST; do
    MOUNT=$(docker volume inspect --format '{{ .Mountpoint }}' "$vol" 2>/dev/null)
    if [ -n "$MOUNT" ] && [ -d "$MOUNT" ]; then
      VOLUME_PATHS="$VOLUME_PATHS $MOUNT"
    fi
  done
  if [ -n "$VOLUME_PATHS" ]; then
    tar czf "$VOL_ARCHIVE" $VOLUME_PATHS 2>/dev/null || true
    VOL_SIZE=$(wc -c < "$VOL_ARCHIVE" 2>/dev/null | tr -d ' ')
    log "Volume archive complete (${VOL_SIZE} bytes compressed)"
  else
    log "WARN: No volume mount points found"
    : > "$VOL_ARCHIVE"
  fi
else
  log "WARN: No minio/typesense volumes found"
  : > "$VOL_ARCHIVE"
fi

# ── Step 4: Bundle everything into a single archive ──
log "Creating final archive..."
tar czf "$ARCHIVE" -C /tmp database.sql.gz volumes.tar.gz 2>&1
ARCHIVE_SIZE=$(wc -c < "$ARCHIVE" 2>/dev/null | tr -d ' ')
log "Final archive: ${ARCHIVE_SIZE} bytes"
rm -f "$DB_DUMP" "$VOL_ARCHIVE"

# ── Step 5: Upload to S3 via presigned PUT URL ──
if [ -n "$UPLOAD_URL" ]; then
  log "Uploading archive to S3..."
  if wget -q --method=PUT --body-file="$ARCHIVE" \
       --header="Content-Type: application/gzip" \
       -O /dev/null "$UPLOAD_URL" 2>&1; then
    UPLOAD_OK="true"
    log "Upload complete (wget)"
  elif curl -sf -X PUT -T "$ARCHIVE" \
       -H "Content-Type: application/gzip" \
       "$UPLOAD_URL" 2>&1; then
    UPLOAD_OK="true"
    log "Upload complete (curl)"
  else
    ERROR="\"upload failed\""
    log "ERROR: Upload failed via both wget and curl"
  fi
else
  ERROR="\"no upload URL provided\""
  log "WARN: No presigned upload URL — skipping upload"
fi

# ── Step 6: Cleanup archive file ──
rm -f "$ARCHIVE"

# ── Step 7: Stop all services (CP will delete the server) ──
log "Stopping all services..."
$COMPOSE stop 2>&1 || true

# ── Step 8: Callback to CP ──
if [ "$UPLOAD_OK" = "true" ]; then
  log "Reporting success to CP"
  # Clear the EXIT trap — we'll report manually
  trap - EXIT
  report "completed" "null"
else
  log "Reporting failure to CP"
  trap - EXIT
  report "failed" "$ERROR"
fi

log "=== Pod archive finished (upload=$UPLOAD_OK) ==="
