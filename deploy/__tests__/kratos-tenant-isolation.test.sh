#!/usr/bin/env bash
# A pod's sign-in never reaches other tenants (tenant isolation).
#
# A Synap Cloud pod is <name>.pod.synap.live, its console
# admin.<name>.pod.synap.live; pods named before are pod.<name>.synap.live +
# pod-admin.<name>.synap.live (nested) or <name>.synap.live +
# <name>-admin.synap.live (flat). Neither zone is on the Public Suffix List
# yet, so to browsers each is one site. Nothing a pod sets may be scoped to a
# zone (pod.synap.live, synap.live, and their staging twins):
#   • the Kratos session cookie domain: the pod's and console's shared parent
#     (<name>.pod.synap.live), refused when it is a public suffix or a tenant
#     zone — a legacy flat pod gets a host-only cookie instead of
#     Domain=synap.live, and the installer says what that means;
#   • Kratos CORS origins and return URLs: the pod, its console and the listed
#     Synap apps (the Control Plane's FIRST_PARTY_WEB_SUBDOMAINS), never
#     https://*.synap.live;
#   • SYNAP_BASE_DOMAIN (the first-party CORS base): a stale synap.live or
#     pod.synap.live is removed by the self-heal, a pod's own site is kept.
# The naming itself is pinned to the backend's one statement
# (packages/types/src/tenancy) by its installer-parity.test.ts.
# Renders the REAL generate_kratos_config / backfill_federation_public_urls
# extracted from `synap`, with a fake CP (OIDC off) and a fixture Public Suffix
# List, so the result does not depend on the host's list.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

extract() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {p=1} p{print} p&&/^}/{exit}' "$HERE/synap"; }
{
  echo 'RED=;YELLOW=;BLUE=;NC=;GREEN=;'
  for f in update_env_value synap_tenant_zones synap_legacy_tenant_zones synap_pod_name_ok synap_is_tenant_zone \
           pod_admin_domain_for_domain pod_admin_url_for_domain is_public_suffix \
           common_parent_domain shared_cookie_domain synap_first_party_web_origins backfill_federation_public_urls \
           generate_kratos_config kratos_config_errors; do
    extract "$f"
  done
} > "$TMP/lib.sh"
for f in is_public_suffix shared_cookie_domain synap_first_party_web_origins backfill_federation_public_urls generate_kratos_config; do
  grep -q "^$f()" "$TMP/lib.sh" || { bad "could not extract $f"; exit 1; }
done

cat > "$TMP/psl.dat" <<'PSL'
// fixture: a few rules of each kind
com
uk
co.uk
dev
fly.dev
github.io
ck
*.ck
!www.ck
PSL
export SYNAP_PSL_FILE="$TMP/psl.dat"
lib() { ( . "$HERE/deploy/env-config.sh"; . "$TMP/lib.sh"; "$@" ); }

# ── is_public_suffix ──────────────────────────────────────────────────────────
for d in pod.synap.live POD.Synap.Live pod.staging.synap.live synap.live SYNAP.LIVE staging.synap.live com co.uk fly.dev github.io foo.ck; do
  lib is_public_suffix "$d" && ok "public suffix: $d" || bad "$d should be a public suffix"
done
for d in alice.pod.synap.live alice.pod.staging.synap.live alice.synap.live thearch.synap.live alice.staging.synap.live example.com mycorp.co.uk alice.fly.dev www.ck; do
  lib is_public_suffix "$d" && bad "$d is not a public suffix" || ok "not a public suffix: $d"
done
SYNAP_PSL_FILE="$TMP/missing.dat" lib is_public_suffix co.uk && bad "co.uk without a list: unknown, so not refused" \
  || ok "no list on the host: only TLDs and tenant zones are known"
SYNAP_PSL_FILE="$TMP/missing.dat" lib is_public_suffix synap.live && ok "no list on the host: synap.live is still refused" \
  || bad "synap.live must be refused without a list"
SYNAP_PSL_FILE="$TMP/missing.dat" lib is_public_suffix pod.synap.live && ok "no list on the host: pod.synap.live is still refused" \
  || bad "pod.synap.live must be refused without a list"

