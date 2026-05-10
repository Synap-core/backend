#!/bin/sh
#
# Pod Self-Update Script — Canary-First, Near-Zero Downtime on Failure
#
# Key improvement over naive force-recreate:
#   The new image is validated in a sidecar (canary) container BEFORE the
#   production container is ever touched. If the image fails to start,
#   fails schema coherence, or fails health checks → the canary is removed
#   and the old backend keeps serving. No downtime on bad deploys.
#
# Flow:
#   1. Pull new image          (old backend still serving)
#   2. Run migrations          (backward-compat; old backend still serves)
#   3. Start backend-canary    (old backend still serving, canary on same net)
#   4. Health check canary     (up to 3 min; if fails → abort, old untouched)
#   5. Stop canary             (image is guaranteed good)
#   6. Force-recreate backend  (~2-3s gap; image already verified)
#   7. Verify production       (fast, ~2 min budget; image pre-verified)
#   8. Clean up old images
#
# Usage: update-pod.sh <version-tag>
#
set -e

VERSION="$1"
CD="$(dirname "$0")"
# CANONICAL PROJECT NAME — must match the synap CLI's `_resolve_compose_project_name`
# at the top of /opt/synap-backend/synap. The CLI pins `synap-backend`, init scripts
# use the same, eve's @eve/brain delegate exports the same. Anything else here will
# spawn a parallel project and orphan the data volumes.
#
# History: an earlier revision of this file used `-p synap` AND included a
# destructive `compose -p synap-backend down -v --remove-orphans` block under
# the (incorrect) assumption that `synap-backend` was an orphan from broken
# runs. That block destroyed live volumes on every CP-triggered update —
# kratos identities, hydra DB, and any data unique to synap_postgres_data —
# forcing operators to bootstrap a fresh admin every time. The block has been
# removed. NEVER reintroduce it: the canonical CLI owns project naming.
COMPOSE="docker compose -p synap-backend -f $CD/docker-compose.yml"
CANARY_NAME="synap-backend-canary"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [update] $*"; }
die() { log "ERROR: $*"; exit 1; }

[ -z "$VERSION" ] && die "version required"
log "=== Updating to ${VERSION} ==="

# Save current version for rollback (in case production swap still fails)
PREV_VERSION=$(grep "^BACKEND_VERSION=" "$CD/.env" 2>/dev/null | cut -d= -f2 || echo "")

# ─── Step 1: Set version and pull (old backend still serving) ─────────────────
case "$VERSION" in
  v*)   DOCKER_TAG="$VERSION" ;;
  *)    DOCKER_TAG="$VERSION" ;;
esac

log "Setting BACKEND_VERSION=${DOCKER_TAG} (from version=${VERSION})"
grep -q "^BACKEND_VERSION=" "$CD/.env" \
  && sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${DOCKER_TAG}/" "$CD/.env" \
  || echo "BACKEND_VERSION=${DOCKER_TAG}" >> "$CD/.env"

log "Pulling new images (backend still serving)..."
if ! $COMPOSE pull backend realtime backend-migrate 2>&1; then
  log "ERROR: Image pull failed — restoring previous version, old backend untouched"
  [ -n "$PREV_VERSION" ] && sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${PREV_VERSION}/" "$CD/.env"
  exit 1
fi

# Pull Kratos image (non-fatal — old Kratos keeps running if pull fails)
log "Pulling Kratos image (non-fatal)..."
$COMPOSE pull kratos kratos-migrate 2>/dev/null || log "WARN: Kratos image pull failed — skipping Kratos update"

# ─── Step 1b: Ensure Kratos/Hydra databases exist ─────────────────────────────
log "Ensuring kratos and hydra databases exist..."
$COMPOSE exec -T postgres psql -U synap -c "SELECT 'CREATE DATABASE kratos' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'kratos')\gexec" 2>/dev/null || true
$COMPOSE exec -T postgres psql -U synap -c "SELECT 'CREATE DATABASE hydra' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hydra')\gexec" 2>/dev/null || true

# ─── Step 2: Run migrations (old backend still serving) ───────────────────────
log "Running migrations (old backend still serving)..."
$COMPOSE run --rm backend-migrate 2>&1 || log "WARN: migration exited non-zero"

# Run Kratos migrations and update Kratos container (non-fatal).
# Kratos data lives in Postgres, so upgrading the image is safe.
# This ensures pods provisioned with older Kratos get POST /admin/identities/:id/sessions.
log "Running Kratos migrations (non-fatal)..."
$COMPOSE run --rm kratos-migrate 2>/dev/null || log "WARN: kratos-migrate exited non-zero"
log "Updating Kratos container (non-fatal)..."
$COMPOSE up -d --force-recreate kratos 2>/dev/null || log "WARN: Kratos container update failed"

