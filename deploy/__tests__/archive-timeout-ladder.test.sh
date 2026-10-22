#!/usr/bin/env bash
# ============================================================================
# The pod archive's timeouts form a strictly nested ladder (inner < outer),
# every step derived from ONE constant in deploy/archive-limits.sh:
#   host unit TimeoutStartSec + TimeoutStopSec  <  archive-request.sh's wait
#   <  pod-agent's kill  <  the control plane's wait
# so a host that finishes in time beats every outer timer, and an overrun is
# recorded by the host unit itself (request-outcome.sh) before anyone outside
# gives up. Each value is read where it is USED, not from the constants file:
#   - the unit: rendered by the real `synap units install`;
#   - the wait: archive-request.sh run against a host that takes the request
#     and never answers (a no-op `sleep`, so the 57-minute wait passes at once),
#     its own "no outcome … within Ns" line;
#   - pod-agent: ARCHIVE_MAX_RUN_MS from archive-manifest.js (server.js runs
#     the archive command under it: archive-timeout.test.js);
#   - the control plane: its mirror in archive-limits.sh (the CP's
#     ARCHIVE_DEADLINE_MS, another repository).
# ============================================================================
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
num() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }

REPO="$TMP/repo"; DEPLOY="$REPO/deploy"; UNITS="$TMP/units"
mkdir -p "$DEPLOY/state/requests" "$REPO/kratos" "$TMP/run" "$UNITS" "$TMP/bin" "$TMP/fastbin"
cp "$HERE/synap" "$REPO/synap"
cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$DEPLOY/"
cp -R "$HERE/deploy/systemd" "$DEPLOY/systemd"
printf 'DOMAIN=pod.example.com\nCOMPOSE_PROJECT_NAME=synap-backend\nPOSTGRES_PASSWORD=x\nJWT_SECRET=x\nKRATOS_SECRETS_COOKIE=x\nPOD_ADMIN_DOMAIN=pod-admin.example.com\n' > "$DEPLOY/.env"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/systemctl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/docker"
chmod +x "$TMP/bin/systemctl" "$TMP/bin/docker"

# 1. the host unit, as `synap units install` renders it
( cd "$TMP" && PATH="$TMP/bin:$PATH" SYNAP_DEPLOY_DIR="$DEPLOY" SYNAP_SYSTEMD_RUN_DIR="$TMP/run" SYNAP_SYSTEMD_DIR="$UNITS" bash "$REPO/synap" units install ) >"$TMP/units.out" 2>&1 </dev/null \
  || bad "synap units install failed: $(tail -2 "$TMP/units.out")"
UNIT_START="$(sed -n 's/^TimeoutStartSec=//p' "$UNITS/synap-archive.service")"
UNIT_STOP="$(sed -n 's/^TimeoutStopSec=//p' "$UNITS/synap-archive.service")"
num "$UNIT_START" && num "$UNIT_STOP" && ! grep -q '@' "$UNITS/synap-archive.service" \
  && ok "the rendered unit carries numeric limits (start ${UNIT_START}s, stop ${UNIT_STOP}s), no placeholder left" \
  || bad "rendered unit limits: start='$UNIT_START' stop='$UNIT_STOP' placeholders: $(grep -c '@' "$UNITS/synap-archive.service")"

# 2. archive-request.sh's own wait: the host takes the request, never answers
cat > "$TMP/fastbin/sleep" <<S
#!/bin/sh
r="$DEPLOY/state/requests/archive.json"
[ -e "\$r" ] && mv -f "\$r" "$DEPLOY/state/requests/archive.taken.json"
exit 0
S
chmod +x "$TMP/fastbin/sleep"
( PATH="$TMP/fastbin:$PATH" ARCHIVE_AGE_RECIPIENTS="age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p" HOST_REQUEST_POLL_SECONDS=1 \
    sh "$DEPLOY/archive-request.sh" "https://upload.invalid/x" "" "" ) >"$TMP/agent.out" 2>&1 </dev/null
WAIT="$(sed -n 's/.*no outcome for request .* within \([0-9]*\)s.*/\1/p' "$TMP/agent.out" | tail -1)"
num "$WAIT" && ok "archive-request.sh waits ${WAIT}s for the host's outcome" \
  || bad "archive-request.sh wait not read: $(tail -3 "$TMP/agent.out")"

# 3. pod-agent's kill, 4. the control plane's wait (its mirror)
AGENT_MS="$(node -e 'process.stdout.write(String(require(process.argv[1]).ARCHIVE_MAX_RUN_MS))' "$HERE/deploy/pod-agent/archive-manifest.js" 2>/dev/null)"
num "$AGENT_MS" && AGENT=$((AGENT_MS / 1000)) || { bad "pod-agent ARCHIVE_MAX_RUN_MS not read: '$AGENT_MS'"; AGENT=""; }
CP="$(sh -c '. "$1"; echo "$ARCHIVE_CP_DEADLINE_SECONDS"' _ "$HERE/deploy/archive-limits.sh")"
MAX="$(sh -c '. "$1"; echo "$ARCHIVE_MAX_RUN_SECONDS"' _ "$HERE/deploy/archive-limits.sh")"
[ -n "$AGENT" ] && [ "$AGENT" = "$MAX" ] && ok "pod-agent's kill (${AGENT}s) is the ladder's constant ARCHIVE_MAX_RUN_SECONDS" \
  || bad "pod-agent's kill ${AGENT:-?}s ≠ ARCHIVE_MAX_RUN_SECONDS ${MAX}s"

# The ladder, strictly nested, from the values above.
if num "${UNIT_START:-}" && num "${UNIT_STOP:-}" && num "${WAIT:-}" && num "${AGENT:-}" && num "${CP:-}"; then
  [ $((UNIT_START + UNIT_STOP)) -lt "$WAIT" ] && ok "the unit's limit + stop window ($((UNIT_START + UNIT_STOP))s) < the request wait (${WAIT}s): an overrun is the unit's own outcome" \
    || bad "unit ${UNIT_START}s + stop ${UNIT_STOP}s is not below the request wait ${WAIT}s"
  [ "$WAIT" -lt "$AGENT" ] && ok "the request wait (${WAIT}s) < pod-agent's kill (${AGENT}s)" || bad "request wait ${WAIT}s is not below pod-agent's kill ${AGENT}s"
  [ "$AGENT" -lt "$CP" ] && ok "pod-agent's kill (${AGENT}s) < the control plane's wait (${CP}s)" || bad "pod-agent's kill ${AGENT}s is not below the CP wait ${CP}s"
else
  bad "the ladder could not be read whole: unit=${UNIT_START:-?}+${UNIT_STOP:-?} wait=${WAIT:-?} agent=${AGENT:-?} cp=${CP:-?}"
fi
exit $fail
