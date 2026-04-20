#!/bin/sh
#
# Configure Pod — updates .env and optionally activates profiles
#
# Usage: configure-pod.sh <callback-url> <callback-jwt> [KEY=VALUE...] [--profile <name>]
#
set -e

CALLBACK_URL="$1"
CALLBACK_JWT="$2"
shift 2 2>/dev/null || true

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="docker compose -p synap -f ${DEPLOY_DIR}/docker-compose.yml"
ENV_FILE="${DEPLOY_DIR}/.env"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [configure] $*"; }

report() {
  STATUS="$1"
  ERROR="$2"
  if [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ]; then
    wget -q -O - --timeout=10 \
      --header="Authorization: Bearer ${CALLBACK_JWT}" \
      --header="Content-Type: application/json" \
      --post-data="{\"command\":\"configure\",\"status\":\"${STATUS}\",\"error\":$(printf '%s' "${ERROR:-null}" | sed 's/"/\\"/g; s/^/"/; s/$/"/' | sed 's/^"null"$/null/')}" \
      "$CALLBACK_URL" 2>/dev/null || log "WARN: callback failed (non-fatal)"
  fi
}

log "=== Configuring pod ==="

PROFILES=""
RECREATE_SERVICES=""

# Process arguments: KEY=VALUE pairs, --profile, and --recreate flags.
# --recreate <service>: force-recreate the named service so it picks up
#   new env values (Docker Compose won't reload env vars on a simple
#   restart). Typically used after changing DOMAIN — the Caddy container
#   has to recreate to re-issue a cert for the new hostname.
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      PROFILES="$PROFILES --profile $1"
      log "Will activate profile: $1"
      ;;
    --recreate)
      shift
      RECREATE_SERVICES="$RECREATE_SERVICES $1"
      log "Will force-recreate service: $1"
      ;;
    *=*)
      KEY=$(echo "$1" | cut -d= -f1)
      VALUE=$(echo "$1" | cut -d= -f2-)
      # Update or append to .env
      if grep -q "^${KEY}=" "$ENV_FILE" 2>/dev/null; then
        sed -i "s|^${KEY}=.*|${KEY}=${VALUE}|" "$ENV_FILE"
        log "Updated ${KEY} in .env"
      else
        echo "${KEY}=${VALUE}" >> "$ENV_FILE"
        log "Added ${KEY} to .env"
      fi
      ;;
    *)
      log "WARN: ignoring unknown argument: $1"
      ;;
  esac
  shift
done

# Activate profiles if requested
if [ -n "$PROFILES" ]; then
  log "Starting profile services..."
  $COMPOSE $PROFILES up -d 2>&1
fi

# Force-recreate specific services so they pick up new .env values.
# Using `up -d --force-recreate` rather than `restart` because Compose
# only re-evaluates env vars on recreate.
if [ -n "$RECREATE_SERVICES" ]; then
  log "Force-recreating services:$RECREATE_SERVICES"
  # shellcheck disable=SC2086
  $COMPOSE up -d --force-recreate --no-deps $RECREATE_SERVICES 2>&1 | tail -20
fi

log "=== Configuration complete ==="
report "completed" ""
