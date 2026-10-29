#!/usr/bin/env bash
# deploy-tests.sh — the deploy safety tests, one door for every job that runs
# them: ci.yml "Release gate: deploy tests" and docker-publish.yml job
# release-checks (when each runs: scripts/ci-changes.mjs IMAGE_INPUTS).
#
# Deploy safety tripwires (daemon-free). pgdata-safety guards the 2026-10-02
# pod wipe: postgres data must live on its volume, every update door must run
# the placement guard first, and backups must land on the host. They guard
# what a release DOES to a pod, so they gate releases.
# bash, python3 and node only: no install, no layout. Run from the repo root.
set -uo pipefail

python3 -c 'import yaml' 2>/dev/null || pip install --quiet pyyaml
# EVERY deploy/__tests__/*.test.sh, derived by glob: a new test joins by
# existing. stdin is closed: a test that reads it would hang the job.
failed=""
n=0
for t in deploy/__tests__/*.test.sh; do
  n=$((n + 1))
  echo "::group::$t"
  bash "$t" </dev/null || failed="$failed $t"
  echo "::endgroup::"
done
[ "$n" -ge 30 ] || {
  echo "::error::only $n deploy tests found (glob moved?)"
  exit 1
}
node --test deploy/pod-agent/*.test.js || failed="$failed deploy/pod-agent"
[ -z "$failed" ] || {
  echo "::error::deploy tests failed:$failed"
  exit 1
}
echo "deploy tests: all $n shell tests and deploy/pod-agent passed"
