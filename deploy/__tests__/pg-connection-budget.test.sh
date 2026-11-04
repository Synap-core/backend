#!/usr/bin/env bash
# ============================================================================
# Tripwire: every pool that can open a Postgres connection on a pod has an
# explicit cap, and the caps sum under the postgres service's max_connections.
# ============================================================================
# The defect (2026-11-02): a pod answered login with
#   unable to fetch records: failed to connect to user=synap database=kratos:
#   ... FATAL: sorry, too many clients already (SQLSTATE 53300)
# One Postgres (max_connections: the default 100) served backend (Drizzle 50 +
# pg-boss 10 + LISTEN 1), backend-canary during an update (the same 61),
# realtime (its own Drizzle pool, 50), backend-migrate (50) and Kratos (Ory's
# default 2 x CPUs). Nothing bounded the sum, so Kratos lost the race.
# Since plan P6 a split pod also runs backend-worker (the job workers in their
# own process, profile `workers`): counted like every profile-gated service.
#
# Asserts, on the PARSED compose YAML (merge keys resolved; ${VAR:-default}
# read as its shipped default):
#   CONSUMERS (derived, never hand-listed) = every service whose environment
#     holds a postgres(ql):// URL to the postgres service, or PGHOST=postgres.
#   A. a DATABASE_URL consumer sets DB_POOL_SIZE explicitly (a positive int):
#      the code default (client-pg.ts) is 50 per process;
#   B. a backend-image service with no `command` runs the image CMD, the API,
#      which also starts pg-boss (PGBOSS_POOL_SIZE, set explicitly) and one
#      dedicated LISTEN connection;
#   C. a DSN consumer (Ory) carries max_conns (and max_idle_conns) in its DSN;
#   D. sum(every consumer's cap) + PGHOST/admin allowances < max_connections
#      set by `-c max_connections=N` on the postgres command (absent = 100).
#      The sum is the worst case: every service at once, the profile-gated
#      canary and the one-shot migrators included.
#   E. the env names compose sets are the names the code reads
#      (client-pg.ts DB_POOL_SIZE via pool-size.ts, events/src/boss.ts
#      PGBOSS_POOL_SIZE -> max).
#   F. every consumer's URL names it: `application_name=<service>`, so
#      pg_stat_activity says which service holds each connection.
#   G. sizing (pod resilience plan P5): the image's initdb tune
#      (timescaledb-tune) sizes work_mem for TS_TUNE_MAX_CONNS, so the postgres
#      service passes it the SAME variable the `-c max_connections` reads, with
#      the same shipped default; TS_TUNE_MEMORY reads POSTGRES_TUNE_MEMORY; and
#      NO_TS_TUNE is not set (it would drop the sizing in silence).
#   H. the postgres command sets no parameter but max_connections: a `-c` there
#      changes every RUNNING pod on its next update, while sizing must change
#      a pod only at initdb or through `synap tune-postgres` (the opt-in).
#      A new `-c` is a decision: add it to PG_COMMAND_PARAMS with its reason.
#   Non-vacuity: the known consumers are all found, and the ${...} resolver
#   still reads a literal sample.
#
# NOT covered: values an operator writes to deploy/.env (the sum uses the
# shipped defaults), docker-compose.override.yml (Eve pods), a pool opened by
# code that reads neither variable, and what a running Postgres reports
# (`SHOW max_connections`). Daemon-free.
# ============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/../.."
COMPOSE_FILE="${PG_BUDGET_COMPOSE_FILE:-$ROOT/deploy/docker-compose.yml}"
CLIENT_PG="${PG_BUDGET_CLIENT_PG:-$ROOT/packages/database/src/client-pg.ts}"
POOL_SIZE_TS="${PG_BUDGET_POOL_SIZE_TS:-$ROOT/packages/database/src/pool-size.ts}"
BOSS_TS="${PG_BUDGET_BOSS_TS:-$ROOT/packages/events/src/boss.ts}"

python3 - "$COMPOSE_FILE" "$CLIENT_PG" "$BOSS_TS" "$POOL_SIZE_TS" <<'PY'
import re, sys, yaml
from urllib.parse import urlsplit, parse_qs
compose, client_pg, boss_ts, pool_size_ts = sys.argv[1:5]
svcs = (yaml.safe_load(open(compose)) or {}).get("services") or {}
fails = []

