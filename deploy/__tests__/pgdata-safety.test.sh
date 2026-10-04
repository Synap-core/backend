#!/usr/bin/env bash
# ============================================================================
# Tripwire for the 2026-10-02 pod wipe (deploy/pgdata-safety.sh header).
# ============================================================================
# The defect: compose mounted `postgres_data` at /var/lib/postgresql/data while
# the timescaledb-ha image keeps its cluster at /home/postgres/pgdata/data. Every
# type, lint and health check stayed green for eight months while the volume
# was empty; one container recreate deleted a pod. So this test asserts the
# things that would have caught it, daemon-free:
#
#   S. STRUCTURE (parsed YAML, not grep):
#      S1 postgres pins PGDATA to the script's PGDATA_CLUSTER_DIR
#      S2 postgres_data is mounted at the script's PGDATA_MOUNT_TARGET, and
#         PGDATA lies strictly UNDER it
#      S3 nothing is mounted at the stock /var/lib/postgresql/data
#      S4 the entrypoint refuses to start off-mount and refuses a blank initdb
#         over the state marker, and still execs the image entrypoint
#      S5 postgres-backup uses the SAME image (pg_dump version = server
#         version), writes to a HOST bind dir (not a named volume — prune and
#         `down -v` must not reach backups), shares ./state, has a healthcheck
#   D. DOORS: every script that runs `compose up|run` calls the guard BEFORE its
#      first such line (positions derived from the files, not hand-listed);
#      the `synap` CLI intercepts `docker compose up|run|create` itself.
#   B. BEHAVIOUR of pgdata_layout against a mocked docker: the exact incident
#      configuration reads `legacy`; a mount that is only a STRING prefix of
#      PGDATA (/home/postgres/pg) does not count as its parent.
#
# NOT covered (stated, measured by hand on CT101 2026-10-04 with the real
# image): the entrypoint's runtime refusals (exit 78 off-mount; exit 78 on an
# empty volume with the marker), the legacy move (fingerprint 7|123|2 before =
# after), and the backup loop. Those need a Docker daemon; CI has none here.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
COMPOSE_FILE="${PGDATA_TEST_COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.yml}"
SAFETY="$DEPLOY_DIR/pgdata-safety.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $*"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $*"; }

MOUNT_TARGET="$(sed -n 's/^PGDATA_MOUNT_TARGET="\(.*\)"$/\1/p' "$SAFETY")"
CLUSTER_DIR="$(sed -n 's/^PGDATA_CLUSTER_DIR="\(.*\)"$/\1/p' "$SAFETY")"
[ -n "$MOUNT_TARGET" ] && [ -n "$CLUSTER_DIR" ] && ok "layout constants read from pgdata-safety.sh ($MOUNT_TARGET, $CLUSTER_DIR)" \
    || bad "could not read PGDATA_MOUNT_TARGET / PGDATA_CLUSTER_DIR from $SAFETY"

