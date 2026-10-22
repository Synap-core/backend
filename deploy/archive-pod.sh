#!/bin/sh
#
# Archive Pod — dump DB + volumes, age-encrypt, upload to presigned S3 URL, callback to CP
#
# Usage: ARCHIVE_AGE_RECIPIENTS="age1… [age1…]" \
#          archive-pod.sh <presigned-upload-url> <callback-url> <callback-jwt>
#
# Run ON THE HOST by `synap archive-request` (ARCHIVE_ON_HOST=1) when the CP
# sends pod-agent the "archive" command: pod-agent only writes the request
# (deploy/archive-request.sh). The archive leaves this host ONLY age-encrypted
# (D15) to the recipients in the owner's deploy/state/pod-agent-policy.json
# (`archiveRecipients`), which pod-agent puts in the request. The Control Plane holds no private key:
# only a recipient's identity can open the archive. No recipient, or no `age`
# binary, refuses BEFORE any service is stopped.
# The script is intentionally defensive — it always reaches the callback step
# even if individual sub-steps fail, so the CP never gets stuck waiting.
#
# The archive carries a MANIFEST (manifest.json inside it, and the last stdout
# line `ARCHIVE_MANIFEST {json}`, which pod-agent returns as the result's
# data.archiveManifest and the push callback carries as "manifest"): the
# database dump and every volume in ARCHIVE_VOLUMES with its file count, byte
# size and sha256, plus the encrypted object's size and sha256. The CP deletes
# a server only when the manifest accounts for every expected volume. A volume
# that is missing, unreadable, or archived with fewer files than it holds FAILS
# the archive: an empty volumes archive once passed as success (2026-10-21),
# because this script read host paths it cannot see from inside pod-agent.
#

UPLOAD_URL="$1"
CALLBACK_URL="$2"
CALLBACK_JWT="$3"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNAP_DEPLOY_DIR="$DEPLOY_DIR"; export SYNAP_DEPLOY_DIR
# shellcheck source=/dev/null
. "$DEPLOY_DIR/env-config.sh"
# The pod's compose project (install/update pin it in .env); volumes are found
# by its labels, never by a grep on their names.
PROJECT="$(envcfg_value COMPOSE_PROJECT_NAME)"; PROJECT="${PROJECT:-synap-backend}"
COMPOSE="docker compose -p ${PROJECT} -f ${DEPLOY_DIR}/docker-compose.yml"
# The compose volumes that hold the pod's files (the database is dumped
# separately). The CP expects exactly these (archive-manifest.ts EXPECTED_ARCHIVE_VOLUMES).
ARCHIVE_VOLUMES="${ARCHIVE_VOLUMES:-minio_data typesense_data}"
# Volumes are read through a throwaway container of an image this pod already
# has (pod-agent's pinned image: busybox find/stat/tar), mounted read-only.
HELPER_IMAGE="$(envcfg_value SYNAP_IMAGE_POD_AGENT)"
# Containers are created by the HOST engine (host-request.sh): a compose `up`
# run in this container mounts the host's nonexistent /deploy paths.
# shellcheck source=/dev/null
. "$DEPLOY_DIR/host-request.sh"

WORK="${ARCHIVE_WORK_DIR:-/tmp}"
ARCHIVE="${WORK}/pod-archive.tar.gz"
ARCHIVE_AGE="${ARCHIVE}.age"
DB_DUMP="${WORK}/database.sql.gz"
DB_RAW="${WORK}/database.sql"
VOL_DIR="${WORK}/volumes"
MANIFEST="${WORK}/manifest.json"
UPLOAD_OK="false"
ERROR=""

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [archive] $*"; }

report() {
  STATUS="$1"; ERROR_MSG="$2"
  if [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ]; then
    BODY="{\"command\":\"archive\",\"status\":\"${STATUS}\",\"error\":${ERROR_MSG:-null}${3:+,\"manifest\":$3}}"
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
  rm -rf "$DB_DUMP" "$DB_RAW" "$VOL_DIR" "$MANIFEST" "$ARCHIVE" "$ARCHIVE_AGE"
}

