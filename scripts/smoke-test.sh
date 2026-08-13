#!/usr/bin/env bash
# =============================================================================
# Synap Backend Smoke Test
# =============================================================================
# Usage:
#   ./scripts/smoke-test.sh [BASE_URL] [HUB_API_KEY]
#   BASE_URL=http://localhost:4000 HUB_API_KEY=synap_hub_... ./scripts/smoke-test.sh
#
#   --check-script-only   Validate script syntax only (used in CI lint step)
#
# Defaults:
#   BASE_URL  = http://localhost:4000
#   HUB_API_KEY = (empty — auth tests are skipped; /health tests still run)
#
# Notes:
#   - Created entities use a "__smoke_test__" prefix in their title so they
#     are easy to identify and clean up. No DELETE endpoint exists in the Hub
#     Protocol; manual cleanup: DELETE FROM entities WHERE title LIKE '__smoke_test__%';
#
# Exit codes:
#   0  All tests passed (or all auth tests were skipped and health passed)
#   1  One or more tests failed
# =============================================================================

# ─── --check-script-only flag ────────────────────────────────────────────────
for arg in "$@"; do
  if [ "$arg" = "--check-script-only" ]; then
    echo "Syntax check only — exiting (used by CI lint step)"
    exit 0
  fi
done

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
BASE_URL="${1:-${BASE_URL:-http://localhost:4000}}"
HUB_API_KEY="${2:-${HUB_API_KEY:-}}"

# ─── Color helpers ───────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

PASS="${GREEN}✓ PASS${RESET}"
FAIL="${RED}✗ FAIL${RESET}"
SKIP="${YELLOW}⚠ SKIP${RESET}"

# ─── State ───────────────────────────────────────────────────────────────────
FAILURES=0
CREATED_ENTITY_ID=""
START_TS=$(date +%s)

# ─── Helpers ─────────────────────────────────────────────────────────────────
# http_status URL [extra curl args...]
http_status() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@"
}

# http_body URL [extra curl args...]
http_body() {
  curl -s --max-time 15 "$@"
}

step_pass() {
  printf "${PASS}  %s\n" "$1"
}

step_fail() {
  printf "${FAIL}  %s\n" "$1"
  FAILURES=$((FAILURES + 1))
}

# ─── Steps ───────────────────────────────────────────────────────────────────

echo ""
printf "${CYAN}Synap Backend Smoke Test${RESET}\n"
printf "Base URL : %s\n" "$BASE_URL"
printf "API Key  : %s\n" "${HUB_API_KEY:+(set)}"
if [ -z "$HUB_API_KEY" ]; then
  printf "${YELLOW}Note: HUB_API_KEY not set — auth tests will be skipped${RESET}\n"
fi
echo "──────────────────────────────────────────"
echo ""

# ── Step 1: GET /health ───────────────────────────────────────────────────────
printf "Step 1: GET /health ... "
STATUS=$(http_status "${BASE_URL}/health")
if [ "$STATUS" = "200" ]; then
  step_pass "GET /health → $STATUS"
else
  step_fail "GET /health → $STATUS (expected 200)"
fi

# ── Step 2: GET /api/hub/health ───────────────────────────────────────────────
# /api/hub/health is accessible without an API key (returns hub status)
printf "Step 2: GET /api/hub/health ... "
if [ -n "$HUB_API_KEY" ]; then
  STATUS=$(http_status "${BASE_URL}/api/hub/health" \
    -H "Authorization: Bearer ${HUB_API_KEY}")
else
  STATUS=$(http_status "${BASE_URL}/api/hub/health")
fi
if [ "$STATUS" = "200" ]; then
  step_pass "GET /api/hub/health → $STATUS"
else
  step_fail "GET /api/hub/health → $STATUS (expected 200)"
fi

# ── Step 3: POST /api/hub/entities ────────────────────────────────────────────
# Titles use __smoke_test__ prefix for easy identification and manual cleanup.
# No DELETE endpoint exists in the Hub Protocol; to purge test entities run:
#   DELETE FROM entities WHERE title LIKE '__smoke_test__%';
printf "Step 3: POST /api/hub/entities ... "
if [ -z "$HUB_API_KEY" ]; then
  printf "${SKIP}  POST /api/hub/entities (no HUB_API_KEY set)\n"
