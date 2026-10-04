#!/usr/bin/env bash
# Tripwire: `synap setup admin --email <e> --magic-link` (the self-hosted
# owner-claim door for a pod with no Cloud) must call the route the pod
# actually serves — POST /api/hub/setup/magic-link — with the token that route
# checks: PROVISIONING_TOKEN (packages/api/src/routers/hub-protocol/rest/setup.ts).
# It used to POST /setup/magic-link (404) with ADMIN_BOOTSTRAP_TOKEN (401).
# Runs the REAL cmd_setup_admin against a fake curl that records its argv.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

mkdir -p "$TMP/bin" "$TMP/deploy"
cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_ARGV"
echo '{"token":"t","url":"https://pod.example.com/setup?token=t"}'
C
chmod +x "$TMP/bin/curl"
export FAKE_ARGV="$TMP/argv"
cat > "$TMP/deploy/.env" <<'E'
PROVISIONING_TOKEN=prov-token-123
ADMIN_BOOTSTRAP_TOKEN=bootstrap-token-456
E

extract() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {p=1} p{print} p&&/^}/{exit}' "$HERE/synap"; }
{
  echo 'RED=;YELLOW=;BLUE=;NC=;GREEN=;'
  echo "get_deploy_dir(){ echo '$TMP/deploy'; }"
  for f in _synap_pod_url _synap_bootstrap_token cmd_setup_admin; do extract "$f"; done
} > "$TMP/lib.sh"
grep -q 'cmd_setup_admin()' "$TMP/lib.sh" || { bad "could not extract cmd_setup_admin"; exit 1; }

out=$( ( PATH="$TMP/bin:$PATH"; SYNAP_POD_URL=http://127.0.0.1:4000; . "$TMP/lib.sh"; cmd_setup_admin --email owner@example.com --magic-link ) 2>&1 )
[ -s "$TMP/argv" ] || { bad "curl was never called: $out"; exit 1; }

grep -qx 'http://127.0.0.1:4000/api/hub/setup/magic-link' "$TMP/argv" \
  && ok "POSTs to /api/hub/setup/magic-link" || bad "wrong magic-link URL: $(tail -1 "$TMP/argv")"
grep -qx 'Authorization: Bearer prov-token-123' "$TMP/argv" \
  && ok "authorizes with PROVISIONING_TOKEN" || bad "wrong token header"
grep -q 'bootstrap-token-456' "$TMP/argv" && bad "ADMIN_BOOTSTRAP_TOKEN sent" || ok "ADMIN_BOOTSTRAP_TOKEN not sent"
[ "$out" = "https://pod.example.com/setup?token=t" ] && ok "prints the magic-link URL" || bad "unexpected output: $out"

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
