#!/bin/sh
# Replace the pod-agent container with the image the CURRENT RELEASE pins.
# Called by the pod-agent itself via the "agent-update" command.
#
# Update-door plan P4: the pod-agent is never built on the pod any more. The
# release block in deploy/.env (written by `synap update` / install.sh from a
# release manifest) pins SYNAP_IMAGE_POD_AGENT by DIGEST; this pulls exactly
# that and recreates the container from it (`--no-build`). A pod without a
# digest pin is refused — run `synap update --release <id>` on the host first.
#
# Args:
#   $1 — callbackUrl (optional, CP update result endpoint)
#   $2 — callbackJwt (optional, Bearer token for callback)

set -e

CALLBACK_URL="${1:-}"
CALLBACK_JWT="${2:-}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

notify() { # <true|false> [error]
  [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ] || return 0
  # wget, not curl: the pod-agent image (node:20-alpine + docker-cli) ships no curl.
  wget -q -O - --timeout=10 \
    --header="Authorization: Bearer ${CALLBACK_JWT}" \
    --header="Content-Type: application/json" \
    --post-data="{\"type\":\"agent-update\",\"success\":$1${2:+,\"error\":\"$2\"}}" \
    "$CALLBACK_URL" >/dev/null 2>&1 || echo "[update-agent] Callback failed (non-fatal)"
}
die() { echo "[update-agent] ERROR: $1" >&2; notify false "$1"; exit 1; }

[ -f "$DEPLOY_DIR/env-config.sh" ] || die "env-config.sh missing from the deploy dir"
SYNAP_DEPLOY_DIR="$DEPLOY_DIR"; export SYNAP_DEPLOY_DIR
# shellcheck source=/dev/null
. "$DEPLOY_DIR/env-config.sh"

IMAGE="$(envcfg_value SYNAP_IMAGE_POD_AGENT)"
case "$IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  "") die "no SYNAP_IMAGE_POD_AGENT pin in .env — run synap update --release <id> on the host (pod-agent is never built on the pod)" ;;
  *)  die "SYNAP_IMAGE_POD_AGENT=${IMAGE} is not pinned by digest — refusing to recreate from a mutable tag" ;;
esac

# shellcheck source=/dev/null
. "$DEPLOY_DIR/host-request.sh"

echo "[update-agent] Pulling ${IMAGE}..."
docker pull "$IMAGE" || die "pull failed: ${IMAGE}"
# The HOST recreates pod-agent: from in here, compose would mount the host's
# nonexistent /deploy into the new agent, and the recreate ends this process
# half-way. So the request is handed over and this returns once the host has
# TAKEN it — "success" here means accepted by the host engine; the recreate
# itself replaces this container (outcome: state/last-compose-request.json).
echo "[update-agent] Asking the host to recreate pod-agent from the pinned digest..."
host_compose --no-wait --recreate --no-deps --profile pod-agent pod-agent || die "the host did not take the pod-agent recreate request"

echo "[update-agent] Handed to the host engine."
notify true
