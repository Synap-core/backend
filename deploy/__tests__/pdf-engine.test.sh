#!/usr/bin/env bash
# The PDF tools engine (pod session 8d23e259), the deploy half: one switch,
# SYNAP_PDF_ENGINE in deploy/.env, OFF by default.
#
# Proves, on the PARSED compose file and the REAL `synap` functions (fake
# `docker` on PATH, every call logged):
#   R. the switch means the same thing to compose and to `synap`: for every
#      value ("", 1, 0, true) the backend's STIRLING_URL resolves to the
#      engine exactly when pdf_engine_enabled is true; off = "" (the pdf.*
#      verbs then say the engine is off). A STIRLING_URL set by hand wins.
#   S. stirling-pdf: profile `pdf` only (never started by a plain `up`), a
#      literal image pin, no published port, a memory limit, the sandbox
#      label, alone on `pdf-engine` (internal: no egress), and every service
#      that reads STIRLING_URL (the backend-env anchor) is on it.
#   C. pdf_engine_converge: off and no engine → no change; off with a
#      leftover engine → removed; on → started with --no-deps; a failed start
#      is NOT fatal (returns 0: an engine never fails an install or update).
#   W. install, update and apply each call pdf_engine_converge.
#
# NOT covered: what a real Docker does with the profile (the fake logs calls),
# whether the pinned digest resolves (image-pins.test.sh checks its shape;
# the image workflow's smoke test checks the engine), the network rules
# themselves (network-split.test.sh).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${PDF_ENGINE_COMPOSE_FILE:-$HERE/deploy/docker-compose.yml}"
SYNAP="${PDF_ENGINE_SYNAP:-$HERE/synap}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# ── the real functions, extracted from synap ─────────────────────────────────
fn() { awk -v n="$1" '$0 ~ "^"n"\\(\\) *\\{" { p = 1 } p { print } p && /^}$/ { exit }' "$SYNAP"; }
oneline() { grep -E "^$1\(\) *\{.*\}$" "$SYNAP"; }
src="$(fn _pod_agent_setting; oneline pdf_engine_enabled; fn pdf_engine_converge)"
eval "$src" || bad "extract: the functions extracted from synap do not parse"
for f in _pod_agent_setting pdf_engine_enabled pdf_engine_converge; do
  declare -F "$f" >/dev/null && ok "extract: $f loaded from synap" || bad "extract: $f not loaded from synap — the test is blind"
done
BLUE=""; YELLOW=""; NC=""

# ── R. the switch: compose and synap agree ───────────────────────────────────
url_for() { # <engine value or __unset__> [hand-set STIRLING_URL] → backend's STIRLING_URL
  python3 - "$COMPOSE" "$1" "${2:-}" <<'PY'
import re, sys, yaml
compose, val, hand = sys.argv[1], sys.argv[2], sys.argv[3]
env = {} if val == "__unset__" else {"SYNAP_PDF_ENGINE": val}
if hand: env["STIRLING_URL"] = hand
raw = (yaml.safe_load(open(compose))["services"]["backend"].get("environment") or {}).get("STIRLING_URL")
if raw is None: print("<absent>"); sys.exit()
VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:[+-])((?:[^{}]|\$\{[^{}]*\})*))?\}")
def sub(m):
    var, op, arg = m.group(1), m.group(2), m.group(3) or ""
    v = env.get(var, "")
    if op == ":+": return expand(arg) if v else ""
    if op == ":-": return v or expand(arg)
    return v
