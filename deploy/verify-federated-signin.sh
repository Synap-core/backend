#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Federated "Continue with Synap Cloud" sign-in — server-side smoke test.
#
# Walks every hop of the config-driven federated sign-in that a browser can't
# be scripted for, WITHOUT a session (so it runs in CI / from any shell):
#
#   1. Pod Kratos login-init   (approved-app origin, guard-fix exemption)  → 200
#   2. Pod Kratos oidc submit   (provider=cp)                              → 422 + CP authorize URL
#   3. CP /oauth/authorize      (no session)      → bounces to USER host (synap.live), NOT admin
#   4. CP /oauth/authorize      (prompt=none)     → login_required back to the pod (silent-auth)
#   5. CP OIDC discovery        issuer self-consistent
#   6. Pod Kratos login-init   (UNAPPROVED origin) → no ACAO (browser can't read it)
#
# The session-dependent tail (auto-consent → code → token-exchange → pod session)
# needs a real .synap.live cookie and is the ONLY part a human must dogfood.
#
# Usage:
#   POD=https://pod.thearch.synap.live \
#   CP=https://api.synap.live \
#   APP_ORIGIN=https://crm.synap.live \
#   USER_HOST=synap.live \
#   ./verify-federated-signin.sh
# ---------------------------------------------------------------------------
set -uo pipefail

POD="${POD:-https://pod.thearch.synap.live}"
CP="${CP:-https://api.synap.live}"
APP_ORIGIN="${APP_ORIGIN:-https://crm.synap.live}"
USER_HOST="${USER_HOST:-synap.live}"
CLIENT_ID="pod:$(echo "$POD" | sed -E 's#https?://##; s#/.*##')"
CALLBACK="$POD/.ory/kratos/public/self-service/methods/oidc/callback/cp"
RT="$APP_ORIGIN/login?federation=cloud"

enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
pass=0; fail=0
ok(){ echo "  ✅ $1"; pass=$((pass+1)); }
no(){ echo "  ❌ $1"; fail=$((fail+1)); }

echo "── Federated sign-in smoke test ──  POD=$POD  CP=$CP  APP=$APP_ORIGIN"

# 1. login-init from the approved app origin
curl -sS -o /tmp/vf_flow.json -D /tmp/vf_h1.txt -H "Origin: $APP_ORIGIN" \
  "$POD/.ory/kratos/public/self-service/login/api?return_session_token_exchange_code=true&return_to=$(enc "$RT")" >/dev/null
[ "$(node -pe "require('/tmp/vf_flow.json').session_token_exchange_code?1:0" 2>/dev/null)" = "1" ] \
  && ok "1. login-init → 200 + session_token_exchange_code" || no "1. login-init failed (guard not deployed?)"
FLOW=$(node -pe "require('/tmp/vf_flow.json').id" 2>/dev/null)

# 2. oidc submit → CP authorize URL
curl -sS -o /tmp/vf_sub.json -X POST -H "Origin: $APP_ORIGIN" -H "Content-Type: application/json" \
  "$POD/.ory/kratos/public/self-service/login?flow=$FLOW" -d '{"csrf_token":"","method":"oidc","provider":"cp"}' >/dev/null
AUTHZ=$(node -pe "(require('/tmp/vf_sub.json').error||{}).reason||''" 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)
echo "$AUTHZ" | grep -q "$(enc "$CLIENT_ID")" && ok "2. oidc submit → CP authorize URL (client_id=$CLIENT_ID)" \
  || no "2. oidc submit did not return the expected CP authorize URL"

# 3. /oauth/authorize (no session) bounces to the USER host, NOT the admin host
LOC=$(curl -sS -o /dev/null -D - "$CP/oauth/authorize?response_type=code&client_id=$(enc "$CLIENT_ID")&redirect_uri=$(enc "$CALLBACK")&scope=openid+email+profile&state=s&code_challenge=abc&code_challenge_method=S256" \
  | grep -i '^location:' | tr -d '\r' | sed 's/location: //I')
echo "$LOC" | grep -qE "^https://$USER_HOST/login" \
  && ok "3. unauthenticated → https://$USER_HOST/login (user host, not admin)" \
  || no "3. unauthenticated bounced to WRONG host: $LOC"

# 4. prompt=none → OIDC login_required back to the RP (never a UI host)
LOC=$(curl -sS -o /dev/null -D - "$CP/oauth/authorize?response_type=code&client_id=$(enc "$CLIENT_ID")&redirect_uri=$(enc "$CALLBACK")&scope=openid+email+profile&state=s&code_challenge=abc&code_challenge_method=S256&prompt=none" \
  | grep -i '^location:' | tr -d '\r' | sed 's/location: //I')
echo "$LOC" | grep -q "login_required" && ok "4. prompt=none → login_required back to pod" \
  || no "4. prompt=none redirect unexpected: $LOC"

# 5. discovery issuer self-consistent
ISS=$(curl -sS "$CP/.well-known/openid-configuration" | node -pe "JSON.parse(require('fs').readFileSync(0)).issuer" 2>/dev/null)
[ "$ISS" = "$CP" ] && ok "5. OIDC discovery issuer = $CP" || no "5. issuer mismatch: $ISS"

# 6. an UNAPPROVED external origin must NOT get a CORS grant (browser can't read the flow)
ACAO=$(curl -sS -o /dev/null -D - -H "Origin: https://not-approved.example.com" \
  "$POD/.ory/kratos/public/self-service/login/api" | grep -i '^access-control-allow-origin:' | tr -d '\r')
[ -z "$ACAO" ] && ok "6. unapproved origin gets no ACAO (cannot read the flow)" \
  || no "6. SECURITY: unapproved origin got a CORS grant: $ACAO"

# 7. the token-exchange endpoint (callback's final hop) is wired + CORS-readable.
#    Dummy codes → Kratos "no session yet for this code" (route exists); a REAL
#    completed flow returns the session_token here.
TX_H=$(curl -sS -o /tmp/vf_tx.json -D - -H "Origin: $APP_ORIGIN" \
  "$POD/.ory/kratos/public/sessions/token-exchange?init_code=dummy&return_to_code=dummy")
TX_ACAO=$(echo "$TX_H" | grep -i '^access-control-allow-origin:' | tr -d '\r')
grep -q "no session yet for this" /tmp/vf_tx.json && [ -n "$TX_ACAO" ] \
  && ok "7. token-exchange route wired + ACAO for $APP_ORIGIN" \
  || no "7. token-exchange endpoint missing/misrouted or no CORS: $(head -c 80 /tmp/vf_tx.json)"

echo "── $pass passed, $fail failed ──"
[ "$fail" -eq 0 ]
