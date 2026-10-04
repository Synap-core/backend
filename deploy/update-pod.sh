#!/bin/sh
#
# update-pod.sh <release-id> — SHIM to the one update engine.
#
# Update-door plan P2 (2026-10-04): every pod update goes through
# `synap update --release <id>` on the HOST (founder decision U1). The canary,
# the verified pre-update backup, the pull-by-digest, verification and the
# automatic rollback (previous images; the pre-update dump when the migration
# level moved) all live there — this file used to carry a second copy of each,
# and the two copies had drifted (by-tag rollback that could never work for
# `:local`, a `latest` default, no DB restore).
#
# The control plane already sends release ids (`main-<sha7>`, `vX.Y.Z`) — the
# same ids the release manifests are published under — so the argument passes
# through unchanged.
#
# Where the engine cannot run (inside the pod-agent container: no bash, no
# `synap`, and compose there would resolve this deploy dir's bind mounts
# against the wrong host path) this REFUSES before touching anything. Making
# pod-agent delegate to the host engine is plan phase P4.
#
# Usage: update-pod.sh <release-id | fast | stable>
#
set -e

VERSION="$1"
CD="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [update-pod] $*"; }
die() { log "ERROR: $*"; exit "${2:-1}"; }

[ -n "$VERSION" ] || die "a release id is required (update-pod.sh <release-id|fast|stable>)"

SYNAP=""
for candidate in "$CD/../synap" "$CD/synap" "$(command -v synap 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then SYNAP="$candidate"; break; fi
done
[ -n "$SYNAP" ] || die "the synap CLI (the update engine) is not reachable from here — run \`synap update --release ${VERSION}\` on the pod host. Nothing was changed." 3
command -v bash >/dev/null 2>&1 || die "bash is required to run the update engine (${SYNAP}). Nothing was changed." 3

log "delegating to: synap update --release ${VERSION}"
SYNAP_DEPLOY_DIR="$CD" SYNAP_ASSUME_YES=1 exec bash "$SYNAP" update --release "$VERSION"
