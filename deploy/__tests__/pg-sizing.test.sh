#!/usr/bin/env bash
# Postgres is sized for the pod's host, once, through the image's own tune
# (pod resilience plan P5).
#
# The postgres image (timescale/timescaledb-ha) runs timescaledb-tune at initdb
# (/docker-entrypoint-initdb.d/001_timescaledb_tune.sh) with TS_TUNE_MEMORY
# (empty = the whole host) and TS_TUNE_MAX_CONNS. Before P5 it was told the
# whole host's RAM while a dozen services share that host, and sized work_mem
# for its own connection guess while `-c max_connections=200` overrode it.
#
# Asserts, on the REAL functions (extracted from `synap` with awk, not copied):
#   1. pg_tune_memory: half the host's RAM, 512MB..8192MB — 16 GB → 8192MB,
#      8 GB → 4096MB, 4 GB → 2048MB, a real "4 GB" VM (3.8 GB) → 1923MB,
#      1 GB → 512MB (floor), 64 GB → 8192MB (cap); an unreadable size prints
#      nothing and fails (the image then measures the host, as before), never 0.
#   2. `synap install` writes POSTGRES_TUNE_MEMORY = pg_tune_memory of this host
#      into the .env it generates (generate_and_create_env, run for real).
#   3. `synap tune-postgres` (the opt-in for an existing pod) runs the image's
#      timescaledb-tune with the memory from .env and the max_connections the
#      RUNNING server reports, keeps a copy of postgresql.conf, restarts
#      Postgres; --dry-run changes and restarts nothing; a server that does not
#      answer refuses before anything runs.
# The compose wiring (TS_TUNE_* fed from POSTGRES_*, no memory `-c` on the
# command) is pg-connection-budget.test.sh G/H. NOT covered: what
# timescaledb-tune computes (its own tool; the values in synap's comment were
# measured with timescaledb-tune 0.19 in the pg16 image).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

awk '/^(pg_tune_memory|generate_and_create_env|pod_admin_domain_for_domain|pod_admin_url_for_domain)\(\) \{/{p=1} p{print} p&&/^}/{p=0}' "$HERE/synap" > "$TMP/fn.sh"
for f in pg_tune_memory generate_and_create_env; do
  grep -q "^$f()" "$TMP/fn.sh" || { bad "could not extract $f from synap"; exit 1; }
done
RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''; _BOOTSTRAP_TOKEN_MARKER="$TMP/no-marker"
# shellcheck disable=SC1091
. "$TMP/fn.sh"

# ── 1. the pod's share ────────────────────────────────────────────────────────
want() { # <MemTotal kB> <expected> <label>
  local got rc; got="$(pg_tune_memory "$1")"; rc=$?
  [ "$rc" = 0 ] && [ "$got" = "$2" ] && ok "pg_tune_memory: $3 → $2" || bad "pg_tune_memory: $3 → '$got' (rc $rc), want $2"
}
want 16777216 8192MB "16 GB host"
want 8388608  4096MB "8 GB host"
want 4194304  2048MB "4 GB host"
want 3940000  1923MB "a '4 GB' VM's real MemTotal (3.76 GiB)"
want 1048576  512MB  "1 GB host (floor)"
want 67108864 8192MB "64 GB host (cap)"
for junk in abc 0 -5 "1.5"; do
  out="$(pg_tune_memory "$junk")"; rc=$?
  [ "$rc" != 0 ] && [ -z "$out" ] && ok "pg_tune_memory: '$junk' → nothing, rc $rc (never a made-up size)" || bad "pg_tune_memory: '$junk' → '$out' rc $rc"
done

# ── 2. synap install writes it ────────────────────────────────────────────────
mkdir -p "$TMP/install" && cd "$TMP/install" || exit 1
generate_and_create_env pod.example.com ops@example.com "" "" "" "" admin@example.com "" "" token tok >/dev/null 2>&1 || bad "generate_and_create_env failed"
expect="$(pg_tune_memory || true)"
line="$(grep '^POSTGRES_TUNE_MEMORY=' .env)"
[ "$line" = "POSTGRES_TUNE_MEMORY=${expect}" ] && ok "install: .env carries POSTGRES_TUNE_MEMORY=${expect:-<empty: no /proc/meminfo here, the image measures the host>}" || bad "install: .env line '$line', want POSTGRES_TUNE_MEMORY=$expect"
[ "$(grep -c '^POSTGRES_TUNE_MEMORY=' .env)" = 1 ] && ok "install: written once" || bad "install: written $(grep -c '^POSTGRES_TUNE_MEMORY=' .env) times"
cd "$HERE" || exit 1

