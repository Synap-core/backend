# shellcheck shell=sh
# ============================================================================
# The pod archive's timeouts: ONE constant, every limit derived, strictly
# nested (inner < outer). Sourced by `synap` (rendering synap-archive.service)
# and deploy/archive-request.sh; mirrored in pod-agent (ARCHIVE_MAX_RUN_MS,
# deploy/pod-agent/archive-manifest.js) and the control plane
# (ARCHIVE_MAX_RUN_MS / ARCHIVE_DEADLINE_MS, archive-manifest.ts).
#
#   1. the host unit (synap-archive.service): TimeoutStartSec, then its stop
#      window before ExecStopPost records the outcome      55 min + 1 min
#   2. archive-request.sh waits for that outcome            57 min
#   3. pod-agent kills archive-request.sh                   60 min
#   4. the control plane waits for the result               65 min
#
# A host that finishes in time beats every outer timer, and a host overrun is
# reported by its OWN unit first (request-outcome.sh: the precise reason),
# never as a pod-agent or control-plane timeout.
# deploy/__tests__/archive-timeout-ladder.test.sh asserts the order from the
# values each reader actually uses.
# ============================================================================
ARCHIVE_MAX_RUN_SECONDS=3600
ARCHIVE_UNIT_TIMEOUT_SECONDS=$((ARCHIVE_MAX_RUN_SECONDS - 180))
ARCHIVE_UNIT_STOP_SECONDS=60
ARCHIVE_REQUEST_WAIT_SECONDS=$((ARCHIVE_MAX_RUN_SECONDS - 300))
ARCHIVE_CP_DEADLINE_SECONDS=$((ARCHIVE_MAX_RUN_SECONDS + 300))
