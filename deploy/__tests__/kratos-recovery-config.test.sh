#!/usr/bin/env bash
# Tripwire: account recovery in the kratos.yml `synap` generates.
#   1. `mailslurper` never reappears in `synap` (the courier URI it named was
#      dead config: COURIER_SMTP_CONNECTION_URI from compose overrides the
#      file), and the generated file carries NO courier connection_uri.
#   2. recovery uses `code`, renders at pod-admin /recovery, and revokes the
#      account's other sessions after a recovery.
#   3. settings renders at pod-admin /settings/security, and every settings
#      method that changes a sign-in method runs the BLOCKING Cloud-trust
#      guard (can_interrupt ⇒ pre-persist) on a route the API mounts.
#   4. "Continue with Synap Cloud" runs the BLOCKING Cloud sign-in gate.
# Runs the REAL generate_kratos_config with fake curl/docker (CP OIDC branch
# enabled), then parses the YAML.
#
# Does NOT cover: whether Kratos accepts the file at runtime, or the jsonnet
# bodies' evaluation (checked with go-jsonnet; see the commit message).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

if grep -qi 'mailslurper' "$HERE/synap"; then
  bad "synap mentions mailslurper again: $(grep -ni mailslurper "$HERE/synap" | head -3)"
else
  ok "synap never mentions mailslurper"
fi

mkdir -p "$TMP/bin" "$TMP/deploy" "$TMP/kratos"
cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
echo '{"delivered":true}'
C
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
echo 'pod:example.com|client-secret|https://api.synap.live'
D
chmod +x "$TMP/bin/curl" "$TMP/bin/docker"
cat > "$TMP/deploy/.env" <<'E'
KRATOS_WEBHOOK_SECRET=test-secret
CONTROL_PLANE_URL=https://api.synap.live
PUBLIC_URL=https://pod.example.com
E

extract() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {p=1} p{print} p&&/^}/{exit}' "$HERE/synap"; }
{
  echo 'RED=;YELLOW=;BLUE=;NC=;GREEN=;'
  for f in pod_admin_domain_for_domain pod_admin_url_for_domain shared_cookie_domain generate_kratos_config; do
    extract "$f"
  done
} > "$TMP/lib.sh"
grep -q 'generate_kratos_config()' "$TMP/lib.sh" || { bad "could not extract generate_kratos_config"; exit 1; }

( cd "$TMP/deploy"; PATH="$TMP/bin:$PATH"; . "$TMP/lib.sh"; generate_kratos_config pod.example.com ) >/dev/null 2>"$TMP/err"
[ -s "$TMP/kratos/kratos.yml" ] || { bad "kratos.yml not generated: $(cat "$TMP/err")"; exit 1; }

python3 - "$TMP/kratos/kratos.yml" <<'PY' || fail=1
import base64, sys, yaml
cfg = yaml.safe_load(open(sys.argv[1]))
errors = []
def check(cond, msg):
    print(("ok   - " if cond else "FAIL - ") + msg)
    if not cond: errors.append(msg)

ADMIN = "https://pod-admin.example.com"
sel = cfg["selfservice"]
flows = sel["flows"]
check(sel["methods"]["oidc"]["enabled"] is True, "oidc branch enabled by the fake CP (non-vacuous)")

smtp = (cfg.get("courier") or {}).get("smtp") or {}
check("connection_uri" not in smtp, "no courier connection_uri in the file (env is the one source)")

rec = flows["recovery"]
check(rec.get("enabled") is True, "recovery enabled")
check(rec.get("use") == "code", f"recovery.use = code ({rec.get('use')})")
check(rec.get("ui_url") == f"{ADMIN}/recovery", f"recovery.ui_url = pod-admin /recovery ({rec.get('ui_url')})")
rec_hooks = [h.get("hook") for h in (rec.get("after") or {}).get("hooks", [])]
check("revoke_active_sessions" in rec_hooks, f"recovery revokes other sessions ({rec_hooks})")

st = flows["settings"]
check(st.get("ui_url") == f"{ADMIN}/settings/security", f"settings.ui_url = pod-admin /settings/security ({st.get('ui_url')})")
check(st.get("privileged_session_max_age") == "15m", "privileged window stays 15m (the API mirrors it)")

def body(h):
    raw = h["config"]["body"]
    assert raw.startswith("base64://")
    return base64.b64decode(raw[len("base64://"):]).decode()

for method in ("password", "passkey", "profile", "oidc"):
    hooks = ((st.get("after") or {}).get(method) or {}).get("hooks") or []
    guard = [h for h in hooks if h.get("hook") == "web_hook" and h["config"]["url"].endswith("/settings/guard")]
    check(len(guard) == 1, f"settings.{method}: one Cloud-trust guard")
    if guard:
        g = guard[0]["config"]
        check(g.get("can_interrupt") is True, f"settings.{method}: guard is BLOCKING (pre-persist)")
        check(g["url"] == "http://backend:4000/api/webhooks/kratos/settings/guard", f"settings.{method}: mounted URL")
        check(g["headers"].get("X-Webhook-Secret") == "test-secret", f"settings.{method}: secret header")
        b = body(guard[0])
        check("identity_id: ctx.identity.id" in b and "ory_kratos_session" in b, f"settings.{method}: body forwards identity + session cookie")

login_hooks = ((flows["login"].get("after") or {}).get("oidc") or {}).get("hooks") or []
gate = [h for h in login_hooks if h.get("hook") == "web_hook" and h["config"]["url"].endswith("/login/cloud")]
check(len(gate) == 1, "login.oidc: one Cloud sign-in gate")
if gate:
    check(gate[0]["config"].get("can_interrupt") is True, "login.oidc: gate is BLOCKING")
    check(gate[0]["config"]["url"] == "http://backend:4000/api/webhooks/kratos/login/cloud", "login.oidc: mounted URL")
    check("identity_id: ctx.identity.id" in body(gate[0]), "login.oidc: body carries identity_id")

for name in ("login", "registration", "error"):
    check(flows[name]["ui_url"] == f"{ADMIN}/login", f"{name}.ui_url stays pod-admin /login")

sys.exit(1 if errors else 0)
PY

# The generated URLs must land on what the API mounts.
grep -qF 'app.route("/api/webhooks/kratos", kratosWebhookRouter)' "$HERE/apps/api/src/index.ts" \
  && grep -qF 'createCloudTrustHookRouter(' "$HERE/apps/api/src/webhooks/kratos.ts" \
  && grep -qF 'router.post("/settings/guard"' "$HERE/apps/api/src/webhooks/kratos-cloud-trust.ts" \
  && grep -qF 'router.post("/login/cloud"' "$HERE/apps/api/src/webhooks/kratos-cloud-trust.ts" \
  && ok "Cloud-trust hook routes mounted under /api/webhooks/kratos" || bad "Cloud-trust hook routes moved"
for page in recovery settings/security; do
  [ -f "$HERE/apps/pod-admin/app/$page/page.tsx" ] && ok "pod-admin renders /$page" || bad "pod-admin has no /$page page"
done

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
