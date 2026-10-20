#!/bin/sh
#
# Archive Pod — dump DB + volumes, age-encrypt, upload to presigned S3 URL, callback to CP
#
# Usage: ARCHIVE_AGE_RECIPIENTS="age1… [age1…]" \
#          archive-pod.sh <presigned-upload-url> <callback-url> <callback-jwt>
#
# Called by pod-agent when CP triggers the "archive" command. The archive
# leaves this host ONLY age-encrypted (D15) to the recipients in the owner's
# deploy/state/pod-agent-policy.json (`archiveRecipients`), which pod-agent
# passes as ARCHIVE_AGE_RECIPIENTS. The Control Plane holds no private key:
# only a recipient's identity can open the archive. No recipient, or no `age`
# binary, refuses BEFORE any service is stopped.
# The script is intentionally defensive — it always reaches the callback step
# even if individual sub-steps fail, so the CP never gets stuck waiting.
#

UPLOAD_URL="$1"
CALLBACK_URL="$2"
CALLBACK_JWT="$3"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="docker compose -p synap-backend -f ${DEPLOY_DIR}/docker-compose.yml"
# Containers are created by the HOST engine (host-request.sh): a compose `up`
# run in this container mounts the host's nonexistent /deploy paths.
SYNAP_DEPLOY_DIR="$DEPLOY_DIR"; export SYNAP_DEPLOY_DIR
# shellcheck source=/dev/null
. "$DEPLOY_DIR/host-request.sh"

WORK="${ARCHIVE_WORK_DIR:-/tmp}"
ARCHIVE="${WORK}/pod-archive.tar.gz"
ARCHIVE_AGE="${ARCHIVE}.age"
DB_DUMP="${WORK}/database.sql.gz"
DB_RAW="${WORK}/database.sql"
VOL_ARCHIVE="${WORK}/volumes.tar.gz"
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
  rm -f "$DB_DUMP" "$DB_RAW" "$VOL_ARCHIVE" "$ARCHIVE" "$ARCHIVE_AGE"
}

# ── Step 0: the archive must be encryptable, or nothing happens (D15) ──
# Recipients are validated by pod-agent (age1… only); re-checked here so the
# script never uploads plaintext even when run by hand.
AGE_ARGS=""
for r in ${ARCHIVE_AGE_RECIPIENTS:-}; do
  case "$r" in
    age1*) AGE_ARGS="$AGE_ARGS -r $r" ;;
    *) log "ERROR: ARCHIVE_RECIPIENT_INVALID — not an age recipient"
       report "failed" "\"ARCHIVE_RECIPIENT_INVALID\""; exit 1 ;;
  esac
done
if [ -z "$AGE_ARGS" ]; then
  log "ERROR: ARCHIVE_RECIPIENT_MISSING — no archiveRecipients in deploy/state/pod-agent-policy.json; nothing stopped, nothing uploaded"
  report "failed" "\"ARCHIVE_RECIPIENT_MISSING\""
  exit 1
fi
if ! command -v age >/dev/null 2>&1; then
  log "ERROR: ARCHIVE_AGE_UNAVAILABLE — the age binary is not installed; nothing stopped, nothing uploaded"
  report "failed" "\"ARCHIVE_AGE_UNAVAILABLE\""
  exit 1
fi

# Always clean up and callback, even on failure
trap 'cleanup; report "failed" "\"unexpected error\""; log "=== Archive aborted ==="' EXIT

log "=== Starting pod archive ==="

# ── Step 1: Stop application services (keep postgres for dump, keep caddy + pod-agent) ──
log "Stopping application services..."
$COMPOSE stop backend realtime redis minio typesense kratos 2>&1 || true

# ── Step 2: Dump database ──
log "Dumping database..."
# Dump to a plain file FIRST, then gzip: in `pg_dumpall | gzip` the pipeline's
# exit status is gzip's, so a failed pg_dumpall used to look like success.
# An empty/zero-byte dump is also a failure — never archive a placeholder.
dump_failed() {
  log "ERROR: $1 — aborting archive (nothing uploaded, pod kept running)"
  cleanup
  # Step 1 stopped the app services; bring them back so the pod stays usable.
  host_compose || log "WARN: could not restart services after failed dump"
  trap - EXIT
  report "failed" "\"$1\""
  log "=== Pod archive finished (upload=false) ==="
  exit 1
}

if ! $COMPOSE exec -T postgres pg_dumpall -U synap > "$DB_RAW" 2>/dev/null; then
  dump_failed "database dump failed"
fi
if [ ! -s "$DB_RAW" ]; then
  dump_failed "database dump is empty"
fi
if ! gzip -c "$DB_RAW" > "$DB_DUMP" || [ ! -s "$DB_DUMP" ]; then
  dump_failed "database dump compression failed"
fi
rm -f "$DB_RAW"
DB_SIZE=$(wc -c < "$DB_DUMP" 2>/dev/null | tr -d ' ')
log "Database dump complete (${DB_SIZE} bytes compressed)"

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
    # GNU tar: 1 = "file changed as we read it" (survivable — services are
    # stopped, so this is a straggler write); >=2 = fatal. A fatal error used to
    # be swallowed (`|| true`) and the pod archived WITHOUT its files.
    tar czf "$VOL_ARCHIVE" $VOLUME_PATHS 2>/dev/null; tar_rc=$?
    if [ "$tar_rc" -ge 2 ] || [ ! -s "$VOL_ARCHIVE" ]; then
      dump_failed "volume archive failed (tar exit $tar_rc)"
    elif [ "$tar_rc" -eq 1 ]; then
      log "WARN: tar reported files changed while archiving volumes (exit 1) — archive kept"
    fi
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
tar czf "$ARCHIVE" -C "$WORK" database.sql.gz volumes.tar.gz 2>&1
ARCHIVE_SIZE=$(wc -c < "$ARCHIVE" 2>/dev/null | tr -d ' ')
log "Final archive: ${ARCHIVE_SIZE} bytes"
rm -f "$DB_DUMP" "$VOL_ARCHIVE"

# ── Step 4b: Encrypt (D15) — the plaintext never leaves this host ──
log "Encrypting archive with age..."
# shellcheck disable=SC2086 # AGE_ARGS is "-r age1… -r age1…", validated above
if ! age $AGE_ARGS -o "$ARCHIVE_AGE" "$ARCHIVE" || [ ! -s "$ARCHIVE_AGE" ]; then
  dump_failed "archive encryption failed"
fi
rm -f "$ARCHIVE"
log "Encrypted archive: $(wc -c < "$ARCHIVE_AGE" 2>/dev/null | tr -d ' ') bytes"

# ── Step 5: Upload to S3 via presigned PUT URL ──
if [ -n "$UPLOAD_URL" ]; then
  log "Uploading archive to S3..."
  if wget -q --method=PUT --body-file="$ARCHIVE_AGE" \
       --header="Content-Type: application/octet-stream" \
       -O /dev/null "$UPLOAD_URL" 2>&1; then
    UPLOAD_OK="true"
    log "Upload complete (wget)"
  elif curl -sf -X PUT -T "$ARCHIVE_AGE" \
       -H "Content-Type: application/octet-stream" \
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
rm -f "$ARCHIVE" "$ARCHIVE_AGE"

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
[ "$UPLOAD_OK" = "true" ] || exit 1
