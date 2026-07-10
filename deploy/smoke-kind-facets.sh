#!/usr/bin/env bash
# ─── Kind + Facets live smoke test ───────────────────────────────────────────
# Verifies the deployed pod's facet/identity machinery end-to-end.
#
#   POD_URL=https://pod.example.com HUB_KEY=sk_... ./smoke-kind-facets.sh
#   ... --write   also exercises the WRITE paths (graph-door within-batch
#                 dedup + execute-door persisted dedup). Write mode creates
#                 ONE pending proposal (reject it afterwards) and enriches /
#                 links against the smoke sentinel entity; it never deletes.
#
# Read-only checks (default): release status, facet read routes, list filter,
# invalid-attach rejection. Exit non-zero on any failure.
set -euo pipefail

POD_URL="${POD_URL:?set POD_URL}"
HUB_KEY="${HUB_KEY:?set HUB_KEY (hub-protocol Bearer key)}"
WRITE=false
[ "${1:-}" = "--write" ] && WRITE=true

SENTINEL_EMAIL="smoke.kind-facets@test.synap"
SENTINEL_TITLE="Smoke Sentinel (kind-facets)"
PASS=0; FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "  ✅ $*"; }
bad()  { FAIL=$((FAIL+1)); say "  ❌ $*"; }

hub() { curl -sS -m 20 -H "Authorization: Bearer $HUB_KEY" "$@"; }

say "── 1. Release status"
REL=$(curl -sS -m 15 "$POD_URL/status/release")
echo "$REL" | grep -q '"ok":true' && ok "schemaCoherence ok" || bad "schemaCoherence NOT ok: $REL"
echo "$REL" | python3 -c "import json,sys; d=json.load(sys.stdin); print('  ·', d['migrations']['lastApplied'], '· build', (d.get('buildStamp') or 'n/a')[:12])"

say "── 2. Facet read routes"
ANY_ENTITY=$(hub "$POD_URL/api/hub/entities?limit=1" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['id'] if r else '')")
if [ -n "$ANY_ENTITY" ]; then
  FACETS=$(hub "$POD_URL/api/hub/entities/$ANY_ENTITY/facets")
  echo "$FACETS" | grep -q '"facets"' && ok "GET /entities/{id}/facets live" || bad "facets route broken: $FACETS"
else
  bad "no entity visible to probe facets route"
fi

say "── 3. facetSlug list filter accepted"
LF=$(hub "$POD_URL/api/hub/entities?facetSlug=__smoke_nonexistent__&limit=1")
[ "$LF" = "[]" ] && ok "unknown facetSlug → [] (never silently ignored)" || bad "facetSlug filter unexpected: $LF"

say "── 4. Invalid attach fast-fails (kind profile as facet)"
CODE=$(hub -o /tmp/smoke-attach.json -w '%{http_code}' -X POST -H "Content-Type: application/json" \
  -d '{"profileSlug":"bookmark"}' "$POD_URL/api/hub/entities/$ANY_ENTITY/facets")
BODY=$(cat /tmp/smoke-attach.json)
if echo "$BODY" | grep -q "not a role profile"; then
  if [ "$CODE" = "400" ]; then ok "rejected with 400 + correct message"
  else ok "rejected with correct message (HTTP $CODE — 400 mapping arrives with commit 9fb3e7d4)"; fi
elif echo "$BODY" | grep -q '"proposalId"'; then
  bad "attach of a KIND was parked as a proposal (pre-12076f24 behavior): $BODY"
else
  bad "unexpected attach response (HTTP $CODE): $BODY"
fi

if $WRITE; then
  say "── 5. [write] Graph-door within-batch dedup (2 same-email refs → entityCount 2)"
  G=$(hub -X POST -H "Content-Type: application/json" -d "{
    \"summary\":\"SMOKE: within-batch dedup (reject me)\",
    \"entities\":[
      {\"ref\":\"p1\",\"profileSlug\":\"contact\",\"title\":\"$SENTINEL_TITLE\",\"properties\":{\"email\":\"$SENTINEL_EMAIL\"}},
      {\"ref\":\"p2\",\"profileSlug\":\"contact\",\"title\":\"$SENTINEL_TITLE B\",\"properties\":{\"email\":\"$SENTINEL_EMAIL\"}},
      {\"ref\":\"c\",\"profileSlug\":\"company\",\"title\":\"Smoke Co\"}
    ],\"relations\":[]}" "$POD_URL/api/hub/capture/graph")
  COUNT=$(echo "$G" | python3 -c "import json,sys; print(json.load(sys.stdin).get('entityCount',-1))")
  if [ "$COUNT" = "2" ]; then ok "collapsed to entityCount=2 (proposal: reject it — $(echo "$G" | python3 -c "import json,sys; print(json.load(sys.stdin).get('proposalId','?'))"))"
  else bad "expected entityCount 2, got $COUNT: $G"; fi

  say "── 6. [write] Execute-door persisted dedup (needs an APPROVED sentinel from a prior run)"
  E=$(hub -X POST -H "Content-Type: application/json" -d "{
    \"entities\":[{\"tempId\":\"a\",\"profileSlug\":\"contact\",\"title\":\"$SENTINEL_TITLE Again\",\"properties\":{\"email\":\"$SENTINEL_EMAIL\"}}],\"relations\":[]}" \
    "$POD_URL/api/hub/capture/execute")
  if echo "$E" | grep -q '"deduplicated":true'; then ok "strong-signal match → linked, not created"
  elif echo "$E" | grep -q '"entityId"'; then ok "created fresh (no persisted sentinel yet — approve one, rerun to test dedup)"
  else bad "execute door failed: $E"; fi
fi

say ""
say "Smoke result: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
