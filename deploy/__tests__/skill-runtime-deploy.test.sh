#!/usr/bin/env bash
# Tripwire: the code-skill runtime is operable on a deployed pod.
#
# 1. Every variable the runtime reads reaches the backend AND the canary.
#    The backend gets an explicit `environment:` map (x-backend-env), so a
#    variable missing there never reaches the container: `SKILL_RUNTIME=is`,
#    the only rollback, did nothing when set in deploy/.env. The set is DERIVED
#    from the runtime's own reads (`process.env.SKILL_*` and quoted "SKILL_*"
#    names in services/skills/runner/), never listed here.
# 2. The update gate refuses a backend whose code-skill runtime cannot start.
#    /health stays HTTP 200 then (skillRuntime.status "unavailable" is
#    body-only), so the probe `synap` runs in the canary must read the body. It
#    is run here for real, with node, against a local /health.
#
# CANNOT SEE: a variable read under another name pattern than the two above.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

RUNNER_DIR="$HERE/packages/api/src/services/skills/runner"
# Non-test sources only; read whole files so `intFromEnv(\n  "SKILL_…"` (as
# prettier wraps it) is still one match.
runner_src="$(find "$RUNNER_DIR" -name '*.ts' ! -name '*.test.ts')"
reads="$(perl -0777 -ne 'print "$1\n" while /process\.env\.(SKILL_[A-Z0-9_]+)/g; print "$1\n" while /intFromEnv\(\s*"(SKILL_[A-Z0-9_]+)"/g' $runner_src \
  | grep -v '^SKILL_RUNNER$' | sort -u)"
# SKILL_RUNNER (inline|process) is a dev/test switch, refused in production: not forwarded.
n="$(echo "$reads" | grep -c .)"
[ "$n" -ge 5 ] && echo "$reads" | grep -qx SKILL_RUNTIME && echo "$reads" | grep -qx SKILL_RUNNER_QUEUE_MAX && echo "$reads" | grep -qx SKILL_RUNNER_PER_REQUESTER_MAX \
  && ok "the runtime reads $n SKILL_* variables (derived; sees SKILL_RUNTIME and the wrapped SKILL_RUNNER_PER_REQUESTER_MAX)" \
  || bad "could not derive the runtime's variables (got: $(echo $reads))"

# (a heredoc inside $(…) does not parse in the macOS bash 3.2)
read -r -d '' MISSING_PY <<'PY'
import sys, yaml
env = (yaml.safe_load(open(sys.argv[1]))["services"][sys.argv[2]].get("environment") or {})
if isinstance(env, list):
    env = dict(e.split("=", 1) for e in env if "=" in e)
print(" ".join(k for k in sys.argv[3:] if not str(env.get(k, "")).startswith("${" + k)))
PY
for svc in backend backend-canary; do
  missing="$(python3 -c "$MISSING_PY" "$HERE/deploy/docker-compose.yml" "$svc" $reads)"
  [ -z "$missing" ] && ok "$svc receives every SKILL_* variable from deploy/.env" \
    || bad "$svc does not receive:$missing (set in deploy/.env, it would reach nothing)"
done

# ── 2. the health probe ───────────────────────────────────────────────────────
probe_line="$(grep -E '^_BACKEND_HEALTH_PROBE=' "$HERE/synap")"
[ -n "$probe_line" ] && ok "synap defines one backend health probe" || bad "synap: _BACKEND_HEALTH_PROBE not found"
eval "$probe_line"
uses="$(grep -cE '"\$_BACKEND_HEALTH_PROBE"' "$HERE/synap")"
inline="$(grep -cE "require\('http'\)\.get\('http://localhost:4000/health'" "$HERE/synap")"
[ "$uses" -ge 2 ] && [ "$inline" = 1 ] && ok "the canary and the update checks use it ($uses uses, no second probe)" \
  || bad "a backend health check bypasses the shared probe (uses=$uses, inline probes=$inline)"

command -v node >/dev/null 2>&1 || { echo "FAIL - node is required"; exit 1; }
TMP="$(mktemp -d)"; trap 'kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null; rm -rf "$TMP"' EXIT
cat > "$TMP/server.js" <<'JS'
const fs = require("fs");
const dir = process.argv[2];
const srv = require("http").createServer((req, res) => {
  const [code, body] = JSON.parse(fs.readFileSync(dir + "/answer", "utf8"));
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
});
srv.listen(0, "127.0.0.1", () => fs.writeFileSync(dir + "/port", String(srv.address().port)));
JS
node "$TMP/server.js" "$TMP" & srv=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
port="$(cat "$TMP/port" 2>/dev/null)"
[ -n "$port" ] || { echo "FAIL - the test /health server did not start"; exit 1; }
local_probe="${_BACKEND_HEALTH_PROBE//localhost:4000/127.0.0.1:$port}"
[ "$local_probe" != "$_BACKEND_HEALTH_PROBE" ] || bad "self-check: the probe's URL was not redirected to the test server"

# <expect pass|fail> <http code> <body> <label>
case_() {
  printf '%s' "$(python3 -c 'import json,sys; print(json.dumps([int(sys.argv[1]), sys.argv[2]]))' "$2" "$3")" > "$TMP/answer"
  local err rc
  err="$(node -e "$local_probe" 2>&1 >/dev/null)"; rc=$?
  if [ "$1" = pass ]; then [ "$rc" = 0 ] && ok "$4" || bad "$4 (rc=$rc: $err)"
  else [ "$rc" != 0 ] && ok "$4${err:+ — says: $err}" || bad "$4 (it passed)"; fi
}
case_ pass 200 '{"status":"ok","skillRuntime":{"runner":"process","status":"ready"}}' "a ready runtime passes"
case_ pass 200 '{"status":"ok","skillRuntime":{"runner":"process","status":"starting"}}' "a runtime still starting passes (the canary retries for 3 min)"
case_ pass 200 '{"status":"ok","skillRuntime":{"runner":"intelligence-service"}}' "the SKILL_RUNTIME=is rollback passes"
case_ pass 200 '{"status":"ok"}' "an older image without skillRuntime passes (a rollback target)"
case_ fail 200 '{"status":"ok","skillRuntime":{"runner":"process","status":"unavailable","reason":"isolated-vm could not be loaded"}}' "a runtime that cannot start FAILS the gate"
case_ fail 503 '{"status":"ok"}' "a non-200 fails"
case_ fail 200 'not json' "a body that is not JSON fails (unread is not healthy)"
printf '%s' '[200,"{\"skillRuntime\":{\"status\":\"unavailable\",\"reason\":\"no addon\"}}"]' > "$TMP/answer"
err="$(node -e "$local_probe" 2>&1 >/dev/null)"
echo "$err" | grep -q "no addon" && ok "the probe says why (the runtime's reason)" || bad "the probe's failure does not carry the reason: $err"

exit $fail