# Allowances for connections no pool setting caps: pg_dump/psql of the
# backup loop, and an operator's psql / `synap doctor` through docker exec.
PGHOST_ALLOWANCE = 3
ADMIN_ALLOWANCE = 5
PG_DEFAULT_MAX = 100

INNER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^${}]*))?(?::?\?[^${}]*)?\}")
def resolve(v):
    """${VAR:-default} -> default, ${VAR} -> '' (the shipped value), innermost first."""
    v = str(v)
    for _ in range(10):
        n = INNER.sub(lambda m: m.group(2) or "", v)
        if n == v:
            break
        v = n
    return v

if resolve("a${X:-${Y:-7}}b${P}c${Q:?must}") != "a7bc":
    fails.append(f"resolver went blind on the literal sample: {resolve('a${X:-${Y:-7}}b${P}c${Q:?must}')!r}")

def env(s):
    e = s.get("environment") or {}
    if isinstance(e, list):
        e = dict(x.split("=", 1) if "=" in x else (x, "") for x in e)
    return {k: resolve("" if v is None else v) for k, v in e.items()}

def pos_int(v):
    return int(v) if re.fullmatch(r"[1-9][0-9]*", v or "") else None

def is_backend_image(s):
    return "synap-core/backend" in str(s.get("image", "")) or "SYNAP_IMAGE_BACKEND" in str(s.get("image", ""))

pool_src = open(pool_size_ts).read()
code_default = re.search(r"DEFAULT_DB_POOL_SIZE = (\d+);", pool_src)
code_default = int(code_default.group(1)) if code_default else None
if code_default is None or "raw = process.env.DB_POOL_SIZE" not in pool_src:
    fails.append("E: pool-size.ts no longer reads process.env.DB_POOL_SIZE with a DEFAULT_DB_POOL_SIZE = <n>")
if not re.search(r"\bmax:\s*DB_POOL_SIZE\b", open(client_pg).read()) or "dbPoolSize()" not in open(client_pg).read():
    fails.append("E: client-pg.ts no longer passes dbPoolSize() to postgres.js as `max`")
boss_src = open(boss_ts).read()
if "process.env.PGBOSS_POOL_SIZE" not in boss_src or not re.search(r"\bmax:\s*pgBossPoolSize\(\)", boss_src):
    fails.append("E: events/src/boss.ts no longer passes PGBOSS_POOL_SIZE to pg-boss as `max`")

rows, consumers = [], set()
for name, s in sorted(svcs.items()):
    e = env(s)
    for k, v in sorted(e.items()):
        if not re.match(r"postgres(ql)?://", v):
            continue
        u = urlsplit(v)
        if u.hostname != "postgres":
            continue
        consumers.add(name)
        app = (parse_qs(u.query).get("application_name") or [""])[0]
        if app != name:
            fails.append(f"F: {name}'s {k} names itself {app!r} in application_name, not {name!r}")
        if k == "DSN":
            q = parse_qs(u.query)
            mc = pos_int((q.get("max_conns") or [""])[0])
            if mc is None:
                fails.append(f"C: {name} DSN has no max_conns (Ory then opens 2 x CPUs, unbounded by the pod): {v.split('@')[-1]}")
                mc = 16  # what a 8-vCPU host would take
            if pos_int((q.get("max_idle_conns") or [""])[0]) is None:
                fails.append(f"C: {name} DSN has no max_idle_conns")
            rows.append((name, "Ory DSN max_conns", mc))
            continue
        if k != "DATABASE_URL":
            fails.append(f"{name}: {k} is a postgres URL this test does not know how to cap")
            continue
        pool = pos_int(e.get("DB_POOL_SIZE"))
        if pool is None:
            fails.append(f"A: {name} has DATABASE_URL but no explicit DB_POOL_SIZE (code default {code_default} per process)")
            pool = code_default or 50
        rows.append((name, "Drizzle DB_POOL_SIZE", pool))
        if is_backend_image(s) and not s.get("command"):
            boss = pos_int(e.get("PGBOSS_POOL_SIZE"))
            if boss is None:
                fails.append(f"B: {name} runs the API (pg-boss) but sets no explicit PGBOSS_POOL_SIZE (pg-pool default 10)")
                boss = 10
            rows.append((name, "pg-boss PGBOSS_POOL_SIZE", boss))
            rows.append((name, "LISTEN (session-changed)", 1))
    if e.get("PGHOST") == "postgres":
        consumers.add(name)
        rows.append((name, "pg_dump/psql allowance", PGHOST_ALLOWANCE))
