#!/usr/bin/env bash
# Tripwire: pgdata-safety.sh's `_PGS_WRITERS` (the services pgdata_restore and
# the guard stop before touching the cluster) stays in step with the compose file.
#
# The defect it exists for (W9-UPDATE, 2026-10-15): Hydra left compose while
# `_PGS_WRITERS` still named it. `docker compose stop <list>` refuses the WHOLE
# list on one unknown service ("no such service: hydra", rc 1, NOTHING stopped)
# and the call is `2>/dev/null`-quiet, so a restore would have run with every
# writer still live.
#
# Both directions, derived from the files (no hand list here):
#   1. every name in _PGS_WRITERS is a compose service;
#   2. every long-running service that connects to Postgres (its block names
#      `@postgres:5432` / DATABASE_URL / POSTGRES_HOST / PGHOST, or merges an
#      x- anchor that does) is in _PGS_WRITERS.
# Excluded from 2, on purpose: one-shot `*-migrate` services (`run --rm`, never
# running while a restore stops writers) and `postgres-backup` (the dumper — it
# reads; the backup lock, not this list, keeps it off a restore).
# NOT covered: a service that writes Postgres through another service's API
# (pod-admin, pod-agent are listed by judgment, and may stay listed).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="${PGDATA_WRITERS_COMPOSE:-$HERE/docker-compose.yml}"
SAFETY="${PGDATA_WRITERS_SAFETY:-$HERE/pgdata-safety.sh}"

python3 - "$COMPOSE" "$SAFETY" <<'PY'
import re, sys
compose, safety = (open(p).read() for p in sys.argv[1:3])
fails = 0
def ok(m): print(f"ok   - {m}")
def bad(m):
    global fails; fails = 1; print(f"FAIL - {m}")

m = re.search(r'^_PGS_WRITERS="([^"]*)"', safety, re.M)
if not m:
    bad("pgdata-safety.sh no longer defines _PGS_WRITERS=\"...\" on one line"); sys.exit(1)
writers = m.group(1).split()

head, rest = compose.split("\nservices:\n", 1)
body = rest.split("\nvolumes:\n", 1)[0]
blocks = {}
for b in re.split(r"\n(?=  [a-z0-9][a-z0-9-]*:\n)", "\n" + body):
    n = re.match(r"\s*([a-z0-9][a-z0-9-]*):\n", b)
    if n: blocks[n.group(1)] = b
PG = r"@postgres:5432|DATABASE_URL|POSTGRES_HOST|PGHOST"
anchors = {a for key, a in re.findall(r"^(x-[\w-]+):\s*&([\w-]+)", head, re.M)
           if re.search(PG, head.split(key + ":", 1)[1].split("\nx-", 1)[0])}
connected = {s for s, b in blocks.items()
             if re.search(PG, b) or any("*" + a in b for a in anchors)}

# non-vacuity: the parse still sees the services this guards
if len(blocks) >= 12 and {"backend", "kratos", "postgres"} <= set(blocks) and {"backend", "kratos"} <= connected and len(writers) >= 4:
    ok(f"parsed {len(blocks)} compose services, {len(connected)} Postgres-connected, {len(writers)} writers")
else:
    bad(f"vacuous parse: {len(blocks)} services, connected={sorted(connected)}, writers={writers}")

unknown = [w for w in writers if w not in blocks]
if unknown: bad(f"_PGS_WRITERS names services compose does not define (stop refuses the whole list): {unknown}")
else: ok("every _PGS_WRITERS name is a compose service")

missing = sorted(s for s in connected
                 if not s.endswith("-migrate") and s != "postgres-backup" and s not in writers)
if missing: bad(f"Postgres-connected services not stopped before a restore: {missing}")
else: ok("every long-running Postgres-connected service is in _PGS_WRITERS")
sys.exit(fails)
PY
