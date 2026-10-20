#!/usr/bin/env bash
# Unattended install + Control Plane registration (PODPROV-CONTRACT §3, §4, §6).
#
# Daemon-free: the REAL `synap install` against a fake `docker` on PATH, and ONE
# local python HTTP server that plays three parties:
#   • the release host     GET  /rel/<id>/release.json
#   • the Control Plane    POST /pods/register         (mode from $FAKE/cp-mode)
#   • the pod's own API    POST /api/federation/bootstrap, /api/hub/federation/
#                          oidc-config, /api/provision/register-intelligence —
#                          reached the way the real installer reaches them: the
#                          fake `docker exec <cid> node -e …` runs the CLI's real
#                          node script on this host against SYNAP_LOCAL_POD_URL.
# Every request is recorded (headers + body) so the test asserts what ARRIVED.
#
# Scenarios:
#   flags     bad --name / bad code / code without --name / code + preseed /
#             --edge tunnel without a token / http CP → refused before docker runs
#   happy     no prompt (stdin /dev/null), every default, the register request,
#             the nonce served DURING the call only, owner → oidc → AI applied
#             with the right secrets, CONTROL_PLANE_URL written, kratos.yml
#             renders the OIDC client, state recorded without secrets
#   rerun     a second run never spends the code again
#   refused   CP 401 → install fails loudly; nothing applied, no trust written
#   partial   intelligence.url without apiKey → loud failure BEFORE any pod call
#   resume    a pod step fails after a 200 → re-run re-applies the kept response
#             without calling the CP again
#   nulls     oidc + intelligence null → both skipped, install succeeds
#   podkey    §8: the pod's own P-256 key is born on the host (0600, never sent),
#             its PUBLIC JWK rides in the register body; no key → the code is
#             not spent; `synap pod-key enroll` sends only the public JWK
#   policy    D3: registration writes state/pod-agent-policy.json once, from the
#             response's deploymentMode (managed / self-hosted, 0644); an existing
#             owner file is never touched; a CP that predates the field → no file
#   bootstrap install.sh: retired flags refused with the new spelling; bundle
#             sha mismatch refused; happy path unpacks, links the CLI, execs
#             `synap install --non-interactive --release <id> …`
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FAIL - node is required (the CLI's local POST runs under node)"; exit 1; }

TOKEN="spr_abcdefghijklmnopqrstuvwxyz234567abcd"
NONCE="$(printf '%s' "synap-registration:$TOKEN" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
D64() { printf "$1%.0s" $(seq 1 64); }
REL="main-1234567"; SHA="$(printf 'a%.0s' $(seq 1 40))"

# ── one fake server: release host + Control Plane + the pod's API ─────────────
mkdir -p "$TMP/srv/rel/$REL" "$TMP/bin"
cat > "$TMP/server.py" <<'PY'
import http.server, json, os, sys
D = sys.argv[1]
def rd(name, default=""):
    try: return open(os.path.join(D, name)).read().strip()
    except FileNotFoundError: return default
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/meta/ip": return self.send(200, "203.0.113.7", "text/plain")
        p = os.path.join(D, "srv", self.path.lstrip("/"))
        if os.path.isfile(p): return self.send(200, open(p, "rb").read(), "application/octet-stream")
        self.send(404, "{}")
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = self.rfile.read(n).decode()
        name = self.path.strip("/").replace("/", "_")
        rec = {"headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
        with open(os.path.join(D, "calls.log"), "a") as f: f.write(self.path + "\n")
        json.dump(rec, open(os.path.join(D, "req-" + name + ".json"), "w"))
        if self.path == "/pods/register":
            nf = rd("nonce-path")
            open(os.path.join(D, "nonce-seen"), "w").write(open(nf).read() if nf and os.path.exists(nf) else "")
            mode = rd("cp-mode", "200")
            if mode != "200": return self.send(int(mode), '{"error":"injected %s"}' % mode)
            return self.send(200, rd("cp-response.json"))
        if self.path.startswith("/pods/") and self.path.endswith("/keys/enroll"):
            mode = rd("enroll-mode", "200")
            if mode != "200": return self.send(int(mode), '{"error":"injected","code":"ENROLLMENT_CODE_INVALID"}')
            jwk = json.loads(body)["podPublicJwk"]
            return self.send(200, json.dumps({"podId": self.path.split("/")[2], "kid": "kid-" + jwk["x"][:8], "replaced": 0}))
        fail = rd("pod-fail")
        if fail and fail in self.path:
            os.remove(os.path.join(D, "pod-fail")); return self.send(500, '{"error":"injected pod failure"}')
        self.send(200, '{"ok":true}')
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(os.path.join(D, "port"), "w").write(str(s.server_address[1]))
s.serve_forever()
PY
python3 "$TMP/server.py" "$TMP" & SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT="$(cat "$TMP/port" 2>/dev/null)"
[ -n "$PORT" ] && ok "fake server up on :$PORT" || { bad "fake server did not start"; exit 1; }
BASE="http://127.0.0.1:$PORT"

# ── release manifest: every compose image pinned by digest ─────────────────────
KEYS="$(grep -oE '\$\{SYNAP_IMAGE_[A-Z0-9_]+' "$HERE/deploy/docker-compose.yml" | sed 's/^\${//' | sort -u)"
images="{}"; for k in $KEYS; do images="$(jq -c --arg k "$k" --arg v "ghcr.io/x/$(echo "$k" | tr 'A-Z_' 'a-z-')@sha256:$(D64 c)" '. + {($k): $v}' <<<"$images")"; done
jq -n --arg id "$REL" --arg sha "$SHA" --argjson images "$images" --arg compose "sha256:$(D64 e)" \
  '{schema:1, id:$id, channel:"fast", gitSha:$sha, createdAt:"2026-10-13T00:00:00Z", images:$images,
    migrations:{last:"0001_x.sql", count:1}, composeSha:$compose, minFrom:null, bundle:null}' > "$TMP/srv/rel/$REL/release.json"

# ── fake docker ───────────────────────────────────────────────────────────────
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
F="$FAKE"; echo "$*" >> "$F/docker.log"
case "$*" in
  "compose ps -q backend"*) [ -f "$F/up" ] && echo be1; exit 0 ;;
  "compose ps"*postgres*) [ -f "$F/up" ] && echo pg1; exit 0 ;;
  "compose ps"*) exit 0 ;;
  "compose exec -T postgres psql"*federationOidcClient*) echo "pod-client-1|pod-secret-1|https://cp.test"; exit 0 ;;
  "compose exec -T postgres psql"*) cat >/dev/null 2>&1; echo 1; exit 0 ;;
  "compose run --rm --no-deps -T --user 0:0 --entrypoint node "*)
    # The CLI's real key script, on this host, against the host side of the -v mount.
    [ -f "$F/podkey-fail" ] && exit 1
    shift 9; host="${2%%:*}"
    while [ "$1" != backend ]; do shift; done; shift
    SYNAP_PODKEY_DIR="$host" SYNAP_PODKEY_UID=10001 exec node -e "$2" ;;
  "compose run --rm kratos-migrate"*) [ -f "$F/migrate-fail" ] && exit 1; exit 0 ;;
  "compose"*" up "*) : > "$F/up"; exit 0 ;;
  "compose"*) exit 0 ;;
  "exec "*" node -e "*SYNAP_REG_POD*)
    # The CLI's real registration script, run on this host (env is inherited exactly as
    # `docker exec -e NAME` would pass it).
    # (cwd is the deploy dir: remember the token the pod holds at the owner step.)
    [ -f "$F/token-at-bootstrap" ] || grep '^PROVISIONING_TOKEN=' .env 2>/dev/null | cut -d= -f2- > "$F/token-at-bootstrap"
    shift; while [ "$1" != node ]; do shift; done; shift
    exec node "$@" ;;
  "exec "*" node -e "*) exit 0 ;;   # health / canary probes: the pod is healthy
  "inspect -f {{.State.Running}} pg1") echo true; exit 0 ;;
  "inspect -f {{range .Config.Env}}"*) echo "PGDATA=/home/postgres/pgdata/data"; exit 0 ;;
  "inspect -f {{range .Mounts}}"*) echo "/home/postgres/pgdata"; exit 0 ;;
  "inspect"*) exit 0 ;;
  "image inspect "*) exit 1 ;;
  "pull "*) exit 0 ;;
  "ps --filter publish"*) exit 0 ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker"

