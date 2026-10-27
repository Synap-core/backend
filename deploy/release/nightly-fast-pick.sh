#!/usr/bin/env bash
# nightly-fast-pick.sh <owner/repo> [limit]
#
# Picks the commit the NIGHTLY fast release builds (docker-publish.yml,
# `schedule`): the newest commit on main's first-parent line whose CI
# "Release gate" check run succeeded. The newest main commit is not enough:
# its gate is often cancelled by the next push (ci.yml concurrency).
#
# Run it in a checkout of main (a shallow one deep enough for `limit`). Reads
# GitHub only (gh api, GH_TOKEN), never writes. Prints, for $GITHUB_OUTPUT:
#   sha=<40 hex>     the picked commit
#   build=true       it has no fast release yet → build it
#   build=false      main-<sha7> already exists, or channel-fast already points
#                    at it → nothing to do (no build, no approval request)
# Exit 1 when no commit of the last `limit` has a green gate, or when a GitHub
# read FAILS: a failed read is never taken for "not green" or "not released".
set -euo pipefail

repo="${1:?usage: nightly-fast-pick.sh <owner/repo> [limit]}"
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

picked=""
for sha in $(git log --first-parent --format=%H -n "$limit" HEAD); do
  green="$(_api "repos/$repo/commits/$sha/check-runs?check_name=Release%20gate&per_page=100" \
            --jq '[.check_runs[] | select(.conclusion == "success")] | length')"
  if [ "${green:-0}" -ge 1 ]; then picked="$sha"; break; fi
  echo "skip ${sha:0:7}: no green Release gate" >&2
done
if [ -z "$picked" ]; then
  echo "::error::None of the last $limit commits on main has a green \"Release gate\". Nothing to release." >&2
  exit 1
fi
sha7="${picked:0:7}"
echo "picked ${sha7}: newest main commit with a green Release gate" >&2

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
         if [ "$pointer_sha" = "$picked" ]; then released="channel-fast already points at $sha7"; fi
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
