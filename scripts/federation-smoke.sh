#!/usr/bin/env bash
# Federated auto-sign-in live smoke test.
# Verifies the deployed CP + pod behaviors from this workstream. No secrets;
# crafts unsigned/wrong-signature probe assertions that only reach the
# pre-verification gates. Re-run after any redeploy.
#
#   POD_URL=... CP_URL=... CRM_ORIGIN=... ./federation-smoke.sh
set -u
CP="${CP_URL:-https://api.synap.live}"
POD="${POD_URL:-${SYNAP_POD_URL:-https://pod.perso.thearchitech.xyz}}"
CRM_ORIGIN="${CRM_ORIGIN:-http://localhost:3030}"
pass=0; fail=0
ok(){ echo "  ✅ $1"; pass=$((pass+1)); }
no(){ echo "  ❌ $1"; fail=$((fail+1)); }

jwt(){ node -e '
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const now=Math.floor(Date.now()/1000);
const c=JSON.parse(process.argv[1]);
process.stdout.write(b64({alg:"ES256",typ:"JWT",kid:"cp-signing-key-1"})+"."+
  b64({sub:"smoke",jti:"smoke-"+now,iat:now,exp:now+240,purpose:"user-exchange",...c})+".badsig");
' "$1"; }

echo "CP=$CP  POD=$POD  CRM_ORIGIN=$CRM_ORIGIN"

echo "[1] CP /federation/metadata declares the real federation issuer + scopes"
M=$(curl -s -m 15 "$CP/federation/metadata")
echo "$M" | grep -q "\"issuer\":\"$CP\"" && ok "issuer == $CP" || no "issuer wrong/missing: $M"
echo "$M" | grep -q '"auth:exchange-user"' && ok "canonical scopes present" || no "scopes missing"

echo "[2] CP JWKS serves the ES256 signing key"
curl -s -m 15 "$CP/.well-known/jwks.json" | grep -q '"alg":"ES256"' && ok "ES256 key present" || no "jwks missing key"

echo "[3] §5 — untrusted issuer + azp → ISSUER_APPROVAL_REQUIRED (not app-connection)"
R=$(curl -s -m 15 -X POST "$POD/api/federation/exchange" -H "Content-Type: application/json" \
  -d "{\"assertion\":\"$(jwt '{"iss":"https://untrusted.example.test","azp":"crm-client"}')\"}")
echo "$R" | grep -q '"ISSUER_APPROVAL_REQUIRED"' && ok "emits ISSUER_APPROVAL_REQUIRED" || no "wrong code: $R"
echo "$R" | grep -q 'APPLICATION_CONNECTION_APPROVAL_REQUIRED' && no "REGRESSION: app-connection code" || ok "no app-connection mislabel"

echo "[4] CP trusted on pod via discovery — real CP iss + bad sig → 401 (past issuer gate)"
C=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -X POST "$POD/api/federation/exchange" \
  -H "Content-Type: application/json" -d "{\"assertion\":\"$(jwt '{"iss":"'$CP'"}')\"}")
[ "$C" = "401" ] && ok "CP is a trusted issuer (401, failed only signature)" \
  || no "CP NOT trusted (got $C; 403 = discovery/seed didn't land)"

echo "[5] CRM origin CORS-approved → discrete 403 is browser-readable"
H=$(curl -s -m 15 -i -X POST "$POD/api/federation/exchange" -H "Origin: $CRM_ORIGIN" \
  -H "Content-Type: application/json" -d '{"assertion":"x"}' | grep -i "access-control-allow-origin")
echo "$H" | grep -qi "$CRM_ORIGIN" && ok "origin approved ($CRM_ORIGIN echoed)" \
  || no "origin NOT approved — recovery would show 'allow this website' ($CRM_ORIGIN)"

echo "[6] Malformed assertion → 401"
curl -s -m 15 -X POST "$POD/api/federation/exchange" -H "Content-Type: application/json" \
  -d '{"assertion":"not-a-jwt"}' | grep -q "Invalid federated user assertion" && ok "rejects malformed" || no "malformed handling off"

echo "----"
echo "PASS=$pass  FAIL=$fail"
[ "$fail" = 0 ] || exit 1