cp_response() { # <oidc-json|null> <intelligence-json|null> [managed|self-hosted — omitted = a CP that predates deploymentMode]
  jq -n --arg cp "$BASE" --argjson oidc "$1" --argjson intel "$2" --arg mode "${3:-}" \
    '{podId:"pod_123", controlPlaneUrl:"https://cp.synap.test", issuer:"https://cp.synap.test",
      ownerAssertion:"eyJowner.assertion.jwt", oidc:$oidc, intelligence:$intel, catalogUrl:"https://cp.synap.test/catalog"}
     + (if $mode == "" then {} else {deploymentMode: $mode} end)' \
    > "$TMP/cp-response.json"
}
OIDC='{"assertion":"eyJoidc.push.jwt","clientId":"ignored"}'
INTEL='{"url":"https://intelligence.synap.live","apiKey":"shub_secret_key","provisionToken":"eyJprovision.jwt"}'

# setup <name> — a fresh host: an unpacked bundle (synap + deploy/ + kratos/)
setup() {
  S="$TMP/$1"; ROOT="$S/opt"; DEPLOY="$ROOT/deploy"; FAKE="$S/fake"
  mkdir -p "$DEPLOY" "$FAKE"
  cp "$HERE/synap" "$ROOT/synap"
  cp "$HERE/deploy/"*.sh "$HERE/deploy/env.schema" "$HERE/deploy/docker-compose.yml" "$HERE/deploy/Caddyfile" "$DEPLOY/"
  cp -R "$HERE/kratos" "$ROOT/kratos"
  rm -f "$TMP"/req-*.json "$TMP/calls.log" "$TMP/nonce-seen" "$TMP/pod-fail"
  echo 200 > "$TMP/cp-mode"
  echo "$DEPLOY/state/registration-nonce/nonce.json" > "$TMP/nonce-path"
  export FAKE
}
run_install() { # <args...>
  ( cd "$ROOT" || exit; PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_RELEASE_BASE_URL="$BASE/rel" \
    SYNAP_LOCAL_POD_URL="$BASE" SYNAP_METADATA_IP_URL="$BASE/meta/ip" \
    SYNAP_HEALTH_INTERVAL=0 SYNAP_REGISTER_RETRY_SECONDS=0 SYNAP_REGISTER_HEALTH_TRIES=2 \
    bash "$ROOT/synap" install "$@" ) >"$S/out" 2>&1 </dev/null
}
env_of() { grep "^$1=" "$DEPLOY/.env" | tail -1 | cut -d= -f2-; }
req()    { jq -r "$2" "$TMP/req-$1.json" 2>/dev/null; }
show()   { echo "      --- tail of output ---"; tail -15 "$S/out" | sed 's/^/      /'; }
REG=(--non-interactive --release "$REL" --name lab1 --register-token "$TOKEN" --control-plane "$BASE")

