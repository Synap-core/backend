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
#   I2. init --non-interactive — no TTY: kit file 0600 (never stdout/argv), marker
#                 state/kit/status=pending, re-run no-op; loop auto-init predicate.
#   K. kit      — printing is not saving (interactive init stays pending); the
#                 read-back compares the password's last 6; the W7 layout
#                 migrates into state/kit; the kit dir's owner uid equals the
#                 backend image's user (deploy/Dockerfile).
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
  inspect) case "$*" in *"{{.Image}}"*) echo "${FAKE_MINIO_IMAGE:-sha256:minio-1}" ;; *) echo true ;; esac ;;
  cp) printf '#!/bin/sh\nexit 0\n' > "$3"; chmod +x "$3" ;;
  exec)
    shift; stdin=""; [ "$1" = -i ] && { stdin=1; shift; }; shift
    case "$*" in
      *pg_isready*) exit 0 ;;
      *pg_restore*) cat >/dev/null; echo "EVENT pg_restore" >> "$CALLS" ;;
      *"from api_keys"*) echo "EVENT fingerprint" >> "$CALLS"; cat "$FAKE_LIVE_FP_FILE" ;;
      *"count(*) from users"*) echo 5 ;;
      # A model of the cluster's database list ($FAKE_DBS): a restore renames
      # the live database aside, creates a fresh one, then drops the aside one.
      *pg_encoding_to_char*) echo "UTF8|C.UTF-8|C.UTF-8" ;;
      *pg_database_size*) echo 100 ;;
      *pg_terminate_backend*) : ;;
      *"from pg_database where datname="*)
        n="$(echo "$*" | sed -n "s/.*datname='\([^']*\)'.*/\1/p")"; grep -qx "$n" "$FAKE_DBS" && echo 1 || echo 0 ;;
      *"alter database "*" rename to "*)
        a="$(echo "$*" | sed -n 's/.*alter database "\([^"]*\)" rename to.*/\1/p')"; b="$(echo "$*" | sed -n 's/.*rename to "\([^"]*\)".*/\1/p')"
        { grep -vx "$a" "$FAKE_DBS"; echo "$b"; } > "$FAKE_DBS.n"; mv "$FAKE_DBS.n" "$FAKE_DBS"; echo "EVENT rename $a $b" >> "$CALLS" ;;
      *"create database "*)
        n="$(echo "$*" | sed -n 's/.*create database "\([^"]*\)".*/\1/p')"; echo "$n" >> "$FAKE_DBS"; echo "EVENT create $n" >> "$CALLS" ;;
      *"drop database "*)
        n="$(echo "$*" | sed -n 's/.*drop database \(if exists \)\{0,1\}"\([^"]*\)".*/\2/p')"; grep -vx "$n" "$FAKE_DBS" > "$FAKE_DBS.n"; mv "$FAKE_DBS.n" "$FAKE_DBS"; echo "EVENT drop $n" >> "$CALLS" ;;
      *psql*) [ -n "$stdin" ] && cat > "$T_STDIN_SINK"; echo "EVENT psql-stdin" >> "$CALLS" ;;
    esac ;;
esac
SH
export FAKE_DBS="$T/dbs"; printf 'synap\nkratos\n' > "$FAKE_DBS"
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
        SYNAP_PG_LIB_DIR="${PG_LIB:-$T/no-pg-lib}" \
        SYNAP_ENV_FILE="$T/deploy/.env" BACKUP_KEEP=5 TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$@"; }
mkdir -p "$T/tmp"
# Dump dirs are named to the second ($ts-auto, the format below) and a kept
# dump blocks a second run in the SAME second (mv fails, the run returns
# early). Real runs are an hour apart; a fast CI runner's are not, so every
# backup run below starts in a fresh second.
fresh_second() { local s0; s0="$(date -u +%Y%m%dT%H%M%SZ)"; while [ "$(date -u +%Y%m%dT%H%M%SZ)" = "$s0" ]; do sleep 0.1; done; }
calls_since() { tail -n +"$(( $1 + 1 ))" "$CALLS"; }
# Under pipefail never pipe this into `grep -q`: grep exits at the first match,
# tail then dies of SIGPIPE, and the check fails at random (it did, about 1 run
# in 2 on the devbox). Pipe into `grep >/dev/null`, which reads everything.
mark() { wc -l < "$CALLS" | tr -d ' '; }
REPO="$T/repo"

echo "── P0. push before init"
fresh_second
ct BACKUP_REPOSITORY="$REPO" sh "$SAFETY" run >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q "synap backup init" "$T/out" && grep -q "'backup', 'failed'" "$RUNS" \
    && ok "no password yet → push fails loudly, recorded failed" || bad "push before init: rc=$rc $(cat "$T/out")"

echo "── I. init"
m=$(mark)
ct sh "$SAFETY" init >"$T/out" 2>&1; rc=$?
[ "$rc" = 2 ] && [ ! -e "$T/state/backup/restic-password" ] && ok "no BACKUP_REPOSITORY → refused (rc 2), no password written" || bad "init without repo: rc=$rc"
ct BACKUP_REPOSITORY="$REPO" sh "$SAFETY" init >"$T/out" 2>&1 </dev/null; rc=$?
[ "$rc" = 1 ] && [ ! -e "$T/state/backup/restic-password" ] && ! calls_since "$m" | grep >/dev/null "^restic" \
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
calls_since "$m" | grep >/dev/null "^restic init" && [ -x "$T/state/bin/mc" ] && ok "restic init ran; mc copied out of the minio container" || bad "init calls: $(calls_since "$m")"
ct BACKUP_REPOSITORY="$REPO" SYNAP_BACKUP_KIT_STDOUT=1 sh "$SAFETY" init >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && ! grep -q -- "$PW" "$T/out" && [ "$(cat "$T/state/backup/restic-password")" = "$PW" ] \
    && ok "second init refuses, prints no secret, keeps the password" || bad "re-init: rc=$rc"
cp "$T/state/bin/mc" "$T/state/bin/mc.real" 2>/dev/null; cp "$T/bin/mc" "$T/state/bin/mc"   # the copied mc → our fake
[ "$(cat "$T/state/kit/status" 2>/dev/null)" = pending ] && [ "$(perm "$T/state/kit/status")" = 644 ] \
    && ok "interactive init PRINTS the kit but leaves state/kit/status = pending (printing is not saving)" || bad "interactive init marker: $(cat "$T/state/kit/status" 2>/dev/null)"
[ "$(perm "$T/state/kit/recovery-kit.txt")" = 600 ] && [ "$(perm "$T/state/kit")" = 700 ] && grep -q -- "$PW" "$T/state/kit/recovery-kit.txt" \
    && ok "interactive init also writes the kit to state/kit/recovery-kit.txt (0600 in a 0700 dir) for the app's download" || bad "interactive kit file: $(perm "$T/state/kit/recovery-kit.txt" 2>/dev/null)"

echo "── I2. init --non-interactive (no TTY: the hourly loop / the CP vault delivery)"
S2="$T/state2"; REPO2="$T/repo2"; B2KEY="b2-application-key-9f3a"; mkdir -p "$S2/bin" && cp "$T/bin/restic" "$S2/bin/restic"
ni() { ct SYNAP_STATE_DIR="$S2" BACKUP_REPOSITORY="$REPO2" BACKUP_B2_ACCOUNT_KEY="$B2KEY" COMPOSE_CMD="$T/bin/fake-compose" SYNAP_DEPLOY_DIR="$T/deploy" "$@"; }
ni sh "$SAFETY" init --non-interactive >"$T/ni.out" 2>"$T/ni.err" </dev/null; rc=$?
PW2="$(cat "$S2/backup/restic-password" 2>/dev/null)"; KIT="$S2/kit/recovery-kit.txt"
[ "$rc" = 0 ] && [ "${#PW2}" -ge 32 ] && [ "$(perm "$KIT")" = 600 ] && [ "$(perm "$S2/kit")" = 700 ] && [ "$(perm "$S2/backup")" = 700 ] \
    && grep -q -- "$PW2" "$KIT" && grep -q "Repository : $REPO2" "$KIT" && grep -q "restore --from-snapshot" "$KIT" && grep -q "BACKUP_B2_ACCOUNT_KEY=$B2KEY" "$KIT" \
    && ok "non-interactive init → kit file 0600 (repo, password, B2 key, restore steps) without a TTY" || bad "ni init: rc=$rc kit=$(perm "$KIT" 2>/dev/null) $(cat "$T/ni.err")"
! grep -q -- "$PW2" "$T/ni.out" "$T/ni.err" && ! grep -q -- "$B2KEY" "$T/ni.out" "$T/ni.err" && ! grep -q -- "$PW2" "$CALLS" \
    && ok "the password and keys never reach stdout, stderr or any command line" || bad "secret leaked: $(cat "$T/ni.out" "$T/ni.err")"
[ "$(cat "$S2/kit/status" 2>/dev/null)" = pending ] && ok "marker state/kit/status = pending (recovery kit not yet saved)" || bad "marker: $(cat "$S2/kit/status" 2>/dev/null)"
sum1="$(cat "$KIT" "$S2/backup/restic-password" | cksum)"; m=$(mark)
ni sh "$SAFETY" init --non-interactive >"$T/ni.out" 2>"$T/ni.err" </dev/null; rc=$?
[ "$rc" = 0 ] && ! calls_since "$m" | grep >/dev/null "^restic" && [ "$(cat "$KIT" "$S2/backup/restic-password" | cksum)" = "$sum1" ] && ! grep -q -- "$PW2" "$T/ni.out" "$T/ni.err" \
    && ok "re-run is a no-op (rc 0, no restic call, kit + password unchanged, nothing printed)" || bad "ni re-run: rc=$rc $(calls_since "$m" | head -3)"
ni sh -c '. "$1"; _bk_kit_mark saved' _ "$SAFETY"
[ "$(cat "$S2/kit/status")" = saved ] && ok "kit-saved clears the pending marker" || bad "kit-saved: $(cat "$S2/kit/status")"

echo "── M. mc: the backup container has no docker; the host provides mc"
# The system tools minus any docker (a CI runner has /usr/bin/docker), so the
# backup container's real shape — no docker CLI, no socket — can be staged.
mkdir -p "$T/sys" "$T/ctbin"
for d in /usr/bin /bin; do for f in "$d"/*; do b="${f##*/}"; [ "$b" = docker ] && continue; [ -e "$T/sys/$b" ] || ln -s "$f" "$T/sys/$b"; done; done
for f in "$T/bin/"*; do [ "${f##*/}" = docker ] || ln -s "$f" "$T/ctbin/${f##*/}"; done
NOD="$T/ctbin:$T/sys"
PATH="$NOD" command -v docker >/dev/null 2>&1 && bad "a docker is still on the staged container PATH — the case cannot be staged"
S4="$T/state4"; REPO4="$T/repo4"; mkdir -p "$S4/bin" && cp "$T/bin/restic" "$S4/bin/restic"; m=$(mark)
ct SYNAP_STATE_DIR="$S4" BACKUP_REPOSITORY="$REPO4" env PATH="$NOD" sh "$SAFETY" init --non-interactive >"$T/m.out" 2>"$T/m.err" </dev/null; rc=$?
[ "$rc" = 0 ] && [ -s "$S4/backup/restic-password" ] && calls_since "$m" | grep >/dev/null "^restic init" && ! calls_since "$m" | grep -E >/dev/null "^(docker|compose) " \
    && grep -q "the pod host provides it" "$T/m.err" \
    && ok "in the backup container (no docker): init creates the repository + kit, says the host provides mc, never calls docker" \
    || bad "container init without docker: rc=$rc $(cat "$T/m.err")"
cp "$T/bin/mc" "$S4/bin/mc"; m=$(mark)
ct SYNAP_STATE_DIR="$S4" env PATH="$NOD" sh -c '. "$1"; _bk_ensure_mc' _ "$SAFETY" >"$T/m.out" 2>&1; rc=$?
[ "$rc" = 0 ] && ! calls_since "$m" | grep >/dev/null "^docker" && ok "in the container, a host-provided state/bin/mc is used as is" || bad "container mc present: rc=$rc"
# host side: copy once per minio image
S5="$T/state5"; mkdir -p "$S5"; m=$(mark)
host_mc() { env SYNAP_STATE_DIR="$S5" SYNAP_DEPLOY_DIR="$T/deploy" COMPOSE_CMD="$T/bin/fake-compose" PATH="$T/bin:$PATH" "$@" sh -c '. "$1"; _bk_ensure_mc' _ "$SAFETY"; }
host_mc >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && [ -x "$S5/bin/mc" ] && [ "$(cat "$S5/bin/mc.image")" = sha256:minio-1 ] && calls_since "$m" | grep >/dev/null "^docker cp minio-cid:/usr/bin/mc" \
    && ok "host: mc copied out of this pod's minio container, its image recorded" || bad "host mc copy: rc=$rc $(calls_since "$m")"
m=$(mark); host_mc >/dev/null 2>&1
! calls_since "$m" | grep >/dev/null "^docker cp" && ok "host: same minio image → mc not copied again" || bad "host: mc re-copied for an unchanged image"
m=$(mark); host_mc FAKE_MINIO_IMAGE=sha256:minio-2 >/dev/null 2>&1
calls_since "$m" | grep >/dev/null "^docker cp" && [ "$(cat "$S5/bin/mc.image")" = sha256:minio-2 ] && ok "host: a new minio image → mc refreshed" || bad "host: mc not refreshed for a new minio image"
grep -q '_ue_provide_backup_mc$' "$SCRIPT_DIR/../../synap" && [ "$(grep -c '^    _ue_provide_backup_mc$' "$SCRIPT_DIR/../../synap")" -ge 2 ] \
    && ok "synap provides mc at install AND after every verified update" || bad "synap does not call _ue_provide_backup_mc on both doors"

echo "── K. recovery kit: read-back, W7 layout migration, owner uid"
rb() { ni sh -c '. "$1"; _bk_kit_readback_ok "$2" "$3" && echo yes || echo no' _ "$SAFETY" "$1" "$S2/backup/restic-password"; }
TAIL6="${PW2: -6}"; WRONG6="$(printf '%s' "$TAIL6" | tr '0-9a-f' '1-9a-f0')"
[ "$(rb "$TAIL6")" = yes ] && [ "$(rb " $(printf '%s' "$TAIL6" | tr 'a-f' 'A-F') ")" = yes ] \
    && ok "read-back: the password's last 6 match (case and blanks ignored)" || bad "read-back refused the right tail"
[ "$(rb "$WRONG6")" = no ] && [ "$(rb "${PW2:0:6}")" = no ] && [ "$(rb "${TAIL6:1}")" = no ] && [ "$(rb "")" = no ] \
    && ok "read-back: a wrong tail, the FIRST 6, 5 characters and nothing are all refused" || bad "read-back accepted a wrong answer"
L="$T/state3"; mkdir -p "$L/backup"; echo "kit-v7" > "$L/backup/recovery-kit.txt"; echo saved > "$L/recovery-kit"
ct SYNAP_STATE_DIR="$L" sh -c '. "$1"; _bk_kit_layout' _ "$SAFETY"
[ "$(cat "$L/kit/recovery-kit.txt" 2>/dev/null)" = kit-v7 ] && [ "$(cat "$L/kit/status" 2>/dev/null)" = saved ] \
    && [ ! -e "$L/backup/recovery-kit.txt" ] && [ ! -e "$L/recovery-kit" ] && [ "$(perm "$L/kit/recovery-kit.txt")" = 600 ] && [ "$(perm "$L/kit")" = 700 ] \
    && ok "a W7 pod's kit + marker move into state/kit (0600 / 0700), old paths gone" || bad "layout migration: $(ls -la "$L" "$L/kit" 2>&1 | tr '\n' ' ')"
ct SYNAP_STATE_DIR="$L" sh -c '. "$1"; _bk_kit_layout' _ "$SAFETY"
[ "$(cat "$L/kit/recovery-kit.txt")" = kit-v7 ] && [ "$(cat "$L/kit/status")" = saved ] && ok "layout is idempotent" || bad "layout re-run changed the kit"
grep -q "_bk_kit_layout || true" "$SAFETY" && sed -n '/^backup_loop()/,/^}/p' "$SAFETY" | grep >/dev/null "_bk_kit_layout" \
    && ok "the backup loop converges the layout on every pass" || bad "backup_loop does not run _bk_kit_layout"
img_uid="$(sed -n 's/.*adduser -S nodejs -u \([0-9][0-9]*\).*/\1/p' "$SCRIPT_DIR/../Dockerfile")"
kit_uid="$(sed -n 's/^_BK_BACKEND_UID=\([0-9][0-9]*\)$/\1/p' "$SAFETY")"
[ -n "$img_uid" ] && [ "$img_uid" = "$kit_uid" ] && ok "state/kit is given to the backend image's uid ($kit_uid = deploy/Dockerfile)" || bad "uid drift: Dockerfile=$img_uid script=$kit_uid"
grep -q '\./state/kit:/opt/synap/deploy/state/kit:rw' "$COMPOSE_FILE" \
    && ok "compose mounts state/kit read-write into the backend" || bad "compose does not mount ./state/kit:/opt/synap/deploy/state/kit:rw into the backend"
rm -rf "$S2" "$REPO2"; mkdir -p "$S2/bin" && cp "$T/bin/restic" "$S2/bin/restic"
due() { ct SYNAP_STATE_DIR="$S2" "$@" sh -c '. "$1"; _bk_auto_init_due && echo due || echo no' _ "$SAFETY"; }
B2ENV=(BACKUP_REPOSITORY=b2:bucket:pods/x BACKUP_B2_ACCOUNT_ID=id BACKUP_B2_ACCOUNT_KEY=k)
[ "$(due "${B2ENV[@]}")" = no ] && ok "loop auto-init: an unregistered pod never auto-initialises" || bad "auto-init due without registration"
: > "$S2/registration.json"
[ "$(due "${B2ENV[@]}")" = due ] && ok "loop auto-init: registered pod + b2 repository + B2 keys delivered → due" || bad "auto-init not due after vault delivery"
[ "$(due BACKUP_REPOSITORY="$REPO" BACKUP_B2_ACCOUNT_ID=id BACKUP_B2_ACCOUNT_KEY=k)" = no ] && [ "$(due BACKUP_REPOSITORY=b2:bucket:x)" = no ] \
    && ok "loop auto-init: a hand-set (non-b2 / keyless) repository is left to the interactive kit" || bad "auto-init too eager"
mkdir -p "$S2/backup" && : > "$S2/backup/restic-password"
[ "$(due "${B2ENV[@]}")" = no ] && ok "loop auto-init: never once a password exists" || bad "auto-init due with a password"

echo "── P. push"
echo "BACKUP_REPOSITORY=$REPO" >> "$T/deploy/.env"
echo "stuff" > "$T/state/release"
m=$(mark)
fresh_second
ct sh "$SAFETY" run >"$T/out" 2>&1; rc=$?
snap1="$(ls "$REPO/snaps" | grep -v meta | tail -1)"
S="$REPO/snaps/$snap1"
[ "$rc" = 0 ] && [ -n "$snap1" ] && ok "good dump → snapshot ${snap1:0:8}" || bad "push: rc=$rc $(cat "$T/out")"
calls_since "$m" | grep "^restic backup" | grep >/dev/null -- "--tag fp:5|100|1" && ok "snapshot tagged with the dump's fingerprint" || bad "no fp tag: $(calls_since "$m" | grep '^restic backup')"
ls "$S/backups/"*-auto/synap.dump >/dev/null 2>&1 && [ -f "$S/synap-deploy/.env" ] && [ -f "$S/synap-state/release" ] && [ -f "$S/backups/.minio-mirror/files/obj.txt" ] \
    && ok "snapshot holds dumps + .env + state/ + MinIO export (at the container paths)" || bad "snapshot content: $(cd "$S" && find . | head -20)"
[ ! -e "$S/synap-state/bin" ] && [ ! -e "$S/synap-state/backup" ] && [ ! -e "$S/synap-state/kit" ] && [ -d "$T/state/kit" ] \
    && ok "state/bin, the password and the recovery kit are excluded from the snapshot" || bad "excluded paths present"
grep -q "'backup', 'ok'.*'$snap1'" "$RUNS" && ok "backup_runs row: ok + snapshot id + fingerprint" || bad "runs: $(tail -1 "$RUNS")"
calls_since "$m" | grep >/dev/null "^curl .*https://hc.example/ping/abc" && ok "heartbeat pinged on success" || bad "no heartbeat"

m=$(mark); n1="$(ls "$REPO/snaps" | grep -vc meta)"
fresh_second
ct FAKE_USERS=0 sh "$SAFETY" run >"$T/out" 2>&1; rc=$?
[ "$rc" = 3 ] && ! calls_since "$m" | grep >/dev/null "^restic backup" && [ "$(ls "$REPO/snaps" | grep -vc meta)" = "$n1" ] \
    && ok "SUSPECT dump (0 users) → exit 3, NOT pushed" || bad "suspect push: rc=$rc $(calls_since "$m" | grep restic)"
! calls_since "$m" | grep >/dev/null "^curl" && ok "SUSPECT → no heartbeat (the dead-man alarm fires)" || bad "suspect pinged the heartbeat"

m=$(mark)
fresh_second
ct FAKE_RESTIC_FAIL=1 sh "$SAFETY" run >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && [ -s "$T/backups/.push-failed" ] && ! calls_since "$m" | grep >/dev/null "^curl" && grep -q "'backup', 'failed'.*restic backup failed" "$RUNS" \
    && ok "restic failure → exit 1, .push-failed, no heartbeat, recorded" || bad "restic fail: rc=$rc"
fresh_second
ct sh "$SAFETY" run >"$T/out" 2>&1; [ ! -e "$T/backups/.push-failed" ] && ok "next good push clears .push-failed" || bad ".push-failed stuck: $(cat "$T/backups/.push-failed" 2>/dev/null) $(cat "$T/out")"
snap_good="$(ls "$REPO/snaps" | grep -v meta | tail -1)"

echo "── D. drill"
m=$(mark)
ct sh "$SAFETY" drill >"$T/out" 2>&1; rc=$?
[ "$rc" = 0 ] && grep -q "'drill', 'ok'" "$RUNS" && [ ! -e "$T/backups/.drill-failed" ] && ok "faithful snapshot → drill GREEN, recorded" || bad "drill green: rc=$rc $(cat "$T/out")"
calls_since "$m" | grep >/dev/null "^pg_restore PGHOST=.*synap-drill" && ! calls_since "$m" | grep -E "^(pg_restore|psql) PGHOST=($|postgres)" | grep -qv "insert into backup_runs" \
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
rn="$(pos 'EVENT rename synap synap__pre_restore')"; cr="$(pos 'EVENT create synap$')"; dr="$(pos 'EVENT drop synap__pre_restore')"
pl="$(pos 'EVENT pg_restore' last)"
[ -n "$rn" ] && [ -n "$cr" ] && [ -n "$dr" ] && [ "$rn" -lt "$cr" ] && [ "$cr" -lt "$pl" ] && [ "$pl" -lt "$dr" ] && [ "$(sort "$FAKE_DBS" | tr '\n' ' ')" = "kratos synap " ] \
    && ok "DBs restore into FRESH databases (live renamed aside → created → restored → aside dropped)" || bad "fresh restore: rename=$rn create=$cr restore=$pl drop=$dr dbs=$(tr '\n' ' ' < "$FAKE_DBS")"
calls_since "$m" | grep >/dev/null "EVENT postgres-up env-present" && cmp -s "$F/.env" "$T/deploy/.env" && [ "$(perm "$F/.env")" = 600 ] \
    && ok "restored .env (0600) is in place before postgres starts" || bad ".env not restored first"
[ -f "$F/state/release" ] && [ -e "$F/state/postgres-initialized" ] && ok "state/ restored; init marker written after the data" || bad "state: $(ls -A "$F/state")"
grep -q "pg-secret-1" "$T/stdin-sink" && ! grep -q "pg-secret-1" "$CALLS" && ok "synap role aligned with the restored POSTGRES_PASSWORD via stdin (not argv)" || bad "role password alignment"
cmp -s "$F/state/backup/restic-password" "$T/kit-password" && ! ls -d "$F/backups/postgres/.restore-"* >/dev/null 2>&1 \
    && ok "kit password installed for future pushes; staging removed" || bad "post-restore: $(ls -A "$F/state/backup" "$F/backups/postgres" 2>&1)"
# MinIO import itself, driven directly in the container context
stage="$(mktemp -d "$T/tmp/imp.XXXX")"; mkdir -p "$stage/files"; echo object > "$stage/files/obj.txt"
m=$(mark)
ct sh "$SAFETY" minio-import "$stage" >"$T/out" 2>&1; rc=$?
[ "$rc" = 0 ] && calls_since "$m" | grep >/dev/null "^mc .*mb --ignore-existing synapbk/files" && calls_since "$m" | grep >/dev/null "^mc .*mirror --overwrite --quiet $stage/files/ synapbk/files" \
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
cmp -s "$F4/.env" "$T/deploy/.env" && calls_since "$m" | grep >/dev/null "^restic restore" && calls_since "$m" | grep >/dev/null "EVENT minio-import ok" \
    && calls_since "$m" | grep >/dev/null "^compose up -d --remove-orphans" \
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