rows.append(("(operator)", "admin psql allowance", ADMIN_ALLOWANCE))

pg = svcs.get("postgres") or {}
cmd = pg.get("command") or []
cmd = [resolve(c) for c in (cmd if isinstance(cmd, list) else str(cmd).split())]
pg_max = PG_DEFAULT_MAX
for i, c in enumerate(cmd):
    m = re.fullmatch(r"max_connections=(\d+)", c)
    if m and i > 0 and cmd[i - 1] == "-c":
        pg_max = int(m.group(1))

# G. the initdb tune sizes for the real connection ceiling and the pod's memory share
PG_COMMAND_PARAMS = {"max_connections"}  # H: each one changes running pods on update
raw_env = pg.get("environment") or {}
raw_cmd = pg.get("command") or []
raw_cmd = raw_cmd if isinstance(raw_cmd, list) else str(raw_cmd).split()
cmd_var = next((re.search(r"max_connections=(\$\{[^}]*\})", c).group(1) for c in raw_cmd if re.search(r"max_connections=\$\{", c)), None)
if not isinstance(raw_env, dict) or str(raw_env.get("TS_TUNE_MAX_CONNS")) != str(cmd_var):
    fails.append(f"G: postgres TS_TUNE_MAX_CONNS is {raw_env.get('TS_TUNE_MAX_CONNS')!r}, not the command's max_connections {cmd_var!r}: work_mem would be sized for another number of connections")
if not re.fullmatch(r"\$\{POSTGRES_TUNE_MEMORY:-\}", str(raw_env.get("TS_TUNE_MEMORY", ""))):
    fails.append(f"G: postgres TS_TUNE_MEMORY is {raw_env.get('TS_TUNE_MEMORY')!r}, not ${{POSTGRES_TUNE_MEMORY:-}} (what synap install writes)")
if "NO_TS_TUNE" in (raw_env or {}):
    fails.append("G: postgres sets NO_TS_TUNE: the initdb tune (and the pod's sizing) would be skipped in silence")
for i, c in enumerate(cmd):
    if i > 0 and cmd[i - 1] == "-c":
        param = c.split("=", 1)[0]
        if param not in PG_COMMAND_PARAMS:
            fails.append(f"H: postgres command sets -c {c}: it would change every running pod on its next update (size at initdb, or opt in with synap tune-postgres)")

total = sum(n for _, _, n in rows)
print(f"  budget (shipped defaults) vs postgres max_connections={pg_max}:")
for name, what, n in rows:
    print(f"    {name:<16} {what:<26} {n:>4}")
print(f"    {'TOTAL':<16} {'':<26} {total:>4}")
if total >= pg_max:
    fails.append(f"D: pool caps sum to {total}, not under postgres max_connections={pg_max}")

for f in fails:
    print("  ✗ " + f)
if not fails:
    print(f"  ✓ {len(consumers)} Postgres consumers, every pool capped, worst case {total} < max_connections {pg_max}")
    print(f"  ✓ sizing: the initdb tune reads TS_TUNE_MAX_CONNS={raw_env.get('TS_TUNE_MAX_CONNS')} (= -c max_connections) and TS_TUNE_MEMORY; the command sets only {sorted(PG_COMMAND_PARAMS)}")
known = {"backend", "backend-canary", "backend-worker", "realtime", "backend-migrate", "kratos", "kratos-migrate", "postgres-backup"}
nv = known <= consumers and "postgres" in svcs
print(("  ✓ " if nv else "  ✗ ") + f"non-vacuity: consumers {sorted(consumers)} (must include {sorted(known)})")
sys.exit(1 if fails or not nv else 0)
PY
