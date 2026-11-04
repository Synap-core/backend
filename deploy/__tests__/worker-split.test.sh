#!/usr/bin/env bash
# The job workers in their own process (pod resilience plan P6), the deploy
# half: one switch, SYNAP_SPLIT_WORKERS in deploy/.env, OFF by default.
#
# Proves, on the PARSED compose file and the REAL `synap` functions (fake
# `docker` on PATH, every call logged):
#   R. the switch means the same thing to compose and to `synap`: for every
#      value ("", 1, 0, true) backend's SYNAP_PROCESS_ROLE resolves to `api`
#      exactly when split_workers_enabled is true; unset = "" (= all). So
#      backend is never the API only while `synap` starts no worker.
#   W. backend-worker: the backend image with no `command` (the image CMD, the
#      same entry point), SYNAP_PROCESS_ROLE=worker, profile `workers` only
#      (never started by a plain `up`), its own application_name and explicit
#      pools, restart always, a /health healthcheck, the deploy dir read-only
#      and nothing writable, backend's networks. The canary sets no role (all).
#   C. split_workers_converge: off and no worker → no change; off with a
#      leftover worker → removed; on → started with --no-deps.
#   H. heal probes backend-worker by default (its /health reports eventLoop),
#      and the clean door may restart it (schema enum and _CLEAN_RESTARTABLE).
#
# NOT covered: what a real Docker does with the profile (the fake logs calls),
# cmd_install / cmd_update / cmd_apply end to end (they call the converge
# tested here; update-*.test.sh and config-door.test.sh run the real flows
# with the switch off), the pod's Postgres connections (pg-connection-budget).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${WORKER_SPLIT_COMPOSE_FILE:-$HERE/deploy/docker-compose.yml}"
SYNAP="${WORKER_SPLIT_SYNAP:-$HERE/synap}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# ── the real functions, extracted from synap ─────────────────────────────────
fn() { awk -v n="$1" '$0 ~ "^"n"\\(\\) *\\{" { p = 1 } p { print } p && /^}$/ { exit }' "$SYNAP"; }
oneline() { grep -E "^$1\(\) *\{.*\}$" "$SYNAP"; }
src="$(fn _pod_agent_setting; oneline split_workers_enabled; fn split_workers_converge; fn _heal_capped; fn _heal_json; fn _heal_probe)"
eval "$src" || bad "extract: the functions extracted from synap do not parse"
for f in _pod_agent_setting split_workers_enabled split_workers_converge _heal_probe; do
  declare -F "$f" >/dev/null && ok "extract: $f loaded from synap" || bad "extract: $f not loaded from synap — the test is blind"
done
BLUE=""; NC=""

# ── R. the switch: compose and synap agree ───────────────────────────────────
role_for() { # <value or __unset__> → backend's resolved SYNAP_PROCESS_ROLE
  python3 - "$COMPOSE" "$1" <<'PY'
import re, sys, yaml
compose, val = sys.argv[1], sys.argv[2]
env = {} if val == "__unset__" else {"SYNAP_SPLIT_WORKERS": val}
raw = (yaml.safe_load(open(compose))["services"]["backend"].get("environment") or {}).get("SYNAP_PROCESS_ROLE")
if raw is None: print("<absent>"); sys.exit()
def sub(m):
    var, op, arg = m.group(1), m.group(2), m.group(3) or ""
    v = env.get(var, "")
    if op == ":+": return arg if v else ""
    if op == ":-": return v or arg
    return v
print(re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(:[+-])?([^}]*)\}", sub, str(raw)) or "<empty>")
PY
}
cd "$TMP"
for v in __unset__ "" 1 0 true; do
  rm -f .env; unset SYNAP_SPLIT_WORKERS
  [ "$v" = __unset__ ] || printf 'SYNAP_SPLIT_WORKERS=%s\n' "$v" > .env
  r="$(role_for "$v")"
  if split_workers_enabled; then on=1; else on=0; fi
  if { [ "$on" = 1 ] && [ "$r" = api ]; } || { [ "$on" = 0 ] && [ "$r" = "<empty>" ]; }; then
    ok "R: SYNAP_SPLIT_WORKERS=${v} → backend role '${r}', synap starts a worker: ${on}"
  else
    bad "R: SYNAP_SPLIT_WORKERS=${v} → backend role '${r}' but split_workers_enabled=${on}"
  fi
done
rm -f .env

