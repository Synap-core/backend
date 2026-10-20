#!/bin/sh
#
# Caddy's entrypoint: writes the site blocks for the pod's PREVIOUS names, then
# runs the command (`caddy run …`, or `caddy validate …` from `synap update`).
#
# When the Control Plane moves a pod to its new names, deploy/.env names the
# old pair for the move window: SYNAP_LEGACY_DOMAIN (the old pod host) and
# SYNAP_LEGACY_POD_ADMIN_DOMAIN (the old console host). Each one that is set
# gets a TLS block and its :80 twin that answer EVERY request with a 308 to the
# same path and query on the new host (DOMAIN / POD_ADMIN_DOMAIN). Only
# /.well-known/acme-challenge/* is left alone, so the old names' certificates
# renew during the window. Nothing else is served there: no proxy, no cookie,
# no CORS, no Kratos, no pod-agent.
#
# A key that is unset or empty renders no block (Caddy refuses an empty site
# address, so this cannot be a placeholder in the Caddyfile). A value that is
# not a bare hostname, or that equals a current name (a redirect to itself), is
# skipped and said so; deploy/env-config.sh refuses both before they reach .env.
# The Caddyfile imports what this writes: `import /etc/caddy/synap.d/*.caddy`.
set -eu

OUT_DIR="${SYNAP_CADDY_SNIPPETS_DIR:-/etc/caddy/synap.d}"
OUT="${OUT_DIR}/legacy-names.caddy"

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
is_host() { printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; }

# <old host> <placeholder of the new host> <current pod host> <current console host>
moved_block() {
    old="$(lower "$1")"
    [ -n "$old" ] || return 0
    if ! is_host "$old"; then
        echo "[caddy-entrypoint] previous name '$1' is not a hostname: no redirect for it" >&2
        return 0
    fi
    if [ "$old" = "$(lower "$3")" ] || [ "$old" = "$(lower "$4")" ]; then
        echo "[caddy-entrypoint] previous name ${old} is a current name: no redirect for it" >&2
        return 0
    fi
    for site in "$old" "${old}:80"; do
        cat <<EOF
${site} {
	@moved not path /.well-known/acme-challenge/*
	redir @moved https://${2}{uri} 308
}
EOF
    done
}

mkdir -p "$OUT_DIR"
{
    echo "# Written by caddy-entrypoint.sh at container start. Do not edit."
    moved_block "${SYNAP_LEGACY_DOMAIN:-}" '{$DOMAIN}' "${DOMAIN:-}" "${POD_ADMIN_DOMAIN:-}"
    moved_block "${SYNAP_LEGACY_POD_ADMIN_DOMAIN:-}" '{$POD_ADMIN_DOMAIN}' "${DOMAIN:-}" "${POD_ADMIN_DOMAIN:-}"
} > "${OUT}.tmp"
mv -f "${OUT}.tmp" "$OUT"

exec "$@"
