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
# bodies' evaluation (checked separately with go-jsonnet v0.20.0, Kratos
# v1.3.1's: the oidc body yields transient_payload null when the flow has none).
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
  for f in pod_admin_domain_for_domain pod_admin_url_for_domain synap_tenant_zones is_public_suffix common_parent_domain shared_cookie_domain synap_first_party_web_origins generate_kratos_config; do
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

# EVERY enabled method that can register must hit a BLOCKING gate first.
# Kratos v1.3.1 looks registration hooks up per method, the global list only
# when a method has none (driver/registry_default_registration.go), so an
# enabled method with no hooks registers with NO gate (passkey did until
# 2026-10-23: an open sign-up on every pod). The method list is DERIVED from
# the generated file, merged with Kratos v1.3.1's own defaults for a method
# the file does not mention (embedx/config.schema.json: password, profile and
# code are enabled by default; every other method is off unless enabled here).
# Never registering: profile (the traits step of two-step registration; it
# persists nothing), link (recovery/verification), totp and lookup_secret
# (second factors); code registers only with passwordless_enabled.
KRATOS_DEFAULT_ENABLED = {"password", "profile", "code"}
NEVER_REGISTERS = {"profile", "link", "totp", "lookup_secret"}
methods = sel.get("methods") or {}
enabled = {}
for name in set(methods) | KRATOS_DEFAULT_ENABLED:
    m = methods.get(name) or {}
    on = m.get("enabled", name in KRATOS_DEFAULT_ENABLED)
    enabled[name] = (on is True, m)
registering = []
for name, (on, m) in sorted(enabled.items()):
    if not on or name in NEVER_REGISTERS:
        continue
    if name == "code" and (m.get("config") or {}).get("passwordless_enabled") is not True \
            and m.get("passwordless_enabled") is not True:
        continue
    registering.append(name)
check({"password", "passkey", "oidc"} <= set(registering), f"registering methods derived: {registering}")
check(not (reg.get("after") or {}).get("hooks"), "registration: no global after.hooks (each method gates itself)")
for name in registering:
    hs = ((reg.get("after") or {}).get(name) or {}).get("hooks") or []
    first = hs[0] if hs else {}
    gated = (first.get("hook") == "web_hook"
             and (first.get("config") or {}).get("can_interrupt") is True
             and str((first.get("config") or {}).get("url", "")).endswith("/registration/gate"))
    check(gated, f"{name}: registration's first hook is the BLOCKING gate")
    if gated:
        check(f'method: "{name}"' in body(first), f"{name}: gate body declares method {name}")
    check(bool(hs) and hs[-1].get("hook") == "session", f"{name}: session is the last hook")

pk = reg["after"].get("passkey", {}).get("hooks") or []
check([h.get("hook") for h in pk] == ["web_hook", "web_hook", "session"], "passkey order gate, complete, session")
if len(pk) == 3:
    check(not pk[1]["config"].get("can_interrupt") and pk[1]["config"]["url"].endswith("/registration/complete"),
          "passkey: complete hook is post-persist (no can_interrupt)")
# Join plan phase 4: the invite page's invite_token rides the flow's
# transient_payload; the oidc and passkey hooks forward it (guarded: the field
# is omitempty, and a missing field is a jsonnet error, i.e. a broken hook).
TRANSIENT = 'std.objectHas(ctx.flow, "transient_payload") then ctx.flow.transient_payload else null'
for h in pk[:2]:
    check(TRANSIENT in body(h), "passkey: body forwards ctx.flow.transient_payload, guarded")

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
    check(TRANSIENT in body(h), "oidc: body forwards ctx.flow.transient_payload, guarded")
check("transient_payload" not in body(pw[0]), "password: body carries no transient_payload (password sign-up stays refused)")

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