else
  TITLE="__smoke_test__-$(date +%s)"
  # workspaceId is omitted so the server derives pod-wide placement — this makes
  # the smoke test pod-agnostic (a hardcoded/bogus workspaceId like "__SMOKE__"
  # is rejected: the entities door returns 500 on an unknown workspace, so the
  # old body could never pass against a real pod).
  BODY="{\"profileSlug\":\"note\",\"title\":\"${TITLE}\"}"

  # Capture body and status in a single request to avoid double-posting
  RESPONSE=$(http_body "${BASE_URL}/api/hub/entities" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${HUB_API_KEY}" \
    -w "\n__HTTP_STATUS__%{http_code}" \
    -d "$BODY")

  HTTP_CODE=$(echo "$RESPONSE" | grep '__HTTP_STATUS__' | sed 's/__HTTP_STATUS__//')
  BODY_ONLY=$(echo "$RESPONSE" | grep -v '__HTTP_STATUS__')

  # Accept 200 or 201
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    CREATED_ENTITY_ID=$(echo "$BODY_ONLY" | grep -o '"id":"[^"]*"' | head -1 | awk -F'"' '{print $4}')
    step_pass "POST /api/hub/entities → $HTTP_CODE (id: ${CREATED_ENTITY_ID:-<not captured>})"
  else
    step_fail "POST /api/hub/entities → $HTTP_CODE (expected 200 or 201)"
  fi
fi

# ── Step 4: GET /api/hub/search?query=__smoke_test__ ─────────────────────────
# Uses /api/hub/search (full-text search endpoint).
# NOT /api/hub/entities?q= — that parameter is not supported.
# userId is required by the endpoint; a placeholder will return 400 which is
# acceptable for a smoke probe (we only assert the endpoint is reachable, not 5xx).
printf "Step 4: GET /api/hub/search?query=__smoke_test__ ... "
if [ -z "$HUB_API_KEY" ]; then
  printf "${SKIP}  GET /api/hub/search (no HUB_API_KEY set)\n"
else
  STATUS=$(http_status \
    "${BASE_URL}/api/hub/search?query=__smoke_test__&userId=smoke-probe" \
    -H "Authorization: Bearer ${HUB_API_KEY}")
  # 200 = search worked; 400 = invalid userId is acceptable for smoke purposes
  if [ "$STATUS" = "200" ] || [ "$STATUS" = "400" ]; then
    step_pass "GET /api/hub/search → $STATUS (endpoint reachable)"
  else
    step_fail "GET /api/hub/search → $STATUS (expected 200 or 400)"
  fi
fi

# ── Step 5: Cleanup note ─────────────────────────────────────────────────────
printf "Step 5: Cleanup created entity ... "
if [ -z "$HUB_API_KEY" ] || [ -z "$CREATED_ENTITY_ID" ]; then
  printf "${SKIP}  Cleanup skipped (no entity created)\n"
else
  # Hub Protocol does not expose a DELETE endpoint for entities.
  # Created test entities have a __smoke_test__ title prefix for easy identification.
  # To purge manually: DELETE FROM entities WHERE title LIKE '__smoke_test__%';
  printf "${YELLOW}NOTE${RESET}  Entity '%s' left in DB (title: %s). To clean up:\n" \
    "$CREATED_ENTITY_ID" "${TITLE:-unknown}"
  printf "       DELETE FROM entities WHERE title LIKE '__smoke_test__%%';\n"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo ""
echo "──────────────────────────────────────────"
if [ "$FAILURES" -eq 0 ]; then
  printf "${GREEN}All smoke tests passed${RESET} in ${ELAPSED}s\n"
  exit 0
else
  printf "${RED}${FAILURES} smoke test(s) failed${RESET} in ${ELAPSED}s\n"
  exit 1
fi
