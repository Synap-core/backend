#!/bin/sh
# Rebuild and restart the pod-agent container.
# Called by the pod-agent itself via the "agent-update" command.
#
# Args:
#   $1 — callbackUrl (optional, CP update result endpoint)
#   $2 — callbackJwt (optional, Bearer token for callback)

set -e

CALLBACK_URL="${1:-}"
CALLBACK_JWT="${2:-}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="docker compose -p synap-backend -f ${DEPLOY_DIR}/docker-compose.yml"

echo "[update-agent] Rebuilding pod-agent container..."
$COMPOSE build pod-agent
$COMPOSE up -d --force-recreate pod-agent

echo "[update-agent] Done."

# Notify CP if callback was provided
if [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ]; then
  curl -sf -X POST "$CALLBACK_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $CALLBACK_JWT" \
    -d '{"type":"agent-update","success":true}' \
    || echo "[update-agent] Callback failed (non-fatal)"
fi
