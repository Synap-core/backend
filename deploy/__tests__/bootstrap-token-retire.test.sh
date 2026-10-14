#!/usr/bin/env bash
# Tripwire: PROVISIONING_TOKEN is BOOTSTRAP-ONLY (SECURITY-PLAN-R1 §4 / D9). The
# pod refuses it once it has an owner, so the installer drops it from
# deploy/.env at that moment — and `synap update` must not write a new one.
#
# Runs the REAL helpers and the REAL cmd_setup_admin (extracted from `synap`)
# against a temp deploy dir, a fake curl (the pod's setup/status answer) and a
# stubbed preseed. The end-to-end owner-step case (federated registration) lives
# in install-register.test.sh ("happy: PROVISIONING_TOKEN retired …").
#
#   retire      removes only that line, writes the marker, idempotent, prints no value
#   backfill    writes a token when missing and not retired; never after retirement
#   status      `setup admin --retire-token`: ready → retired; needed/unknown → kept
#   preseed     `setup admin --password`: admin created → retired; failed → kept
#   magic-link  minting a link does NOT retire (the owner does not exist yet)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

SECRET="test-secret-prov-0123456789abcdef"
mkdir -p "$TMP/bin" "$TMP/deploy"
cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
# the pod's answer, chosen by $FAKE_STATUS: ready | needed | garbage
case "$*" in
  *setup/status*) case "$FAKE_STATUS" in
      ready) echo '{"needsSetup":false}' ;; needed) echo '{"needsSetup":true}' ;; *) exit 22 ;; esac ;;
  *setup/magic-link*) echo '{"url":"https://pod.example.com/setup?token=t"}' ;;
esac
C
chmod +x "$TMP/bin/curl"

extract() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {p=1} p{print} p&&/^}/{exit}' "$HERE/synap"; }
{
  echo 'RED=;YELLOW=;BLUE=;NC=;GREEN=;'
  echo "get_deploy_dir(){ echo '$TMP/deploy'; }"
  echo "run_preseed_admin_in_container(){ [ \"\${FAKE_PRESEED:-ok}\" = ok ]; }"
  sed -n '/^_BOOTSTRAP_TOKEN_MARKER=/p' "$HERE/synap"
  cat "$HERE/deploy/env-config.sh"
  for f in _synap_pod_url _synap_bootstrap_token _bootstrap_token_retire _bootstrap_token_backfill _setup_needs_probe cmd_setup_admin; do extract "$f"; done
} > "$TMP/lib.sh"
for f in _bootstrap_token_retire _bootstrap_token_backfill _setup_needs_probe cmd_setup_admin; do
  grep -q "^$f()" "$TMP/lib.sh" || { bad "could not extract $f"; exit 1; }
done
grep -q '^_BOOTSTRAP_TOKEN_MARKER=' "$TMP/lib.sh" || { bad "marker variable not found"; exit 1; }

D="$TMP/deploy"
fresh() { rm -rf "$D/state"; printf 'DOMAIN=pod.example.com\nPROVISIONING_TOKEN=%s\nADMIN_BOOTSTRAP_TOKEN=bootstrap-456\nJWT_SECRET=jwt-789\n' "$SECRET" > "$D/.env"; chmod 600 "$D/.env"; }
# run <fn+args…> in the deploy dir with the fakes; stdout+stderr captured to $TMP/out
run() { ( cd "$D" && PATH="$TMP/bin:$PATH" SYNAP_POD_URL=http://127.0.0.1:4000 FAKE_STATUS="${FAKE_STATUS:-ready}" \
    bash -c '. "$1"; shift; "$@"' _ "$TMP/lib.sh" "$@" ) > "$TMP/out" 2>&1; }
has_token() { grep -q '^PROVISIONING_TOKEN=' "$D/.env"; }
marker()    { [ -f "$D/state/bootstrap-token.retired" ]; }

# ── retire ────────────────────────────────────────────────────────────────────
fresh; run _bootstrap_token_retire; rc=$?
[ "$rc" = 0 ] && ! has_token && marker && ok "retire: token line gone, marker written" || bad "retire: rc=$rc token=$(has_token && echo kept) marker=$(marker && echo y || echo n)"
[ "$(grep -c . "$D/.env")" = 3 ] && grep -q '^DOMAIN=pod.example.com$' "$D/.env" && grep -q '^ADMIN_BOOTSTRAP_TOKEN=bootstrap-456$' "$D/.env" && grep -q '^JWT_SECRET=jwt-789$' "$D/.env" \
  && ok "retire: every other line untouched" || bad "retire: .env damaged: $(cut -d= -f1 "$D/.env" | tr '\n' ' ')"
