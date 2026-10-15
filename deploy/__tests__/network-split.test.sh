#!/usr/bin/env bash
# ============================================================================
# Tripwire: the pod's docker networks keep untrusted services away from the
# pod's data and identity admin APIs, and every real call path stays wired.
# ============================================================================
# The defect (SECURITY-PLAN-R2 S3c, 2026-10-14): rsshub (fetches arbitrary URLs)
# and browserless (headless Chrome) — and, until it was removed the same day,
# the bundled agent container — sat on synap-net beside the UNAUTHENTICATED
# Kratos/Hydra admin APIs (4434/4445), postgres, redis and MinIO: one SSRF in a
# scraper = account takeover.
#
# Asserts, on the PARSED compose YAML (every set derived, never hand-listed):
#   UNTRUSTED = services labelled synap.network.zone=sandbox.
#   PROTECTED = services named as the host of a datastore/admin URL anywhere in
#               the file: postgres(ql)://, redis://, *_ADMIN_URL, MINIO_*,
#               DSN, PGHOST.
#   ADMIN     = services named as the host of a *_ADMIN_URL (kratos, hydra:
#               unauthenticated admin APIs).
#   EDGES     = caller -> callee, from every service's env URLs and *HOST vars,
#               the Caddyfile's reverse_proxy upstreams (caddy), the Prometheus
#               scrape targets (prometheus) and the kratos.yml webhook URLs the
#               installer (../../synap) renders (kratos).
#   A. no network holds both an UNTRUSTED and a PROTECTED service;
#   B. every other member of an UNTRUSTED service's networks has an EDGE with
#      an UNTRUSTED service (a justified bridge, e.g. backend -> rsshub);
#   C. both ends of every EDGE share at least one network.
#   D. every ADMIN service sits on exactly one network, the same one for all;
#   E. every member of that network is ADMIN or has an EDGE with an ADMIN
#      service (caller: backend/realtime/caddy; callee: postgres via DSN).
#   Non-vacuity: >=2 untrusted, >=4 protected, >=2 admin, >=20 edges, >=5 caddy upstreams,
#   >=1 kratos webhook edge, and the URL extractor still reads a literal sample.
#
# NOT covered: docker-compose.override.yml (Eve adds eve-network, which joins
# postgres/backend to Eve's own containers), URLs stored in the DB (a feed
# provider pointing at another host), hosts built at runtime, and what a running
# daemon actually wires. Daemon-free.
# ============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${NET_TEST_COMPOSE_FILE:-$SCRIPT_DIR/../docker-compose.yml}"
CADDYFILE="${NET_TEST_CADDYFILE:-$SCRIPT_DIR/../Caddyfile}"
PROM_FILE="${NET_TEST_PROMETHEUS:-$SCRIPT_DIR/../monitoring/prometheus.yml}"
INSTALLER="${NET_TEST_INSTALLER:-$SCRIPT_DIR/../../synap}"

python3 - "$COMPOSE_FILE" "$CADDYFILE" "$PROM_FILE" "$INSTALLER" <<'PY'
import re, sys, yaml
compose, caddyfile, promfile, installer = sys.argv[1:5]
svcs = (yaml.safe_load(open(compose)) or {}).get("services") or {}
fails = []

def nets(s):
    n = s.get("networks")
    if n is None:
        return {"default"}
    return set(n.keys() if isinstance(n, dict) else n)

def labels(s):
    l = s.get("labels") or {}
    if isinstance(l, list):
        return dict(x.split("=", 1) if "=" in x else (x, "") for x in l)
    return {k: str(v) for k, v in l.items()}

def env(s):
    e = s.get("environment") or {}
    if isinstance(e, list):
        return [tuple(x.split("=", 1)) if "=" in x else (x, "") for x in e]
    return [(k, "" if v is None else str(v)) for k, v in e.items()]

# Aliases: a container_name reaches the service too.
alias = {}
for name, s in svcs.items():
    alias[name] = name
    if isinstance(s.get("container_name"), str) and "$" not in s["container_name"]:
        alias[s["container_name"]] = name

URL = re.compile(r"([a-z][a-z0-9+.-]*)://(?:[^@/\s]*@)?([A-Za-z0-9_.-]+)")
def urls(v):
    return [(m.group(1), m.group(2)) for m in URL.finditer(v)]

# Self-check: the extractor still reads credentials-in-userinfo and defaults.
sample = urls("x ${A:-postgresql://u:${P}@db:5432/x} ws://brw:3000 https://${DOMAIN}/y")
if sample != [("postgresql", "db"), ("ws", "brw")]:
    fails.append(f"URL extractor went blind on the literal sample: {sample}")