# ── pod_admin_domain_for_domain: the console a pod's name pairs with ─────────
pad() { # <want> <pod>
  local got; got="$(lib pod_admin_domain_for_domain "$2")"
  [ "$got" = "$1" ] && ok "console of $2 = '${1}'" || bad "console of $2: want '$1', got '$got'"
}
pad admin.alice.pod.synap.live alice.pod.synap.live
pad admin.alice.pod.synap.live Alice.Pod.Synap.Live
pad admin.a.pod.staging.synap.live a.pod.staging.synap.live
pad pod-admin.alice.synap.live pod.alice.synap.live
pad alice-admin.synap.live alice.synap.live
pad pod-admin.example.com pod.example.com
pad synap-admin.example.com synap.example.com
pad pod-admin.localhost localhost
for d in pod.synap.live synap.live pod.staging.synap.live admin.alice.pod.synap.live shop.alice.pod.synap.live admin.pod.synap.live; do
  pad "" "$d"
done
[ -z "$(lib pod_admin_url_for_domain pod.synap.live)" ] && ok "no console URL for a zone (never https:// alone)" || bad "console URL of a zone: $(lib pod_admin_url_for_domain pod.synap.live)"

# ── shared_cookie_domain ──────────────────────────────────────────────────────
scd() { # <want> <pod> <console>
  local got; got="$(lib shared_cookie_domain "$2" "$3")"
  [ "$got" = "$1" ] && ok "cookie parent of $2 + $3 = '${1}'" || bad "cookie parent of $2 + $3: want '$1', got '$got'"
}
scd "alice.pod.synap.live" alice.pod.synap.live admin.alice.pod.synap.live
scd "a.pod.staging.synap.live" a.pod.staging.synap.live admin.a.pod.staging.synap.live
scd "" a.pod.synap.live admin.b.pod.synap.live
scd "" alice.pod.synap.live alice-admin.pod.synap.live
scd "alice.synap.live" pod.alice.synap.live pod-admin.alice.synap.live
scd "" alice.synap.live alice-admin.synap.live
scd "" alice.staging.synap.live alice-admin.staging.synap.live
scd "" pod.synap.live pod-admin.synap.live
scd "example.com" pod.example.com pod-admin.example.com
scd "mycorp.co.uk" pod.mycorp.co.uk pod-admin.mycorp.co.uk
scd "" alice.co.uk alice-admin.co.uk
scd "" alice.fly.dev alice-admin.fly.dev
scd "" pod.a.com admin.b.org

# ── synap_first_party_web_origins ─────────────────────────────────────────────
FP="$(lib synap_first_party_web_origins pod.alice.synap.live)"
want="https://synap.live
https://www.synap.live
https://app.synap.live
https://dashboard.synap.live
https://connect.synap.live
https://relay.synap.live
https://doc.synap.live
https://docs.synap.live
https://crm.synap.live
https://hub.synap.live
https://studio.synap.live
https://canvas.synap.live
https://devplane.synap.live
https://arch.synap.live
https://the-arch-grants.synap.live
https://mini-app.synap.live"
[ "$FP" = "$want" ] && ok "first-party apps = the Control Plane's FIRST_PARTY_WEB_SUBDOMAINS (+ apex)" \
  || bad "first-party apps drifted from the CP list: $FP"
lib synap_first_party_web_origins pod.x.staging.synap.live | grep -qx "https://crm.staging.synap.live" \
  && ok "a staging pod admits the staging apps" || bad "staging pod: no staging apps"
lib synap_first_party_web_origins pod.mycorp.io | grep -qx "https://crm.synap.live" \
  && ok "a custom-domain pod admits the synap.live apps (Continue with Synap Cloud)" || bad "custom pod: no synap.live apps"

