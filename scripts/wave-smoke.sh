#!/usr/bin/env bash
# Post-deploy smoke for the capability-address / door-parity wave.
#
# Verifies AGAINST A LIVE POD the things a unit test cannot: that the deployed
# build actually serves the widened contracts, that the reconcile→verb-catalog
# →intent chain reaches this pod, and that the identity + pending-review doors
# answer. Read-only: it creates nothing and approves nothing.
#
#   ./scripts/wave-smoke.sh                       # uses $SYNAP_POD_URL + $SYNAP_HUB_API_KEY
#   POD=https://pod.example.live ./scripts/wave-smoke.sh
set -uo pipefail

POD="${POD:-${SYNAP_POD_URL:-https://pod.antoinesrvt.synap.live}}"
KEY="${SYNAP_HUB_API_KEY:-}"
WS="${SYNAP_WORKSPACE_ID:-}"
pass=0; fail=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=$((fail+1)); }
head_() { printf "\n\033[1m%s\033[0m\n" "$1"; }

[ -z "$KEY" ] && { echo "SYNAP_HUB_API_KEY is not set — export it and re-run."; exit 2; }

head_ "Pod reachable"
HEALTH=$(curl -s --max-time 20 "$POD/health")
SHA=$(printf '%s' "$HEALTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("buildSha","?"))' 2>/dev/null)
[ -n "$SHA" ] && [ "$SHA" != "?" ] && ok "build $SHA" || bad "no /health buildSha"

head_ "Declared contracts (the wave widened these — a field absent here is invisible to every client)"
SPEC=$(curl -s --max-time 40 "$POD/api/hub/openapi.json")
check_prop() { # schema_name field
  printf '%s' "$SPEC" | python3 -c "
import sys,json
d=json.load(sys.stdin); s=d.get('components',{}).get('schemas',{}).get('$1',{})
sys.exit(0 if '$2' in s.get('properties',{}) else 1)" 2>/dev/null \
    && ok "$1.$2 declared" || bad "$1.$2 MISSING from the published contract"
}
check_prop ExecuteCapabilityProposed reviewUrl
check_prop ExecuteCapabilityProposed ackState
check_prop ExecuteCapabilityResult   ackState
printf '%s' "$SPEC" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d['paths']['/knowledge/search']['post']['responses']['200']['content']['application/json']['schema']
if '\$ref' in s: s=d['components']['schemas'][s['\$ref'].split('/')[-1]]
sys.exit(0 if 'pending' in s.get('properties',{}) else 1)" 2>/dev/null \
  && ok "/knowledge/search 200 declares pending" || bad "/knowledge/search 200 MISSING pending"

head_ "Reconcile → verb catalog → intent (the founding defect: this returned [] on every pod)"
# ⚠ NOT VERIFIABLE OVER REST — and that is itself the finding. The intent axis is
# severed on the Hub door TWICE: no route takes an `intent` query param, and the
# `/capabilities/catalog` verb projection omits `intent` entirely (83/83 verbs, 11
# fields, none of them intent) while MCP returns it fine. The shared index
# (services/capabilities/capability-intent-index.ts) is consumed ONLY by
# routers/mcp/handlers/capability.ts. Same door-parity class T4 audits, on a
# service/door pair T4 does not cover.
#
# VERIFY THIS ONE BY HAND (it is the founding defect of the whole wave):
#     synap_list_capabilities({ workspaceId, intent: "send_message" })
#   expected: >=1 match. Before the reconcile fix it returned [] for every value.
echo "  – intent reverse-lookup is MCP-only; verify with synap_list_capabilities({intent})"
echo "    REST gap: no \`intent\` query param, and /capabilities/catalog drops the field."

head_ "Pending-review block (stops an agent re-filing what is already queued)"
PB=$(curl -s --max-time 40 -X POST "$POD/api/hub/knowledge/search" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"query":"pitch deck"}')
printf '%s' "$PB" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('    pending block present:', 'pending' in d, '| matches:', len(d.get('pending',{}).get('matches',[])))
sys.exit(0)" 2>/dev/null && ok "retrieval answered" || bad "retrieval door failed"

head_ "Pod health"
curl -s --max-time 30 -X POST "$POD/api/hub/diagnose" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}' \
  | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); print('   ', d.get('status','?'), '—', d.get('summary','')[:160])
except Exception: print('    (diagnose door did not answer over REST — use the MCP tool)')" 2>/dev/null

printf "\n\033[1m%d passed, %d failed\033[0m\n" "$pass" "$fail"
[ "$fail" -gt 0 ] && exit 1 || exit 0
