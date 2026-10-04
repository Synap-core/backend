#!/usr/bin/env bash
# Tripwire: archive-pod.sh / restore-archive-pod.sh must FAIL (non-zero exit AND
# status "failed" to the CP callback) when the data did not make it.
#   archive : failed or empty DB dump -> no upload of a placeholder, no "completed"
#   restore : failed DB replay, failed volume restore, failed health check -> fail
# Runs the REAL scripts against fake docker/wget/curl on PATH (daemon-free).
# Override SCRIPT_DIR to point at a different copy (used for the negative control).
# Not covered: real pg_dumpall / psql behaviour; only the scripts' handling of
# their exit codes and stderr.
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
  *"volume ls"*) : ;;
esac
exit 0
D
cat > "$TMP/bin/wget" <<'D'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do
  case "$a" in
    --post-data=*) echo "${a#--post-data=}" >> "$CB_LOG"; exit 0 ;;
    --method=PUT) echo PUT >> "$UPLOAD_LOG"; exit 0 ;;
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
chmod +x "$TMP/bin"/*
export CB_LOG="$TMP/cb" UPLOAD_LOG="$TMP/up" FAKE_ARCHIVE="$TMP/fake.tar.gz"
export ARCHIVE_WORK_DIR="$TMP/work"; mkdir -p "$ARCHIVE_WORK_DIR"
export RESTORE_PG_WAIT_SECS=0 RESTORE_HEALTH_INTERVAL=0 RESTORE_HEALTH_TRIES=2

reset() { : > "$CB_LOG"; : > "$UPLOAD_LOG"; }
last_status() { grep -o '"status":"[a-z]*"' "$CB_LOG" | tail -1; }
run_archive() { reset; ( PATH="$TMP/bin:$PATH"; sh "$SCRIPT_DIR/archive-pod.sh" http://up http://cb jwt ) >"$TMP/out" 2>&1; }
run_restore() { reset; ( PATH="$TMP/bin:$PATH"; sh "$SCRIPT_DIR/restore-archive-pod.sh" http://arch http://cb jwt ) >"$TMP/out" 2>&1; }

# ── archive ──
DUMP_MODE=ok run_archive; rc=$?
[ $rc -eq 0 ] && ok "archive: good dump -> exit 0" || bad "archive: good dump exited $rc"
[ "$(last_status)" = '"status":"completed"' ] && ok "archive: good dump reports completed" || bad "archive: good dump status=$(last_status)"
grep -q PUT "$UPLOAD_LOG" && ok "archive: good dump uploads" || bad "archive: good dump did not upload"

for mode in fail empty; do
  DUMP_MODE=$mode run_archive; rc=$?
  [ $rc -ne 0 ] && ok "archive[$mode]: non-zero exit" || bad "archive[$mode]: exited 0"
  [ "$(last_status)" = '"status":"failed"' ] && ok "archive[$mode]: reports failed" || bad "archive[$mode]: status=$(last_status)"
  grep -q '"completed"' "$CB_LOG" && bad "archive[$mode]: reported completed" || ok "archive[$mode]: never reports completed"
  [ ! -s "$UPLOAD_LOG" ] && ok "archive[$mode]: nothing uploaded" || bad "archive[$mode]: uploaded a placeholder"
done

# ── restore ──
mkdir -p "$TMP/pk"; echo "CREATE ROLE synap;" | gzip > "$TMP/pk/database.sql.gz"
: > "$TMP/pk/volumes.tar.gz"
tar czf "$FAKE_ARCHIVE" -C "$TMP/pk" database.sql.gz volumes.tar.gz

HEALTH_RC=0 PSQL_MODE=ok run_restore; rc=$?
[ $rc -eq 0 ] && [ "$(last_status)" = '"status":"completed"' ] && ok "restore: clean -> exit 0 + completed" || bad "restore: clean rc=$rc status=$(last_status): $(tail -3 "$TMP/out")"
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
