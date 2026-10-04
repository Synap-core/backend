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
rc=$?

# The same exposure through the PROXY: an unauthenticated admin API must never be
# a reverse_proxy upstream on a public site block. Kratos 4434 was routed at
# /.ory/kratos/admin/* until 2026-10-04 — account takeover on any Caddy-fronted pod.
# Scope: non-comment `reverse_proxy` lines of the shipped Caddyfile; it cannot see
# a Caddyfile generated elsewhere (Eve's Traefik routes live in hestia-cli).
CADDYFILE="${PORT_TEST_CADDYFILE:-$SCRIPT_DIR/../Caddyfile}"
ADMIN_UPSTREAMS='kratos:4434|hydra:4445'
nproxy=$(grep -cE '^[[:space:]]*reverse_proxy[[:space:]]' "$CADDYFILE")
hits=$(grep -nE "^[[:space:]]*reverse_proxy[[:space:]].*($ADMIN_UPSTREAMS)" "$CADDYFILE" || true)
if [ "$nproxy" -lt 3 ]; then
    echo "  ✗ non-vacuity: only $nproxy reverse_proxy lines in $CADDYFILE — scan went blind"; rc=1
elif [ -n "$hits" ]; then
    echo "  ✗ Caddyfile proxies an unauthenticated admin API publicly:"; echo "$hits" | sed 's/^/      /'; rc=1
else
    echo "  ✓ no reverse_proxy to an admin upstream ($ADMIN_UPSTREAMS) across $nproxy proxy lines"
fi
# The reverse: the public status reads the CP monitors MUST reach the backend in
# the TLS site block. Missing there, Caddy's catch-all answers 200 text and the
# CP backup-staleness monitor reads every pod as "unknown" (2026-10-04).
# Scope: the first `{$DOMAIN} {` block, `handle <path> {` followed by a backend proxy.
for path in /status/backup /status/release; do
    if awk -v p="$path" '
        /^\{\$DOMAIN\} \{/ { inblk=1; next }
        inblk && /^[^[:space:]#]/ { inblk=0 }
        inblk && $1=="handle" && $2==p { want=1; next }
        want && /reverse_proxy[[:space:]]+backend:4000/ { found=1 }
        want && /^[[:space:]]*\}/ { want=0 }
        END { exit found ? 0 : 1 }' "$CADDYFILE"; then
        echo "  ✓ TLS block routes $path to backend"
    else
        echo "  ✗ TLS block does not route $path to backend:4000"; rc=1
    fi
done
exit $rc
