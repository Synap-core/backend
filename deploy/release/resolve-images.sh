#!/usr/bin/env bash
# ============================================================================
# THE image pin rule of a release — one resolver for both ways a release is
# made: make-manifest.py (published releases) and `synap update --from-source`
# (_ue_build_from_source, a pod building its own checkout).
# ============================================================================
#   resolve-images.sh <docker-compose.yml> [KEY=REF ...]
#
# Prints one line per SYNAP_IMAGE_* variable the compose file consumes:
#   KEY=<repo[:tag]@sha256:<64 hex>>   a given REF, else the compose default
#                                      tag resolved to its registry digest
#   KEY=                               a first-party image (its default is a
#                                      nested ${...}) that no REF was given for
# Exits non-zero (nothing printed) when a REF or a resolution is not pinned by
# digest, or a registry lookup fails. Never prints a floating tag: a pod that
# ran the compose default tag stayed on whatever it pulled first (the founder
# pod's TimescaleDB 2.26.4 while releases moved to 2.28.3, 2026-10-21).
# Resolution: `docker buildx imagetools inspect` (the registry's own index
# digest — the same image on every architecture).
# ============================================================================
set -uo pipefail
compose="${1:?usage: resolve-images.sh <docker-compose.yml> [KEY=REF ...]}"; shift
DIGEST_RE='^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$'
given=""                                           # "KEY=REF" lines (bash 3: no assoc arrays)
for kv in "$@"; do
    [[ "$kv" == SYNAP_IMAGE_*=* ]] || { echo "resolve-images: '$kv' is not KEY=REF" >&2; exit 2; }
    given+="${kv}"$'\n'
done
# ${SYNAP_IMAGE_X:-default} — default up to the first '}' or '$' (a nested
# ${...} default marks a first-party image); same reading as the engine's
# _ue_compose_image_keys and make-manifest's contract.
defaults="$(grep -oE '\$\{SYNAP_IMAGE_[A-Z0-9_]+:-[^}$]*\$?' "$compose" | sort -u)" || true
[ -n "$defaults" ] || { echo "resolve-images: no SYNAP_IMAGE_* variables in $compose" >&2; exit 1; }
out=""; seen=" "
while IFS= read -r m; do
    key="${m#\$\{}"; key="${key%%:-*}"
    case "$seen" in *" $key "*) continue ;; esac; seen="$seen$key "
    default="${m#*:-}"
    if grep -q "^${key}=" <<<"$given"; then
        ref="$(grep "^${key}=" <<<"$given" | tail -n 1)"; ref="${ref#*=}"
        given="$(grep -v "^${key}=" <<<"$given")"; [ -z "$given" ] || given+=$'\n'
    elif [[ "$default" == *'$' ]]; then
        out+="${key}="$'\n'; continue                    # first-party: the build names its digest
    else
        digest="$(docker buildx imagetools inspect "$default" --format '{{json .Manifest}}' 2>/dev/null | jq -r '.digest // empty' 2>/dev/null)"
        [ -n "$digest" ] || { echo "resolve-images: could not resolve ${default} (${key}) to a digest" >&2; exit 1; }
        ref="${default}@${digest}"
    fi
    [[ "$ref" =~ $DIGEST_RE ]] || { echo "resolve-images: ${key}=${ref} is not pinned by digest" >&2; exit 1; }
    out+="${key}=${ref}"$'\n'
done <<<"$defaults"
[ -z "${given//$'\n'/}" ] || { echo "resolve-images: given for keys the compose file does not use: $(cut -d= -f1 <<<"$given" | tr '\n' ' ')" >&2; exit 1; }
printf '%s' "$out"