# ── flags: refused before anything runs ───────────────────────────────────────
setup flags
refuse() { # <label> <expected message fragment> <args...>
  local label="$1" msg="$2"; shift 2
  : > "$FAKE/docker.log"
  run_install "$@"; local rc=$?
  if [ "$rc" != 0 ] && grep -q -- "$msg" "$S/out" && ! grep -qE '^compose .*(up|run) ' "$FAKE/docker.log"; then
    ok "flags: $label → refused, nothing started"
  else bad "flags: $label (rc=$rc)"; show; fi
}
refuse "bad --name"              "must be a DNS label"     --non-interactive --name "Lab_1" --register-token "$TOKEN"
refuse "malformed code"          "registration code"       --non-interactive --name lab1 --register-token "abc"
refuse "code not CP-shaped"      "registration code"       --non-interactive --name lab1 --register-token "spr_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCD"
refuse "code without --name"     "needs --name"            --non-interactive --domain pod.x.example --register-token "$TOKEN"
refuse "code + preseed admin"    "exclusive"               "${REG[@]}" --admin-email a@b.c --admin-password pw
refuse "--edge tunnel no token"  "needs --tunnel-token"    --non-interactive --name lab1 --edge tunnel
refuse "plain-http CP"           "must be an https URL"    --non-interactive --name lab1 --register-token "$TOKEN" --control-plane http://cp.example.com
refuse "--control-plane alone"   "only applies with"       --non-interactive --name lab1 --control-plane https://cp.example.com
refuse "unknown edge"            "--edge must be"          --non-interactive --name lab1 --edge nginx
refuse "a zone as --domain"      "is not a pod's address"  --non-interactive --domain pod.synap.live
refuse "a console as --domain"   "is not a pod's address"  --non-interactive --domain admin.lab1.pod.synap.live

# ── plain: unattended, no code (a self-hoster's non-interactive run) ─────────
setup plain
run_install --non-interactive --release "$REL" --domain pod.example.org --email ops@example.org; rc=$?
[ "$rc" = 0 ] && [ "$(env_of ADMIN_BOOTSTRAP_MODE)" = token ] && [ -n "$(env_of ADMIN_BOOTSTRAP_TOKEN)" ] \
  && ok "plain: no admin flags → token bootstrap (no preseed error, no prompt)" || { bad "plain: rc=$rc mode=$(env_of ADMIN_BOOTSTRAP_MODE)"; show; }
[ "$(env_of POD_ADMIN_DOMAIN)" = "pod-admin.example.org" ] && [ -n "$(env_of VAULT_SERVER_KEY)" ] \
  && ok "plain: derived admin host + compose-required VAULT_SERVER_KEY" || bad "plain: POD_ADMIN_DOMAIN=$(env_of POD_ADMIN_DOMAIN)"
[ ! -s "$TMP/calls.log" ] && [ -z "$(env_of CONTROL_PLANE_URL)" ] && ok "plain: no Control Plane contacted, no trust written" || bad "plain: CP contacted"
[ -n "$(env_of PROVISIONING_TOKEN)" ] && [ ! -e "$DEPLOY/state/bootstrap-token.retired" ] \
  && ok "plain: no owner yet → PROVISIONING_TOKEN stays (the magic-link door needs it)" || bad "plain: token retired before any owner exists"
[ -s "$DEPLOY/state/pod-identity/pod-key.pem" ] && [ "$(jq -r .crv "$DEPLOY/state/pod-identity.pub.json")" = P-256 ] \
  && ok "plain: an unregistered pod gets its own identity key too" || bad "plain: no pod identity key"
