#!/usr/bin/env bash
# ============================================================================
# Off-host backups (deploy/pgdata-safety.sh "Off-host backups"), executed for
# real and daemon-free: the REAL script runs against fakes on PATH — restic (a
# python stand-in that keeps snapshots as plain dirs under the repository
# path, storing them at the backup CONTAINER's paths like the real push does),
# mc, psql/pg_dump/pg_restore/pg_isready/initdb/pg_ctl, curl, docker and a
# compose stand-in. Every call is appended to $CALLS.
#
#   I. init     — refuses without BACKUP_REPOSITORY and on a non-tty; writes the
#                 password 0600 (dir 0700); prints the kit ONCE (password in it,
#                 nowhere else: not on stderr, not in any argv); a second init
#                 refuses and prints nothing secret; a restic download whose
#                 checksum does not match is refused and nothing is kept.
#   P. push     — refuses before init; a good dump is snapshotted with its
#                 fingerprint tag + MinIO export + .env + state/ (bin/ and the
#                 password excluded) and pings the heartbeat; a SUSPECT dump is
#                 never pushed and never pings; a failed restic marks
#                 .push-failed and does not ping; NOTHING ever calls
#                 forget/prune (behavioural over the whole run + a static scan).
#   D. drill    — green on a faithful snapshot; RED on a fingerprint mismatch
#                 and on a corrupt snapshot; never touches the live postgres.
#   R. restore  — fresh host: secrets → DBs → MinIO → fingerprint, in that
#                 order; a mismatch is RED and leaves the staging dir.
#   L. layout   — the compose service's paths equal the script's _BK_CT_*.
#
# NOT covered (needs a daemon / network): real restic/mc/pg binaries, the
# python setuid drop to the postgres user, the compose `run` of minio-import
# (the import function itself is driven directly in R).
# ============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAFETY_SRC="${BACKUP_TEST_SAFETY:-$SCRIPT_DIR/../pgdata-safety.sh}"
COMPOSE_FILE="$SCRIPT_DIR/../docker-compose.yml"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $*"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $*"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/backups" "$T/state" "$T/deploy"
cp "$SAFETY_SRC" "$T/deploy/pgdata-safety.sh"
SAFETY="$T/deploy/pgdata-safety.sh"
export CALLS="$T/calls.log" RUNS="$T/runs.log"; : > "$CALLS"; : > "$RUNS"
cat > "$T/deploy/.env" <<EOF
POSTGRES_PASSWORD=pg-secret-1
MINIO_ACCESS_KEY=minio-user
MINIO_SECRET_KEY=minio-secret
BACKUP_HEARTBEAT_URL=https://hc.example/ping/abc
EOF
export FAKE_PATHMAP="$T/backups=/backups;$T/state=/synap-state;$T/deploy=/synap-deploy"

# ── fakes ────────────────────────────────────────────────────────────────────
cat > "$T/bin/restic" <<'PY'
#!/usr/bin/env python3
import json, os, shutil, sys
open(os.environ["CALLS"], "a").write("restic " + " ".join(sys.argv[1:]) + "\n")
repo = os.environ.get("RESTIC_REPOSITORY", ""); pwf = os.environ.get("RESTIC_PASSWORD_FILE", "")
args = sys.argv[1:]; cmd = args[0]
if not repo: sys.exit("Fatal: no repository")
def pw(): return open(pwf).read() if pwf and os.path.isfile(pwf) else ""
if cmd == "init":
    if os.path.exists(repo + "/config"): sys.exit("Fatal: config file already exists")
    if not pw(): sys.exit("Fatal: no password")
    os.makedirs(repo, exist_ok=True); open(repo + "/config", "w").write(pw()); print("created"); sys.exit(0)
if not pw() or not os.path.exists(repo + "/config") or open(repo + "/config").read() != pw():
    sys.exit("Fatal: wrong password or no key found")
