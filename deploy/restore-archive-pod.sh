#!/bin/sh
#
# Restore Pod from Archive — downloads archive, restores DB + volumes, starts services
#
# Usage: restore-archive-pod.sh <archive-url> <callback-url> <callback-jwt>
#
# An archive made since D15 is age-encrypted (archive-pod.sh). Its identity
# never comes from the Control Plane: the operator places it on THIS host at
# deploy/state/archive-identity.txt (ARCHIVE_AGE_IDENTITY_FILE overrides)
# before the restore runs. Older plaintext archives still restore as before.
#
set -e

ARCHIVE_URL="$1"
CALLBACK_URL="$2"
CALLBACK_JWT="$3"
CD="$(dirname "$0")"
AGE_IDENTITY_FILE="${ARCHIVE_AGE_IDENTITY_FILE:-$CD/state/archive-identity.txt}"
SYNAP_DEPLOY_DIR="$(cd "$CD" && pwd)"; export SYNAP_DEPLOY_DIR
# shellcheck source=/dev/null
. "$CD/env-config.sh"
PROJECT="$(envcfg_value COMPOSE_PROJECT_NAME)"; PROJECT="${PROJECT:-synap-backend}"
COMPOSE="docker compose -p ${PROJECT} -f $CD/docker-compose.yml"
HELPER_IMAGE="$(envcfg_value SYNAP_IMAGE_POD_AGENT)"
# Containers are created by the HOST engine (host-request.sh): a compose `up`
# run in this container mounts the host's nonexistent /deploy paths.
# shellcheck source=/dev/null
. "$CD/host-request.sh"

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
  host_compose
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
  host_compose
  exit 1
}

# Fatal: report the failure to the CP and exit non-zero. A restore that
# "completed" over a half-restored pod is worse than one that says it failed.
fatal() {
  log "ERROR: $1"
  report "failed" "\"$1\""
  exit 1
}

# Decrypt (D15): an age file starts with this exact header line.
if [ "$(head -c 21 /tmp/pod-archive.tar.gz 2>/dev/null)" = "age-encryption.org/v1" ]; then
  [ -s "$AGE_IDENTITY_FILE" ] \
    || fatal "ARCHIVE_IDENTITY_MISSING — the archive is encrypted; place its age identity at deploy/state/archive-identity.txt and retry"
  command -v age >/dev/null 2>&1 || fatal "ARCHIVE_AGE_UNAVAILABLE — the age binary is not installed"
  age -d -i "$AGE_IDENTITY_FILE" -o /tmp/pod-archive.tar.gz.dec /tmp/pod-archive.tar.gz \
    || { rm -f /tmp/pod-archive.tar.gz.dec; fatal "archive decryption failed (wrong identity?)"; }
  mv -f /tmp/pod-archive.tar.gz.dec /tmp/pod-archive.tar.gz
  log "Archive decrypted"
fi

# Extract
TMPDIR=$(mktemp -d)
tar xzf /tmp/pod-archive.tar.gz -C "$TMPDIR" 2>&1 || fatal "archive extraction failed"
rm -f /tmp/pod-archive.tar.gz
log "Archive extracted"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
# Decide what this archive can restore BEFORE anything is written: a restore
# that replays the database and then refuses the files leaves a half pod.
if [ -f "$TMPDIR/manifest.json" ]; then
  # The dump must be the one the manifest describes.
  want_db="$(sed -n 's/.*"database":{[^}]*"sha256":"\([0-9a-f]*\)".*/\1/p' "$TMPDIR/manifest.json")"
  [ -n "$want_db" ] || fatal "the archive manifest names no database checksum"
  [ -f "$TMPDIR/database.sql.gz" ] && [ "$(sha256_of "$TMPDIR/database.sql.gz")" = "$want_db" ] \
    || fatal "database dump: checksum does not match the manifest"
