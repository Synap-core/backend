#!/usr/bin/env bash
# ============================================================================
# Behaviour of the scheduled backup (compose `postgres-backup`), executed for
# real: the service's entrypoint and environment are EXTRACTED from the
# compose file (never a copy), its container paths (/backups, /synap-state,
# /synap-deploy) are pointed at a temp dir holding the REAL
# deploy/pgdata-safety.sh, and psql / pg_dump / pg_restore / pg_isready / sleep
# are faked on PATH. One loop iteration per run.
#
# Pins the 2026-10-04 retention fix: a dump of an EMPTIED pod must never rotate
# the good dumps out. Scenarios: first dump · normal rotation keeps BACKUP_KEEP ·
# 0 users while initialized → SUSPECT + alarm + nothing pruned · entities halved
# → SUSPECT · a good dump afterwards clears the alarm · every run leaves a
# metadata row for backup_runs.
#
# 2026-10-04 (backup engine): the inline loop moved into pgdata-safety.sh
# `backup_loop` (§7: the inline loop was a second implementation of
# pgdata_backup). Changes to this test, all from that extraction: the script
# is now run through the entrypoint instead of being the entrypoint; the
# fingerprint is the one `_pgs_fingerprint` writes (users|entities|api_keys,
# field 2 still entities, so pre-existing `-daily` dumps still gate); good
# dumps are named `-auto` (the cadence is hourly) and legacy `-daily` ones
# rotate with them. Off-host push/drill are covered in backup-offhost.test.sh.
# NOT covered: real pg_dump/pg_restore, the healthcheck command itself.
# ============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${BACKUP_TEST_COMPOSE_FILE:-$SCRIPT_DIR/../docker-compose.yml}"
SAFETY="${BACKUP_TEST_SAFETY:-$SCRIPT_DIR/../pgdata-safety.sh}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $*"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $*"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/backups" "$T/state" "$T/deploy"
cp "$SAFETY" "$T/deploy/pgdata-safety.sh"
: > "$T/deploy/.env"

# entrypoint script + environment (KEY=VALUE lines, compose defaults resolved)
python3 - "$COMPOSE_FILE" "$T/loop.sh" "$T/env" <<'PY'
import re, sys, yaml
svc = yaml.safe_load(open(sys.argv[1]))["services"]["postgres-backup"]
ep = svc["entrypoint"]; script = ep[-1] if isinstance(ep, list) else ep
open(sys.argv[2], "w").write(script.replace("$$", "$"))
env = svc.get("environment") or {}
with open(sys.argv[3], "w") as f:
    for k, v in env.items():
        v = re.sub(r"\$\{[A-Z_]+:-([^}]*)\}", r"\1", str(v))
        v = re.sub(r"\$\{[A-Z_]+\}", "", v)
        f.write(f"{k}={v}\n")
PY
repoint() { sed -i.bak -e "s#/synap-deploy#$T/deploy#g" -e "s#/synap-state#$T/state#g" -e "s#/backups#$T/backups#g" "$1"; }
repoint "$T/loop.sh"; repoint "$T/env"
grep -q "$T/deploy/pgdata-safety.sh loop" "$T/loop.sh" && grep -q "^SYNAP_BACKUPS_DIR=$T/backups$" "$T/env" \
    && ok "extracted entrypoint runs pgdata-safety.sh loop; env repointed (non-vacuity)" \
    || { bad "could not extract/repoint the entrypoint ($(cat "$T/loop.sh"))"; exit 1; }

cat > "$T/bin/psql" <<'SH'
#!/bin/sh
case "$*" in
  *pg_database*) printf 'synap\nkratos\n' ;;
  *"from api_keys"*) echo "${FAKE_USERS:-0}|${FAKE_ENTS:-0}|1" ;;
  *"insert into backup_runs"*) printf '%s\n' "$*" >> "$RUNS_LOG" ;;
  *) exit 1 ;;