snaps = repo + "/snaps"; os.makedirs(snaps, exist_ok=True)
ids = sorted(x for x in os.listdir(snaps) if not x.endswith(".meta"))
pmap = [p.split("=", 1) for p in os.environ.get("FAKE_PATHMAP", "").split(";") if p]
def to_ct(p):
    for host, ct in pmap:
        if p == host or p.startswith(host + "/"): return ct + p[len(host):]
    return p
def pick(s):
    if s == "latest": return ids[-1] if ids else None
    m = [i for i in ids if i.startswith(s)]; return m[0] if m else None
if cmd == "backup":
    if os.environ.get("FAKE_RESTIC_FAIL"): sys.exit("Fatal: unable to save snapshot")
    paths, excl, tags, i = [], [], [], 1
    while i < len(args):
        a = args[i]
        if a in ("--host", "--tag", "--exclude"):
            (excl if a == "--exclude" else tags if a == "--tag" else []).append(args[i + 1]); i += 2; continue
        if a.startswith("--"): i += 1; continue
        paths.append(a); i += 1
    sid = "%064x" % (len(ids) + 1); root = os.path.join(snaps, sid)
    for p in paths:
        if not os.path.exists(p): sys.exit("Fatal: %s does not exist" % p)
        dst = root + to_ct(os.path.abspath(p))
        if os.path.isdir(p):
            shutil.copytree(p, dst, ignore=lambda d, n: [x for x in n if os.path.join(d, x) in excl])
        else:
            os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(p, dst)
    json.dump({"tags": tags, "paths": paths}, open(root + ".meta", "w"))
    print(json.dumps({"message_type": "status", "percent_done": 1}, separators=(",", ":")))
    print(json.dumps({"message_type": "summary", "snapshot_id": sid, "total_bytes_processed": 4242}, separators=(",", ":")))
elif cmd == "snapshots":
    want = [a for a in args[1:] if not a.startswith("--")]
    s = pick(want[0]) if want else None
    if not s: sys.exit("Fatal: no matching ID found")
    tags = json.load(open(os.path.join(snaps, s + ".meta")))["tags"]
    print(json.dumps([{"time": "t", "hostname": "synap-pod", "tags": tags, "id": s, "short_id": s[:8]}], separators=(",", ":")))
elif cmd == "restore":
    if os.environ.get("FAKE_RESTIC_CORRUPT"): sys.exit("Fatal: hash does not match id")
    s = pick(args[1])
    if not s: sys.exit("Fatal: no matching ID found")
    target = args[args.index("--target") + 1]
    excl = [args[i + 1] for i, a in enumerate(args) if a == "--exclude"]
    shutil.copytree(os.path.join(snaps, s), target, dirs_exist_ok=True, ignore=lambda d, n: [x for x in n if x in excl])
else:
    print("ok")
