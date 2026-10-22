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
#   volumes : each volume in ARCHIVE_VOLUMES is found by its compose LABELS
#             (project + volume key; a same-named volume of another project is
#             never read), read through a helper container, counted, and listed
#             in the manifest. Missing, duplicated, unreadable or short-archived
#             -> fail, nothing uploaded. Empty -> "empty": true, never silent.
#             Restore writes each volume back and counts its files.
# The fake docker MODELS volumes: $FAKE_VOLS/<name>/ is a volume's content,
# <name>.labels its labels; `docker run -v <name>:/v` runs the script with
# V=<that dir> (no host path is ever read by the script itself).
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
  "volume ls"*)
    p="$(printf '%s\n' "$*" | sed -n 's/.*com.docker.compose.project=\([^ ]*\).*/\1/p')"
    k="$(printf '%s\n' "$*" | sed -n 's/.*com.docker.compose.volume=\([^ ]*\).*/\1/p')"
    for f in "$FAKE_VOLS"/*.labels; do
      [ -e "$f" ] || continue
      grep -qx "project=$p" "$f" && grep -qx "volume=$k" "$f" && basename "$f" .labels
    done ;;
  "volume create"*)
    name="${*: -1}"; mkdir -p "$FAKE_VOLS/$name"; : > "$FAKE_VOLS/$name.labels"
    for a in "$@"; do case "$a" in com.docker.compose.project=*) echo "project=${a#*=}" >> "$FAKE_VOLS/$name.labels" ;;
      com.docker.compose.volume=*) echo "volume=${a#*=}" >> "$FAKE_VOLS/$name.labels" ;; esac; done ;;
  "run "*)
    vol=""; prev=""; for a in "$@"; do [ "$prev" = "-v" ] && vol="${a%%:*}"; prev="$a"; done
    script="${*: -1}"
    [ -d "$FAKE_VOLS/$vol" ] || { echo "no such volume: $vol" >&2; exit 1; }
    [ -e "$FAKE_VOLS/$vol.unreadable" ] && { echo "tar: ./obj: Permission denied" >&2; exit 1; }
    src="$FAKE_VOLS/$vol"
    if [ -e "$FAKE_VOLS/$vol.short" ] && [[ "$script" == *"tar czf"* ]]; then   # a tar that drops a file
      src="$(mktemp -d)"; cp -R "$FAKE_VOLS/$vol/." "$src/"; rm -f "$(find "$src" -type f | head -1)"
    fi
    V="$src" exec bash -c "$script" ;;
esac
exit 0
D
# busybox `stat -c %s` (the helper image) on a BSD host
cat > "$TMP/bin/stat" <<'D'
#!/usr/bin/env bash
if [ "$1" = -c ] && ! /usr/bin/env -i PATH=/usr/bin:/bin stat -c %s / >/dev/null 2>&1; then shift 2; exec /usr/bin/stat -f %z "$@"; fi
exec /usr/bin/env -i PATH=/usr/bin:/bin stat "$@"
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
HELPER="ghcr.io/synap-core/pod-agent@sha256:$(printf 'a%.0s' $(seq 1 64))"
printf 'COMPOSE_PROJECT_NAME=testpod\nSYNAP_IMAGE_POD_AGENT=%s\n' "$HELPER" > "$D/.env"
export FAKE_VOLS="$TMP/vols"
vol() { # <name> <project> <key> <files...> — a volume and its content
  local n="$1" p="$2" k="$3"; shift 3
  rm -rf "$FAKE_VOLS/$n" "$FAKE_VOLS/$n".*; mkdir -p "$FAKE_VOLS/$n"
  printf 'project=%s\nvolume=%s\n' "$p" "$k" > "$FAKE_VOLS/$n.labels"
  for f in "$@"; do mkdir -p "$FAKE_VOLS/$n/$(dirname "$f")"; echo "content of $f" > "$FAKE_VOLS/$n/$f"; done
}
pod_vols() { # the pod's two volumes + a same-key volume of ANOTHER project
  rm -rf "$FAKE_VOLS"; mkdir -p "$FAKE_VOLS"
  vol testpod_minio_data testpod minio_data bucket/a.bin bucket/b.bin .minio.sys/format.json
  vol testpod_typesense_data testpod typesense_data db/state
  vol other_minio_data other minio_data secret/x
}
pod_vols
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

# ── archive: volumes (by label, counted, manifest) ──
# The keys archive-pod.sh archives are volumes the compose file declares (a
# renamed volume would otherwise be "found 0" on every pod, or never archived).
keys="$(sed -n 's/^ARCHIVE_VOLUMES="\${ARCHIVE_VOLUMES:-\(.*\)}"$/\1/p' "$SCRIPT_DIR/archive-pod.sh")"
declared="$(python3 -c 'import sys,yaml; print(" ".join((yaml.safe_load(open(sys.argv[1])).get("volumes") or {}).keys()))' "$SCRIPT_DIR/docker-compose.yml" 2>/dev/null)"
missing=""; for k in $keys; do [[ " $declared " == *" $k "* ]] || missing="$missing $k"; done
[ -n "$keys" ] && [ -n "$declared" ] && [ -z "$missing" ] && ok "archive: its volumes ($keys) are declared by the compose file" || bad "archive: ARCHIVE_VOLUMES='$keys' vs compose volumes '$declared' (missing:$missing)"
pod_vols
run_archive; rc=$?
cb="$(grep '"completed"' "$CB_LOG" | tail -1)"
[ $rc -eq 0 ] && [ -n "$cb" ] && ok "archive[volumes]: completed" || bad "archive[volumes]: rc=$rc $(tail -3 "$TMP/out")"
m="$(sed -n 's/^ARCHIVE_MANIFEST //p' "$TMP/out")"
jq -e '.schema == 1 and .project == "testpod" and .database.bytes > 0 and (.archive.sha256 | test("^[0-9a-f]{64}$"))
  and ([.volumes[] | {name, volume, files, empty}] == [{name:"minio_data",volume:"testpod_minio_data",files:3,empty:false},{name:"typesense_data",volume:"testpod_typesense_data",files:1,empty:false}])
  and (.volumes | all(.bytes > 0 and (.sha256 | test("^[0-9a-f]{64}$"))))' <<<"$m" >/dev/null \
  && ok "archive[volumes]: the manifest lists both volumes with file counts, sizes, checksums (last stdout line)" || bad "archive[volumes]: manifest=$m"
jq -e --argjson m "$m" '.manifest == $m' <<<"${cb}" >/dev/null 2>&1 && ok "archive[volumes]: the push callback carries the same manifest" || bad "archive[volumes]: callback=$cb"
[ "$(jq -r .archive.bytes <<<"$m")" = "$(wc -c < "$UPLOADED" | tr -d ' ')" ] && [ "$(jq -r .archive.sha256 <<<"$m")" = "$({ sha256sum "$UPLOADED" 2>/dev/null || shasum -a 256 "$UPLOADED"; } | cut -d' ' -f1)" ] \
  && ok "archive[volumes]: archive.bytes/sha256 are the uploaded object's" || bad "archive[volumes]: archive=$(jq -c .archive <<<"$m")"
mkdir -p "$TMP/x"; tail -n +3 "$UPLOADED" | tar xzf - -C "$TMP/x" 2>/dev/null
[ "$(tar tzvf "$TMP/x/volumes/minio_data.tar.gz" | grep -c '^-')" = 3 ] && jq -e '.volumes | length == 2' "$TMP/x/manifest.json" >/dev/null \
  && ok "archive[volumes]: the archive holds manifest.json and volumes/minio_data.tar.gz with its 3 files" || bad "archive[volumes]: contents $(ls -R "$TMP/x" | tr '\n' ' ')"
! grep -q 'other_minio_data' "$DOCKER_LOG" && ok "archive[volumes]: another project's minio_data volume is never read" || bad "archive[volumes]: read other_minio_data"
cp "$UPLOADED" "$TMP/with-volumes.age"
[ -z "$(ls -A "$ARCHIVE_WORK_DIR")" ] && ok "archive[volumes]: nothing left in the work dir" || bad "archive[volumes]: left $(ls "$ARCHIVE_WORK_DIR")"

refuses() { # <label> <reason regex> — the archive failed, said why, uploaded nothing
  local rc="$1" label="$2" re="$3"
  [ "$rc" -ne 0 ] && [ "$(last_status)" = '"status":"failed"' ] && grep -qE "$re" "$CB_LOG" && [ ! -s "$UPLOAD_LOG" ] && ! grep -q '"completed"' "$CB_LOG" \
    && ok "archive[$label]: fails ($re), nothing uploaded" || bad "archive[$label]: rc=$rc cb=$(cat "$CB_LOG") up=$(cat "$UPLOAD_LOG")"
}
pod_vols; rm -rf "$FAKE_VOLS"/testpod_typesense_data*
run_archive; refuses $? "volume missing" 'volume typesense_data of project testpod: found 0'
pod_vols; touch "$FAKE_VOLS/testpod_minio_data.unreadable"
run_archive; refuses $? "volume unreadable" 'volume minio_data \(testpod_minio_data\) could not be read'
pod_vols; touch "$FAKE_VOLS/testpod_minio_data.short"
run_archive; refuses $? "short tarball" 'volume minio_data: the archive holds 2 files, the volume 3'
pod_vols; vol testpod_minio_data_2 testpod minio_data dup/y
run_archive; refuses $? "two volumes" 'volume minio_data of project testpod: found 2'
pod_vols; ( sed -i.x '/^SYNAP_IMAGE_POD_AGENT=/d' "$D/.env"; rm -f "$D/.env.x"; run_archive ); rc=$?
printf 'COMPOSE_PROJECT_NAME=testpod\nSYNAP_IMAGE_POD_AGENT=%s\n' "$HELPER" > "$D/.env"
[ $rc -ne 0 ] && grep -q ARCHIVE_HELPER_MISSING "$CB_LOG" && ! grep -q stop "$DOCKER_LOG" \
  && ok "archive[no helper pin]: refuses before stopping anything" || bad "archive[no helper pin]: rc=$rc cb=$(cat "$CB_LOG")"
pod_vols; vol testpod_typesense_data testpod typesense_data
run_archive; rc=$?
[ $rc -eq 0 ] && jq -e '.volumes[] | select(.name == "typesense_data") | .empty == true and .files == 0' <<<"$(sed -n 's/^ARCHIVE_MANIFEST //p' "$TMP/out")" >/dev/null \
  && ok "archive[empty volume]: completes and SAYS empty (\"empty\": true, 0 files)" || bad "archive[empty volume]: rc=$rc $(tail -2 "$TMP/out")"
pod_vols

# ── restore: the per-volume archive goes back into the pod's volumes ──
cp "$TMP/with-volumes.age" "$FAKE_ARCHIVE"
rm -rf "$FAKE_VOLS"; mkdir -p "$FAKE_VOLS"; vol testpod_minio_data testpod minio_data stale/old.bin   # typesense absent: created
HEALTH_RC=0 PSQL_MODE=ok run_restore; rc=$?
[ $rc -eq 0 ] && [ "$(last_status)" = '"status":"completed"' ] && [ -f "$FAKE_VOLS/testpod_minio_data/bucket/a.bin" ] && [ ! -e "$FAKE_VOLS/testpod_minio_data/stale/old.bin" ] \
  && [ -f "$FAKE_VOLS/testpod_typesense_data/db/state" ] && grep -qx 'volume=typesense_data' "$FAKE_VOLS/testpod_typesense_data.labels" \
  && ok "restore[volumes]: each volume is replaced by its archived files (a missing one created with its compose labels)" || bad "restore[volumes]: rc=$rc $(tail -3 "$TMP/out")"
mkdir -p "$TMP/t"; rm -rf "$TMP/t"/*; tail -n +3 "$TMP/with-volumes.age" | tar xzf - -C "$TMP/t"
echo "DROP TABLE users;" | gzip > "$TMP/t/database.sql.gz.x"; cp "$TMP/t/database.sql.gz" "$TMP/t/db.keep"; mv "$TMP/t/database.sql.gz.x" "$TMP/t/database.sql.gz"
( cd "$TMP/t" && tar czf "$FAKE_ARCHIVE" manifest.json database.sql.gz volumes )
HEALTH_RC=0 PSQL_MODE=ok run_restore; rc=$?
[ $rc -ne 0 ] && grep -q 'database dump: checksum does not match the manifest' "$CB_LOG" && ! grep -q psql "$DOCKER_LOG" \
  && ok "restore[db tampered]: a dump that is not the manifest's is refused before any replay" || bad "restore[db tampered]: rc=$rc cb=$(cat "$CB_LOG")"
mv "$TMP/t/db.keep" "$TMP/t/database.sql.gz"
echo tampered | gzip > "$TMP/t/volumes/minio_data.tar.gz"; ( cd "$TMP/t" && tar czf "$FAKE_ARCHIVE" manifest.json database.sql.gz volumes )
HEALTH_RC=0 PSQL_MODE=ok run_restore; rc=$?
[ $rc -ne 0 ] && grep -q 'volume minio_data: checksum does not match the manifest' "$CB_LOG" \
  && ok "restore[volumes tampered]: a tarball that does not match the manifest is refused" || bad "restore[volumes tampered]: rc=$rc cb=$(cat "$CB_LOG")"
pod_vols

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
[ $rc -ne 0 ] && grep -q ARCHIVE_WITHOUT_FILES "$CB_LOG" && ! grep -q psql "$DOCKER_LOG" && ! grep -q '"completed"' "$CB_LOG" \
  && ok "restore[legacy, no files]: refused before the database is touched (never 'completed' without the pod's files)" || bad "restore[legacy, no files]: rc=$rc cb=$(cat "$CB_LOG")"
export RESTORE_ALLOW_NO_FILES=1   # the database-only restore the operator opts into, for the db cases below
HEALTH_RC=0 PSQL_MODE=ok run_restore; rc=$?
[ $rc -eq 0 ] && [ "$(last_status)" = '"status":"completed"' ] && grep -q "restored without the pod's files" "$TMP/out" \
  && ok "restore: clean (database only, opted in) -> exit 0 + completed, and says so" || bad "restore: clean rc=$rc status=$(last_status): $(tail -3 "$TMP/out")"
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
[ $rc -ne 0 ] && ok "restore[legacy volumes]: non-zero exit" || bad "restore[legacy volumes]: exited 0"
[ "$(last_status)" = '"status":"failed"' ] && grep -q LEGACY_VOLUME_ARCHIVE "$CB_LOG" && ! grep -q psql "$DOCKER_LOG" \
  && ok "restore[legacy volumes]: refused before the database is touched (host paths cannot be written from pod-agent)" || bad "restore[legacy volumes]: cb=$(cat "$CB_LOG")"
unset RESTORE_ALLOW_NO_FILES

exit $fail
