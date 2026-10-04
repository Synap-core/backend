#!/usr/bin/env bash
# Tripwire: `synap reset` is the ONE explicit wipe door, and it is guarded.
#
# update-door plan P0 (2026-10-04): reset ran `down --volumes` + `system prune
# -a -f --volumes` behind a "type recreate" prompt that --yes/SYNAP_ASSUME_YES
# skipped, with no backup. Now every mode: (a) the operator types the pod
# DOMAIN — no assume-yes bypass; (b) a verified `pgdata_backup pre-reset`
# first, abort on failure; (c) `down` keeps volumes unless --delete-data.
#
# Daemon-free: the REAL `synap` with a fake `docker` that plays a running
# postgres (so the real pgdata_backup runs) and records every call.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

REPO="$TMP/repo"; DEPLOY="$REPO/deploy"
mkdir -p "$TMP/bin" "$DEPLOY"
cp "$HERE/synap" "$REPO/synap"
cp "$HERE/deploy/ensure-ory-databases.sh" "$HERE/deploy/pgdata-safety.sh" "$HERE/deploy/update-lock.sh" "$HERE/deploy/env-config.sh" "$HERE/deploy/env.schema" "$DEPLOY/"
printf 'services:\n  postgres:\n    image: x\n' > "$DEPLOY/docker-compose.yml"
printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\nPOSTGRES_PASSWORD=x\n' > "$DEPLOY/.env"

cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "compose ps -a -q postgres") echo cid ;;
  "inspect -f {{.State.Running}} cid") echo true ;;
  *"{{range .Config.Env}}"*) echo PGDATA=/home/postgres/pgdata/data ;;
  *"{{range .Mounts}}"*) echo /home/postgres/pgdata ;;
  *"exec cid psql"*"pg_database"*) [ -n "${FAKE_BACKUP_FAIL:-}" ] && exit 1; echo synap ;;
  *"exec cid pg_dump"*) echo DUMP ;;
  *"pg_restore -l"*) cat >/dev/null ;;
  *"exec -T postgres psql"*|*"exec -T minio"*) cat >/dev/null 2>&1; echo cleared ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker"
export FAKE_LOG="$TMP/log"

