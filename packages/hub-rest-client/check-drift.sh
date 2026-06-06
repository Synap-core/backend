#!/usr/bin/env bash
# Hub Protocol drift detector
# Compares REST routes defined in the backend against methods in HubRestClient.
# Run from any directory: ./synap-backend/packages/hub-rest-client/check-drift.sh
#
# Exit code: 0 = no gaps detected, 1 = uncovered routes found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REST_DIR="$SCRIPT_DIR/../api/src/routers/hub-protocol/rest"
CLIENT="$SCRIPT_DIR/src/client.ts"

if [[ ! -d "$REST_DIR" ]]; then
  echo "ERROR: REST route directory not found: $REST_DIR" >&2
  exit 2
fi

if [[ ! -f "$CLIENT" ]]; then
  echo "ERROR: Client not found: $CLIENT" >&2
  exit 2
fi

# ── Collect all declared REST paths ──────────────────────────────────────────
mapfile -t ALL_PATHS < <(
  grep -h 'path:' "$REST_DIR"/*.ts \
    | grep -oP '"/[^"]*"' \
    | tr -d '"' \
    | sort -u
)

# ── Collect all public async method names from client ────────────────────────
mapfile -t CLIENT_METHODS < <(
  grep -oP '^\s+async \K[a-zA-Z]+' "$CLIENT" \
    | sort -u
)

# ── Keyword map: route path segment → client method name fragment ─────────────
# For each route we extract its significant segments and check if any client
# method name contains those keywords. This is heuristic — the goal is to flag
# clearly uncovered routes, not to enforce 1:1 naming.

declare -a UNCOVERED=()
declare -a COVERED=()

path_is_covered() {
  local path="$1"
  # Extract significant words from the path (strip leading /, {params}, and trailing /{id} segments)
  local words
  words=$(echo "$path" | tr '/' '\n' | grep -v '^{' | grep -v '^$' | tr '-' '_')
  for word in $words; do
    [[ ${#word} -lt 3 ]] && continue
    for method in "${CLIENT_METHODS[@]}"; do
      local lower_method
      lower_method=$(echo "$method" | tr '[:upper:]' '[:lower:]')
      local lower_word
      lower_word=$(echo "$word" | tr '[:upper:]' '[:lower:]')
      if [[ "$lower_method" == *"$lower_word"* ]]; then
        return 0
      fi
    done
  done
  return 1
}

for path in "${ALL_PATHS[@]}"; do
  if path_is_covered "$path"; then
    COVERED+=("$path")
  else
    UNCOVERED+=("$path")
  fi
done

# ── Report ────────────────────────────────────────────────────────────────────
TOTAL=${#ALL_PATHS[@]}
N_COVERED=${#COVERED[@]}
N_UNCOVERED=${#UNCOVERED[@]}

echo ""
echo "Hub Protocol Drift Report"
echo "========================="
echo "Routes:  $TOTAL total  |  $N_COVERED covered  |  $N_UNCOVERED gaps"
echo ""

if [[ ${#CLIENT_METHODS[@]} -gt 0 ]]; then
  echo "Client methods (${#CLIENT_METHODS[@]}):"
  for m in "${CLIENT_METHODS[@]}"; do
    echo "  + $m"
  done
  echo ""
fi

if [[ $N_UNCOVERED -gt 0 ]]; then
  echo "Uncovered routes (no matching client method keyword):"
  for p in "${UNCOVERED[@]}"; do
    echo "  ! $p"
  done
  echo ""
  echo "ACTION: Add a method to HubRestClient for each '!' route, or mark it as intentionally server-only."
  exit 1
else
  echo "No drift detected — all routes have matching client coverage."
  exit 0
fi
