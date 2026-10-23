#!/bin/sh
#
# pod-agent's `archive` command: hand the archive to the HOST engine.
#
# Usage: ARCHIVE_AGE_RECIPIENTS="age1… [age1…]" \
#          archive-request.sh <presigned-upload-url> <callback-url> <callback-jwt>
#
# pod-agent never archives the pod itself: from inside its container the
# pod's volumes are not files it can read, and an archive made there was
# uploaded EMPTY while reporting success. This script writes
# state/requests/archive.json (the ARCHIVE REQUEST CONTRACT above
# cmd_archive_request in `synap`); the host's synap-archive.path runs
# deploy/archive-pod.sh there, under the update lock, and records the outcome
# with the archive's manifest. This script waits for that outcome, prints the
# manifest as its last line (`ARCHIVE_MANIFEST {json}`: pod-agent returns it
# as the result's data.archiveManifest) and calls back a pushed command.
# The recipients come from the owner's policy (pod-agent passes them, D15);
# none, or a non-age one, refuses before anything is asked of the host.
#
UPLOAD_URL="$1"
CALLBACK_URL="$2"
CALLBACK_JWT="$3"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNAP_DEPLOY_DIR="$DEPLOY_DIR"; export SYNAP_DEPLOY_DIR
# shellcheck source=/dev/null
. "$DEPLOY_DIR/host-request.sh"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [archive] $*"; }
report() { # <status> <error-json> [manifest-json]
  [ -n "$CALLBACK_URL" ] && [ -n "$CALLBACK_JWT" ] || return 0
  BODY="{\"command\":\"archive\",\"status\":\"$1\",\"error\":${2:-null}${3:+,\"manifest\":$3}}"
  wget -q -O - --timeout=10 --header="Authorization: Bearer ${CALLBACK_JWT}" \
    --header="Content-Type: application/json" --post-data="$BODY" "$CALLBACK_URL" >/dev/null 2>&1 \
    || log "WARN: callback failed (non-fatal)"
}
refuse() { log "ERROR: $1"; report "failed" "\"$2\""; exit 1; }

RCPTS=""
for r in ${ARCHIVE_AGE_RECIPIENTS:-}; do
  case "$r" in
    age1*) RCPTS="${RCPTS:+$RCPTS,}\"$(printf '%s' "$r" | tr -cd 'a-z0-9')\"" ;;
    *) refuse "ARCHIVE_RECIPIENT_INVALID — not an age recipient" ARCHIVE_RECIPIENT_INVALID ;;
  esac
done
[ -n "$RCPTS" ] || refuse "ARCHIVE_RECIPIENT_MISSING — no archiveRecipients in deploy/state/pod-agent-policy.json; nothing stopped, nothing uploaded" ARCHIVE_RECIPIENT_MISSING
case "$UPLOAD_URL" in
  https://*) ;;
  *) refuse "ARCHIVE_UPLOAD_URL_INVALID — the upload URL must be https://" ARCHIVE_UPLOAD_URL_INVALID ;;
esac
# A presigned URL carries no quote or backslash; refuse one that would break the JSON.
case "$UPLOAD_URL" in *'"'*|*'\'*|*' '*) refuse "ARCHIVE_UPLOAD_URL_INVALID — unexpected characters" ARCHIVE_UPLOAD_URL_INVALID ;; esac

ID="archive-$(date -u +%Y%m%dT%H%M%SZ)-$$"
# The wait is a step of the archive timeout ladder (archive-limits.sh): longer
# than the host unit's own limit, shorter than pod-agent's kill.
# shellcheck source=/dev/null
[ -f "$DEPLOY_DIR/archive-limits.sh" ] || refuse "archive-limits.sh is missing from the deploy dir" "archive limits missing"
. "$DEPLOY_DIR/archive-limits.sh"
HOST_REQUEST_TIMEOUT_SECONDS="${ARCHIVE_TIMEOUT_SECONDS:-$ARCHIVE_REQUEST_WAIT_SECONDS}"; export HOST_REQUEST_TIMEOUT_SECONDS
if host_request archive "$ID" \
    "{\"schema\":1,\"id\":\"$ID\",\"uploadUrl\":\"$UPLOAD_URL\",\"recipients\":[$RCPTS],\"requestedBy\":\"pod-agent\",\"requestedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    "archive this pod"; then
  MANIFEST="$(printf '%s\n' "$HR_RECORD" | sed -n 's/.*"manifest":\({.*}\),"pod":.*/\1/p')"
  [ -n "$MANIFEST" ] || refuse "the host reported success without a manifest" "archive outcome has no manifest"
  report "completed" "null" "$MANIFEST"
  log "=== Pod archive finished on the host (request $ID) ==="
  echo "ARCHIVE_MANIFEST ${MANIFEST}"
  exit 0
fi
REASON="$(_hr_field "$HR_RECORD" reason | tr -d '"\\' | cut -c1-300)"
report "failed" "\"${REASON:-the host did not archive the pod}\""
exit 1