# ── 3. synap tune-postgres ────────────────────────────────────────────────────
mkdir -p "$TMP/bin" "$TMP/pod/deploy"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *"SHOW max_connections"*) [ -n "${FAKE_PG_DOWN:-}" ] && exit 1; echo 200; exit 0 ;;
  *"pg_settings"*) echo "shared_buffers = 262144 8kB"; exit 0 ;;
  "compose ps"*) exit 0 ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker"
cp "$HERE/synap" "$TMP/pod/synap"
cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$TMP/pod/deploy/"
printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\nPOSTGRES_PASSWORD=x\nPOSTGRES_TUNE_MEMORY=3072MB\n' > "$TMP/pod/deploy/.env"
tune() { ( cd "$TMP/pod" && PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/log" SYNAP_DEPLOY_DIR="$TMP/pod/deploy" bash ./synap tune-postgres "$@" ) > "$TMP/out" 2>&1 </dev/null; }

: > "$TMP/log"; tune --dry-run; rc=$?
[ "$rc" = 0 ] && grep -q "timescaledb-tune .*--dry-run.*--memory='3072MB' --max-conns='200'" "$TMP/log" \
  && ok "tune --dry-run: the image's timescaledb-tune, memory from .env, max_connections from the running server" || { bad "tune --dry-run: rc=$rc"; cat "$TMP/log" "$TMP/out"; }
grep -qE "restart|cp .*postgresql.conf" "$TMP/log" && bad "tune --dry-run: changed or restarted something" || ok "tune --dry-run: no copy, no rewrite, no restart"

: > "$TMP/log"; tune; rc=$?
[ "$rc" = 0 ] && grep -q "Nothing was changed" "$TMP/out" && ! grep -q "restart" "$TMP/log" && ok "tune: no answer at the prompt → nothing changed" || bad "tune: unconfirmed run rc=$rc"

: > "$TMP/log"; tune --yes; rc=$?
tl="$(grep -n "timescaledb-tune" "$TMP/log" | head -1 | cut -d: -f1)"; rl="$(grep -n "compose restart postgres" "$TMP/log" | head -1 | cut -d: -f1)"
[ "$rc" = 0 ] && grep -q "cp \"\$PGDATA/postgresql.conf\" \"\$PGDATA/postgresql.conf.before-tune-" "$TMP/log" && [ -n "$tl" ] && [ -n "$rl" ] && [ "$tl" -lt "$rl" ] \
  && ok "tune --yes: copy kept, timescaledb-tune, THEN restart postgres" || { bad "tune --yes: rc=$rc"; cat "$TMP/log"; }
grep -q -- "--dry-run" <(grep timescaledb-tune "$TMP/log") && bad "tune --yes: ran a dry run instead" || ok "tune --yes: a real run (no --dry-run)"
grep -q "put them back" "$TMP/out" && grep -q "postgresql.conf.before-tune-" "$TMP/out" && ok "tune --yes: prints how to put the previous settings back" || bad "tune --yes: no undo printed"

: > "$TMP/log"; tune --yes --memory 6GB; rc=$?
[ "$rc" = 0 ] && grep -q -- "--memory='6GB'" "$TMP/log" && ok "tune --memory wins over .env" || bad "tune --memory: rc=$rc"

: > "$TMP/log"; FAKE_PG_DOWN=1; export FAKE_PG_DOWN; tune --yes; rc=$?; unset FAKE_PG_DOWN
[ "$rc" != 0 ] && ! grep -qE "timescaledb-tune|restart" "$TMP/log" && grep -q "Could not read max_connections" "$TMP/out" \
  && ok "tune: a Postgres that does not answer → refused before anything runs" || { bad "tune: pg down rc=$rc"; cat "$TMP/log"; }

: > "$TMP/log"; tune --yes --memory lots; rc=$?
[ "$rc" != 0 ] && ! grep -q "timescaledb-tune" "$TMP/log" && ok "tune: a memory that is not <n>MB|<n>GB is refused" || bad "tune: bad memory rc=$rc"

# tune-postgres records the size it applied (deploy/.env, through the one writer)
: > "$TMP/log"; tune --yes --memory 6GB; rc=$?
[ "$rc" = 0 ] && [ "$(grep -c '^POSTGRES_TUNE_MEMORY=' "$TMP/pod/deploy/.env")" = 1 ] && grep -qx 'POSTGRES_TUNE_MEMORY=6GB' "$TMP/pod/deploy/.env" \
  && ok "tune --memory 6GB: deploy/.env now says POSTGRES_TUNE_MEMORY=6GB, once" || { bad "tune: .env not updated (rc=$rc)"; grep POSTGRES_TUNE "$TMP/pod/deploy/.env"; }
: > "$TMP/log"; tune --yes --memory lots
grep -qx 'POSTGRES_TUNE_MEMORY=6GB' "$TMP/pod/deploy/.env" && ok "tune: a refused size leaves .env as it was" || bad "tune: a refused size changed .env"

# ── 4. _pg_oversized: the running Postgres against this pod's share ──────────
awk '/^(pg_tune_memory|_pg_oversized|_ue_env_get)\(\) \{/{p=1} p{print} p&&/^}/{p=0}' "$HERE/synap" > "$TMP/ov.sh"
grep -q '^_pg_oversized()' "$TMP/ov.sh" || { bad "could not extract _pg_oversized from synap"; exit 1; }
mkdir -p "$TMP/ov"
ov() { # <.env share or ""> <shared_buffers MB or FAIL> [container] → "<rc>:<out>"
  ( cd "$TMP/ov"; { [ -n "$1" ] && echo "POSTGRES_TUNE_MEMORY=$1"; echo "X=1"; } > .env
    # shellcheck disable=SC1091
    . "$TMP/ov.sh"
    C="${3-synap-backend-postgres-1}"; _pgs_container() { echo "$C"; }
    _pgs_psql() { [ "$SB" = FAIL ] && return 1; echo "$SB"; }
    SB="$2"; out="$(_pg_oversized)"; echo "$?:$out" )
}
check_ov() { local got; got="$(ov "$1" "$2" "${4-synap-backend-postgres-1}")"; [ "$got" = "$3" ] && ok "_pg_oversized: share '${1:-<half RAM>}', shared_buffers ${2} → '$3'" || bad "_pg_oversized: share '$1' sb $2 → '$got', want '$3'"; }
check_ov 8192MB 15872 "0:15872|8192MB"          # the 4 Nov pod: tuned for the 62 GB host
check_ov 8192MB 2048 "0:"                        # tuned for its share
check_ov 8192MB 2560 "0:"                        # what tune-postgres applied there (2.5 GB)
check_ov 4GB 1024 "0:"                           # an 8 GB pod, GB unit
check_ov 4GB 2100 "0:2100|4GB"                   # just over half of a GB share
check_ov 8192MB FAIL "1:"                        # unreadable server → no verdict, never "fits"
check_ov 8192MB 2048 "1:" ""                     # no postgres container
check_ov 8192MB 2048 "1:" direct                 # a direct host Postgres is not this pod's container
check_ov lots 2048 "1:"                          # an unreadable share
[ -r /proc/meminfo ] && check_ov "" 99999 "0:99999|$(pg_tune_memory)"   # no share in .env: half this host's RAM

# ── 5. the update and doctor read that check; the compose sizes ─────────────
grep -q '^    _ue_pg_size_notice$' "$HERE/synap" && grep -q '_ue_pg_size_notice() {' "$HERE/synap" \
  && ok "update: a verified update runs the Postgres size notice" || bad "update: no _ue_pg_size_notice call"
grep -q 'pgsz="$(_pg_oversized)"' "$HERE/synap" && grep -q '_dr postgres-size warn "shared_buffers is' "$HERE/synap" \
  && ok "doctor: reports an oversized Postgres" || bad "doctor: no postgres-size row"
python3 - "$HERE/deploy/docker-compose.yml" <<'PY' && ok "compose: postgres-backup capped (PG_BACKUP_MEM_LIMIT, default 1g); backend pool default 20" || bad "compose: backup cap or pool default missing"
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))
s = c["services"]
assert s["postgres-backup"].get("mem_limit") == "${PG_BACKUP_MEM_LIMIT:-1g}", s["postgres-backup"].get("mem_limit")
assert s["backend"]["environment"]["DB_POOL_SIZE"] == "${DB_POOL_SIZE:-20}", s["backend"]["environment"]["DB_POOL_SIZE"]
PY

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
