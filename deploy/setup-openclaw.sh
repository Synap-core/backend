#!/usr/bin/env bash
# ==============================================================================
# OpenClaw Setup for Self-Hosted Synap
# ==============================================================================
#
# Creates an OpenClaw agent user + Hub Protocol API key on a running Synap pod,
# writes the credentials to an .env file, and starts the OpenClaw container.
#
# Prerequisites:
#   - A running Synap pod (docker compose up -d)
#   - PROVISIONING_TOKEN set in your Synap .env
#   - jq installed (brew install jq / apt install jq)
#
# Usage:
#   ./setup-openclaw.sh
#   ./setup-openclaw.sh --pod-url http://localhost:4000
#   ./setup-openclaw.sh --pod-url http://localhost:4000 --token MY_TOKEN
#
# Environment variables (alternative to flags):
#   SYNAP_POD_URL          Pod URL (default: http://localhost:4000)
#   PROVISIONING_TOKEN     Admin provisioning token
#   ENV_FILE               Path to .env file (default: .env)
#   COMPOSE_FILE           Docker compose file (default: docker-compose.standalone.yml)
#
# ==============================================================================

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────

POD_URL="${SYNAP_POD_URL:-http://localhost:4000}"
TOKEN="${PROVISIONING_TOKEN:-}"
ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.standalone.yml}"

# ── Parse flags ──────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pod-url)
      POD_URL="$2"
      shift 2
      ;;
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --help|-h)
      head -28 "$0" | tail -24
      exit 0
      ;;
    *)
      echo "Unknown flag: $1"
      exit 1
      ;;
  esac
done

# ── Preflight checks ────────────────────────────────────────────────────────

if ! command -v jq &> /dev/null; then
  echo "ERROR: jq is required but not installed."
  echo "  macOS:  brew install jq"
  echo "  Ubuntu: sudo apt install jq"
  echo "  Alpine: apk add jq"
  exit 1
fi

if [ -z "$TOKEN" ]; then
  # Try to read from .env file
  if [ -f "$ENV_FILE" ]; then
    TOKEN=$(grep -E '^PROVISIONING_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  fi
  if [ -z "$TOKEN" ]; then
    echo "ERROR: PROVISIONING_TOKEN is required."
    echo "  Set it via: --token <TOKEN>, PROVISIONING_TOKEN env var,"
    echo "  or ensure it exists in $ENV_FILE"
    exit 1
  fi
fi

echo "=== Synap + OpenClaw Setup ==="
echo ""
echo "Pod URL:  $POD_URL"
echo "Env file: $ENV_FILE"
echo ""

# ── Step 1: Check pod health ────────────────────────────────────────────────

echo "Checking Synap backend health..."
if ! curl -sf "$POD_URL/health" > /dev/null 2>&1; then
  echo "ERROR: Synap backend is not running at $POD_URL"
  echo "Start it first: docker compose -f $COMPOSE_FILE up -d"
  exit 1
fi
echo "OK - Backend is healthy"

# ── Step 2: Create agent credentials ────────────────────────────────────────

echo ""
echo "Generating OpenClaw agent credentials..."

HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
  "$POD_URL/api/hub/setup/agent" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"agentType": "openclaw"}' 2>&1) || {
  echo "ERROR: Could not reach the setup endpoint at $POD_URL/api/hub/setup/agent"
  exit 1
}

HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Setup endpoint returned HTTP $HTTP_CODE"
  ERROR_MSG=$(echo "$HTTP_BODY" | jq -r '.error // empty' 2>/dev/null || true)
  if [ -n "$ERROR_MSG" ]; then
    echo "  $ERROR_MSG"
  fi
  if echo "$HTTP_BODY" | grep -qi "no workspace"; then
    echo ""
    echo "  No workspace found. You must create an admin account first:"
    echo "  1. Set ADMIN_EMAIL in your .env file"
    echo "  2. Restart the backend: docker compose restart backend"
    echo "  3. Visit https://your-domain/registration to create your account"
    echo "  4. Re-run this script"
  fi
  exit 1
fi

# Parse response
HUB_API_KEY=$(echo "$HTTP_BODY" | jq -r '.hubApiKey')
AGENT_USER_ID=$(echo "$HTTP_BODY" | jq -r '.agentUserId')
WORKSPACE_ID=$(echo "$HTTP_BODY" | jq -r '.workspaceId')

if [ "$HUB_API_KEY" = "null" ] || [ -z "$HUB_API_KEY" ]; then
  echo "ERROR: Failed to parse credentials from response"
  echo "Response: $HTTP_BODY"
  exit 1
fi

echo "OK - Agent credentials created"

# ── Step 3: Write to .env ──────────────────────────────────────────────────

echo ""
echo "Writing OpenClaw env vars to $ENV_FILE..."

# Create .env if it does not exist
touch "$ENV_FILE"

# Remove existing OpenClaw vars (macOS + Linux compatible sed)
for var in OPENCLAW_HUB_API_KEY SYNAP_AGENT_USER_ID SYNAP_WORKSPACE_ID; do
  if grep -q "^${var}=" "$ENV_FILE" 2>/dev/null; then
    # macOS sed requires '' after -i, Linux does not
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "/^${var}=/d" "$ENV_FILE"
    else
      sed -i "/^${var}=/d" "$ENV_FILE"
    fi
  fi
done

# Append new values
cat >> "$ENV_FILE" << EOF

# OpenClaw Agent (generated by setup-openclaw.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ"))
OPENCLAW_HUB_API_KEY=$HUB_API_KEY
SYNAP_AGENT_USER_ID=$AGENT_USER_ID
SYNAP_WORKSPACE_ID=$WORKSPACE_ID
EOF

echo "OK - Env vars written"

# ── Step 4: Start OpenClaw ─────────────────────────────────────────────────

echo ""
echo "Starting OpenClaw..."
docker compose -f "$COMPOSE_FILE" --profile openclaw up -d openclaw 2>/dev/null || {
  echo "WARNING: Could not start OpenClaw container."
  echo "  Make sure the openclaw service is defined in $COMPOSE_FILE"
  echo "  and the openclaw profile is uncommented."
  echo ""
  echo "  You can start it manually:"
  echo "    docker compose -f $COMPOSE_FILE --profile openclaw up -d openclaw"
}

# ── Step 5: Wait for health ────────────────────────────────────────────────

echo "Waiting for OpenClaw to start..."
HEALTH_OK=false
for i in $(seq 1 20); do
  if curl -sf "http://localhost:18789/health" > /dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 3
done

if [ "$HEALTH_OK" = true ]; then
  echo "OK - OpenClaw is running!"
else
  echo "WARNING: OpenClaw did not respond to health check after 60s"
  echo "  Check logs: docker compose -f $COMPOSE_FILE logs openclaw"
fi

# ── Step 6: Summary ───────────────────────────────────────────────────────

echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Hub API Key:  ${HUB_API_KEY:0:12}..."
echo "  Agent User:   $AGENT_USER_ID"
echo "  Workspace:    $WORKSPACE_ID"
echo ""
echo "IMPORTANT: Full API key saved to $ENV_FILE — do not share or log this file."
echo ""
echo "OpenClaw is now connected to your Synap pod."
echo "Install the Synap skill:"
echo "  openclaw skill install synap"
echo ""
echo "Or from source:"
echo "  openclaw skill install https://raw.githubusercontent.com/synap-core/backend/main/skills/synap/SKILL.md"
