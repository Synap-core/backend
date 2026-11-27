#!/usr/bin/env bash
# nightly-fast-pick.sh <owner/repo> [limit]
# nightly-fast-pick.sh --commit <sha> <owner/repo>
#
# Picks the commit a fast release builds (docker-publish.yml).
#
# --commit (event `workflow_run`, decision ce5fb987, 2026-11-27): the commit
# whose post-merge CI run just finished. A pod deploys a commit by PULLING its
# CI-built release main-<sha7> instead of building it on the host, so every
# main commit whose post-merge run is all green gets one. Not all green, or
# already released, or channel-fast already at or past it: build=false and
# exit 0 (a red or superseded main run is not this workflow's failure).
#
# Default (event `schedule`, the NIGHTLY): the newest commit on main's first-parent line whose
# POST-MERGE CI run was all green (scripts/ci/release-gate-wait.mjs --once:
# the push run's Release gate, Full suite, API e2e and Reference docs all
# `success`; founder, 2026-10-29, "One trunk, three CI tiers"). The newest
# main commit is not enough: its run is often superseded by the next push
# (ci.yml concurrency), or still running.
#
# Run it in a checkout of main (a shallow one deep enough for `limit`) with
# node on PATH. Reads GitHub only (gh api, GH_TOKEN), never writes. Prints,
# for $GITHUB_OUTPUT:
#   sha=<40 hex>     the picked commit
#   build=true       it has no fast release yet → build it
#   build=false      main-<sha7> already exists, or channel-fast already points
#                    at it → nothing to do (no build, no approval request)
# Exit 1 when no commit of the last `limit` has an all-green post-merge run,
# or when a GitHub read FAILS: a failed read is never taken for "not green"
# or "not released".
set -euo pipefail

commit=""
if [ "${1:-}" = --commit ]; then
  commit="${2:-}"; shift 2 || true
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: nightly-fast-pick.sh --commit <40-hex sha> <owner/repo>" >&2; exit 1; }
fi
repo="${1:?usage: nightly-fast-pick.sh [--commit <sha>] <owner/repo> [limit]}"
limit="${2:-30}"

# gh api, with a 404 told apart from a failure: prints the body and exits 0,
# exits 4 on a 404, 1 on any other error.
_api() {
  local out err rc=0
  err="$(mktemp)"
  out="$(gh api "$@" 2>"$err")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if grep -q "HTTP 404" "$err"; then rm -f "$err"; return 4; fi
    echo "::error::GitHub read failed: gh api $*: $(cat "$err")" >&2
    rm -f "$err"; return 1
  fi
  rm -f "$err"
  printf '%s\n' "$out"
}

verdict="$(cd "$(dirname "$0")" && pwd)/../../scripts/ci/release-gate-wait.mjs"

picked=""
if [ -n "$commit" ]; then
  rc=0; node "$verdict" --once "$repo" "$commit" || rc=$?
  case "$rc" in
    0) picked="$commit" ;;
    1|3) echo "${commit:0:7}: its post-merge run is not all green (or still running): no release for it" >&2
         echo "sha=$commit"; echo "build=false"; exit 0 ;;
    *) echo "::error::could not read the post-merge run of ${commit:0:7} (exit $rc)" >&2; exit 1 ;;
  esac
fi
if [ -z "$commit" ]; then
  for sha in $(git log --first-parent --format=%H -n "$limit" HEAD); do
    rc=0; node "$verdict" --once "$repo" "$sha" || rc=$?
    case "$rc" in
      0) picked="$sha"; break ;;
      1|3) echo "skip ${sha:0:7}: its post-merge run is not all green (or still running)" >&2 ;;
      *) echo "::error::could not read the post-merge run of ${sha:0:7} (exit $rc)" >&2; exit 1 ;;
    esac
  done
fi
if [ -z "$picked" ]; then
  echo "::error::None of the last $limit commits on main has an all-green post-merge run. Nothing to release." >&2
  exit 1
fi
sha7="${picked:0:7}"
echo "picked ${sha7}: newest main commit whose post-merge run was all green" >&2

released=""
rc=0; _api "repos/$repo/releases/tags/main-$sha7" --jq .id >/dev/null || rc=$?
case "$rc" in
  0) released="release main-$sha7 exists" ;;
  4) ;;
  *) exit 1 ;;
esac
if [ -z "$released" ]; then
  rc=0
  url="$(_api "repos/$repo/releases/tags/channel-fast" \
           --jq '.assets[] | select(.name == "release.json") | .browser_download_url')" || rc=$?
  case "$rc" in
    0) if [ -n "$url" ]; then
         pointer_sha="$(curl -fsSL --max-time 30 "$url" | jq -r '.gitSha // empty')" || {
           echo "::error::could not read channel-fast release.json ($url)" >&2; exit 1; }
         if [ "$pointer_sha" = "$picked" ]; then released="channel-fast already points at $sha7"
         elif [[ "$pointer_sha" =~ ^[0-9a-f]{40}$ ]]; then
           # channel-fast only moves forward: a per-commit run that finishes
           # after a newer commit's would otherwise move it back. Read through
           # GitHub (the checkout may be too shallow to hold the pointer's commit).
           rc=0; st="$(_api "repos/$repo/compare/$pointer_sha...$picked" --jq .status)" || rc=$?
           case "$rc" in
             0) case "$st" in
                  ahead) ;;
                  *) released="channel-fast points at ${pointer_sha:0:7}, which $sha7 is not ahead of ($st)" ;;
                esac ;;
             *) exit 1 ;;
           esac
         fi
       fi ;;
    4) ;;
    *) exit 1 ;;
  esac
fi

echo "sha=$picked"
if [ -n "$released" ]; then
  echo "already released: $released — nothing to build" >&2
  echo "build=false"
else
  echo "not released yet: main-$sha7 will be built" >&2
  echo "build=true"
fi