sha256_of() { # <file>
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
size_of() { wc -c < "$1" | tr -d ' '; }

# Run <script> in a throwaway helper container with <volume> read-only at $V.
in_volume() { # <volume> <script>
  docker run --rm -e V=/v -v "$1:/v:ro" --entrypoint sh "$HELPER_IMAGE" -c "set -eo pipefail; $2"
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
case "$HELPER_IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) log "ERROR: ARCHIVE_HELPER_MISSING — no SYNAP_IMAGE_POD_AGENT digest pin in .env to read the volumes with; nothing stopped, nothing uploaded"
     report "failed" "\"ARCHIVE_HELPER_MISSING\""; exit 1 ;;
esac
# age: the binary here (pod-agent's image ships it), else — on the host, where
# `synap archive-request` runs this script — the same binary from the pinned
# helper image, reading the plaintext on stdin.
encrypt() { # <in> <out>
  # shellcheck disable=SC2086 # AGE_ARGS is "-r age1… -r age1…", validated above
  if command -v age >/dev/null 2>&1; then age $AGE_ARGS -o "$2" "$1"
  else docker run --rm -i --entrypoint age "$HELPER_IMAGE" $AGE_ARGS < "$1" > "$2"; fi
}
if ! command -v age >/dev/null 2>&1 && [ "${ARCHIVE_ON_HOST:-}" != 1 ]; then
  log "ERROR: ARCHIVE_AGE_UNAVAILABLE — the age binary is not installed; nothing stopped, nothing uploaded"
  report "failed" "\"ARCHIVE_AGE_UNAVAILABLE\""
  exit 1
fi

# Always clean up and callback, even on failure
trap 'cleanup; report "failed" "\"unexpected error\""; log "=== Archive aborted ==="' EXIT

log "=== Starting pod archive ==="

# ── Step 1: Stop application services (keep postgres for dump, keep caddy + pod-agent) ──
log "Stopping application services..."
STOPPED="backend realtime redis minio typesense kratos"
# shellcheck disable=SC2086
$COMPOSE stop $STOPPED 2>&1 || true

# ── Step 2: Dump database ──
log "Dumping database..."
# Dump to a plain file FIRST, then gzip: in `pg_dumpall | gzip` the pipeline's
# exit status is gzip's, so a failed pg_dumpall used to look like success.
# An empty/zero-byte dump is also a failure — never archive a placeholder.
dump_failed() {
  log "ERROR: $1 — aborting archive (nothing uploaded, pod kept running)"
  cleanup
  # Step 1 stopped the app services; bring them back so the pod stays usable.
  # On the host (synap archive-request) they are started directly: the host
  # door holds the update lock, so a compose request would wait on it.
  if [ "${ARCHIVE_ON_HOST:-}" = 1 ]; then
    # shellcheck disable=SC2086
    $COMPOSE start $STOPPED 2>&1 || log "WARN: could not restart services after failed dump"
  else
    host_compose || log "WARN: could not restart services after failed dump"
  fi
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

# ── Step 3: Archive the pod's volumes, one tarball each, counted ──
# Each volume is found by its compose labels (this project, this volume key):
# exactly one must exist. It is read through a helper container (the volume
# mounted read-only), so this works from inside pod-agent and from the host.
# Its regular files are counted and summed, then tarred; the tarball must hold
# exactly that many files. Anything else fails the archive — empty is only
# ever reported as such ("empty": true, 0 files), never a silent placeholder.
log "Archiving volumes (${ARCHIVE_VOLUMES})..."
mkdir -p "$VOL_DIR" || dump_failed "cannot create ${VOL_DIR}"
VOL_JSON=""
for key in $ARCHIVE_VOLUMES; do
  vols="$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.volume=${key}")" \
    || dump_failed "could not list the docker volumes"
  n="$(printf '%s\n' "$vols" | grep -c .)"
  [ "$n" = 1 ] || dump_failed "volume ${key} of project ${PROJECT}: found ${n} (expected exactly 1)"
  stats="$(in_volume "$vols" 'cd "$V"; find . -type f | wc -l; find . -type f -exec stat -c %s {} + | awk "{s+=\$1} END {print s+0}"')" \
    || dump_failed "volume ${key} (${vols}) could not be read"
  files="$(printf '%s\n' "$stats" | sed -n 1p | tr -d ' ')"; bytes="$(printf '%s\n' "$stats" | sed -n 2p | tr -d ' ')"
  case "${files}:${bytes}" in *[!0-9:]*|:*|*:) dump_failed "volume ${key}: unreadable counts (${stats})" ;; esac
  out="${VOL_DIR}/${key}.tar.gz"
  in_volume "$vols" 'tar czf - -C "$V" .' > "$out" || dump_failed "volume ${key} (${vols}) could not be archived"
  got="$(tar tzvf "$out" 2>/dev/null | grep -c '^-')" || true
  [ "$got" = "$files" ] || dump_failed "volume ${key}: the archive holds ${got:-0} files, the volume ${files}"
  empty=false; note=""
  [ "$files" = 0 ] && { empty=true; note=" — EMPTY"; }
  log "  ${key} (${vols}): ${files} files, ${bytes} bytes${note}"
  VOL_JSON="${VOL_JSON:+${VOL_JSON},}{\"name\":\"${key}\",\"volume\":\"${vols}\",\"file\":\"volumes/${key}.tar.gz\",\"files\":${files},\"bytes\":${bytes},\"sha256\":\"$(sha256_of "$out")\",\"empty\":${empty}}"
done
CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
MANIFEST_BODY="\"schema\":1,\"project\":\"${PROJECT}\",\"createdAt\":\"${CREATED_AT}\",\"database\":{\"file\":\"database.sql.gz\",\"bytes\":${DB_SIZE},\"sha256\":\"$(sha256_of "$DB_DUMP")\"},\"volumes\":[${VOL_JSON}]"
printf '{%s}\n' "$MANIFEST_BODY" > "$MANIFEST" || dump_failed "could not write the manifest"

# ── Step 4: Bundle everything into a single archive ──
log "Creating final archive..."
tar czf "$ARCHIVE" -C "$WORK" manifest.json database.sql.gz volumes 2>&1 || dump_failed "could not bundle the archive"
ARCHIVE_SIZE=$(wc -c < "$ARCHIVE" 2>/dev/null | tr -d ' ')
log "Final archive: ${ARCHIVE_SIZE} bytes"
rm -rf "$DB_DUMP" "$VOL_DIR" "$MANIFEST"

# ── Step 4b: Encrypt (D15) — the plaintext never leaves this host ──
log "Encrypting archive with age..."
if ! encrypt "$ARCHIVE" "$ARCHIVE_AGE" || [ ! -s "$ARCHIVE_AGE" ]; then
  dump_failed "archive encryption failed"
fi
rm -f "$ARCHIVE"
log "Encrypted archive: $(size_of "$ARCHIVE_AGE") bytes"
MANIFEST_JSON="{${MANIFEST_BODY},\"archive\":{\"bytes\":$(size_of "$ARCHIVE_AGE"),\"sha256\":\"$(sha256_of "$ARCHIVE_AGE")\"}}"

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
  report "completed" "null" "$MANIFEST_JSON"
else
  log "Reporting failure to CP"
  trap - EXIT
  report "failed" "$ERROR"
fi

log "=== Pod archive finished (upload=$UPLOAD_OK) ==="
[ "$UPLOAD_OK" = "true" ] || exit 1
# The last line: pod-agent returns it as the result's data.archiveManifest.
echo "ARCHIVE_MANIFEST ${MANIFEST_JSON}"