# ── W. the backend-worker service ────────────────────────────────────────────
python3 - "$COMPOSE" <<'PY' && ok "W: backend-worker = the backend image as role worker, profile workers, own pools, /health, read-only, backend's networks; canary runs all" || fail=1
import sys, yaml
svcs = yaml.safe_load(open(sys.argv[1]))["services"]
w, b, c = svcs.get("backend-worker"), svcs["backend"], svcs["backend-canary"]
errs = []
if not w: print("FAIL - W: no backend-worker service"); sys.exit(1)
env = w.get("environment") or {}
if w.get("image") != b.get("image"): errs.append("image differs from backend's")
if w.get("command") or w.get("entrypoint"): errs.append("sets a command/entrypoint (must run the image CMD)")
if env.get("SYNAP_PROCESS_ROLE") != "worker": errs.append(f"SYNAP_PROCESS_ROLE={env.get('SYNAP_PROCESS_ROLE')!r}")
if w.get("profiles") != ["workers"]: errs.append(f"profiles={w.get('profiles')!r} (must be exactly ['workers'])")
if "application_name=backend-worker" not in str(env.get("DATABASE_URL")): errs.append("DATABASE_URL does not name backend-worker")
for k in ("DB_POOL_SIZE", "PGBOSS_POOL_SIZE"):
    if k not in env: errs.append(f"no explicit {k}")
if w.get("restart") != "always": errs.append(f"restart={w.get('restart')!r}")
if "/health" not in str((w.get("healthcheck") or {}).get("test")): errs.append("healthcheck does not read /health")
vols = w.get("volumes") or []
if any(not str(v).endswith(":ro") for v in vols): errs.append(f"a writable volume: {vols}")
if sorted(w.get("networks") or []) != sorted(b.get("networks") or []): errs.append("networks differ from backend's")
if "SYNAP_PROCESS_ROLE" in (c.get("environment") or {}): errs.append("backend-canary sets a role (it validates the image as all)")
if b.get("profiles"): errs.append("backend is profile-gated")
for e in errs: print("FAIL - W: " + e)
sys.exit(1 if errs else 0)
PY

# ── C. split_workers_converge ────────────────────────────────────────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *"ps -a -q backend-worker"*) [ -n "${FAKE_WORKER:-}" ] && echo cid-worker ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/log"
converge() { : > "$FAKE_LOG"; split_workers_converge >/dev/null 2>&1; }
rm -f .env
FAKE_WORKER="" converge
! grep -qE " up | rm " "$FAKE_LOG" && ok "C: off, no worker → nothing started or removed" || bad "C: off, no worker → $(cat "$FAKE_LOG")"
FAKE_WORKER=1 converge
grep -qx "compose --profile workers rm -sf backend-worker" "$FAKE_LOG" && ! grep -q " up " "$FAKE_LOG" \
  && ok "C: off, a leftover worker → removed" || bad "C: off with a worker → $(cat "$FAKE_LOG")"
echo SYNAP_SPLIT_WORKERS=1 > .env
FAKE_WORKER="" converge
grep -qx "compose --profile workers up -d --no-deps backend-worker" "$FAKE_LOG" && ! grep -q " rm " "$FAKE_LOG" \
  && ok "C: on → backend-worker started (--no-deps)" || bad "C: on → $(cat "$FAKE_LOG")"
rm -f .env

# ── H. heal probes it, the clean door may restart it ─────────────────────────
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in *"exec -T backend-worker"*) echo '{"probe":"answered","httpStatus":503,"eventLoop":{"p99Ms":2400}}' ;; esac
exit 0
D
: > "$FAKE_LOG"
p="$(unset SYNAP_HEAL_PROBE_SERVICES; _heal_probe backend-worker)"
[ "$(jq -r '.probe + ":" + (.eventLoop.p99Ms | tostring)' <<<"$p" 2>/dev/null)" = "answered:2400" ] \
  && ok "H: heal probes backend-worker by default and reads its eventLoop" || bad "H: heal probe of backend-worker → $p"
restartable="$(grep -E '^_CLEAN_RESTARTABLE=' "$SYNAP")"
enum="$(jq -r '.properties.service.enum[]' "$HERE/deploy/schemas/clean-request.v1.schema.json")"
[[ "$restartable" == *" backend-worker "* ]] && grep -qx backend-worker <<<"$enum" \
  && ok "H: the clean door may restart backend-worker (synap and the request schema)" || bad "H: clean door: $restartable / $(echo $enum)"

exit "$fail"
