#!/usr/bin/env bash
# Tripwire: the Caddyfile's plain-HTTP `{$DOMAIN}:80` block (the ONLY ingress of a
# tunnelled pod — cloudflared → caddy:80) must route every path the TLS
# `{$DOMAIN} {` block routes, to the SAME upstream.
#
# The defect (PODPROV B-report, 2026-10-13): the :80 block had fallen behind —
# no /.ory/hydra (no OAuth), no /storage + /synap-storage (no uploads), and
# /api/pod-agent went to the backend instead of the pod-agent (no CP control).
#
# Derived, never hand-listed: every `handle <path> {` of the TLS block is read
# with the upstream of its `reverse_proxy` (or `file_server` root) and looked up
# in the :80 block — an explicit handle with the same upstream, or, when the TLS
# upstream is backend:4000, the :80 catch-all `reverse_proxy backend:4000`.
# Also pinned: the /synap-storage sandbox CSP is on BOTH blocks (a stored SVG
# served on the pod origin must never run script, tunnelled or not), and the
# registration-proof route exists on both (PODPROV-CONTRACT §6.2).
#
# NOT covered: matcher-based routes (`@name` / bare `handle {`), header blocks
# other than the CSP above, the pod-admin pair (both are one reverse_proxy), and
# what a running Caddy actually serves (daemon-free; `caddy adapt` needs a
# Caddy binary or Docker, neither assumed in CI).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CADDYFILE="${CADDY_ROUTES_CADDYFILE:-$HERE/Caddyfile}"
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# <site-header-regex> → "path<TAB>upstream" per `handle <path> {` in that block.
routes() {
    HDR="$1" awk '
        BEGIN { hdr = ENVIRON["HDR"] }
        $0 ~ hdr { inblk=1; depth=0; next }
        inblk {
            line=$0; sub(/#.*/, "", line)
            if (depth == 0 && line ~ /^}/) { inblk=0; next }
            if (depth == 0 && match(line, /^[[:space:]]*(handle|handle_path)[[:space:]]+\/[^[:space:]]*[[:space:]]*\{/)) {
                split(line, f, /[[:space:]]+/); i=1; while (f[i] == "") i++
                path=f[i+1]; up=""; depth=1; next
            }
            if (depth > 0) {
                if (line ~ /reverse_proxy[[:space:]]+[^[:space:]{]+/ && up == "") {
                    split(line, g, /[[:space:]]+/); for (j in g) if (g[j] == "reverse_proxy") k=j; up=g[k+1]
                }
                if (line ~ /^[[:space:]]*root[[:space:]]/ && up == "") { n=split(line, g, /[[:space:]]+/); up="root:" g[n] }
                if (line ~ /respond[[:space:]]+404/ && up == "") up="404"
                o=gsub(/\{/, "{", line); c=gsub(/\}/, "}", line); depth += o - c
                if (depth == 0) print path "\t" up
                next
            }
            if (line ~ /^[[:space:]]*reverse_proxy[[:space:]]+backend:4000/) print "*\tbackend:4000"
        }' "$CADDYFILE"
}
# <site-header-regex> <path> → the non-comment lines of that handle block
block_of() {
    HDR="$1" awk -v p="$2" '
        BEGIN { hdr = ENVIRON["HDR"] }
        $0 ~ hdr { inblk=1; next }
        inblk && /^}/ { inblk=0 }
        inblk && ($1 == "handle" || $1 == "handle_path") && $2 == p { want=1 }
        want { if ($0 !~ /^[[:space:]]*#/) print; if ($0 ~ /^[[:space:]]*}/) want=0 }' "$CADDYFILE"
}

TLS_HDR='^\{\$DOMAIN\} \{'
HTTP_HDR='^\{\$DOMAIN\}:80 \{'
tls="$(routes "$TLS_HDR")"
http="$(routes "$HTTP_HDR")"

ntls=$(printf '%s\n' "$tls" | grep -c .)
[ "$ntls" -ge 12 ] && ok "parsed $ntls path routes from the TLS block" || bad "only $ntls TLS routes parsed (scan went blind)"
printf '%s\n' "$tls" | grep -qxF "$(printf '/api/pod-agent/*\tpod-agent:4002')" \
    && ok "self-check: the parser sees the TLS /api/pod-agent/* → pod-agent:4002 route" || bad "self-check: parser misses a known TLS route"
printf '%s\n' "$http" | grep -qxF "$(printf '*\tbackend:4000')" \
    && ok "self-check: the :80 catch-all to backend:4000 is seen" || bad "self-check: :80 catch-all not found"

while IFS="$(printf '\t')" read -r path up; do
    [ -n "$path" ] || continue
    want="$(printf '%s\t%s' "$path" "$up")"
    if printf '%s\n' "$http" | grep -qxF "$want"; then
        ok ":80 routes $path → $up"
    elif [ "$up" = "backend:4000" ] && ! printf '%s\n' "$http" | grep -q "^$(printf '%s' "$path" | sed 's/[.*/]/\\&/g')$(printf '\t')"; then
        ok ":80 routes $path → backend:4000 (catch-all)"
    else
        got="$(printf '%s\n' "$http" | awk -F'\t' -v p="$path" '$1 == p {print $2}')"
        bad ":80 block does not route $path to $up (got: ${got:-nothing — falls to the catch-all})"
    fi
done <<< "$tls"

csp='header Content-Security-Policy "sandbox;'
for hdr in "$TLS_HDR" "$HTTP_HDR"; do
    block_of "$hdr" '/synap-storage/*' | grep -qF "$csp" \
        && ok "/synap-storage/* carries the sandbox CSP in ${hdr}" || bad "/synap-storage/* lacks the sandbox CSP in ${hdr}"
    block_of "$hdr" '/.well-known/synap-registration' | grep -q 'rewrite \* /nonce.json' \
        && ok "registration proof route present in ${hdr}" || bad "registration proof route missing in ${hdr}"
done
# The proof route's root must be what compose mounts from state/registration-nonce.
root="$(block_of "$TLS_HDR" '/.well-known/synap-registration' | awk '$1 == "root" {print $3}')"
grep -qE "^[[:space:]]*- \./state/registration-nonce:${root}:ro\$" "$HERE/docker-compose.yml" \
    && ok "compose mounts ./state/registration-nonce at ${root} (read-only) for Caddy" \
    || bad "compose does not mount ./state/registration-nonce at '${root}'"

exit $fail
