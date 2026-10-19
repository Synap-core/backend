#!/usr/bin/env bash
# Tripwire: a pod reports the release it runs.
#
# /api/provision/status answers podVersion from process.env.BACKEND_VERSION, and
# the CP health poll copies it into data_pods.current_version. Compose used
# BACKEND_VERSION only to pick images and never passed it to the backend, so
# every pod reported null and the CP offered — and ordered — the release already
# running, which ended with the pod in `error` (lifecycle audit, 2026-10-19).
# Both ends are pinned: the reader in the route, the value in the backend env.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

grep -qE 'podVersion:[[:space:]]*process\.env\.BACKEND_VERSION' "$HERE/apps/api/src/routers/provision.ts" \
  && ok "provision status reports podVersion from BACKEND_VERSION" \
  || bad "provision status no longer reads BACKEND_VERSION — update this test with the new source"

python3 - "$HERE/deploy/docker-compose.yml" <<'PY' && ok "the backend container receives BACKEND_VERSION from deploy/.env" || bad "the backend container does not receive BACKEND_VERSION (podVersion would read null)"
import sys, yaml
env = (yaml.safe_load(open(sys.argv[1]))["services"]["backend"].get("environment") or {})
if isinstance(env, list):
    env = dict(e.split("=", 1) for e in env if "=" in e)
v = str(env.get("BACKEND_VERSION", ""))
sys.exit(0 if v.startswith("${BACKEND_VERSION") else 1)
PY
exit $fail
