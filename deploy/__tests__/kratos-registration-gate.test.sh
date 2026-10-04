#!/usr/bin/env bash
# Tripwire: the kratos.yml `synap` generates must (1) post every web_hook to a
# route the API actually mounts (/api/webhooks/kratos — the old /webhooks/kratos
# was a dead URL), (2) gate BOTH registration methods with a BLOCKING hook
# (can_interrupt: true ⇒ Kratos runs it pre-persist), and (3) order the oidc
# chain gate → complete → session (session ends the post-persist chain, so a
# hook after it never runs). Runs the REAL generate_kratos_config with fake
# curl/docker so the CP OIDC branch is enabled, then parses the YAML.
#
# Does NOT cover: whether Kratos accepts the file at runtime, or the jsonnet
# bodies' evaluation (checked separately with go-jsonnet; see the report).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

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

# Extract one top-level function (definition line to its closing brace).
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

sel = cfg["selfservice"]
check(sel["methods"]["oidc"]["enabled"] is True, "oidc branch enabled by the fake CP (non-vacuous)")

# Every web_hook anywhere in the file targets the mounted router.
hooks = []
def walk(o):
    if isinstance(o, dict):
        if o.get("hook") == "web_hook": hooks.append(o)
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(cfg)
check(len(hooks) >= 3, f"found {len(hooks)} web_hooks (expect >= 3)")
for h in hooks:
    url = h["config"]["url"]
    check(url.startswith("http://backend:4000/api/webhooks/kratos"), f"mounted URL: {url}")
    check(h["config"]["headers"].get("X-Webhook-Secret") == "test-secret", f"secret header on {url}")

reg = sel["flows"]["registration"]
check(reg.get("enabled", True) is not False,
      "registration stays enabled (disabling it kills the owner's first oidc sign-in)")

def body(h):
    raw = h["config"]["body"]
    assert raw.startswith("base64://")
    return base64.b64decode(raw[len("base64://"):]).decode()

pw = reg["after"]["password"]["hooks"]
check(pw[0].get("hook") == "web_hook" and pw[0]["config"].get("can_interrupt") is True,
      "password: first hook is a BLOCKING gate")
check(pw[0]["config"]["url"].endswith("/registration/gate"), "password: gate URL")
check('method: "password"' in body(pw[0]), "password: body declares method password")

oidc = reg["after"]["oidc"]["hooks"]
kinds = [h.get("hook") for h in oidc]
check(kinds == ["web_hook", "web_hook", "session"], f"oidc order gate, complete, session: {kinds}")
check(oidc[0]["config"].get("can_interrupt") is True and oidc[0]["config"]["url"].endswith("/registration/gate"),
      "oidc: first hook is the BLOCKING gate")
check(not oidc[1]["config"].get("can_interrupt") and oidc[1]["config"]["url"].endswith("/registration/complete"),
      "oidc: complete hook is post-persist (no can_interrupt)")
for h in oidc[:2]:
    check('method: "oidc"' in body(h) and "identity: ctx.identity" in body(h), "oidc: body carries method + identity")

sys.exit(1 if errors else 0)
PY

# The generated URLs must land on what the API mounts (the dead-URL defect).
grep -qF 'app.route("/api/webhooks/kratos", kratosWebhookRouter)' "$HERE/apps/api/src/index.ts" \
  && ok "index.ts mounts kratosWebhookRouter at /api/webhooks/kratos" || bad "kratos router mount moved"
grep -qF '"/registration",' "$HERE/apps/api/src/webhooks/kratos.ts" \
  && grep -qF 'router.post("/gate"' "$HERE/apps/api/src/webhooks/kratos-registration-gate.ts" \
  && grep -qF 'router.post("/complete"' "$HERE/apps/api/src/webhooks/kratos-registration-gate.ts" \
  && ok "registration gate routes mounted under /registration" || bad "registration gate routes moved"

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