run_install --non-interactive --release "$REL"; rc=$?
[ "$rc" = 0 ] && [ "$(env_of DOMAIN)" = "pod.example.org" ] && ok "plain: a flagless re-run takes every value from the existing .env" || { bad "plain: rerun rc=$rc"; show; }

# ── a failed migration aborts, never prompts "Continue anyway?" ───────────────
setup migrate; : > "$FAKE/migrate-fail"
run_install --non-interactive --release "$REL" --domain pod.example.org --email ops@example.org; rc=$?
[ "$rc" != 0 ] && grep -q 'Aborting in non-interactive mode' "$S/out" && ! grep -q 'Continue anyway' "$S/out" \
  && ok "migrate: --non-interactive alone turns a failed migration into an abort (no prompt)" || { bad "migrate: rc=$rc"; show; }

# ── happy: unattended, registered ─────────────────────────────────────────────
setup happy; cp_response "$OIDC" "$INTEL"
run_install "${REG[@]}"; rc=$?
[ "$rc" = 0 ] && ok "happy: install --non-interactive --register-token succeeded (stdin /dev/null)" || { bad "happy: rc=$rc"; show; }
[ "$(env_of DOMAIN)" = "lab1.pod.synap.live" ] && [ "$(env_of POD_ADMIN_DOMAIN)" = "admin.lab1.pod.synap.live" ] \
  && ok "happy: --name → lab1.pod.synap.live + admin.lab1.pod.synap.live" || bad "happy: domains $(env_of DOMAIN) / $(env_of POD_ADMIN_DOMAIN)"
[ "$(env_of ADMIN_BOOTSTRAP_MODE)" = token ] && ok "happy: admin bootstrap = token (never open /registration)" || bad "happy: ADMIN_BOOTSTRAP_MODE=$(env_of ADMIN_BOOTSTRAP_MODE)"
[ "$(env_of LETSENCRYPT_EMAIL)" = "ops@synap.live" ] && ok "happy: ACME contact defaults for a registered pod" || bad "happy: LETSENCRYPT_EMAIL=$(env_of LETSENCRYPT_EMAIL)"
[ -n "$(env_of VAULT_SERVER_KEY)" ] && [ -n "$(env_of HUB_JWT_SECRET)" ] && ok "happy: VAULT_SERVER_KEY (compose-required) + hub secrets generated" || bad "happy: VAULT_SERVER_KEY/HUB_JWT_SECRET missing"
[ "$(env_of SYNAP_RELEASE_ID)" = "$REL" ] && ok "happy: release block pinned to $REL" || bad "happy: SYNAP_RELEASE_ID=$(env_of SYNAP_RELEASE_ID)"
# the register request
[ "$(req pods_register '.body|fromjson|.token')" = "$TOKEN" ] && [ "$(req pods_register '.body|fromjson|.name')" = lab1 ] \
  && ok "happy: CP got the code + name" || bad "happy: register body $(req pods_register .body)"
[ "$(req pods_register '.body|fromjson|.podUrl')" = "https://lab1.pod.synap.live" ] && [ "$(req pods_register '.body|fromjson|.adminUrl')" = "https://admin.lab1.pod.synap.live" ] \
  && ok "happy: CP got podUrl + adminUrl" || bad "happy: urls $(req pods_register '.body|fromjson|[.podUrl,.adminUrl]')"
[ "$(req pods_register '.body|fromjson|.release')" = "$REL" ] && [ "$(req pods_register '.body|fromjson|.serverIp')" = 203.0.113.7 ] \
  && req pods_register '.body|fromjson|.installerVersion' | grep -qE '^synap-cli@[0-9a-f]{12}$' \
  && ok "happy: CP got release, serverIp, installerVersion" || bad "happy: release/serverIp/installerVersion $(req pods_register .body)"
[ "$(req pods_register '.body|fromjson|.podPublicJwk|[.kty,.crv]|join(" ")')" = "EC P-256" ] \
  && [ "$(req pods_register '.body|fromjson|.podPublicJwk|keys|join(",")')" = "crv,kty,x,y" ] \
  && [ "$(req pods_register '.body|fromjson|.podPublicJwk.x')" = "$(jq -r .x "$DEPLOY/state/pod-identity.pub.json")" ] \
  && ok "happy: §8 the register body carries the pod's PUBLIC JWK only (no d)" || bad "happy: podPublicJwk $(req pods_register '.body|fromjson|.podPublicJwk')"
KEYF="$DEPLOY/state/pod-identity/pod-key.pem"
[ "$(stat -c %a "$KEYF" 2>/dev/null || stat -f %Lp "$KEYF")" = 600 ] && grep -q 'BEGIN PRIVATE KEY' "$KEYF" \
  && [ "$(stat -c %a "$DEPLOY/state/pod-identity" 2>/dev/null || stat -f %Lp "$DEPLOY/state/pod-identity")" = 700 ] \
  && ok "happy: the private key is a 0600 file in a 0700 dir under state/ (not the DB)" || bad "happy: key file mode/contents"