reset() { # <stdin text> <args...>
  local input="$1"; shift
  : > "$FAKE_LOG"; rm -rf "$DEPLOY/backups" "$DEPLOY/state/reset"
  ( cd "$TMP"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" bash "$REPO/synap" reset "$@" ) >"$TMP/out" 2>&1 <<<"$input"
}
destructive() { grep -E "compose down|TRUNCATE|exec -T postgres|exec -T minio" "$FAKE_LOG"; }
backups() { ls -d "$DEPLOY"/backups/postgres/*-pre-reset 2>/dev/null | wc -l | tr -d ' '; }

# (a) wrong domain → nothing happens, even with --yes and SYNAP_ASSUME_YES
reset "yes" --full --yes; rc=$?
[ "$rc" != 0 ] && [ -z "$(destructive)" ] && [ "$(backups)" = 0 ] && ok "typing 'yes' does not confirm (--yes given)" || bad "wrong confirmation proceeded (rc=$rc): $(destructive)"
: > "$FAKE_LOG"
( cd "$TMP"; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_ASSUME_YES=1 bash "$REPO/synap" reset --full ) >"$TMP/out" 2>&1 </dev/null; rc=$?
[ "$rc" != 0 ] && [ -z "$(destructive)" ] && ok "SYNAP_ASSUME_YES + no input does not bypass the domain prompt" || bad "assume-yes bypassed the prompt: $(destructive)"

# (b) right domain but the backup fails → abort before anything destructive
FAKE_BACKUP_FAIL=1 reset "pod.example.com" --full; rc=$?
[ "$rc" != 0 ] && [ -z "$(destructive)" ] && grep -q "Pre-reset backup failed" "$TMP/out" \
  && ok "failed backup aborts the reset" || bad "reset continued without a backup (rc=$rc): $(destructive)"

# (c) --full keeps volumes; backup taken first
reset "pod.example.com" --full; rc=$?
[ "$rc" = 0 ] && ok "--full with the typed domain succeeds" || bad "--full failed (rc=$rc): $(tail -3 "$TMP/out")"
[ "$(backups)" = 1 ] && [ -f "$(ls -d "$DEPLOY"/backups/postgres/*-pre-reset)/synap.dump" ] && ok "--full took a pre-reset backup" || bad "--full: no pre-reset backup"
grep -qx "compose down --remove-orphans" "$FAKE_LOG" && ok "--full runs 'down' without volumes" || bad "--full down: $(grep down "$FAKE_LOG")"
grep -E -- "--volumes|down -v|prune" "$FAKE_LOG" && bad "--full touched volumes / pruned" || ok "--full never removes volumes or prunes"
first_backup=$(grep -n "pg_dump" "$FAKE_LOG" | head -1 | cut -d: -f1); first_down=$(grep -n "compose down" "$FAKE_LOG" | head -1 | cut -d: -f1)
[ -n "$first_backup" ] && [ -n "$first_down" ] && [ "$first_backup" -lt "$first_down" ] && ok "backup runs before down" || bad "order: backup line $first_backup, down line $first_down"

# (d) --full --delete-data: this project's volumes only, never a global prune
reset "pod.example.com" --full --delete-data; rc=$?
grep -qx "compose down --volumes --remove-orphans" "$FAKE_LOG" && ok "--delete-data removes this project's volumes via compose" || bad "--delete-data: $(grep down "$FAKE_LOG")"
grep -q "prune" "$FAKE_LOG" && bad "--delete-data ran a prune" || ok "--delete-data never prunes"
reset "pod.example.com" --delete-data; [ $? != 0 ] && [ -z "$(destructive)" ] && ok "--delete-data without --full is refused" || bad "--delete-data alone proceeded"

# (e) data mode: same guards, then TRUNCATE
reset "pod.example.com"; rc=$?
[ "$rc" = 0 ] && [ "$(backups)" = 1 ] && grep -q "exec -T postgres psql" "$FAKE_LOG" && ok "data reset: backup, then truncate" || bad "data reset rc=$rc backups=$(backups)"

# (f) secrets never land in plaintext beside the dump (backup plan §7). No
#     off-host repository → a 0600 copy in state/reset/ and a loud warning.
reset "pod.example.com" --full; rc=$?
pre="$(ls -d "$DEPLOY"/backups/postgres/*-pre-reset 2>/dev/null | head -1)"
[ "$rc" = 0 ] && [ -n "$pre" ] && [ ! -e "$pre/env.backup" ] && ok "no plaintext env.backup beside the pre-reset dump" || bad "env.backup still written beside the dump (rc=$rc): $(ls "$pre" 2>&1)"
copy="$(ls "$DEPLOY"/state/reset/env.* 2>/dev/null | head -1)"
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
[ -n "$copy" ] && [ "$(mode "$copy")" = 600 ] && [ "$(mode "$DEPLOY/state/reset")" = 700 ] && cmp -s "$copy" "$DEPLOY/.env" \
  && ok "without an off-host repo: .env copied to state/reset/ (0600, dir 0700)" || bad "state/reset copy: '${copy}' mode=$( [ -n "$copy" ] && mode "$copy")"
grep -q "UNENCRYPTED" "$TMP/out" && ok "the unencrypted fallback is announced" || bad "no warning about the unencrypted .env copy"
grep -q "postgres-backup" "$FAKE_LOG" && bad "pushed a snapshot with no repository configured" || ok "no push without a repository"

# (g) off-host repository configured + initialised → .env travels in the
#     encrypted snapshot (`synap backup push`), no local plaintext copy.
cp "$DEPLOY/.env" "$TMP/env.keep"
echo "BACKUP_REPOSITORY=/srv/restic" >> "$DEPLOY/.env"
mkdir -p "$DEPLOY/state/backup" && echo pw > "$DEPLOY/state/backup/restic-password"
reset "pod.example.com" --full; rc=$?
[ "$rc" = 0 ] && grep -q "compose run --rm --no-deps -T --entrypoint sh postgres-backup /synap-deploy/pgdata-safety.sh push" "$FAKE_LOG" \
  && ok "with a repository: an encrypted snapshot is pushed before reset" || bad "no off-host push (rc=$rc): $(grep postgres-backup "$FAKE_LOG")"
[ -z "$(ls "$DEPLOY"/state/reset/env.* 2>/dev/null)" ] && ok "with a repository: no plaintext .env copy" || bad "plaintext copy written although the snapshot carries .env"
push_line=$(grep -n "postgres-backup" "$FAKE_LOG" | head -1 | cut -d: -f1); down_line=$(grep -n "compose down" "$FAKE_LOG" | head -1 | cut -d: -f1)
[ -n "$push_line" ] && [ -n "$down_line" ] && [ "$push_line" -lt "$down_line" ] && ok "push runs before down" || bad "order: push $push_line, down $down_line"
cp "$TMP/env.keep" "$DEPLOY/.env"; rm -rf "$DEPLOY/state/backup"
exit $fail
