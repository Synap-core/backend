#!/usr/bin/env bash
# Orient: fetch identity, workspaces, and profiles in one deterministic shot.
# Requires: SYNAP_HUB_API_KEY, SYNAP_POD_URL.
# Output: single JSON object { user, workspaces, profiles }.
# Exit codes: 0 ok, 1 env missing, 2 HTTP failure.

set -euo pipefail

: "${SYNAP_HUB_API_KEY:?SYNAP_HUB_API_KEY not set}"
: "${SYNAP_POD_URL:?SYNAP_POD_URL not set}"

H="Authorization: Bearer $SYNAP_HUB_API_KEY"
POD="${SYNAP_POD_URL%/}"

user=$(curl -fsS -H "$H" "$POD/api/hub/users/me") || { echo "users/me failed" >&2; exit 2; }
user_id=$(printf '%s' "$user" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)

workspaces=$(curl -fsS -H "$H" "$POD/api/hub/workspaces") || { echo "workspaces failed" >&2; exit 2; }
ws_id="${SYNAP_WORKSPACE_ID:-}"
if [ -z "$ws_id" ]; then
  ws_id=$(printf '%s' "$workspaces" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)
fi

profiles=$(curl -fsS -H "$H" "$POD/api/hub/profiles?userId=$user_id&workspaceId=$ws_id") \
  || { echo "profiles failed" >&2; exit 2; }

printf '{"user":%s,"workspaces":%s,"workspaceId":"%s","profiles":%s}\n' \
  "$user" "$workspaces" "$ws_id" "$profiles"