echo "── S. compose structure ($COMPOSE_FILE)"
python3 - "$COMPOSE_FILE" "$MOUNT_TARGET" "$CLUSTER_DIR" <<'PY'
import sys, yaml
path, mount, cluster = sys.argv[1:4]
doc = yaml.safe_load(open(path))
svcs = doc.get("services") or {}
fails = []
def check(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: fails.append(msg)

pg = svcs.get("postgres")
check(isinstance(pg, dict), "postgres service exists (non-vacuity)")
if not isinstance(pg, dict): sys.exit(1)

def env_of(s):
    e = s.get("environment") or {}
    if isinstance(e, list):
        e = dict(x.split("=", 1) if "=" in x else (x, "") for x in e)
    return e

def vols_of(s):
    out = []
    for v in s.get("volumes") or []:
        if isinstance(v, str):
            parts = v.split(":")
            out.append((parts[0], parts[1] if len(parts) > 1 else parts[0]))
        else:
            out.append((v.get("source"), v.get("target")))
    return out

env = env_of(pg); vols = vols_of(pg)
check(len(vols) >= 2, f"postgres declares volumes (non-vacuity: {len(vols)})")
check(env.get("PGDATA") == cluster, f"S1 PGDATA pinned to {cluster} (got {env.get('PGDATA')!r})")
data_targets = [t for (s, t) in vols if s == "postgres_data"]
check(data_targets == [mount], f"S2 postgres_data mounted exactly at {mount} (got {data_targets})")
check(cluster.startswith(mount.rstrip('/') + '/'), f"S2 PGDATA {cluster} lies strictly under {mount}")
check(all(t != "/var/lib/postgresql/data" for (_, t) in vols), "S3 nothing mounted at the stock /var/lib/postgresql/data")
check(any(s in ("./state",) and t == "/synap-state" for (s, t) in vols), "S4 ./state marker dir mounted at /synap-state")

ep = pg.get("entrypoint") or []
script = "\n".join(ep) if isinstance(ep, list) else str(ep)
check(f"' {mount} ' /proc/self/mountinfo" in script and "exit 78" in script, "S4 entrypoint refuses to start when the mount target is not a mount")
check("/synap-state/postgres-initialized" in script and "PG_VERSION" in script and "SYNAP_ALLOW_PG_REINIT" in script,
      "S4 entrypoint refuses a blank initdb over the initialized marker (with escape hatch)")
check('exec /docker-entrypoint.sh "$$@"' in script, "S4 entrypoint still execs the image entrypoint")

bk = svcs.get("postgres-backup")
check(isinstance(bk, dict), "S5 postgres-backup service exists")
if isinstance(bk, dict):
    check(bk.get("image") == pg.get("image"), f"S5 backup image == postgres image ({bk.get('image')} vs {pg.get('image')})")
    bvols = vols_of(bk)
    dest = [s for (s, t) in bvols if t == "/backups"]
    check(len(dest) == 1 and dest[0].startswith("./"), f"S5 /backups is a HOST bind dir, not a named volume (got {dest})")
    check(("./state", "/synap-state") in bvols, "S5 backup shares ./state (writes the initialized marker)")
    check(bool(bk.get("healthcheck")), "S5 backup has a healthcheck (stale backups surface as unhealthy)")
    bscript = "\n".join(bk.get("entrypoint") or [])
    # The loop is pgdata-safety.sh's backup_loop (one implementation); its
    # read-back + gate behaviour is executed in backup-loop.test.sh.
    check("pgdata-safety.sh loop" in bscript, "S5 backup entrypoint delegates to pgdata-safety.sh loop (no inline second implementation)")
    check(any(t == "/synap-deploy" and s in (".", "./") for (s, t) in bvols), "S5 the deploy dir (script + .env) is mounted at /synap-deploy")
sys.exit(1 if fails else 0)
PY
if [ $? -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo "── D. doors call the guard before compose may recreate postgres"
# Positions are derived from the files: the guard call must precede the first
# line that runs `compose ... up|run` (comments excluded).
first_compose_line() {
    grep -nE '(docker compose|\$COMPOSE)[^#]*[[:space:]](up|run)([[:space:]]|$)' "$1" | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1
}
# deploy/update-pod.sh is a shim to `synap update --release` since update-door
# P2 (it runs no compose itself) — it is covered by the synap checks below.
grep -qE '^[^#]*exec bash "\$SYNAP" update --release' "$DEPLOY_DIR/update-pod.sh" \
    && ok "deploy/update-pod.sh delegates to synap update (the guarded engine)" \
    || bad "deploy/update-pod.sh neither delegates to synap update nor is scanned as a door"
for door in "$REPO_ROOT/install.sh"; do
    name="${door#$REPO_ROOT/}"
    first="$(first_compose_line "$door")"
    guard="$(grep -nE '^[^#]*pgdata_guard' "$door" | head -1 | cut -d: -f1)"
    if [ -z "$first" ]; then bad "$name: no compose up/run found (scan went blind)"; continue; fi
    if [ -n "$guard" ] && [ "$guard" -lt "$first" ]; then ok "$name: pgdata_guard (line $guard) precedes first compose up/run (line $first)"
    else bad "$name: pgdata_guard (line ${guard:-none}) does not precede first compose up/run (line $first)"; fi
done
SYNAP_CLI="$REPO_ROOT/synap"
if grep -qE '^docker\(\) \{' "$SYNAP_CLI" && grep -qE 'up\|run\|create\) _run_pgdata_guard' "$SYNAP_CLI"; then
    ok "synap: docker() intercepts compose up|run|create and runs the guard"
else
    bad "synap: docker() wrapper missing or no longer intercepts up|run|create"
fi
# The wrapper is only a door if nothing bypasses it: `command docker compose ...
# up|run` would skip the guard. Only the guard's own calls may use `command docker`.
bypass="$(grep -nE 'command docker compose[^#]*[[:space:]](up|run|create)([[:space:]]|$)' "$SYNAP_CLI" || true)"
[ -z "$bypass" ] && ok "synap: no call site bypasses the wrapper with \`command docker compose up|run\`" \
    || bad "synap: wrapper bypassed: $bypass"
# The pre-update backup runs before migrations in both update doors.
for door in "$SYNAP_CLI"; do
    grep -q 'pgdata_backup pre-update' "$door" && ok "${door#$REPO_ROOT/}: takes a pre-update backup" \
        || bad "${door#$REPO_ROOT/}: no pre-update backup"
done

echo "── I. build context never ships pod data or secrets"
# The image build context is the repo root, so on a pod checkout deploy/ holds
# live dumps and .env. A backup tarball WITH .env was found baked into build
# layers on CT101 (2026-10-04). Each pattern must be excluded.
for pat in deploy/backups deploy/state 'deploy/.env*'; do
    grep -qxF "$pat" "$REPO_ROOT/.dockerignore" && ok ".dockerignore excludes $pat" || bad ".dockerignore does not exclude $pat"
done

echo "── B. pgdata_layout against a mocked docker"
run_layout() {  # $1=PGDATA env (may be empty) $2=newline-separated mount destinations
    ( MOCK_PGDATA="$1"; MOCK_MOUNTS="$2"
      COMPOSE_CMD="mock_compose"
      mock_compose() { echo "cafebabe1234"; }
      docker() {
          case "$*" in
              *".Config.Env"*) [ -n "$MOCK_PGDATA" ] && echo "PGDATA=$MOCK_PGDATA"; echo "PATH=/usr/bin" ;;
              *".Mounts"*) printf '%s\n' "$MOCK_MOUNTS" ;;
          esac
      }
      # shellcheck source=/dev/null
      . "$SAFETY"; SYNAP_DEPLOY_DIR=/tmp pgdata_layout )
}
expect() { local got; got="$(run_layout "$2" "$3")"; [ "$got" = "$1" ] && ok "$4 → $got" || bad "$4 → expected $1, got $got"; }
expect legacy "/home/postgres/pgdata/data" $'/var/lib/postgresql/data\n/docker-entrypoint-initdb.d/init-databases.sh' \
    "the 2026-10-02 incident config (PGDATA in image path, volume at stock path)"
expect ok "/home/postgres/pgdata/data" $'/home/postgres/pgdata\n/synap-state' "fixed config (volume at PGDATA's parent)"
expect ok "/home/postgres/pgdata/data" "/home/postgres/pgdata/data" "volume mounted exactly at PGDATA"
# Discriminating row: a naive string-prefix test would call this mount a parent
# of PGDATA. Only a path-boundary check reads it as legacy.
expect legacy "/home/postgres/pgdata/data" "/home/postgres/pg" "a mount that is a STRING prefix but not a path parent"
expect ok "" "/var/lib/postgresql/data" "stock image without PGDATA env, stock mount"
expect legacy "" "" "no mounts at all"
abs="$( ( COMPOSE_CMD=mock_empty; mock_empty() { :; }; . "$SAFETY"; SYNAP_DEPLOY_DIR=/tmp pgdata_layout ) )"
[ "$abs" = absent ] && ok "no postgres container → absent" || bad "no postgres container → expected absent, got $abs"

echo
echo "RESULTS PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
