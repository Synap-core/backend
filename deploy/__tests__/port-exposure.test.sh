#!/usr/bin/env bash
# ============================================================================
# Tripwire: infrastructure/admin ports must not be published on all interfaces.
# ============================================================================
# The defect (found 2026-10-04): postgres 5432, Kratos 4433-4434 (4434 = ADMIN,
# unauthenticated by design), Hydra 4444-4445, MinIO 9000-9001 and Typesense 8108
# were published as bare "PORT:PORT" => 0.0.0.0 + [::], reachable from every
# other host on the pod's LAN. Proxies reach them by Docker service name, so the
# host publish had no off-host consumer.
#
# Asserts, on the PARSED compose YAML (service set derived, never hand-listed):
#   every published port of every service except EDGE_SERVICES binds a loopback
#   host IP (127.0.0.1 / ::1) -- bare, 0.0.0.0 and [::] mappings all fail. Both
#   short ("127.0.0.1:5432:5432") and long (published/host_ip) syntax are read.
#   Non-vacuity: >=10 services and >=10 published-port mappings were seen, and
#   the edge service still publishes (so the edge exemption cannot hide a scan
#   that read nothing).
#
# NOT covered: ${VAR}-interpolated host IPs (rejected as unverifiable, fail);
# docker-compose.override.yml files on a pod (e.g. Eve's loopback override) and
# eve/hestia-managed containers; the Caddyfile (a proxy route to an admin port
# is a separate exposure); what a running daemon actually binds. Daemon-free.
# ============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${PORT_TEST_COMPOSE_FILE:-$SCRIPT_DIR/../docker-compose.yml}"
EDGE_SERVICES="caddy"   # the reverse proxy: 80/443 are the only public ports

python3 - "$COMPOSE_FILE" "$EDGE_SERVICES" <<'PY'
import sys, yaml
path, edge = sys.argv[1], set(sys.argv[2].split())
svcs = (yaml.safe_load(open(path)) or {}).get("services") or {}
fails, nports, seen = [], 0, 0
LOOP = {"127.0.0.1", "::1", "[::1]", "localhost"}
def host_ip(p):
    if isinstance(p, dict):
        return p.get("host_ip")
    parts = str(p).split("/")[0]
    if parts.startswith("["):                      # [::1]:80:80
        return parts[: parts.index("]") + 1]
    segs = parts.split(":")
    return segs[0] if len(segs) == 3 else None     # 3 segs => ip:host:ctr
for name, s in svcs.items():
    seen += 1
    for p in s.get("ports") or []:
        nports += 1
        if name in edge:
            continue
        ip = host_ip(p)
        if ip not in LOOP:
            fails.append(f"{name}: {p!r} binds {ip or 'ALL interfaces'}")
for f in fails: print("  ✗ " + f)
if not fails: print(f"  ✓ every non-edge published port is loopback-bound ({nports} mappings, {seen} services)")
nv = seen >= 10 and nports >= 10 and bool((svcs.get("caddy") or {}).get("ports"))
print(("  ✓ " if nv else "  ✗ ") + f"non-vacuity: {seen} services, {nports} port mappings, edge publishes")
sys.exit(1 if fails or not nv else 0)
PY