# ─── Step 3: Start canary with new image (old backend still serving) ──────────
# Clean up any canary left over from a previous failed run
log "Cleaning up any previous canary..."
docker stop "$CANARY_NAME" 2>/dev/null || true
docker rm   "$CANARY_NAME" 2>/dev/null || true

log "Starting canary with new image (old backend still serving)..."
if ! $COMPOSE --profile canary up -d backend-canary 2>&1; then
  log "ERROR: Failed to start canary container — cleaning up, old backend untouched"
  docker stop "$CANARY_NAME" 2>/dev/null || true
  docker rm   "$CANARY_NAME" 2>/dev/null || true
  [ -n "$PREV_VERSION" ] && sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${PREV_VERSION}/" "$CD/.env"
  exit 1
fi

# ─── Step 4: Health check canary — abort if it fails ─────────────────────────
# We check the canary via docker exec → node HTTP (no wget/curl in alpine image).
# Runs against localhost inside the canary container to avoid DNS collision with
# the production `backend` alias. Up to 3 minutes (18 × 10s).
log "Waiting for canary health check (up to 3 min)..."
CANARY_OK=false
for i in $(seq 1 18); do
  sleep 10
  if docker exec "$CANARY_NAME" \
      node -e "const r=require('http').get('http://localhost:4000/health',(s)=>{process.exit(s.statusCode===200?0:1)});r.setTimeout(4000,()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1))" \
      2>/dev/null; then
    CANARY_OK=true
    log "Canary healthy after ${i}0s — image is good"
    break
  fi
  log "Canary health attempt $i/18..."
done

if [ "$CANARY_OK" != "true" ]; then
  log "ERROR: Canary failed health check after 3 minutes"
  log "Removing canary — old backend was never touched and remains up"
  docker stop "$CANARY_NAME" 2>/dev/null || true
  docker rm   "$CANARY_NAME" 2>/dev/null || true
  # Restore .env so the next attempt starts fresh
  [ -n "$PREV_VERSION" ] && sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${PREV_VERSION}/" "$CD/.env"
  exit 1
fi

# ─── Step 5: Canary verified — stop it, swap production ───────────────────────
# We KNOW the image starts and passes health checks. The only remaining gap is
# the ~2-3s while Docker recreates the production container. Caddy returns 502
# during this window, which is unavoidable on a single-process pod.
log "Canary passed — stopping canary, swapping production to new image..."
docker stop "$CANARY_NAME" 2>/dev/null || true
docker rm   "$CANARY_NAME" 2>/dev/null || true

log "Recreating production backend + realtime with new image (~2-3s gap)..."
$COMPOSE up -d --force-recreate --remove-orphans backend realtime 2>&1

# ─── Step 6: Verify production (fast — image already known-good) ──────────────
# Budget: 2 min (12 × 10s). Should pass within the first 1-2 attempts since
# the image was already validated by the canary. Rollback is a last resort here.
log "Verifying production health (up to 2 min)..."
OK=false
for i in $(seq 1 12); do
  sleep 10
  if wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null; then
    OK=true
    log "Production healthy after ${i}0s"
    break
  fi
  log "Production health attempt $i/12..."
done

if [ "$OK" != "true" ]; then
  log "ERROR: Production health check failed — this is unexpected after canary passed"
  log "The image started in canary but not in production (race condition / env diff?)"

  if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" != "$DOCKER_TAG" ]; then
    log "Rolling back to ${PREV_VERSION}..."
    sed -i "s/^BACKEND_VERSION=.*/BACKEND_VERSION=${PREV_VERSION}/" "$CD/.env"
    $COMPOSE up -d --force-recreate --remove-orphans backend realtime 2>&1

    ROLLBACK_OK=false
    for j in $(seq 1 12); do
      sleep 10
      if wget -q -O /dev/null --timeout=5 "http://backend:4000/health" 2>/dev/null; then
        ROLLBACK_OK=true
        log "Rollback to ${PREV_VERSION} successful"
        break
      fi
    done

    [ "$ROLLBACK_OK" != "true" ] && log "ERROR: Rollback also failed — pod may be down"
  fi

  exit 1
fi

# ─── Step 7: Clean up old images (keep last 3) ────────────────────────────────
log "Cleaning up old images..."
docker images "ghcr.io/synap-core/backend" --format "{{.ID}} {{.CreatedAt}}" \
  | sort -k2 -r \
  | tail -n +4 \
  | awk '{print $1}' \
  | xargs -r docker rmi 2>/dev/null || true
docker image prune -f 2>/dev/null || true

FREED=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -1)
log "Cleanup done (reclaimable: ${FREED:-unknown})"

log "=== Update to ${VERSION} complete ==="
exit 0
