#!/usr/bin/env bash
# Tripwire: archive-pod.sh / restore-archive-pod.sh must FAIL (non-zero exit AND
# status "failed" to the CP callback) when the data did not make it.
#   archive : failed or empty DB dump -> no upload of a placeholder, no "completed"
#   restore : failed DB replay, failed volume restore, failed health check -> fail
# Runs the REAL scripts against fake docker/wget/curl on PATH (daemon-free).
# Override SCRIPT_DIR to point at a different copy (used for the negative control).
#   D15     : an archive leaves the host ONLY age-encrypted (no recipient refuses
#             before any service stops); an encrypted archive restores with its
#             identity and refuses without it; a legacy plaintext one still restores
# Not covered: real pg_dumpall / psql behaviour; only the scripts' handling of
# their exit codes and stderr. `age` is a STUB on PATH (header line + recipient
# line + payload; decrypt needs an existing -i file and strips both lines) — it
# proves the scripts call age and ship its output, not age's cryptography.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="${SCRIPT_DIR:-$HERE}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case "$*" in
  *"pg_dumpall"*)
    case "${DUMP_MODE:-ok}" in
      ok) echo "CREATE ROLE synap;" ;;
      fail) echo "partial"; exit 1 ;;
      empty) : ;;
    esac ;;
  *"psql"*)
    cat >/dev/null
    case "${PSQL_MODE:-ok}" in
      ok) : ;;
      connfail) echo "psql: connection refused" >&2; exit 2 ;;
      sqlerr) echo 'ERROR:  relation "x" does not exist' >&2 ;;
      exists) echo 'ERROR:  role "synap" already exists' >&2 ;;
    esac ;;
  *"volume ls"*) [ -n "${VOL_MODE:-}" ] && echo "pod_minio_data" ;;
  *"volume inspect"*) echo "$FAKE_VOL_DIR" ;;
esac
exit 0
D
cat > "$TMP/bin/wget" <<'D'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do
  case "$a" in
    --post-data=*) echo "${a#--post-data=}" >> "$CB_LOG"; exit 0 ;;
    --method=PUT)
      # Record what went up: the body file's name and its first line.
      for b in "$@"; do case "$b" in --body-file=*)
        f="${b#--body-file=}"; echo "PUT $f $(head -n 1 "$f")" >> "$UPLOAD_LOG"; cp "$f" "$UPLOADED" ;;
      esac; done
      exit 0 ;;
  esac
  [ "$prev" = "-O" ] && out="$a"; prev="$a"
done
case "$*" in
  *"/health"*) exit "${HEALTH_RC:-0}" ;;
  *) [ -n "$out" ] && [ "$out" != "/dev/null" ] && cp "$FAKE_ARCHIVE" "$out"; exit 0 ;;
esac
D
cat > "$TMP/bin/curl" <<'D'
#!/usr/bin/env bash
echo "curl $*" >> "$UPLOAD_LOG"; exit 0
D
cat > "$TMP/bin/age" <<'D'
#!/usr/bin/env bash
out=""; in=""; dec=0; id=""; rcpt=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; -r) rcpt="$rcpt $2"; shift 2 ;; -i) id="$2"; shift 2 ;; -d) dec=1; shift ;; *) in="$1"; shift ;; esac
done
if [ "$dec" = 1 ]; then
  [ -s "$id" ] || { echo "age: no identity" >&2; exit 1; }
  tail -n +3 "$in" > "$out"
else
  { echo "age-encryption.org/v1"; echo "-> stub$rcpt"; cat "$in"; } > "$out"
fi
D
# tar wrapper: simulate an exit code ONLY for the volume archive, real tar otherwise.
cat > "$TMP/bin/tar" <<'D'
#!/usr/bin/env bash
if [ -n "${VOL_TAR_RC:-}" ] && [[ "$*" == *volumes.tar.gz*"$FAKE_VOL_DIR"* ]]; then
  [ "$VOL_TAR_RC" = 1 ] && /usr/bin/env -i PATH=/usr/bin:/bin tar "$@" 2>/dev/null
  exit "$VOL_TAR_RC"