# ── generate_kratos_config ────────────────────────────────────────────────────
render() { # <dir> <domain> [POD_ADMIN_DOMAIN]
  mkdir -p "$1/bin" "$1/deploy" "$1/kratos"
  printf '#!/usr/bin/env bash\necho "{}"\n' > "$1/bin/curl"
  printf '#!/usr/bin/env bash\necho nothing\n' > "$1/bin/docker"
  chmod +x "$1/bin/curl" "$1/bin/docker"
  printf 'KRATOS_WEBHOOK_SECRET=s\nPUBLIC_URL=https://%s\n' "$2" > "$1/deploy/.env"
  [ -n "${3:-}" ] && printf 'POD_ADMIN_DOMAIN=%s\nPOD_ADMIN_URL=https://%s\n' "$3" "$3" >> "$1/deploy/.env"
  ( cd "$1/deploy"; PATH="$1/bin:$PATH"; . "$TMP/lib.sh"; generate_kratos_config "$2" ) >"$1/out" 2>"$1/err"
}
section() { awk -v s="$2" '$0 ~ "^ *"s":" {p=1; next} p && /^ *[a-z_]+:/ && !/^ *- / {exit} p' "$1"; }

render "$TMP/current" alice.pod.synap.live; rc=$?
C="$TMP/current/kratos/kratos.yml"
[ "$rc" = 0 ] && [ -s "$C" ] && ok "pod.synap.live pod: kratos.yml rendered" || { bad "current render failed: $(cat "$TMP/current/err")"; exit 1; }
grep -A3 '^  cookie:' "$C" | grep -qx '    domain: alice.pod.synap.live' && ok "pod.synap.live pod: session cookie scoped to alice.pod.synap.live (pod + console)" \
  || bad "pod.synap.live pod: cookie domain: $(grep -A3 '^  cookie:' "$C")"
grep -A2 '^        rp:' "$C" | grep -q 'id: alice.pod.synap.live' && ok "pod.synap.live pod: passkey rp id = alice.pod.synap.live" || bad "pod.synap.live pod: rp id: $(grep -A2 'rp:' "$C")"
section "$C" allowed_origins | grep -qx '        - https://admin.alice.pod.synap.live' && ok "pod.synap.live pod: CORS admits its console" || bad "pod.synap.live pod: console missing from CORS"
section "$C" allowed_return_urls | grep -qx '    - https://admin.alice.pod.synap.live/\*' && ok "pod.synap.live pod: may return to its console" || bad "pod.synap.live pod: console missing from return URLs"
section "$C" allowed_origins | grep -qx '        - https://crm.synap.live' && ok "pod.synap.live pod: CORS admits crm.synap.live" || bad "pod.synap.live pod: crm.synap.live missing from CORS"
grep -q '://\*' "$C" && bad "pod.synap.live pod: a wildcard host is rendered" || ok "pod.synap.live pod: no wildcard origin or return URL"
grep -qE 'bob\.pod\.synap\.live|pod\.alice\.synap\.live|https://api\.synap\.live' "$C" && bad "pod.synap.live pod: another tenant, its old name or the CP is admitted" \
  || ok "pod.synap.live pod: other tenants, the old names and the CP are not admitted"
grep -qE '^ *domain: *\.?(pod\.)?synap\.live *$' "$C" && bad "pod.synap.live pod: a zone is a cookie domain" || ok "pod.synap.live pod: nothing scoped to a zone"
[ -z "$(lib kratos_config_errors "$C")" ] && ok "pod.synap.live pod: the render passes the structural check" || bad "current: $(lib kratos_config_errors "$C")"
[ ! -s "$TMP/current/err" ] && ok "pod.synap.live pod: no warning" || bad "pod.synap.live pod warned: $(cat "$TMP/current/err")"

render "$TMP/nested" pod.alice.synap.live; rc=$?
N="$TMP/nested/kratos/kratos.yml"
[ "$rc" = 0 ] && [ -s "$N" ] && ok "nested pod: kratos.yml rendered" || { bad "nested render failed: $(cat "$TMP/nested/err")"; exit 1; }
grep -A3 '^  cookie:' "$N" | grep -qx '    domain: alice.synap.live' && ok "nested pod: session cookie scoped to alice.synap.live (pod + console)" \
  || bad "nested pod: cookie domain: $(grep -A3 '^  cookie:' "$N")"