def expand(s): return VAR.sub(sub, s)
print(expand(str(raw)) or "<empty>")
PY
}
cd "$TMP"
for v in __unset__ "" 1 0 true; do
  rm -f .env; unset SYNAP_PDF_ENGINE
  [ "$v" = __unset__ ] || printf 'SYNAP_PDF_ENGINE=%s\n' "$v" > .env
  u="$(url_for "$v")"
  if pdf_engine_enabled; then on=1; else on=0; fi
  if { [ "$on" = 1 ] && [ "$u" = http://stirling-pdf:8080 ]; } || { [ "$on" = 0 ] && [ "$u" = "<empty>" ]; }; then
    ok "R: SYNAP_PDF_ENGINE=${v} → STIRLING_URL '${u}', synap starts the engine: ${on}"
  else
    bad "R: SYNAP_PDF_ENGINE=${v} → STIRLING_URL '${u}' but pdf_engine_enabled=${on}"
  fi
done
u="$(url_for 1 http://mac.lan:8080)"
[ "$u" = http://mac.lan:8080 ] && ok "R: a STIRLING_URL set by hand wins over the pod's engine" || bad "R: hand-set STIRLING_URL → '${u}'"
rm -f .env

# ── S. the stirling-pdf service ──────────────────────────────────────────────
python3 - "$COMPOSE" <<'PY' && ok "S: stirling-pdf = profile pdf, pinned, no port, mem limit, sandbox, alone on internal pdf-engine with every STIRLING_URL reader" || fail=1
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1])); svcs = doc["services"]; errs = []
s = svcs.get("stirling-pdf")
if not s: print("FAIL - S: no stirling-pdf service"); sys.exit(1)
if s.get("profiles") != ["pdf"]: errs.append(f"profiles {s.get('profiles')} (want ['pdf'] only)")
if "@sha256:" not in str(s.get("image", "")): errs.append("image is not pinned by digest")
if s.get("ports"): errs.append(f"publishes ports {s.get('ports')} (it has no auth)")
if not s.get("mem_limit"): errs.append("no mem_limit")
if (s.get("labels") or {}).get("synap.network.zone") != "sandbox": errs.append("not labelled synap.network.zone=sandbox")
if (s.get("networks") or []) != ["pdf-engine"]: errs.append(f"networks {s.get('networks')} (want ['pdf-engine'] only)")
net = (doc.get("networks") or {}).get("pdf-engine") or {}
if net.get("internal") is not True: errs.append("network pdf-engine is not internal: true")
readers = [n for n, v in svcs.items() if "STIRLING_URL" in (v.get("environment") or {})]
if not {"backend", "backend-worker", "backend-canary"} <= set(readers):
    errs.append(f"STIRLING_URL readers {sorted(readers)} miss backend/backend-worker/backend-canary")
for n in readers:
    if "pdf-engine" not in (svcs[n].get("networks") or []): errs.append(f"{n} reads STIRLING_URL but is not on pdf-engine")
for e in errs: print("FAIL - S: " + e)
sys.exit(1 if errs else 0)
PY

# ── C. pdf_engine_converge ───────────────────────────────────────────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *"ps -a -q stirling-pdf"*) [ -n "${FAKE_ENGINE:-}" ] && echo cid-engine ;;
  *" up "*) [ -n "${FAKE_UP_FAILS:-}" ] && exit 1 ;;
esac
exit 0
D
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/log"
converge() { : > "$FAKE_LOG"; pdf_engine_converge >/dev/null 2>&1; }
rm -f .env
FAKE_ENGINE="" converge
! grep -qE " up | rm " "$FAKE_LOG" && ok "C: off, no engine → nothing started or removed" || bad "C: off, no engine → $(cat "$FAKE_LOG")"
FAKE_ENGINE=1 converge
grep -qx "compose --profile pdf rm -sf stirling-pdf" "$FAKE_LOG" && ! grep -q " up " "$FAKE_LOG" \
  && ok "C: off, a leftover engine → removed" || bad "C: off with an engine → $(cat "$FAKE_LOG")"
echo SYNAP_PDF_ENGINE=1 > .env
FAKE_ENGINE="" converge
grep -qx "compose --profile pdf up -d --no-deps stirling-pdf" "$FAKE_LOG" && ! grep -q " rm " "$FAKE_LOG" \
  && ok "C: on → stirling-pdf started (--no-deps)" || bad "C: on → $(cat "$FAKE_LOG")"
FAKE_UP_FAILS=1 converge && ok "C: on, the engine fails to start → not fatal (returns 0)" || bad "C: a failed engine start returned non-zero (it would fail an install or update)"
rm -f .env

# ── W. install, update and apply converge the engine ─────────────────────────
# Each caller is the function that already converges the job workers: the
# engine follows the same moments (install's bring-up, update's
# _ue_bring_up_rest, apply's recreate).
for caller in cmd_install _ue_bring_up_rest cmd_apply; do
  body="$(fn "$caller")"
  [ -n "$body" ] || { bad "W: $caller not found in synap — the test is blind"; continue; }
  grep -q "pdf_engine_converge" <<<"$body" && ok "W: $caller calls pdf_engine_converge" || bad "W: $caller never converges the engine"
done

exit "$fail"