fi
exec /usr/bin/env -i PATH=/usr/bin:/bin tar "$@"
D
chmod +x "$TMP/bin"/*
export CB_LOG="$TMP/cb" UPLOAD_LOG="$TMP/up" FAKE_ARCHIVE="$TMP/fake.tar.gz"
export DOCKER_LOG="$TMP/docker" UPLOADED="$TMP/uploaded"
# D15: the happy paths archive to one (stub) age recipient.
RECIPIENT="age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
export ARCHIVE_AGE_RECIPIENTS="$RECIPIENT"
export ARCHIVE_AGE_IDENTITY_FILE="$TMP/identity.txt"; echo "AGE-SECRET-KEY-1TESTONLY" > "$ARCHIVE_AGE_IDENTITY_FILE"
export ARCHIVE_WORK_DIR="$TMP/work"; mkdir -p "$ARCHIVE_WORK_DIR"
export RESTORE_PG_WAIT_SECS=0 RESTORE_HEALTH_INTERVAL=0 RESTORE_HEALTH_TRIES=2

# The scripts run from a COPY of the deploy dir: they hand every container
# start to the host (host-request.sh → state/requests/compose.json), and that
# state must land here, never in the checkout. A fake HOST takes each request,
# logs it as "host-compose <services>" (empty = every service) and records
# success, the way `synap compose-request` does (host-compose-request.test.sh
# covers the real host side).
D="$TMP/deploy"; mkdir -p "$D"
cp "$SCRIPT_DIR"/*.sh "$SCRIPT_DIR/docker-compose.yml" "$D/"
export HOST_REQUEST_POLL_SECONDS=1 HOST_REQUEST_PICKUP_SECONDS=10
fake_host() {
  while :; do
    if [ -f "$D/state/requests/compose.json" ] && mv -f "$D/state/requests/compose.json" "$D/state/requests/taken.json" 2>/dev/null; then
      id="$(jq -r .id "$D/state/requests/taken.json")"
      echo "host-compose $(jq -r '.services | join(" ")' "$D/state/requests/taken.json")" >> "$DOCKER_LOG"
      printf '{"kind":"pod.compose-request","status":"succeeded","request":"%s","reason":""}\n' "$id" > "$D/state/last-compose-request.json"
    fi
    sleep 0.2
  done
}
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }
fake_host & HOST_PID=$!; disown "$HOST_PID" 2>/dev/null
trap 'kill "$HOST_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

reset() { : > "$CB_LOG"; : > "$UPLOAD_LOG"; : > "$DOCKER_LOG"; rm -f "$UPLOADED"; }
last_status() { grep -o '"status":"[a-z]*"' "$CB_LOG" | tail -1; }
run_archive() { reset; ( PATH="$TMP/bin:$PATH"; sh "$D/archive-pod.sh" http://up http://cb jwt ) >"$TMP/out" 2>&1; }
run_restore() { reset; ( PATH="$TMP/bin:$PATH"; sh "$D/restore-archive-pod.sh" http://arch http://cb jwt ) >"$TMP/out" 2>&1; }

# ── archive ──
DUMP_MODE=ok run_archive; rc=$?
[ $rc -eq 0 ] && ok "archive: good dump -> exit 0" || bad "archive: good dump exited $rc"
[ "$(last_status)" = '"status":"completed"' ] && ok "archive: good dump reports completed" || bad "archive: good dump status=$(last_status)"
grep -q PUT "$UPLOAD_LOG" && ok "archive: good dump uploads" || bad "archive: good dump did not upload"
# D15: what went up is the age file, never the plaintext tarball.
grep -qE '^PUT [^ ]+\.tar\.gz\.age age-encryption\.org/v1$' "$UPLOAD_LOG" \
  && ok "archive: uploads the .age file (age header)" || bad "archive: upload is not the age file: $(cat "$UPLOAD_LOG")"
grep -qE '^PUT [^ ]+\.tar\.gz ' "$UPLOAD_LOG" && bad "archive: uploaded a plaintext tarball" || ok "archive: no plaintext tarball uploaded"
[ -z "$(ls -A "$ARCHIVE_WORK_DIR")" ] && ok "archive: no plaintext left in the work dir" || bad "archive: left $(ls "$ARCHIVE_WORK_DIR")"
cp "$UPLOADED" "$TMP/encrypted.age" 2>/dev/null

# D15: no recipient → typed refusal BEFORE anything stops, nothing uploaded.
( unset ARCHIVE_AGE_RECIPIENTS; DUMP_MODE=ok run_archive ); rc=$?
[ $rc -ne 0 ] && ok "archive[no recipient]: non-zero exit" || bad "archive[no recipient]: exited 0"
grep -q ARCHIVE_RECIPIENT_MISSING "$CB_LOG" && ok "archive[no recipient]: reports ARCHIVE_RECIPIENT_MISSING" || bad "archive[no recipient]: callback=$(cat "$CB_LOG")"
grep -q stop "$DOCKER_LOG" && bad "archive[no recipient]: stopped services first" || ok "archive[no recipient]: nothing stopped"
[ ! -s "$UPLOAD_LOG" ] && ok "archive[no recipient]: nothing uploaded" || bad "archive[no recipient]: uploaded"

for mode in fail empty; do
  DUMP_MODE=$mode run_archive; rc=$?
  [ $rc -ne 0 ] && ok "archive[$mode]: non-zero exit" || bad "archive[$mode]: exited 0"
  [ "$(last_status)" = '"status":"failed"' ] && ok "archive[$mode]: reports failed" || bad "archive[$mode]: status=$(last_status)"
  grep -q '"completed"' "$CB_LOG" && bad "archive[$mode]: reported completed" || ok "archive[$mode]: never reports completed"
  [ ! -s "$UPLOAD_LOG" ] && ok "archive[$mode]: nothing uploaded" || bad "archive[$mode]: uploaded a placeholder"
  grep -qx 'host-compose ' "$DOCKER_LOG" && ! grep -qE '(^| )up( |$)' "$DOCKER_LOG" \
    && ok "archive[$mode]: services are brought back by the HOST, not from the agent" || bad "archive[$mode]: restart path: $(cat "$DOCKER_LOG" | tr '\n' '|')"
done

# ── archive: volumes (minio/typesense) ──
export FAKE_VOL_DIR="$TMP/vol"; mkdir -p "$FAKE_VOL_DIR"; echo data > "$FAKE_VOL_DIR/obj"
VOL_MODE=1 run_archive; rc=$?
[ $rc -eq 0 ] && [ "$(last_status)" = '"status":"completed"' ] && ok "archive[volumes ok]: completed" || bad "archive[volumes ok]: rc=$rc status=$(last_status)"
VOL_MODE=1 VOL_TAR_RC=2 run_archive; rc=$?
[ $rc -ne 0 ] && ok "archive[volume tar fatal]: non-zero exit" || bad "archive[volume tar fatal]: exited 0"
[ ! -s "$UPLOAD_LOG" ] && ok "archive[volume tar fatal]: nothing uploaded" || bad "archive[volume tar fatal]: uploaded without its files"
grep -q '"completed"' "$CB_LOG" && bad "archive[volume tar fatal]: reported completed" || ok "archive[volume tar fatal]: never reports completed"
VOL_MODE=1 VOL_TAR_RC=1 run_archive; rc=$?
[ $rc -eq 0 ] && [ "$(last_status)" = '"status":"completed"' ] && ok "archive[tar exit 1]: survivable, completed" || bad "archive[tar exit 1]: rc=$rc status=$(last_status)"
unset VOL_MODE VOL_TAR_RC

# ── restore: D15 round trip of the archive made above ──
if [ -s "$TMP/encrypted.age" ]; then
  cp "$TMP/encrypted.age" "$FAKE_ARCHIVE"
  HEALTH_RC=0 PSQL_MODE=ok run_restore; rc=$?
  [ $rc -eq 0 ] && [ "$(last_status)" = '"status":"completed"' ] && grep -q "Archive decrypted" "$TMP/out" \
    && ok "restore[encrypted + identity]: decrypted and completed" || bad "restore[encrypted + identity]: rc=$rc status=$(last_status): $(tail -3 "$TMP/out")"
  ( export ARCHIVE_AGE_IDENTITY_FILE="$TMP/no-identity.txt"; HEALTH_RC=0 PSQL_MODE=ok run_restore ); rc=$?
  [ $rc -ne 0 ] && grep -q ARCHIVE_IDENTITY_MISSING "$CB_LOG" \
    && ok "restore[encrypted, no identity]: refuses with ARCHIVE_IDENTITY_MISSING" || bad "restore[encrypted, no identity]: rc=$rc cb=$(cat "$CB_LOG")"
else
  bad "restore[encrypted]: no encrypted archive was produced to restore"
fi

# ── restore (legacy plaintext archives, pre-D15) ──
mkdir -p "$TMP/pk"; echo "CREATE ROLE synap;" | gzip > "$TMP/pk/database.sql.gz"
: > "$TMP/pk/volumes.tar.gz"
tar czf "$FAKE_ARCHIVE" -C "$TMP/pk" database.sql.gz volumes.tar.gz

HEALTH_RC=0 PSQL_MODE=ok run_restore; rc=$?
[ $rc -eq 0 ] && [ "$(last_status)" = '"status":"completed"' ] && ok "restore: clean -> exit 0 + completed" || bad "restore: clean rc=$rc status=$(last_status): $(tail -3 "$TMP/out")"
grep -qx 'host-compose postgres' "$DOCKER_LOG" && grep -qx 'host-compose ' "$DOCKER_LOG" && ! grep -qE '(^| )up( |$)' "$DOCKER_LOG" \
  && ok "restore: postgres, then every service, are started by the HOST (none by the agent)" || bad "restore: start path: $(cat "$DOCKER_LOG" | tr '\n' '|')"
HEALTH_RC=0 PSQL_MODE=exists run_restore; rc=$?
[ $rc -eq 0 ] && ok "restore: 'already exists' notice is allow-listed" || bad "restore: 'already exists' was fatal (rc=$rc)"

for mode in connfail sqlerr; do
  HEALTH_RC=0 PSQL_MODE=$mode run_restore; rc=$?
  [ $rc -ne 0 ] && ok "restore[db $mode]: non-zero exit" || bad "restore[db $mode]: exited 0"
  [ "$(last_status)" = '"status":"failed"' ] && ok "restore[db $mode]: reports failed" || bad "restore[db $mode]: status=$(last_status)"
done

HEALTH_RC=1 PSQL_MODE=ok run_restore; rc=$?
[ $rc -ne 0 ] && ok "restore[health]: non-zero exit" || bad "restore[health]: exited 0"
[ "$(last_status)" = '"status":"failed"' ] && ok "restore[health]: reports failed" || bad "restore[health]: status=$(last_status)"
grep -q '"completed"' "$CB_LOG" && bad "restore[health]: reported completed" || ok "restore[health]: never reports completed"

echo "not a tarball" > "$TMP/pk/volumes.tar.gz"
tar czf "$FAKE_ARCHIVE" -C "$TMP/pk" database.sql.gz volumes.tar.gz
HEALTH_RC=0 PSQL_MODE=ok run_restore; rc=$?
[ $rc -ne 0 ] && ok "restore[volumes]: non-zero exit" || bad "restore[volumes]: exited 0"
[ "$(last_status)" = '"status":"failed"' ] && ok "restore[volumes]: reports failed" || bad "restore[volumes]: status=$(last_status)"

exit $fail