grep -q '://\*' "$N" && bad "nested pod: a wildcard host is still rendered: $(grep -n '://\*' "$N" | head -3)" || ok "nested pod: no wildcard origin or return URL"
section "$N" allowed_origins | grep -qx '        - https://crm.synap.live' && ok "nested pod: CORS admits crm.synap.live" || bad "nested pod: crm.synap.live missing from CORS"
section "$N" allowed_origins | grep -qx '        - https://pod-admin.alice.synap.live' && ok "nested pod: CORS admits its console" || bad "nested pod: console missing from CORS"
section "$N" allowed_return_urls | grep -qx '    - https://crm.synap.live/\*' && ok "nested pod: may return to crm.synap.live" || bad "nested pod: crm.synap.live missing from return URLs"
grep -q 'pod.bob.synap.live\|https://api.synap.live' "$N" && bad "nested pod: another tenant or the CP is admitted" || ok "nested pod: other tenants and the CP are not admitted"
grep -A2 '^        rp:' "$N" | grep -q 'id: alice.synap.live' && ok "nested pod: passkey rp id = alice.synap.live" || bad "nested pod: passkey rp id: $(grep -A2 'rp:' "$N")"
[ -z "$(lib kratos_config_errors "$N")" ] && ok "nested pod: the render passes the structural check" || bad "nested: $(lib kratos_config_errors "$N")"
[ ! -s "$TMP/nested/err" ] && ok "nested pod: no warning" || bad "nested pod warned: $(cat "$TMP/nested/err")"

render "$TMP/flat" alice.synap.live; rc=$?
F="$TMP/flat/kratos/kratos.yml"
[ "$rc" = 0 ] && [ -s "$F" ] && ok "flat pod: kratos.yml still rendered (an update never fails on it)" || { bad "flat render failed: $(cat "$TMP/flat/err")"; exit 1; }
grep -A3 '^  cookie:' "$F" | grep -q '^ *domain:' && bad "flat pod: a cookie domain is rendered: $(grep -A3 '^  cookie:' "$F")" \
  || ok "flat pod: no cookie domain — host-only on alice.synap.live, never Domain=synap.live"
grep -qE '^ *domain: *\.?synap\.live *$' "$F" && bad "flat pod: Domain=synap.live rendered" || ok "flat pod: nothing scoped to synap.live"
grep -A2 '^        rp:' "$F" | grep -q 'id: alice.synap.live' && ok "flat pod: passkey rp id = its own host" || bad "flat pod: rp id: $(grep -A2 'rp:' "$F")"
grep -q '://\*' "$F" && bad "flat pod: a wildcard host is still rendered" || ok "flat pod: no wildcard origin or return URL"
section "$F" allowed_origins | grep -qx '        - https://alice-admin.synap.live' && ok "flat pod: its console stays a CORS origin" || bad "flat pod: console missing from CORS"
[ -z "$(lib kratos_config_errors "$F")" ] && ok "flat pod: the render passes the structural check" || bad "flat: $(lib kratos_config_errors "$F")"
if python3 -c 'import yaml' 2>/dev/null; then
  python3 - "$F" <<'PY' && ok "flat pod: PyYAML reads no cookie domain" || bad "flat pod: PyYAML disagrees"
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))
assert "domain" not in (c["session"]["cookie"] or {}), c["session"]["cookie"]
assert all("://*" not in o for o in c["serve"]["public"]["cors"]["allowed_origins"])
assert all("://*" not in u for u in c["selfservice"]["allowed_return_urls"])
PY
else
  echo "skip - PyYAML not installed: no parser cross-check"
fi
grep -q 'alice-admin.synap.live cannot keep you signed in' "$TMP/flat/err" && grep -q '<name>.pod.synap.live, console admin.<name>.pod.synap.live' "$TMP/flat/err" \
  && ok "flat pod: the installer says the console cannot keep a session, and the way out" || bad "flat pod: warning: $(cat "$TMP/flat/err")"