grep -q "$SECRET" "$TMP/out" && bad "retire: the token VALUE was printed" || ok "retire: the value is never printed"
run _bootstrap_token_retire; rc=$?
[ "$rc" = 0 ] && ! has_token && marker && ok "retire: idempotent (second run, token already gone)" || bad "retire: not idempotent rc=$rc"
[ "$(stat -f %Lp "$D/.env" 2>/dev/null || stat -c %a "$D/.env")" = 600 ] && ok "retire: .env keeps its 0600 mode" || bad "retire: .env mode changed"

# ── backfill ──────────────────────────────────────────────────────────────────
fresh; sed -i.bak '/^PROVISIONING_TOKEN=/d' "$D/.env"; rm -f "$D/.env.bak"
run _bootstrap_token_backfill
grep -q '^PROVISIONING_TOKEN=.\{16,\}' "$D/.env" && ok "backfill: an early install with no token gets one" || bad "backfill: nothing written"
fresh; run _bootstrap_token_backfill
[ "$(grep -c '^PROVISIONING_TOKEN=' "$D/.env")" = 1 ] && grep -q "^PROVISIONING_TOKEN=$SECRET$" "$D/.env" \
  && ok "backfill: an existing token is never rotated" || bad "backfill: rotated or duplicated the token"
fresh; run _bootstrap_token_retire; run _bootstrap_token_backfill
! has_token && ok "backfill: a RETIRED token is not resurrected by an update" || bad "backfill: re-added the token after retirement"

# ── setup admin --retire-token ────────────────────────────────────────────────
fresh; FAKE_STATUS=ready run cmd_setup_admin --retire-token; rc=$?
[ "$rc" = 0 ] && ! has_token && marker && ok "retire-token: pod says ready (owner exists) → retired" || { bad "retire-token ready: rc=$rc"; cat "$TMP/out"; }
fresh; FAKE_STATUS=needed run cmd_setup_admin --retire-token; rc=$?
[ "$rc" != 0 ] && has_token && ! marker && ok "retire-token: pod says needed (no owner) → refused, token kept" || bad "retire-token needed: rc=$rc"
fresh; FAKE_STATUS=garbage run cmd_setup_admin --retire-token; rc=$?
[ "$rc" != 0 ] && has_token && ! marker && ok "retire-token: pod unreachable/unknown → refused, token kept" || bad "retire-token unknown: rc=$rc"
fresh; FAKE_STATUS=ready run cmd_setup_admin --status; rc=$?
[ "$rc" = 0 ] && [ "$(cat "$TMP/out")" = ready ] && has_token && ok "status: --status still answers 'ready' and retires nothing" || bad "status: rc=$rc out=$(cat "$TMP/out")"
fresh; FAKE_STATUS=garbage run cmd_setup_admin --status; rc=$?
[ "$rc" = 2 ] && [ "$(cat "$TMP/out")" = unknown ] && ok "status: unreachable pod → 'unknown', exit 2 (unchanged contract)" || bad "status unknown: rc=$rc"

# ── preseed / magic-link ──────────────────────────────────────────────────────
fresh; FAKE_PRESEED=ok run cmd_setup_admin --email a@b.co --password pw; rc=$?
[ "$rc" = 0 ] && ! has_token && marker && ok "preseed: admin created → token retired" || bad "preseed ok: rc=$rc"
fresh; FAKE_PRESEED=fail run cmd_setup_admin --email a@b.co --password pw; rc=$?
[ "$rc" != 0 ] && has_token && ! marker && ok "preseed: admin creation failed → token kept (no owner)" || bad "preseed fail: rc=$rc"
fresh; run cmd_setup_admin --email a@b.co --magic-link; rc=$?
[ "$rc" = 0 ] && has_token && ! marker && ok "magic-link: minting a link keeps the token (the owner does not exist yet)" || bad "magic-link: rc=$rc"

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