untrusted = {n for n, s in svcs.items() if labels(s).get("synap.network.zone") == "sandbox"}
protected, admin, edges = set(), set(), set()
STORE_SCHEMES = {"postgres", "postgresql", "redis"}
for name, s in svcs.items():
    for k, v in env(s):
        for scheme, host in urls(v):
            tgt = alias.get(host)
            if not tgt:
                continue
            edges.add((name, tgt, f"env {k}"))
            if k.endswith("_ADMIN_URL"):
                admin.add(tgt)
            if scheme in STORE_SCHEMES or k.endswith("_ADMIN_URL") or k == "DSN" or k.startswith("MINIO_"):
                protected.add(tgt)
        if k.endswith("HOST") and v in alias:
            edges.add((name, alias[v], f"env {k}"))
            if k == "PGHOST":
                protected.add(alias[v])

ncaddy = 0
for line in open(caddyfile):
    m = re.match(r"\s*reverse_proxy\s+([A-Za-z0-9_.-]+):\d+", line)
    if m and m.group(1) in alias and "caddy" in svcs:
        edges.add(("caddy", alias[m.group(1)], "Caddyfile")); ncaddy += 1
for host in re.findall(r"[\"']([A-Za-z0-9_.-]+):\d+[\"']", open(promfile).read()):
    if host in alias and "prometheus" in svcs:
        edges.add(("prometheus", alias[host], "prometheus.yml"))
# kratos.yml is rendered by the installer (one heredoc); its webhooks call out.
src = open(installer).read()
m = re.search(r'cat > "\$kratos_dir/kratos\.yml" << EOF\n(.*?)\nEOF\n', src, re.S)
nhook = 0
for scheme, host in urls(m.group(1) if m else ""):
    if host in alias and "kratos" in svcs:
        edges.add(("kratos", alias[host], "kratos.yml webhook")); nhook += 1

net_members = {}
for name, s in svcs.items():
    for n in nets(s):
        net_members.setdefault(n, set()).add(name)
linked = {a for a, b, _ in edges if b in untrusted} | {b for a, b, _ in edges if a in untrusted}

# A. untrusted and protected never share a network.
for n, members in sorted(net_members.items()):
    bad_u, bad_p = sorted(members & untrusted), sorted(members & protected)
    if bad_u and bad_p:
        fails.append(f"A: network {n} holds sandbox {bad_u} AND protected {bad_p}")
# B. every co-member of an untrusted service is untrusted or calls/serves one.
for n, members in sorted(net_members.items()):
    if members & untrusted:
        for other in sorted(members - untrusted - linked):
            fails.append(f"B: {other} shares network {n} with sandbox {sorted(members & untrusted)} but neither calls the other")
# D. the admin APIs live on one network of their own.
admin_nets = {n for a in admin for n in nets(svcs[a])}
for a in sorted(admin):
    if nets(svcs[a]) != admin_nets or len(admin_nets) != 1:
        fails.append(f"D: admin API {a} is on {sorted(nets(svcs[a]))}; every admin service must sit on one shared network only (all admin: {sorted(admin_nets)})")
# E. that network holds only admin services and their callers/callees.
admin_linked = {a for a, b, _ in edges if b in admin} | {b for a, b, _ in edges if a in admin}
for n in sorted(admin_nets):
    for other in sorted(net_members.get(n, set()) - admin - admin_linked):
        fails.append(f"E: {other} shares admin network {n} with {sorted(admin & net_members[n])} but neither calls the other")
# C. every call path shares a network.
for a, b, why in sorted(edges):
    if a != b and not (nets(svcs[a]) & nets(svcs[b])):
        fails.append(f"C: {a} -> {b} ({why}) but they share no network ({sorted(nets(svcs[a]))} vs {sorted(nets(svcs[b]))})")

for f in fails:
    print("  ✗ " + f)
if not fails:
    print(f"  ✓ sandbox {sorted(untrusted)} shares no network with {sorted(protected)}; "
          f"{len(edges)} call paths all on a shared network; admin {sorted(admin)} alone on {sorted(admin_nets)} with their callers")
# Floors by known members, not only counts: Hydra left on 2026-10-15 (admin 2→1,
# protected 4→3), and a count alone cannot tell "fewer services" from "blind scan".
nv = (len(untrusted) >= 2 and "kratos" in admin and {"postgres", "minio"} <= protected
      and len(protected) >= 3 and len(edges) >= 20 and ncaddy >= 5 and nhook >= 1)
print(("  ✓ " if nv else "  ✗ ") + f"non-vacuity: {len(untrusted)} sandbox, {len(protected)} protected, "
      f"{len(admin)} admin, {len(edges)} edges, {ncaddy} caddy upstreams, {nhook} kratos webhooks")
sys.exit(1 if fails or not nv else 0)
PY
