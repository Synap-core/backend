#!/bin/sh
#
# Deploy Integrity Gate — fails loud if the running pod is NOT actually on
# the commit/migration set it's supposed to be on.
#
# Born from an investigation into a stale/wrong-commit deploy that silently
# passed: the `synap` CLI's build path (`docker compose build backend`) never
# `git pull`ed first, so a build could run against a stale local checkout
# with no signal anywhere that it happened. This script closes that gap with
# two independent, fail-closed assertions run AFTER the pod reports healthy:
#
#   (a) migrations — /status/release's `migrations.lastApplied` MUST equal
#       the newest migration file in this checkout. Needs NO image change;
#       this half works today against any already-deployed image.
#   (b) build commit — IF /status/release reports a non-null `buildStamp`
#       (i.e. the image was built with the GIT_SHA build-arg introduced
#       alongside this script — see deploy/Dockerfile + docker-compose.yml),
#       it MUST equal `git rev-parse HEAD` in the checkout that built it.
#       Older images (pulled from the registry pre-dating this change, or
#       built without the arg) report buildStamp: null and this half is
#       skipped — it is a strengthening check, not a hard requirement, so
#       existing deploys don't start failing on upgrade day.
#
# Usage:
#   deploy/verify-deploy.sh [pod-url]
#
# Release mode (the `synap update` engine): the expectations come from the
# release MANIFEST, not from a checkout — a release-bundle pod has no git
# HEAD and no migrations dir.
#   SYNAP_EXPECT_MIGRATION  manifest migrations.last (replaces the checkout's newest file)
#   SYNAP_EXPECT_GIT_SHA    manifest gitSha — then a null buildStamp is a FAILURE:
#                           every release image is built with the GIT_SHA build-arg
#   RELEASE_JSON_FILE       read /status/release from this file instead of curl
#                           (the engine fetches it from inside the backend container,
#                           which publishes no host port)
#
# pod-url defaults to http://localhost:4000 (in-cluster / on-host use). Exits
# non-zero on ANY mismatch or unreachable pod — callers (update-pod.sh, the
# synap CLI, CI) should treat a non-zero exit as "deploy did not actually
# land, do not consider it successful."
#
set -eu

POD_URL="${1:-http://localhost:4000}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [verify-deploy] $*"; }
die() { log "FAIL: $*"; exit 1; }

log "Checking ${POD_URL}/status/release against ${REPO_ROOT}..."

if [ -n "${RELEASE_JSON_FILE:-}" ]; then
  RELEASE_JSON="$(cat "$RELEASE_JSON_FILE" 2>/dev/null)" || die "cannot read ${RELEASE_JSON_FILE}"
  [ -n "$RELEASE_JSON" ] || die "${RELEASE_JSON_FILE} is empty"
else
  RELEASE_JSON="$(curl -fsS --max-time 10 "${POD_URL}/status/release" 2>&1)" \
    || die "could not reach ${POD_URL}/status/release: ${RELEASE_JSON:-no response}"
fi

# ── (a) migrations — mandatory, works on every image ───────────────────────
if [ -n "${SYNAP_EXPECT_MIGRATION:-}" ]; then
  EXPECTED_MIGRATION="$SYNAP_EXPECT_MIGRATION"
else
  EXPECTED_MIGRATION="$(cd "$REPO_ROOT" && ls packages/database/migrations/*.sql 2>/dev/null | sort | tail -1 | xargs -r basename)"
fi
[ -n "$EXPECTED_MIGRATION" ] || die "no migration files found under packages/database/migrations/*.sql"

ACTUAL_MIGRATION="$(echo "$RELEASE_JSON" | grep -o '"lastApplied":"[^"]*"' | head -1 | cut -d'"' -f4)"

if [ -z "$ACTUAL_MIGRATION" ]; then
  die "/status/release reported no migrations.lastApplied (expected ${EXPECTED_MIGRATION}) — response: ${RELEASE_JSON}"
fi

if [ "$ACTUAL_MIGRATION" != "$EXPECTED_MIGRATION" ]; then
  die "migration mismatch — pod reports lastApplied=${ACTUAL_MIGRATION}, but the newest migration in this checkout is ${EXPECTED_MIGRATION}. The deployed image/migrate run is behind (or the checkout is ahead of what was deployed)."
fi
log "OK migrations.lastApplied = ${ACTUAL_MIGRATION}"

# ── (b) build commit — best-effort, only when the image reports a buildStamp ──
ACTUAL_BUILD_STAMP="$(echo "$RELEASE_JSON" | grep -o '"buildStamp":"[^"]*"' | head -1 | cut -d'"' -f4)"

if [ -n "${SYNAP_EXPECT_GIT_SHA:-}" ]; then
  [ -n "$ACTUAL_BUILD_STAMP" ] || die "pod reports buildStamp: null, but release ${SYNAP_EXPECT_GIT_SHA} images are stamped — this is not the release's image"
  [ "$ACTUAL_BUILD_STAMP" = "$SYNAP_EXPECT_GIT_SHA" ] || die "buildStamp mismatch — pod reports ${ACTUAL_BUILD_STAMP}, the release is ${SYNAP_EXPECT_GIT_SHA}"
  log "OK buildStamp = ${ACTUAL_BUILD_STAMP} (release)"
elif [ -z "$ACTUAL_BUILD_STAMP" ]; then
  log "SKIP buildStamp check — pod reports buildStamp: null (image predates the GIT_SHA build-arg, or was pulled from the registry). Not a failure."
else
  EXPECTED_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")"
  if [ -z "$EXPECTED_SHA" ]; then
    log "SKIP buildStamp check — could not resolve git HEAD in ${REPO_ROOT} (not a git checkout?)."
  elif [ "$ACTUAL_BUILD_STAMP" != "$EXPECTED_SHA" ]; then
    die "buildStamp mismatch — pod reports buildStamp=${ACTUAL_BUILD_STAMP}, but this checkout's HEAD is ${EXPECTED_SHA}. The image was built from a different (likely stale) commit."
  else
    log "OK buildStamp = ${ACTUAL_BUILD_STAMP}"
  fi
fi

log "=== Deploy integrity verified ==="
exit 0