PY
cat > "$T/bin/mc" <<'SH'
#!/bin/sh
echo "mc $*" >> "$CALLS"
while [ "${1#--}" != "$1" ]; do shift 2; done
cmd=$1; shift
case "$cmd" in
  alias|mb) exit 0 ;;
  ls) echo "[2026-10-04 00:00:00 UTC]     0B files/" ;;
  mirror)
    while [ "${1#--}" != "$1" ]; do shift; done
    case "$1" in synapbk/*) mkdir -p "$2" && echo object > "$2/obj.txt" ;; *) [ -f "$1/obj.txt" ] || exit 1 ;; esac ;;
esac
SH
cat > "$T/bin/psql" <<'SH'
#!/bin/sh
echo "psql PGHOST=${PGHOST:-} $*" >> "$CALLS"
case "$*" in
  *pg_database*) printf 'synap\nkratos\n' ;;
  *"from api_keys"*)
    case "${PGHOST:-}" in *synap-drill*) echo "${FAKE_DRILL_FP:-${FAKE_USERS:-5}|${FAKE_ENTS:-100}|1}" ;;
                          *) echo "${FAKE_USERS:-5}|${FAKE_ENTS:-100}|1" ;; esac ;;
  *"insert into backup_runs"*) printf '%s\n' "$*" >> "$RUNS" ;;
  *"create database"*) ;;
  *) exit 1 ;;
esac
SH
printf '#!/bin/sh\necho dump\n' > "$T/bin/pg_dump"
printf '#!/bin/sh\necho "pg_restore PGHOST=${PGHOST:-} $*" >> "$CALLS"; cat >/dev/null; exit 0\n' > "$T/bin/pg_restore"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/pg_isready"
printf '#!/bin/sh\necho "initdb $*" >> "$CALLS"\n' > "$T/bin/initdb"
printf '#!/bin/sh\necho "pg_ctl $*" >> "$CALLS"\n' > "$T/bin/pg_ctl"
cat > "$T/bin/curl" <<'SH'
#!/bin/sh
echo "curl $*" >> "$CALLS"
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
[ -n "$out" ] && [ "$out" != /dev/null ] && echo "not-restic" > "$out"
exit 0
SH
cat > "$T/bin/docker" <<'SH'
#!/bin/sh
echo "docker $*" >> "$CALLS"
case "$1" in
  inspect) echo true ;;
  cp) printf '#!/bin/sh\nexit 0\n' > "$3"; chmod +x "$3" ;;
  exec)
    shift; stdin=""; [ "$1" = -i ] && { stdin=1; shift; }; shift
    case "$*" in
      *pg_isready*) exit 0 ;;
      *pg_restore*) cat >/dev/null; echo "EVENT pg_restore" >> "$CALLS" ;;
      *"from api_keys"*) echo "EVENT fingerprint" >> "$CALLS"; cat "$FAKE_LIVE_FP_FILE" ;;
      *"count(*) from users"*) echo 5 ;;
      *"from pg_database where datname"*) echo 1 ;;
      *psql*) [ -n "$stdin" ] && cat > "$T_STDIN_SINK"; echo "EVENT psql-stdin" >> "$CALLS" ;;
    esac ;;
esac
SH
cat > "$T/bin/fake-compose" <<'SH'
#!/bin/sh
echo "compose $*" >> "$CALLS"
case "$*" in
  *"ps -a -q postgres"*) echo pg-cid ;;
  *"ps -q minio"*) echo minio-cid ;;
  *"up -d postgres"*) [ -f "$SYNAP_DEPLOY_DIR/.env" ] && echo "EVENT postgres-up env-present" >> "$CALLS" || echo "EVENT postgres-up NO-ENV" >> "$CALLS" ;;
  *"up -d minio"*) echo "EVENT minio-up" >> "$CALLS" ;;
  *minio-import*)
    for last; do :; done
    host="$SYNAP_DEPLOY_DIR/backups/postgres${last#/backups}"
    [ -f "$host/files/obj.txt" ] && echo "EVENT minio-import ok" >> "$CALLS" || { echo "EVENT minio-import MISSING $host" >> "$CALLS"; exit 1; } ;;
esac
SH
chmod +x "$T/bin/"*
cat > "$T/head" <<'SH'
#!/usr/bin/env python3
import sys
a = sys.argv[1:]
if len(a) >= 2 and a[0] == "-n" and a[1].startswith("-"):
    lines = sys.stdin.readlines(); k = int(a[1][1:])
    sys.stdout.writelines(lines[:max(0, len(lines) - k)])
else:
    import subprocess; sys.exit(subprocess.call(["/usr/bin/head", *a]))
SH
chmod +x "$T/head"; [ "$(uname)" = Darwin ] && cp "$T/head" "$T/bin/head"   # GNU `head -n -K` shim

# The backup container's context (docker-compose.yml postgres-backup env).
ct() { env SYNAP_PG_DIRECT=1 SYNAP_BACKUPS_DIR="$T/backups" SYNAP_STATE_DIR="$T/state" \
        SYNAP_ENV_FILE="$T/deploy/.env" BACKUP_KEEP=5 TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$@"; }
mkdir -p "$T/tmp"
calls_since() { tail -n +"$(( $1 + 1 ))" "$CALLS"; }
mark() { wc -l < "$CALLS" | tr -d ' '; }
REPO="$T/repo"

echo "── P0. push before init"
ct BACKUP_REPOSITORY="$REPO" sh "$SAFETY" run >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q "synap backup init" "$T/out" && grep -q "'backup', 'failed'" "$RUNS" \
    && ok "no password yet → push fails loudly, recorded failed" || bad "push before init: rc=$rc $(cat "$T/out")"

echo "── I. init"
m=$(mark)
ct sh "$SAFETY" init >"$T/out" 2>&1; rc=$?
[ "$rc" = 2 ] && [ ! -e "$T/state/backup/restic-password" ] && ok "no BACKUP_REPOSITORY → refused (rc 2), no password written" || bad "init without repo: rc=$rc"
ct BACKUP_REPOSITORY="$REPO" sh "$SAFETY" init >"$T/out" 2>&1 </dev/null; rc=$?
[ "$rc" = 1 ] && [ ! -e "$T/state/backup/restic-password" ] && ! calls_since "$m" | grep -q "^restic" \
    && ok "non-tty stdout → refused before touching anything" || bad "non-tty init: rc=$rc $(cat "$T/out")"
# download path: no pinned binary yet, the fetched file fails the checksum
ct BACKUP_REPOSITORY="$REPO" SYNAP_BACKUP_KIT_STDOUT=1 sh "$SAFETY" init >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q "checksum mismatch" "$T/out" && [ ! -e "$T/state/bin/restic" ] && [ ! -e "$T/state/backup/restic-password" ] \
    && ok "restic download with a wrong checksum → refused, nothing installed" || bad "checksum: rc=$rc $(cat "$T/out")"
mkdir -p "$T/state/bin" && cp "$T/bin/restic" "$T/state/bin/restic"     # = a verified fetch
m=$(mark)
ct BACKUP_REPOSITORY="$REPO" SYNAP_BACKUP_KIT_STDOUT=1 COMPOSE_CMD="$T/bin/fake-compose" SYNAP_DEPLOY_DIR="$T/deploy" \
    sh "$SAFETY" init >"$T/kit" 2>"$T/kit.err"; rc=$?
PW="$(cat "$T/state/backup/restic-password" 2>/dev/null)"
perm() { if stat -c %a "$1" >/dev/null 2>&1; then stat -c %a "$1"; else stat -f %Lp "$1"; fi; }
[ "$rc" = 0 ] && [ "${#PW}" -ge 32 ] && [ "$(perm "$T/state/backup/restic-password")" = 600 ] && [ "$(perm "$T/state/backup")" = 700 ] \
    && ok "init → password file 0600 in a 0700 dir (${#PW} chars)" || bad "init: rc=$rc pw=${#PW} perms=$(perm "$T/state/backup/restic-password" 2>/dev/null)/$(perm "$T/state/backup" 2>/dev/null) $(cat "$T/kit.err")"
[ "$(grep -c -- "$PW" "$T/kit")" = 1 ] && grep -q "TWO PLACES YOU CONTROL" "$T/kit" && grep -q "restore --from-snapshot" "$T/kit" \
    && ok "recovery kit printed once (password, restore command, two-places message)" || bad "kit: $(cat "$T/kit")"
! grep -q -- "$PW" "$T/kit.err" && ! grep -q -- "$PW" "$CALLS" && ok "password never on stderr nor in any command line" || bad "password leaked to stderr/argv"
calls_since "$m" | grep -q "^restic init" && [ -x "$T/state/bin/mc" ] && ok "restic init ran; mc copied out of the minio container" || bad "init calls: $(calls_since "$m")"
ct BACKUP_REPOSITORY="$REPO" SYNAP_BACKUP_KIT_STDOUT=1 sh "$SAFETY" init >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && ! grep -q -- "$PW" "$T/out" && [ "$(cat "$T/state/backup/restic-password")" = "$PW" ] \
    && ok "second init refuses, prints no secret, keeps the password" || bad "re-init: rc=$rc"
cp "$T/state/bin/mc" "$T/state/bin/mc.real" 2>/dev/null; cp "$T/bin/mc" "$T/state/bin/mc"   # the copied mc → our fake

echo "── P. push"
echo "BACKUP_REPOSITORY=$REPO" >> "$T/deploy/.env"
echo "stuff" > "$T/state/release"
m=$(mark)
ct sh "$SAFETY" run >"$T/out" 2>&1; rc=$?
snap1="$(ls "$REPO/snaps" | grep -v meta | tail -1)"
S="$REPO/snaps/$snap1"
[ "$rc" = 0 ] && [ -n "$snap1" ] && ok "good dump → snapshot ${snap1:0:8}" || bad "push: rc=$rc $(cat "$T/out")"
calls_since "$m" | grep "^restic backup" | grep -q -- "--tag fp:5|100|1" && ok "snapshot tagged with the dump's fingerprint" || bad "no fp tag: $(calls_since "$m" | grep '^restic backup')"
ls "$S/backups/"*-auto/synap.dump >/dev/null 2>&1 && [ -f "$S/synap-deploy/.env" ] && [ -f "$S/synap-state/release" ] && [ -f "$S/backups/.minio-mirror/files/obj.txt" ] \
    && ok "snapshot holds dumps + .env + state/ + MinIO export (at the container paths)" || bad "snapshot content: $(cd "$S" && find . | head -20)"
[ ! -e "$S/synap-state/bin" ] && [ ! -e "$S/synap-state/backup" ] && ok "state/bin and the password are excluded from the snapshot" || bad "excluded paths present"
grep -q "'backup', 'ok'.*'$snap1'" "$RUNS" && ok "backup_runs row: ok + snapshot id + fingerprint" || bad "runs: $(tail -1 "$RUNS")"
calls_since "$m" | grep -q "^curl .*https://hc.example/ping/abc" && ok "heartbeat pinged on success" || bad "no heartbeat"

m=$(mark); n1="$(ls "$REPO/snaps" | grep -vc meta)"
ct FAKE_USERS=0 sh "$SAFETY" run >"$T/out" 2>&1; rc=$?
[ "$rc" = 3 ] && ! calls_since "$m" | grep -q "^restic backup" && [ "$(ls "$REPO/snaps" | grep -vc meta)" = "$n1" ] \
    && ok "SUSPECT dump (0 users) → exit 3, NOT pushed" || bad "suspect push: rc=$rc $(calls_since "$m" | grep restic)"
! calls_since "$m" | grep -q "^curl" && ok "SUSPECT → no heartbeat (the dead-man alarm fires)" || bad "suspect pinged the heartbeat"

m=$(mark)
ct FAKE_RESTIC_FAIL=1 sh "$SAFETY" run >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && [ -s "$T/backups/.push-failed" ] && ! calls_since "$m" | grep -q "^curl" && grep -q "'backup', 'failed'.*restic backup failed" "$RUNS" \
    && ok "restic failure → exit 1, .push-failed, no heartbeat, recorded" || bad "restic fail: rc=$rc"
ct sh "$SAFETY" run >"$T/out" 2>&1; [ ! -e "$T/backups/.push-failed" ] && ok "next good push clears .push-failed" || bad ".push-failed stuck"
snap_good="$(ls "$REPO/snaps" | grep -v meta | tail -1)"

echo "── D. drill"
m=$(mark)
ct sh "$SAFETY" drill >"$T/out" 2>&1; rc=$?
[ "$rc" = 0 ] && grep -q "'drill', 'ok'" "$RUNS" && [ ! -e "$T/backups/.drill-failed" ] && ok "faithful snapshot → drill GREEN, recorded" || bad "drill green: rc=$rc $(cat "$T/out")"
calls_since "$m" | grep -q "^pg_restore PGHOST=.*synap-drill" && ! calls_since "$m" | grep -E "^(pg_restore|psql) PGHOST=($|postgres)" | grep -qv "insert into backup_runs" \
    && ok "drill restores into the throwaway cluster only (never PGHOST=postgres)" || bad "drill touched live: $(calls_since "$m" | grep -E '^(pg_restore|psql)')"
ct FAKE_DRILL_FP="5|99|1" sh "$SAFETY" drill >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q "fingerprint mismatch" "$T/out" && [ -s "$T/backups/.drill-failed" ] && grep -q "'drill', 'failed'" "$RUNS" \
    && ok "fingerprint mismatch → drill RED (exit 1, .drill-failed, recorded)" || bad "drill mismatch: rc=$rc $(cat "$T/out")"
ct FAKE_RESTIC_CORRUPT=1 sh "$SAFETY" drill >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q "corrupt" "$T/out" && ok "corrupt snapshot → drill RED" || bad "drill corrupt: rc=$rc $(cat "$T/out")"
ct sh "$SAFETY" drill nosuchsnap >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && ok "unknown snapshot → drill RED" || bad "drill unknown snapshot: rc=$rc"

echo "── P. append-only"
calls="$(grep -E "^restic" "$CALLS" | awk '{print $2}' | sort -u | tr '\n' ' ')"
! grep -qE "^restic (forget|prune)" "$CALLS" && [ -n "$calls" ] && ok "no forget/prune across every run (restic subcommands used: $calls)" || bad "forget/prune called: $(grep -E '^restic (forget|prune)' "$CALLS")"
static="$(grep -nE '^[^#]*_bk_restic[^#]*\b(forget|prune)\b' "$SAFETY" || true)"
[ -z "$static" ] && grep -c '_bk_restic ' "$SAFETY" | grep -qv '^0$' && ok "static: no _bk_restic call site names forget/prune" || bad "static: $static"

echo "── R. restore from snapshot (fresh host)"
F="$T/fresh"; mkdir -p "$F/state/bin"; cp "$T/bin/restic" "$F/state/bin/restic"
cp "$T/state/backup/restic-password" "$T/kit-password"
echo "5|100|1" > "$T/live-fp"
export FAKE_LIVE_FP_FILE="$T/live-fp" T_STDIN_SINK="$T/stdin-sink"
m=$(mark)
env SYNAP_DEPLOY_DIR="$F" COMPOSE_CMD="$T/bin/fake-compose" BACKUP_REPOSITORY="$REPO" BACKUP_PASSWORD_FILE="$T/kit-password" \
    PATH="$T/bin:$PATH" sh "$SAFETY" restore-snapshot latest >"$T/out" 2>&1; rc=$?
# line number of the FIRST (or, with `last`, LAST) call matching $1
ev="$(calls_since "$m" | grep -nE '^(restic restore|EVENT)')"
pos() { printf '%s\n' "$ev" | grep -E "$1" | { if [ "${2:-}" = last ]; then tail -n 1; else head -n 1; fi; } | cut -d: -f1; }
a="$(pos 'restic restore')"; e="$(pos 'postgres-up')"; p="$(pos 'pg_restore')"; i="$(pos 'minio-import')"; fpos="$(pos 'EVENT fingerprint' last)"
[ "$rc" = 0 ] && [ -n "$a" ] && [ -n "$e" ] && [ -n "$p" ] && [ -n "$i" ] && [ -n "$fpos" ] \
    && [ "$a" -lt "$e" ] && [ "$e" -lt "$p" ] && [ "$p" -lt "$i" ] && [ "$i" -lt "$fpos" ] \
    && ok "order: fetch → secrets → DBs → MinIO → fingerprint" || bad "restore order/rc=$rc: $(printf '%s' "$ev" | tr '\n' ';') $(tail -3 "$T/out")"
calls_since "$m" | grep -q "EVENT postgres-up env-present" && cmp -s "$F/.env" "$T/deploy/.env" && [ "$(perm "$F/.env")" = 600 ] \
    && ok "restored .env (0600) is in place before postgres starts" || bad ".env not restored first"
[ -f "$F/state/release" ] && [ -e "$F/state/postgres-initialized" ] && ok "state/ restored; init marker written after the data" || bad "state: $(ls -A "$F/state")"
grep -q "pg-secret-1" "$T/stdin-sink" && ! grep -q "pg-secret-1" "$CALLS" && ok "synap role aligned with the restored POSTGRES_PASSWORD via stdin (not argv)" || bad "role password alignment"
cmp -s "$F/state/backup/restic-password" "$T/kit-password" && ! ls -d "$F/backups/postgres/.restore-"* >/dev/null 2>&1 \
    && ok "kit password installed for future pushes; staging removed" || bad "post-restore: $(ls -A "$F/state/backup" "$F/backups/postgres" 2>&1)"
# MinIO import itself, driven directly in the container context
stage="$(mktemp -d "$T/tmp/imp.XXXX")"; mkdir -p "$stage/files"; echo object > "$stage/files/obj.txt"
m=$(mark)
ct sh "$SAFETY" minio-import "$stage" >"$T/out" 2>&1; rc=$?
[ "$rc" = 0 ] && calls_since "$m" | grep -q "^mc .*mb --ignore-existing synapbk/files" && calls_since "$m" | grep -q "^mc .*mirror --overwrite --quiet $stage/files/ synapbk/files" \
    && ok "minio-import recreates each bucket and mirrors it back" || bad "minio-import: rc=$rc $(calls_since "$m")"
# mismatch → RED, staging kept, nothing started
F2="$T/fresh2"; mkdir -p "$F2/state/bin"; cp "$T/bin/restic" "$F2/state/bin/restic"
echo "5|7|1" > "$T/live-fp"
env SYNAP_DEPLOY_DIR="$F2" COMPOSE_CMD="$T/bin/fake-compose" BACKUP_REPOSITORY="$REPO" BACKUP_PASSWORD_FILE="$T/kit-password" \
    PATH="$T/bin:$PATH" sh "$SAFETY" restore-snapshot latest >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q "MISMATCH" "$T/out" && ls -d "$F2/backups/postgres/.restore-"* >/dev/null 2>&1 \
    && ok "fingerprint mismatch after restore → RED, staging kept" || bad "restore mismatch: rc=$rc $(tail -2 "$T/out")"
env SYNAP_DEPLOY_DIR="$T/fresh3" COMPOSE_CMD="$T/bin/fake-compose" BACKUP_REPOSITORY="$REPO" BACKUP_PASSWORD_FILE="$T/nope" \
    PATH="$T/bin:$PATH" sh "$SAFETY" restore-snapshot latest >"$T/out" 2>&1; rc=$?
[ "$rc" = 2 ] && [ ! -e "$T/fresh3/.env" ] && ok "no kit password → refused, nothing written" || bad "restore without password: rc=$rc"

echo "── C. synap CLI → the same door"
SYNAP_CLI="${BACKUP_TEST_SYNAP:-$SCRIPT_DIR/../../synap}"
F4="$T/fresh4"; mkdir -p "$F4/state/bin"; cp "$T/bin/restic" "$F4/state/bin/restic"; : > "$F4/docker-compose.yml"
echo "5|100|1" > "$T/live-fp"
# The CLI's `docker compose …` goes through its docker() wrapper (pgdata guard)
# to `command docker` — here a fake that answers the guard and hands compose to
# the compose stand-in.
mkdir -p "$T/clibin"
cat > "$T/clibin/docker" <<'SH'
#!/bin/sh
if [ "$1" = compose ]; then shift; exec "$FAKE_COMPOSE" "$@"; fi
case "$*" in
  *".Config.Env"*) echo "PGDATA=/home/postgres/pgdata/data"; exit 0 ;;
  *".Mounts"*) echo "/home/postgres/pgdata"; exit 0 ;;
  "ps "*|"volume "*) exit 0 ;;
esac
exec "$FAKE_DOCKER" "$@"
SH
chmod +x "$T/clibin/docker"
cli() { env BACKUP_REPOSITORY="$REPO" SYNAP_DEPLOY_DIR="$F4" FAKE_COMPOSE="$T/bin/fake-compose" FAKE_DOCKER="$T/bin/docker" PATH="$T/clibin:$T/bin:$PATH" bash "$SYNAP_CLI" "$@"; }
: > "$F4/legacy.tar.gz"
cli restore "$F4/legacy.tar.gz" >"$T/out" 2>&1 </dev/null; rc=$?
[ "$rc" = 1 ] && grep -q "not a backup directory" "$T/out" && [ ! -e "$F4/.env" ] && ok "legacy tar.gz restore is retired (refused, nothing touched)" || bad "legacy restore: rc=$rc $(cat "$T/out")"
m=$(mark)
echo yes | cli restore --from-snapshot latest --password-file "$T/kit-password" >"$T/out" 2>&1; rc=$?
cmp -s "$F4/.env" "$T/deploy/.env" && calls_since "$m" | grep -q "^restic restore" && calls_since "$m" | grep -q "EVENT minio-import ok" \
    && calls_since "$m" | grep -q "^compose up -d --remove-orphans" \
    && ok "synap restore --from-snapshot runs the engine with the kit password, then starts the stack" || bad "cli restore: rc=$rc $(cat "$T/out")"
echo no | cli restore --from-snapshot latest --password-file "$T/kit-password" >"$T/out" 2>&1; rc=$?
[ "$rc" = 0 ] && grep -q "cancelled" "$T/out" && ok "declining the confirmation changes nothing" || bad "cancel: rc=$rc"

echo "── L. compose layout = script constants"
python3 - "$COMPOSE_FILE" "$SAFETY_SRC" <<'PY'
import re, sys, yaml
svc = yaml.safe_load(open(sys.argv[1]))["services"]["postgres-backup"]
src = open(sys.argv[2]).read()
const = {k: re.search(r'^%s="([^"]+)"' % k, src, re.M).group(1) for k in ("_BK_CT_BACKUPS", "_BK_CT_STATE", "_BK_CT_DEPLOY")}
env = svc["environment"]; vols = {v.split(":")[1]: v.split(":")[0] for v in svc["volumes"]}
fails = []
for k, want in (("SYNAP_BACKUPS_DIR", const["_BK_CT_BACKUPS"]), ("SYNAP_STATE_DIR", const["_BK_CT_STATE"])):
    if env.get(k) != want: fails.append(f"{k}={env.get(k)} != {want}")
if env.get("SYNAP_ENV_FILE") != const["_BK_CT_DEPLOY"] + "/.env": fails.append("SYNAP_ENV_FILE")
for ct, host in ((const["_BK_CT_BACKUPS"], "./backups/postgres"), (const["_BK_CT_STATE"], "./state"), (const["_BK_CT_DEPLOY"], ".")):
    if vols.get(ct) != host: fails.append(f"mount {ct} <- {vols.get(ct)} (want {host})")
if str(env.get("SYNAP_PG_DIRECT")) != "1": fails.append("SYNAP_PG_DIRECT")
print(("  ✓ " if not fails else "  ✗ ") + "compose env + mounts match _BK_CT_* " + (str(const) if not fails else "; ".join(fails)))
sys.exit(1 if fails else 0)
PY
if [ $? -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo; echo "RESULTS PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