esac
SH
printf '#!/bin/sh\necho dump\n' > "$T/bin/pg_dump"
printf '#!/bin/sh\ncat >/dev/null; exit 0\n' > "$T/bin/pg_restore"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/pg_isready"
printf '#!/bin/sh\necho "restic must not run without a repository: $*" >> "$RUNS_LOG"; exit 1\n' > "$T/bin/restic"
printf '#!/bin/sh\nkill -TERM $PPID\n' > "$T/bin/sleep"            # one iteration only
# GNU `head -n -K` (drop last K) is used by the loop; BSD head lacks it — shim it.
cat > "$T/bin/head" <<'SH'
#!/usr/bin/env python3
import sys
a = sys.argv[1:]
if len(a) >= 2 and a[0] == "-n" and a[1].startswith("-"):
    lines = sys.stdin.readlines(); k = int(a[1][1:])
    sys.stdout.writelines(lines[:max(0, len(lines) - k)])
else:
    import subprocess; sys.exit(subprocess.call(["/usr/bin/head", *a]))
SH
chmod +x "$T/bin/"*
export RUNS_LOG="$T/runs.log"; : > "$RUNS_LOG"

run() {  # users ents
    sleep 1.1   # distinct timestamps (real sleep; PATH not yet patched)
    ( set -a; . "$T/env"; set +a
      FAKE_USERS="$1" FAKE_ENTS="$2" BACKUP_KEEP=2 BACKUP_KEEP_DAILY="${KD:-1}" PATH="$T/bin:$PATH" exec sh "$T/loop.sh" ) >"$T/out" 2>&1 &
    wait $! 2>/dev/null || true   # the fake `sleep` TERMs the loop after one pass
}
dailies() { ls -1d "$T/backups/"*-auto 2>/dev/null | wc -l | tr -d ' '; }
suspects() { ls -1d "$T/backups/"*-SUSPECT 2>/dev/null | wc -l | tr -d ' '; }

echo "── first dumps / rotation"
run 5 100; [ "$(dailies)" = 1 ] && [ -e "$T/state/postgres-initialized" ] && ok "first dump published, pod marked initialized" || { bad "first dump: dailies=$(dailies) marker=$(ls "$T/state")"; cat "$T/out"; }
fp="$(cat "$(ls -1d "$T/backups/"*-auto | tail -1)/fingerprint")"; [ "$fp" = "5|100|1" ] && ok "fingerprint recorded ($fp)" || bad "fingerprint=$fp"
grep -q "'backup', 'ok'" "$RUNS_LOG" && grep -q "5|100|1" "$RUNS_LOG" && ok "run recorded in backup_runs (ok, fingerprint)" || bad "no backup_runs row: $(cat "$RUNS_LOG")"
# A legacy `-daily` dump (pre-extraction name) rotates with the new ones.
mkdir -p "$T/backups/20000101T000000Z-daily"; echo "5|90" > "$T/backups/20000101T000000Z-daily/fingerprint"
run 5 110; run 6 120; [ "$(dailies)" = 2 ] && [ ! -e "$T/backups/20000101T000000Z-daily" ] && ok "rotation keeps BACKUP_KEEP=2 good dumps (legacy -daily rotated out)" || bad "rotation: dailies=$(dailies) legacy=$(ls "$T/backups")"
# Daily tier: besides the newest BACKUP_KEEP, the newest dump of each of the
# last BACKUP_KEEP_DAILY days survives (hourly must not shrink a week of local
# history to hours). Days 1-3 of 2001 get two dumps each.
for d in 20010101 20010102 20010103; do for h in 01 02; do
    mkdir -p "$T/backups/${d}T${h}0000Z-auto"; echo "6|120|1" > "$T/backups/${d}T${h}0000Z-auto/fingerprint"
done; done
KD=3 run 6 121
kept="$(ls -1d "$T/backups/"*-auto | xargs -n1 basename | tr '\n' ' ')"
case "$kept" in
  "20010102T020000Z-auto 20010103T020000Z-auto "*) [ "$(dailies)" = 4 ] && ok "daily tier: newest per day for 3 days + 2 recent ($kept)" || bad "daily tier count: $kept" ;;
  *) bad "daily tier kept: $kept" ;;
esac
run 6 122; [ "$(dailies)" = 2 ] && ok "KEEP_DAILY=1 → back to the 2 recent" || bad "after tier: $(dailies)"
! grep -q "restic must not run" "$RUNS_LOG" && ok "no repository configured → restic never invoked" || bad "restic ran without a repository"

