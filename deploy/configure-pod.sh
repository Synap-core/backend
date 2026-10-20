#!/bin/sh
#
# Configure Pod — updates .env and optionally activates profiles
#
# Usage: configure-pod.sh <callback-url> <callback-jwt> [KEY=VALUE...] [--profile <name>] [--recreate <service>]
#
# Runs INSIDE the pod-agent container (busybox sh, deploy dir at /deploy).
# .env is written ONLY through deploy/env-config.sh — the same validated door
# as `synap config set` (update-door plan P4): unknown keys, malformed values,
# the release block, the compose-project pin and a POD_AGENT_AUDIENCE that
# would no longer match PUBLIC_URL are refused, ALL-or-nothing, before any
# container is touched; the previous .env is kept as .env.bak.<ts>.
#
set -e

CALLBACK_URL="$1"
CALLBACK_JWT="$2"
shift 2 2>/dev/null || true

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
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

for helper in env-config.sh update-lock.sh host-request.sh; do
  if [ ! -f "${DEPLOY_DIR}/${helper}" ]; then
    log "ERROR: ${DEPLOY_DIR}/${helper} is missing — refusing to write .env without the config door. Nothing was changed."
    report "failed" "${helper} missing from the deploy dir"
    exit 1
  fi
done
SYNAP_DEPLOY_DIR="$DEPLOY_DIR"; export SYNAP_DEPLOY_DIR
# shellcheck source=/dev/null
. "${DEPLOY_DIR}/env-config.sh"
# shellcheck source=/dev/null
. "${DEPLOY_DIR}/update-lock.sh"
# shellcheck source=/dev/null
. "${DEPLOY_DIR}/host-request.sh"
synap_update_lock "$DEPLOY_DIR" "configure-pod" || { report "failed" "another pod operation is running"; exit 1; }

PAIRS="$(umask 077 && mktemp)"
trap 'rm -f "$PAIRS"' EXIT

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
      # Collected, then written in ONE validated batch below (the value never
      # reaches argv of another process, and never this log).
      printf '%s\n' "$1" >> "$PAIRS"
      ;;
    *)
      log "WARN: ignoring unknown argument: $1"
      ;;
  esac
  shift
done

if [ -s "$PAIRS" ]; then
  if ! CONFIG_OUT="$(envcfg_set --from-file "$PAIRS" 2>&1)"; then
    printf '%s\n' "$CONFIG_OUT" | while IFS= read -r l; do log "$l"; done
    report "failed" "$(printf '%s' "$CONFIG_OUT" | grep 'refused' | head -n 3 | tr '\n' ' ')"
    exit 1
  fi
  printf '%s\n' "$CONFIG_OUT" | while IFS= read -r l; do log "$l"; done
fi

# Containers are (re)created by the HOST engine, never from inside this
# container: compose run here resolves the relative binds (../kratos,
# ./Caddyfile, ./state) against /deploy, which the host's docker daemon reads
# as the host's /deploy — kratos once came up with no config and sign-in died
# (2026-10-19). host_compose (host-request.sh) hands the request to
# `synap compose-request` on the host, which also re-renders kratos.yml for the
# new .env (DOMAIN → CORS list) whenever kratos is in the list. The host takes
# the update lock itself, so ours is released first.
if [ -n "$PROFILES" ] || [ -n "$RECREATE_SERVICES" ]; then
  # The values are written; the unlock may drop the EXIT trap that removes them.
  rm -f "$PAIRS"
  synap_update_unlock
fi

# Activate profiles if requested (every service of those profiles comes up)
if [ -n "$PROFILES" ]; then
  log "Starting profile services (on the host)..."
  # shellcheck disable=SC2086
  host_compose $PROFILES || { report "failed" "the host could not start profiles:$(echo "$PROFILES" | sed 's/--profile//g')"; exit 1; }
fi

# Force-recreate specific services so they pick up new .env values (Compose
# re-reads env only on recreate, never on restart).
if [ -n "$RECREATE_SERVICES" ]; then
  log "Force-recreating services (on the host):$RECREATE_SERVICES"
  # shellcheck disable=SC2086
  host_compose --recreate --no-deps $RECREATE_SERVICES || { report "failed" "the host could not recreate:$RECREATE_SERVICES"; exit 1; }
fi

log "=== Configuration complete ==="
report "completed" ""