render "$TMP/apart" pod.a.com admin.b.org; rc=$?
[ "$rc" != 0 ] && grep -q 'must share a parent domain' "$TMP/apart/err" && ok "no shared parent at all: still refused" \
  || bad "pod.a.com + admin.b.org: rc=$rc $(cat "$TMP/apart/err")"

# ── backfill_federation_public_urls: the SYNAP_BASE_DOMAIN self-heal ─────────
heal() { # <dir> <domain> <env lines>
  mkdir -p "$1"; printf '%b' "$3" > "$1/.env"
  ( cd "$1"; . "$HERE/deploy/env-config.sh"; . "$TMP/lib.sh"; backfill_federation_public_urls "$2" ) >"$1/out" 2>&1
}
base() { grep '^SYNAP_BASE_DOMAIN=' "$1/.env" | cut -d= -f2-; }

heal "$TMP/h-flat" alice.synap.live 'PUBLIC_URL=https://alice.synap.live\nPOD_ADMIN_DOMAIN=alice-admin.synap.live\nPOD_ADMIN_URL=https://alice-admin.synap.live\nSYNAP_BASE_DOMAIN=synap.live\n'
! grep -q '^SYNAP_BASE_DOMAIN=' "$TMP/h-flat/.env" && ok "flat pod: SYNAP_BASE_DOMAIN=synap.live is removed" || bad "flat pod: base kept: $(base "$TMP/h-flat")"
grep -q 'Removed SYNAP_BASE_DOMAIN=synap.live' "$TMP/h-flat/out" && ok "flat pod: the removal is said" || bad "flat pod: silent removal: $(cat "$TMP/h-flat/out")"

heal "$TMP/h-nested" pod.alice.synap.live 'PUBLIC_URL=https://pod.alice.synap.live\nPOD_ADMIN_DOMAIN=pod-admin.alice.synap.live\nPOD_ADMIN_URL=https://pod-admin.alice.synap.live\nSYNAP_BASE_DOMAIN=synap.live\n'
[ "$(base "$TMP/h-nested")" = alice.synap.live ] && ok "nested pod: a broad synap.live base heals to alice.synap.live" || bad "nested: base=$(base "$TMP/h-nested")"

heal "$TMP/h-fresh" pod.alice.synap.live 'PUBLIC_URL=https://pod.alice.synap.live\n'
[ "$(base "$TMP/h-fresh")" = alice.synap.live ] && ok "nested pod: base derived on first run" || bad "fresh: base=$(base "$TMP/h-fresh")"

heal "$TMP/h-current" alice.pod.synap.live 'PUBLIC_URL=https://alice.pod.synap.live\n'
[ "$(base "$TMP/h-current")" = alice.pod.synap.live ] && grep -q '^POD_ADMIN_DOMAIN=admin.alice.pod.synap.live$' "$TMP/h-current/.env" \
  && ok "pod.synap.live pod: console admin.alice.pod.synap.live and base alice.pod.synap.live derived on first run" || bad "current: base=$(base "$TMP/h-current") $(cat "$TMP/h-current/.env")"

heal "$TMP/h-zone" alice.pod.synap.live 'PUBLIC_URL=https://alice.pod.synap.live\nPOD_ADMIN_DOMAIN=admin.alice.pod.synap.live\nPOD_ADMIN_URL=https://admin.alice.pod.synap.live\nSYNAP_BASE_DOMAIN=pod.synap.live\n'
[ "$(base "$TMP/h-zone")" = alice.pod.synap.live ] && ok "pod.synap.live pod: a pod.synap.live base heals to alice.pod.synap.live" || bad "zone base: base=$(base "$TMP/h-zone")"

heal "$TMP/h-custom" pod.a.com 'PUBLIC_URL=https://pod.a.com\nPOD_ADMIN_DOMAIN=admin.b.org\nPOD_ADMIN_URL=https://admin.b.org\nSYNAP_BASE_DOMAIN=a.com\n'
[ "$(base "$TMP/h-custom")" = a.com ] && ok "an operator base that is not a suffix is kept" || bad "custom: base=$(base "$TMP/h-custom")"

exit $fail