grep -q 'PRIVATE KEY' "$TMP/req-pods_register.json" "$S/out" && bad "happy: private key material left the host / reached the log" || ok "happy: no private key material in the request or the log"
[ "$(cat "$TMP/nonce-seen")" = "{\"nonce\":\"$NONCE\"}" ] && ok "happy: the nonce (sha256 of synap-registration:<code>) was served DURING the call" || bad "happy: nonce during call: '$(cat "$TMP/nonce-seen")'"
[ ! -e "$DEPLOY/state/registration-nonce/nonce.json" ] && ok "happy: the nonce is gone after the call" || bad "happy: nonce still served"
# applied locally, in order, with the right secrets
order="$(grep -v '^/pods/register$' "$TMP/calls.log" | tr '\n' ' ')"
[ "$order" = "/api/federation/bootstrap /api/hub/federation/oidc-config /api/provision/register-intelligence " ] \
  && ok "happy: owner → oidc → AI applied in order" || bad "happy: pod call order: $order"
BT="$(cat "$FAKE/token-at-bootstrap" 2>/dev/null)"
[ -n "$BT" ] && [ "$(req api_federation_bootstrap '.headers["x-pod-bootstrap-token"]')" = "$BT" ] \
  && [ "$(req api_federation_bootstrap '.body|fromjson|.assertion')" = "eyJowner.assertion.jwt" ] \
  && ok "happy: bootstrap carries the pod's PROVISIONING_TOKEN + the owner assertion" || bad "happy: bootstrap request (token $([ -n "$BT" ] && echo held || echo missing), assertion $(req api_federation_bootstrap '.body|fromjson|.assertion'))"
# D9: bootstrap-only — once the owner exists the token leaves .env (and stays out).
[ -z "$(env_of PROVISIONING_TOKEN)" ] && ! grep -q '^PROVISIONING_TOKEN=' "$DEPLOY/.env" && [ -f "$DEPLOY/state/bootstrap-token.retired" ] \
  && ok "happy: PROVISIONING_TOKEN retired from .env after the owner step (marker written)" || bad "happy: PROVISIONING_TOKEN still in .env / no marker"
[ "$(env_of CONTROL_PLANE_URL)" = "https://cp.synap.test" ] && [ "$(grep -c '^PROVISIONING_TOKEN=' "$DEPLOY/.env")" = 0 ] \
  && ok "happy: the rest of .env survived the retirement" || bad "happy: .env damaged by the retirement"
[ "$(req api_hub_federation_oidc-config '.body|fromjson|.assertion')" = "eyJoidc.push.jwt" ] \
  && ok "happy: oidc-config got the signed assertion" || bad "happy: oidc request $(cat "$TMP/req-api_hub_federation_oidc-config.json" 2>/dev/null)"
