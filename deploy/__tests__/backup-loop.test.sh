#!/usr/bin/env bash
# ============================================================================
# Behaviour of the postgres-backup loop (deploy/docker-compose.yml), executed for
# real: the entrypoint script is EXTRACTED from the compose file (never a copy),
# its /backups and /synap-state paths are pointed at a temp dir, and psql /
# pg_dump / pg_restore / sleep are faked on PATH. One loop iteration per run.
#
# Pins the 2026-10-04 retention fix: a dump of an EMPTIED pod must never rotate
# the good dumps out. Scenarios: first dump · normal rotation keeps BACKUP_KEEP ·
# 0 users while initialized → SUSPECT + alarm + nothing pruned · entities halved
# → SUSPECT · a good dump afterwards clears the alarm.
# NOT covered: real pg_dump/pg_restore, the healthcheck command itself.
# ============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${BACKUP_TEST_COMPOSE_FILE:-$SCRIPT_DIR/../docker-compose.yml}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $*"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $*"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/backups" "$T/state"
python3 - "$COMPOSE_FILE" > "$T/loop.sh" <<'PY'
import sys, yaml
svc = yaml.safe_load(open(sys.argv[1]))["services"]["postgres-backup"]
ep = svc["entrypoint"]; script = ep[-1] if isinstance(ep, list) else ep
print(script.replace("$$", "$"))       # compose escape → shell
PY
sed -i.bak -e "s#/backups#$T/backups#g" -e "s#/synap-state#$T/state#g" "$T/loop.sh"
[ "$(grep -c "$T/backups" "$T/loop.sh")" -ge 3 ] && grep -q "pg_dump" "$T/loop.sh" && ok "extracted loop script and repointed paths (non-vacuity)" \
    || { bad "could not extract/repoint the loop script"; exit 1; }

cat > "$T/bin/psql" <<'SH'
#!/bin/sh
case "$*" in
  *pg_database*) printf 'synap\nkratos\n' ;;
  *"from users"*) echo "${FAKE_USERS:-0}" ;;
  *"from entities"*) echo "${FAKE_ENTS:-0}" ;;
esac
SH
cat > "$T/bin/pg_dump" <<'SH'
#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = -f ] && { echo dump > "$2"; }; shift; done
SH
printf '#!/bin/sh\nexit 0\n' > "$T/bin/pg_restore"
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

run() {  # users ents
    sleep 1.1   # distinct timestamps (real sleep; PATH not yet patched)
    FAKE_USERS="$1" FAKE_ENTS="$2" BACKUP_KEEP=2 BACKUP_INTERVAL_SECONDS=60 PATH="$T/bin:$PATH" \
        sh "$T/loop.sh" >"$T/out" 2>&1 &
    wait $! 2>/dev/null || true   # the fake `sleep` TERMs the loop after one pass
}
dailies() { ls -1d "$T/backups/"*-daily 2>/dev/null | wc -l | tr -d ' '; }
suspects() { ls -1d "$T/backups/"*-SUSPECT 2>/dev/null | wc -l | tr -d ' '; }

echo "── first dumps / rotation"
run 5 100; [ "$(dailies)" = 1 ] && [ -e "$T/state/postgres-initialized" ] && ok "first dump published, pod marked initialized" || bad "first dump: dailies=$(dailies) marker=$(ls "$T/state")"
fp="$(cat "$(ls -1d "$T/backups/"*-daily | tail -1)/fingerprint")"; [ "$fp" = "5|100" ] && ok "fingerprint recorded ($fp)" || bad "fingerprint=$fp"
run 5 110; run 6 120; [ "$(dailies)" = 2 ] && ok "rotation keeps BACKUP_KEEP=2 good dumps" || bad "rotation: dailies=$(dailies)"

echo "── emptied pod"
before="$(ls -1d "$T/backups/"*-daily | xargs -n1 basename | tr '\n' ' ')"
run 0 0
after="$(ls -1d "$T/backups/"*-daily | xargs -n1 basename | tr '\n' ' ')"
# Compare the SET of good dumps, not a count: the pre-fix loop kept the count at
# BACKUP_KEEP while swapping a good dump for an empty one.
[ "$before" = "$after" ] && ok "0 users: the same good dumps survive (none pruned or replaced)" || bad "0 users changed the good dumps: [$before] -> [$after]"
[ "$(suspects)" = 1 ] && [ -e "$T/backups/.alarm" ] && ok "0 users: kept as SUSPECT + alarm raised" || bad "0 users: suspects=$(suspects) alarm=$([ -e "$T/backups/.alarm" ] && echo y || echo n)"
run 6 50
[ "$(suspects)" = 2 ] && [ "$(dailies)" = 2 ] && ok "entities 120→50: SUSPECT, nothing pruned" || bad "halved: suspects=$(suspects) dailies=$(dailies)"

echo "── recovery"
run 6 125
[ ! -e "$T/backups/.alarm" ] && [ "$(dailies)" = 2 ] && ok "good dump clears the alarm and resumes rotation" || bad "recovery: alarm=$([ -e "$T/backups/.alarm" ] && echo y || echo n) dailies=$(dailies)"

echo; echo "RESULTS PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