echo "── emptied pod"
before="$(ls -1d "$T/backups/"*-auto | xargs -n1 basename | tr '\n' ' ')"
run 0 0
after="$(ls -1d "$T/backups/"*-auto | xargs -n1 basename | tr '\n' ' ')"
# Compare the SET of good dumps, not a count: the pre-fix loop kept the count at
# BACKUP_KEEP while swapping a good dump for an empty one.
[ -n "$before" ] && [ "$before" = "$after" ] && ok "0 users: the same good dumps survive (none pruned or replaced)" || bad "0 users changed the good dumps: [$before] -> [$after]"
[ "$(suspects)" = 1 ] && [ -e "$T/backups/.alarm" ] && ok "0 users: kept as SUSPECT + alarm raised" || bad "0 users: suspects=$(suspects) alarm=$([ -e "$T/backups/.alarm" ] && echo y || echo n)"
grep -q "'backup', 'suspect'" "$RUNS_LOG" && ok "SUSPECT run recorded in backup_runs" || bad "no suspect row"
run 6 50
[ "$(suspects)" = 2 ] && [ "$(dailies)" = 2 ] && ok "entities 120→50: SUSPECT, nothing pruned" || bad "halved: suspects=$(suspects) dailies=$(dailies)"
# Discriminating row: users wiped while entities stay — only the 0-users rule
# catches it (`run 0 0` above is also caught by the entities rule).
run 0 130
[ "$(suspects)" = 3 ] && [ "$(dailies)" = 2 ] && ok "0 users, entities intact: SUSPECT (0-users rule on its own)" || bad "users-only wipe: suspects=$(suspects) dailies=$(dailies)"

echo "── recovery"
run 6 125
[ ! -e "$T/backups/.alarm" ] && [ "$(dailies)" = 2 ] && ok "good dump clears the alarm and resumes rotation" || bad "recovery: alarm=$([ -e "$T/backups/.alarm" ] && echo y || echo n) dailies=$(dailies)"

echo "── run lock (flock — a dead holder releases it; mkdir fallback cleared at startup)"
# flock(1) shim: flock(2) on the INHERITED fd, exactly what util-linux does, so
# the shell keeps the lock after the shim exits (macOS has no flock binary).
cat > "$T/bin/flock" <<'PY'
#!/usr/bin/env python3
import fcntl, sys
a = sys.argv[1:]; fd = int(a[-1])
op = fcntl.LOCK_UN if "-u" in a else fcntl.LOCK_EX | (fcntl.LOCK_NB if "-n" in a else 0)
try: fcntl.flock(fd, op)
except OSError: sys.exit(1)
PY
chmod +x "$T/bin/flock"
hold() {  # a live holder of the backup flock, in its own process
    rm -f "$T/held"
    python3 -c 'import fcntl,sys,time; f=open(sys.argv[1],"a"); fcntl.flock(f, fcntl.LOCK_EX); open(sys.argv[2],"w").close(); time.sleep(120)' \
        "$T/backups/.backup.flock" "$T/held" & HOLDER=$!
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -e "$T/held" ] && break; /bin/sleep 0.1; done
}
n_before="$(dailies)"; : > "$RUNS_LOG"
hold; run 6 126
[ "$(dailies)" = "$n_before" ] && grep -q "'backup', 'failed'" "$RUNS_LOG" && grep -q "held the lock" "$RUNS_LOG" \
    && ok "flock held by another run: no dump, a 'failed' backup_runs row (not a silent skip)" || bad "held lock: dailies=$(dailies) runs=$(cat "$RUNS_LOG")"
kill -9 "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; : > "$RUNS_LOG"
run 6 127
grep -q "'backup', 'ok'" "$RUNS_LOG" && ok "holder killed: the kernel released the flock, the next run backs up" || { bad "after holder died: $(cat "$RUNS_LOG")"; cat "$T/out"; }
[ ! -e "$T/backups/.backup.lock" ] && ok "flock path leaves no mkdir lock behind" || bad "a .backup.lock dir exists on the flock path"

# mkdir fallback: a lock left by the service's previous life (fresh — far
# younger than the 6 h staleness) must not block the restarted loop.
mkdir "$T/backups/.backup.lock"; : > "$RUNS_LOG"
SYNAP_LOCK_IMPL=mkdir run 6 128
grep -q "'backup', 'ok'" "$RUNS_LOG" && [ ! -e "$T/backups/.backup.lock" ] \
    && ok "mkdir fallback: backup_loop clears its own stale lock at startup" || { bad "mkdir fallback blocked: $(cat "$RUNS_LOG")"; cat "$T/out"; }

echo; echo "RESULTS PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