elif [ -f "$TMPDIR/volumes.tar.gz" ] && [ -s "$TMPDIR/volumes.tar.gz" ]; then
  # A legacy archive (no manifest.json) holds host paths (/var/lib/docker/volumes/…):
  # this script runs in pod-agent, where those paths are not the host's, so
  # extracting here would write the files nowhere the pod reads. Refuse.
  fatal "LEGACY_VOLUME_ARCHIVE — this archive's volumes hold host paths; restore them on the host (tar xzf volumes.tar.gz -C /) with the services stopped"
elif [ "${RESTORE_ALLOW_NO_FILES:-}" != 1 ]; then
  # A legacy archive made inside pod-agent may carry no files at all
  # (an empty volumes.tar.gz): restoring one brings the database back without
  # the files it points to. Never reported "completed" by default.
  fatal "ARCHIVE_WITHOUT_FILES — this archive holds the database but none of the pod's files (a legacy archive); set RESTORE_ALLOW_NO_FILES=1 to restore the database alone"
fi

# Restore PostgreSQL
if [ -f "$TMPDIR/database.sql.gz" ]; then
  log "Restoring database..."
  gzip -t "$TMPDIR/database.sql.gz" 2>/dev/null || fatal "database dump is corrupt"
  [ -s "$TMPDIR/database.sql.gz" ] || fatal "database dump is empty"
  host_compose postgres || fatal "could not start postgres for restore"
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
if [ -f "$TMPDIR/manifest.json" ]; then
  # One tarball per volume, listed in manifest.json with its
  # file count and sha256 (archive-pod.sh). Each is checked, written into the
  # pod's volume (found by its compose labels, created when absent) through a
  # helper container, and the files counted back.
  M="$(cat "$TMPDIR/manifest.json")"
  keys="$(printf '%s\n' "$M" | grep -o '"name":"[a-z0-9_-]*","volume"' | sed 's/"name":"\([^"]*\)".*/\1/')"
  [ -n "$keys" ] || fatal "the archive manifest lists no volumes"
  case "$HELPER_IMAGE" in *@sha256:*) ;; *) fatal "ARCHIVE_HELPER_MISSING — no SYNAP_IMAGE_POD_AGENT digest pin in .env to write the volumes with" ;; esac
  for key in $keys; do
    entry="$(printf '%s\n' "$M" | grep -o "\"name\":\"${key}\",[^}]*}")"
    files="$(printf '%s\n' "$entry" | sed -n 's/.*"files":\([0-9]*\).*/\1/p')"
    want="$(printf '%s\n' "$entry" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')"
    f="$TMPDIR/volumes/${key}.tar.gz"
    [ -s "$f" ] || fatal "volume ${key}: missing from the archive"
    [ "$(sha256_of "$f")" = "$want" ] || fatal "volume ${key}: checksum does not match the manifest"
    vol="$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.volume=${key}")"
    if [ -z "$vol" ]; then
      vol="${PROJECT}_${key}"
      docker volume create --label "com.docker.compose.project=${PROJECT}" --label "com.docker.compose.volume=${key}" "$vol" >/dev/null \
        || fatal "volume ${key}: could not create ${vol}"
    fi
    [ "$(printf '%s\n' "$vol" | grep -c .)" = 1 ] || fatal "volume ${key}: more than one volume of project ${PROJECT}"
    log "Restoring volume ${key} into ${vol} (${files} files)..."
    docker run --rm -i -e V=/v -v "${vol}:/v" --entrypoint sh "$HELPER_IMAGE" \
      -c 'set -e; find "$V" -mindepth 1 -delete; tar xzf - -C "$V"' < "$f" || fatal "volume ${key}: restore failed"
    got="$(docker run --rm -e V=/v -v "${vol}:/v:ro" --entrypoint sh "$HELPER_IMAGE" -c 'set -eo pipefail; find "$V" -type f | wc -l' | tr -d ' ')" \
      || fatal "volume ${key}: could not count the restored files"
    [ "$got" = "$files" ] || fatal "volume ${key}: ${got} files restored, the archive holds ${files}"
  done
  log "Volumes restored"
else
  log "WARN: RESTORE_ALLOW_NO_FILES=1 — the database was restored without the pod's files (the archive holds none)"
fi

rm -rf "$TMPDIR"

# Start all services
log "Starting services..."
host_compose || fatal "could not start services"

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
