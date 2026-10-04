#!/usr/bin/env bash
# validate-manifest.sh <release.json> [docker-compose.yml]
#
# Validates a release manifest with the ENGINE'S OWN rules: the jq program in
# `synap`'s _ue_manifest_errors (extracted at run time), so CI and every pod
# judge a manifest by one rule set — never a second copy that can drift.
# Exit 0 = valid; 1 = invalid (one reason per line on stderr); 2 = usage/setup.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="${1:-}"; compose="${2:-$HERE/deploy/docker-compose.yml}"
[ -f "$manifest" ] || { echo "usage: $0 <release.json> [docker-compose.yml]" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
fns="$(awk '/^_ue_compose_image_keys\(\) \{/{p=1} /^_ue_manifest_errors\(\) \{/{p=1} p{print} p&&/^}/{p=0}' "$HERE/synap")"
case "$fns" in *"_ue_manifest_errors()"*"_ue_compose_image_keys()"*|*"_ue_compose_image_keys()"*"_ue_manifest_errors()"*) ;; *)
  echo "could not extract the validator from $HERE/synap" >&2; exit 2 ;; esac
eval "$fns"
errors="$(_ue_manifest_errors "$manifest" "$compose")"
if [ -n "$errors" ]; then
  printf 'invalid release manifest %s:\n' "$manifest" >&2
  printf '  %s\n' "$errors" >&2
  exit 1
fi
echo "valid: $(jq -r '"\(.id) (\(.channel // "?")) git \(.gitSha[0:12]) — \(.images|length) images pinned, migrations → \(.migrations.last)"' "$manifest")"