[ "$(req api_provision_register-intelligence '.headers.authorization')" = "Bearer eyJprovision.jwt" ] \
  && [ "$(req api_provision_register-intelligence '.body|fromjson|.serviceApiKey')" = shub_secret_key ] \
  && [ "$(req api_provision_register-intelligence '.body|fromjson|.serviceUrl')" = https://intelligence.synap.live ] \
  && ok "happy: register-intelligence got Bearer provisionToken + {serviceApiKey, serviceUrl}" || bad "happy: AI request $(cat "$TMP/req-api_provision_register-intelligence.json" 2>/dev/null)"
[ "$(env_of CONTROL_PLANE_URL)" = "https://cp.synap.test" ] && ok "happy: CONTROL_PLANE_URL written from the response (trust opt-in)" || bad "happy: CONTROL_PLANE_URL=$(env_of CONTROL_PLANE_URL)"
grep -q 'compose up -d --no-deps --force-recreate backend realtime kratos' "$FAKE/docker.log" && ok "happy: backend/realtime/kratos recreated to read it" || bad "happy: no recreate after the trust write"
# W7-PODREG: a registered pod comes up with pod-agent (issuer = the response's CP issuer, audience = PUBLIC_URL).
[ "$(env_of SYNAP_WITH_POD_AGENT)" = 1 ] && [ "$(env_of POD_AGENT_ISSUER_URL)" = "https://cp.synap.test" ] \
  && [ "$(env_of POD_AGENT_AUDIENCE)" = "https://lab1.pod.synap.live" ] \
  && ok "happy: pod-agent trust written through the env door (issuer from the response, audience = the pod's public URL)" \
  || bad "happy: pod-agent env: $(env_of SYNAP_WITH_POD_AGENT) / $(env_of POD_AGENT_ISSUER_URL) / $(env_of POD_AGENT_AUDIENCE)"
grep -q 'compose --profile pod-agent up -d pod-agent' "$FAKE/docker.log" \
  && ok "happy: the pod-agent profile is enabled and the service started after registration" || bad "happy: pod-agent never started"
grep -q 'client_id: pod-client-1' "$ROOT/kratos/kratos.yml" 2>/dev/null && ok "happy: kratos.yml renders the stored OIDC client (no CP push)" || bad "happy: kratos.yml has no oidc client"
[ "$(jq -r .podId "$DEPLOY/state/registration.json" 2>/dev/null)" = pod_123 ] && ok "happy: state/registration.json records pod_123" || bad "happy: no registration record"
# R1-b: the CP holds the key now, so the backend must switch to signing (pod-cp-auth.ts reads this record).
ENR="$DEPLOY/state/pod-identity-enrollment.json"
[ "$(jq -r .podId "$ENR" 2>/dev/null)" = pod_123 ] && [ "$(jq -r .issuer "$ENR")" = https://cp.synap.test ] \
  && { ! command -v openssl >/dev/null || [ "$(jq -r .kid "$ENR" | tr -d '\n' | wc -c | tr -d ' ')" = 43 ]; } \
  && ok "happy: state/pod-identity-enrollment.json records pod_123 + the CP issuer + the key's kid" || bad "happy: no enrollment record: $(cat "$ENR" 2>/dev/null)"
if grep -rqE 'shub_secret_key|eyJowner|eyJprovision|eyJoidc|spr_' "$DEPLOY/state" 2>/dev/null; then bad "happy: a secret was left in state/"; else ok "happy: no secret left in state/"; fi
grep -q "$TOKEN" "$S/out" && bad "happy: the code was printed to the log" || ok "happy: the code never reaches the log"

# ── rerun: the code is never spent twice ──────────────────────────────────────
rm -f "$TMP/calls.log"
run_install "${REG[@]}"; rc=$?
[ "$rc" = 0 ] && ! grep -q '/pods/register' "$TMP/calls.log" 2>/dev/null && grep -q 'already registered as pod pod_123' "$S/out" \
  && ok "rerun: second install succeeds without calling the CP" || { bad "rerun: rc=$rc"; show; }

# ── podkey: the key is stable, its absence never spends the code ─────────────
before="$(shasum "$KEYF" 2>/dev/null | cut -d' ' -f1)"
( cd "$DEPLOY" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" bash "$ROOT/synap" pod-key ensure ) >"$S/out" 2>&1 </dev/null
[ "$(shasum "$KEYF" | cut -d' ' -f1)" = "$before" ] && ok "podkey: ensure keeps an existing key (idempotent)" || bad "podkey: ensure replaced the key"
podkey_enroll() { ( cd "$DEPLOY" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" bash "$ROOT/synap" pod-key enroll "$@" ) >"$S/out" 2>&1 </dev/null; }
podkey_enroll --pod-id pod-perso --code "$TOKEN" --control-plane "$BASE"; rc=$?
[ "$rc" = 0 ] && [ "$(req pods_pod-perso_keys_enroll '.body|fromjson|.token')" = "$TOKEN" ] \
  && [ "$(req pods_pod-perso_keys_enroll '.body|fromjson|.podPublicJwk|keys|join(",")')" = "crv,kty,x,y" ] \
  && [ "$(jq -r .podId "$DEPLOY/state/pod-identity-enrollment.json")" = pod-perso ] \
  && ok "podkey: enroll sends the code + PUBLIC JWK to /pods/<id>/keys/enroll and records the result" || { bad "podkey: enroll rc=$rc"; show; }
grep -q "$TOKEN" "$S/out" && bad "podkey: enroll printed the code" || ok "podkey: enroll never prints the code"
echo 401 > "$TMP/enroll-mode"; podkey_enroll --pod-id pod-perso --code "$TOKEN" --control-plane "$BASE"; rc=$?
[ "$rc" != 0 ] && grep -q 'ENROLLMENT_CODE_INVALID' "$S/out" && ok "podkey: a refused enrollment fails loudly with the CP's code" || { bad "podkey: refused enroll rc=$rc"; show; }
rm -f "$TMP/enroll-mode"
podkey_enroll --pod-id 'x;y' --code "$TOKEN"; [ $? != 0 ] && grep -q -- '--pod-id must be' "$S/out" && ok "podkey: a malformed --pod-id is refused before any call" || bad "podkey: bad pod id accepted"
setup nokey; cp_response "$OIDC" "$INTEL"; : > "$FAKE/podkey-fail"
run_install "${REG[@]}"; rc=$?
[ "$rc" != 0 ] && grep -q 'The code is still unused' "$S/out" && ! grep -q '/pods/register' "$TMP/calls.log" 2>/dev/null \
  && ok "podkey: no key → registration refused locally, the code is not spent" || { bad "podkey: nokey rc=$rc"; show; }

# ── refused: CP 401 ───────────────────────────────────────────────────────────
setup refused; cp_response "$OIDC" "$INTEL"; echo 401 > "$TMP/cp-mode"
run_install "${REG[@]}"; rc=$?
[ "$rc" != 0 ] && grep -q 'refused (bad, expired or already used)' "$S/out" && ok "refused: 401 fails the install loudly" || { bad "refused: rc=$rc"; show; }
[ "$(grep -c '/pods/register' "$TMP/calls.log")" = 1 ] && ok "refused: a 401 is not retried" || bad "refused: register called $(grep -c '/pods/register' "$TMP/calls.log") times"
grep -q '^/api/' "$TMP/calls.log" && bad "refused: a pod step ran after a refusal" || ok "refused: no pod step ran"
[ -z "$(env_of CONTROL_PLANE_URL)" ] && [ ! -e "$DEPLOY/state/registration-nonce/nonce.json" ] && ok "refused: no trust written, nonce removed" || bad "refused: CONTROL_PLANE_URL=$(env_of CONTROL_PLANE_URL)"

# ── partial AI bundle: loud, before any pod call ─────────────────────────────
setup partial; cp_response "$OIDC" '{"url":"https://intelligence.synap.live","apiKey":"k"}'
run_install "${REG[@]}"; rc=$?
[ "$rc" != 0 ] && grep -q 'apiKey/provisionToken is missing' "$S/out" && ! grep -q '^/api/' "$TMP/calls.log" \
  && ok "partial: intelligence.url without provisionToken → loud failure, nothing applied" || { bad "partial: rc=$rc"; show; }

# ── resume: a pod step fails after the CP said 200 ────────────────────────────
setup resume; cp_response "$OIDC" "$INTEL"; echo register-intelligence > "$TMP/pod-fail"
run_install "${REG[@]}"; rc=$?
[ "$rc" != 0 ] && grep -q 're-run the same command to retry' "$S/out" && [ -f "$DEPLOY/state/registration/response.json" ] \
  && [ "$(stat -c %a "$DEPLOY/state/registration/response.json" 2>/dev/null || stat -f %Lp "$DEPLOY/state/registration/response.json")" = 600 ] \
  && ok "resume: a failed step keeps the response (0600) and fails loudly" || { bad "resume: first run rc=$rc"; show; }
rm -f "$TMP/calls.log"
run_install "${REG[@]}"; rc=$?
[ "$rc" = 0 ] && ! grep -q '/pods/register' "$TMP/calls.log" && grep -q '/api/provision/register-intelligence' "$TMP/calls.log" \
  && [ ! -e "$DEPLOY/state/registration/response.json" ] && [ -f "$DEPLOY/state/registration.json" ] \
  && ok "resume: re-run re-applies from the kept response, CP not called, secrets removed" || { bad "resume: second run rc=$rc"; show; }
! grep -qE '/api/federation/bootstrap|/api/hub/federation/oidc-config' "$TMP/calls.log" \
  && ok "resume: steps that already succeeded (single-use owner assertion) are not replayed" || bad "resume: replayed $(tr '\n' ' ' < "$TMP/calls.log")"

# ── nulls: not entitled + no OIDC ─────────────────────────────────────────────
setup nulls; cp_response null null
run_install "${REG[@]}"; rc=$?
calls="$(grep -v '^/pods/register$' "$TMP/calls.log" | tr '\n' ' ')"
[ "$rc" = 0 ] && [ "$calls" = "/api/federation/bootstrap " ] && grep -q 'Synap sign-in stays off' "$S/out" && grep -q 'not included with this pod' "$S/out" \
  && ok "nulls: oidc + intelligence null → only the owner step, both named, success" || { bad "nulls: rc=$rc calls='$calls'"; show; }

# ── policy: the pod-agent's owner-consent file is seeded from deploymentMode ──
POLF="state/pod-agent-policy.json"
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
setup polmanaged; cp_response "$OIDC" "$INTEL" managed
run_install "${REG[@]}"; rc=$?
[ "$rc" = 0 ] && [ "$(jq -c . "$DEPLOY/$POLF" 2>/dev/null)" = '{"mode":"managed","archiveRecipients":[]}' ] && [ "$(mode_of "$DEPLOY/$POLF")" = 644 ] \
  && ok "policy: a managed registration writes mode=managed (0644)" || { bad "policy: managed rc=$rc file=$(cat "$DEPLOY/$POLF" 2>/dev/null)"; show; }
setup polself; cp_response "$OIDC" "$INTEL" self-hosted
run_install "${REG[@]}"; rc=$?
[ "$rc" = 0 ] && [ "$(jq -r .mode "$DEPLOY/$POLF" 2>/dev/null)" = self-hosted ] \
  && ok "policy: a self-hosted registration writes mode=self-hosted" || { bad "policy: self-hosted rc=$rc"; show; }
setup polkeep; cp_response "$OIDC" "$INTEL" managed
mkdir -p "$DEPLOY/state"; printf '%s\n' '{"mode":"self-hosted","archiveRecipients":["age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"],"refuse":["configure"]}' > "$DEPLOY/$POLF"
before="$(cat "$DEPLOY/$POLF")"
run_install "${REG[@]}"; rc=$?
[ "$rc" = 0 ] && [ "$(cat "$DEPLOY/$POLF")" = "$before" ] && grep -q 'kept as the owner left it' "$S/out" \
  && ok "policy: an existing owner file is untouched even when the CP says managed" || { bad "policy: existing file changed: $(cat "$DEPLOY/$POLF")"; show; }
setup polold; cp_response "$OIDC" "$INTEL"
run_install "${REG[@]}"; rc=$?
[ "$rc" = 0 ] && [ ! -e "$DEPLOY/$POLF" ] && grep -q 'did not say whether this pod is managed' "$S/out" \
  && ok "policy: a CP that predates deploymentMode → no file, named in the output, install succeeds" || { bad "policy: old CP rc=$rc"; show; }
setup polbad; cp_response "$OIDC" "$INTEL" mangaged
run_install "${REG[@]}"; rc=$?
[ "$rc" = 0 ] && [ ! -e "$DEPLOY/$POLF" ] && ok "policy: an unknown deploymentMode value writes nothing" || { bad "policy: bad mode rc=$rc"; show; }

# ── install.sh: the bootstrapper ──────────────────────────────────────────────
B="$TMP/boot"; mkdir -p "$B/bundle/deploy" "$B/bin" "$B/fake"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$PWD" "SYNAP_DEPLOY_DIR=$SYNAP_DEPLOY_DIR" "$@" > "%s/fake/exec-args"\n' "$B" > "$B/bundle/synap"
cp "$HERE/deploy/docker-compose.yml" "$B/bundle/deploy/"
BREL="v9.9.9"; mkdir -p "$TMP/srv/rel/$BREL" "$TMP/srv/rel/channel-stable"
tar -czf "$TMP/srv/rel/$BREL/synap-deploy-$BREL.tar.gz" -C "$B/bundle" .
bsha="$( { sha256sum "$TMP/srv/rel/$BREL/synap-deploy-$BREL.tar.gz" 2>/dev/null || shasum -a 256 "$TMP/srv/rel/$BREL/synap-deploy-$BREL.tar.gz"; } | cut -d' ' -f1)"
jq -n --arg id "$BREL" --arg s "$bsha" '{id:$id, bundle:{asset:("synap-deploy-"+$id+".tar.gz"), sha256:$s}}' > "$TMP/srv/rel/channel-stable/release.json"
cp "$TMP/srv/rel/channel-stable/release.json" "$TMP/srv/rel/$BREL/release.json"
boot() { # <dir> <args...>
  local d="$1"; shift
  PATH="$TMP/bin:$PATH" SYNAP_RELEASE_BASE_URL="$BASE/rel" SYNAP_DIR="$d" SYNAP_BIN_DIR="$B/bin" \
    bash "$HERE/install.sh" "$@" >"$B/out" 2>&1 </dev/null
}
for retired in "--provisioning-token x" "--control-plane-url https://cp" "--backend-version v1" "--token x"; do
  # shellcheck disable=SC2086
  boot "$B/r" $retired; rc=$?
  [ "$rc" != 0 ] && grep -q 'register-token\|--release' "$B/out" && [ ! -e "$B/r" ] \
    && ok "bootstrap: '$retired' refused with the new spelling, nothing written" || { bad "bootstrap: '$retired' rc=$rc"; cat "$B/out"; }
done
boot "$B/r" --release main; [ $? != 0 ] && grep -q "'main' is not a release" "$B/out" && ok "bootstrap: --release main refused" || bad "bootstrap: --release main accepted"
cp "$TMP/srv/rel/$BREL/release.json" "$B/good.json"
jq '.bundle.sha256 = "'"$(D64 0)"'"' "$B/good.json" > "$TMP/srv/rel/$BREL/release.json"
boot "$B/bad" --release "$BREL" --name lab1; rc=$?
[ "$rc" != 0 ] && grep -q 'sha256 mismatch' "$B/out" && [ ! -e "$B/bad/synap" ] && ok "bootstrap: a bundle whose sha256 differs is refused, nothing unpacked" || { bad "bootstrap: sha mismatch rc=$rc"; cat "$B/out"; }
cp "$B/good.json" "$TMP/srv/rel/$BREL/release.json"
boot "$B/opt" --name lab1 --register-token "$TOKEN" --edge caddy; rc=$?
expected="$(printf '%s\n' "$B/opt" "SYNAP_DEPLOY_DIR=$B/opt/deploy" install --non-interactive --release "$BREL" --name lab1 --register-token "$TOKEN" --edge caddy)"
[ "$rc" = 0 ] && [ "$(cat "$B/fake/exec-args" 2>/dev/null)" = "$expected" ] \
  && ok "bootstrap: stable → $BREL, unpacked, execs synap install --non-interactive --release $BREL + the flags" || { bad "bootstrap: rc=$rc"; cat "$B/out"; diff <(echo "$expected") "$B/fake/exec-args"; }
[ "$(readlink "$B/bin/synap")" = "$B/opt/synap" ] && ok "bootstrap: the CLI is linked onto PATH (operators find it)" || bad "bootstrap: $B/bin/synap → $(readlink "$B/bin/synap")"
grep -q "$TOKEN" "$B/out" && bad "bootstrap: the code was printed" || ok "bootstrap: the code is never printed"

exit $fail
