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
# NOT covered: matcher-based routes (`@name`, other than refusing to count one as
# the catch-all), header blocks
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
            # Quoted strings first (the site-root HTML holds `#e4e4e7` and CSS
            # braces), then a comment: `#` at a line start or after a space.
            line=$0; gsub(/"[^"]*"/, "\"\"", line); sub(/(^|[[:space:]])#.*/, "", line)
            if (depth == 0 && line ~ /^}/) { inblk=0; next }
            if (depth == 0 && match(line, /^[[:space:]]*(handle|handle_path)[[:space:]]+\/[^[:space:]]*[[:space:]]*\{/)) {
                split(line, f, /[[:space:]]+/); i=1; while (f[i] == "") i++
                path=f[i+1]; up=""; depth=1; next
            }
            # A bare `handle {` is the catch-all ("*"); `handle @m {` is a
            # matcher route ("@m") and never counts as the catch-all.
            if (depth == 0 && match(line, /^[[:space:]]*handle[[:space:]]*\{/)) { path="*"; up=""; depth=1; next }
            if (depth == 0 && match(line, /^[[:space:]]*handle[[:space:]]+@[^[:space:]]+[[:space:]]*\{/)) {
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
[ "$ntls" -ge 8 ] && ok "parsed $ntls path routes from the TLS block" || bad "only $ntls TLS routes parsed (scan went blind)"
printf '%s\n' "$tls" | grep -qxF "$(printf '/api/pod-agent/*\tpod-agent:4002')" \
    && ok "self-check: the parser sees the TLS /api/pod-agent/* → pod-agent:4002 route" || bad "self-check: parser misses a known TLS route"
printf '%s\n' "$http" | grep -qxF "$(printf '*\tbackend:4000')" \
    && ok "self-check: the :80 catch-all to backend:4000 is seen" || bad "self-check: :80 catch-all not found"

# The reverse direction (2026-10-19, lab pod): the TLS block answered a static
# "Synap Backend API" line for every path it did not list, so backend routes
# outside /api, /trpc and /mcp (/admin/connect = the Claude connect link, the
# MCP OAuth endpoints, /setup) were dead on a directly exposed pod while the
# :80 catch-all served them. Both blocks end in the backend catch-all, and both
# refuse the paths that are never public before it.
printf '%s\n' "$tls" | grep -qxF "$(printf '*\tbackend:4000')" \
    && ok "TLS block forwards unlisted paths to backend:4000 (catch-all)" \
    || bad "TLS block has no backend catch-all: backend routes it does not list are unreachable on a direct pod"
# Cleartext (2026-10-19): the :80 blocks served the API in plain HTTP to anyone
# on a directly exposed pod. Only private (tunnel-connector) clients are served;
# others are redirected. One rule, both :80 blocks.
for hdr in '{$DOMAIN}:80 {' '{$POD_ADMIN_DOMAIN}:80 {'; do
    blk="$(H="$hdr" awk 'index($0, ENVIRON["H"]) == 1 {p=1; next} p && /^}/ {exit} p' "$CADDYFILE")"
    [ -n "$blk" ] || bad "could not find the ${hdr} block (scan went blind)"
    grep -qE '^[[:space:]]*not remote_ip private_ranges$' <<<"$blk" \
      && grep -qE '^[[:space:]]*redir @cleartext_from_outside https://\{host\}\{uri\} 308$' <<<"$blk" \
      && ok "outside cleartext clients are redirected to HTTPS in ${hdr}" \
      || bad "${hdr} serves outside clients in cleartext"
done
# The MinIO CONSOLE is a full admin UI behind one root key: never routed.
grep -qE '^[^#]*reverse_proxy[[:space:]]+minio:9001' "$CADDYFILE" \
  && bad "a route reaches the MinIO console (minio:9001)" || ok "no route reaches the MinIO console"

for never in '/internal/*' '/metrics'; do
    for blk in tls http; do
        eval "rt=\"\$$blk\""
        printf '%s\n' "$rt" | grep -qxF "$(printf '%s\t404' "$never")" \
            && ok "$blk block refuses $never" || bad "$blk block lets $never reach the backend"
    done
done

while IFS="$(printf '\t')" read -r path up; do
    [ -n "$path" ] || continue
    case "$path" in '*'|@*) continue;; esac   # catch-all + matcher routes: checked above / not covered
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
    # MinIO CVE-2026-41145 / CVE-2026-40344: unsigned-trailer uploads are
    # written without a signature check in every free MinIO build, so the
    # public S3 route must refuse them before they reach MinIO.
    blk="$(block_of "$hdr" '/synap-storage/*')"
    grep -qE '^[[:space:]]*@minio_unsigned_trailer header X-Amz-Content-Sha256 STREAMING-UNSIGNED-PAYLOAD-TRAILER$' <<<"$blk" \
        && grep -qE '^[[:space:]]*respond @minio_unsigned_trailer 403$' <<<"$blk" \
        && ok "/synap-storage/* refuses unsigned-trailer uploads in ${hdr}" || bad "/synap-storage/* lets unsigned-trailer uploads reach MinIO in ${hdr}"
    grep -qE '^[[:space:]]*respond @minio_snowball 403$' <<<"$blk" \
        && ok "/synap-storage/* refuses Snowball auto-extract in ${hdr}" || bad "/synap-storage/* lets Snowball auto-extract reach MinIO in ${hdr}"
    block_of "$hdr" '/.well-known/synap-registration' | grep -q 'rewrite \* /nonce.json' \
        && ok "registration proof route present in ${hdr}" || bad "registration proof route missing in ${hdr}"
done
# The proof route's root must be what compose mounts from state/registration-nonce.
root="$(block_of "$TLS_HDR" '/.well-known/synap-registration' | awk '$1 == "root" {print $3}')"
grep -qE "^[[:space:]]*- \./state/registration-nonce:${root}:ro\$" "$HERE/docker-compose.yml" \
    && ok "compose mounts ./state/registration-nonce at ${root} (read-only) for Caddy" \
    || bad "compose does not mount ./state/registration-nonce at '${root}'"

# ── the ACME email: an empty LETSENCRYPT_EMAIL must not make the Caddyfile invalid ──
# `email {$EMAIL}` with EMAIL="" is `email` with no argument: caddy refuses to
# load it (measured, caddy 2.11: "wrong argument count ... after 'email'"), and
# `synap update` validates the Caddyfile with caddy, so such a pod could never
# take a release. The option comes whole from compose (ACME_EMAIL_OPTION =
# "email <addr>" or nothing). Behavioural parts run when their tool exists:
# `docker compose config` (offline, no daemon) and a caddy binary (CADDY_BIN or
# `caddy` on PATH); each says when it was skipped.
COMPOSE_FILE_UNDER_TEST="${CADDY_ROUTES_COMPOSE:-$HERE/docker-compose.yml}"
EMAIL_RE='^[^#]*(^|[[:space:]])email[[:space:]]+\{\$'
printf '    email {$EMAIL}\n' | grep -qE "$EMAIL_RE" && ! printf '    # email {$EMAIL}\n' | grep -qE "$EMAIL_RE" \
    && ok "the email scan sees a literal 'email {\$EMAIL}' and ignores a comment" || bad "the email scan regex cannot see what it hunts"
if grep -qE "$EMAIL_RE" "$CADDYFILE"; then
    bad "the Caddyfile passes an env placeholder as the argument of email (empty ⇒ caddy cannot load it): $(grep -nE "$EMAIL_RE" "$CADDYFILE")"
else
    ok "no email directive takes a bare env placeholder"
fi
awk 'NR==1 && $0 !~ /^\{/ {exit 1} /^\}/ {exit} {print}' "$CADDYFILE" | grep -qE '^[[:space:]]*\{\$ACME_EMAIL_OPTION\}[[:space:]]*$' \
    && ok "the global options block takes the whole email option from ACME_EMAIL_OPTION" \
    || bad "the global options block does not read {\$ACME_EMAIL_OPTION}"
grep -qF 'ACME_EMAIL_OPTION: ${LETSENCRYPT_EMAIL:+email ${LETSENCRYPT_EMAIL}}' "$COMPOSE_FILE_UNDER_TEST" \
    && ok "compose sets ACME_EMAIL_OPTION only when LETSENCRYPT_EMAIL is non-empty" \
    || bad "compose does not derive ACME_EMAIL_OPTION from LETSENCRYPT_EMAIL (\${LETSENCRYPT_EMAIL:+email \${LETSENCRYPT_EMAIL}})"
ET="$(mktemp -d)"
env_base='DOMAIN=pod.example.com\nPOD_ADMIN_DOMAIN=admin.example.com\nPOD_ADMIN_URL=https://admin.example.com\nPUBLIC_URL=https://pod.example.com\nVAULT_SERVER_KEY=x\nBACKEND_VERSION=v0\n'
if docker compose version >/dev/null 2>&1; then
    for case in "ops@example.com|email ops@example.com" "|"; do
        addr="${case%%|*}"; want="${case#*|}"
        printf "${env_base}LETSENCRYPT_EMAIL=%s\n" "$addr" > "$ET/.env"
        got="$(docker compose --env-file "$ET/.env" -f "$COMPOSE_FILE_UNDER_TEST" config --format json caddy 2>/dev/null \
            | jq -r '.services.caddy.environment.ACME_EMAIL_OPTION // "<unset>"')"
        [ "$got" = "$want" ] && ok "compose: LETSENCRYPT_EMAIL='${addr}' → ACME_EMAIL_OPTION='${want}'" \
            || bad "compose: LETSENCRYPT_EMAIL='${addr}' → ACME_EMAIL_OPTION='${got}', want '${want}'"
    done
else
    echo "skip - docker compose is not installed: ACME_EMAIL_OPTION interpolation not exercised"
fi
CADDY="${CADDY_BIN:-$(command -v caddy || true)}"
if [ -n "$CADDY" ] && [ -x "$CADDY" ]; then
    # /var/log/caddy is the container's; point the access log at a temp dir.
    sed "s#/var/log/caddy#$ET/log#g" "$CADDYFILE" > "$ET/Caddyfile"; mkdir -p "$ET/log" "$ET/home"
    for opt in "" "email ops@example.com"; do
        out="$(cd "$ET" && HOME="$ET/home" XDG_DATA_HOME="$ET/home" XDG_CONFIG_HOME="$ET/home" DOMAIN=pod.example.com POD_ADMIN_DOMAIN=admin.example.com \
            EMAIL="${opt#email }" ACME_EMAIL_OPTION="$opt" "$CADDY" validate --config "$ET/Caddyfile" --adapter caddyfile 2>&1)" \
            && ok "caddy validates the Caddyfile with ACME_EMAIL_OPTION='${opt}'" \
            || bad "caddy refuses the Caddyfile with ACME_EMAIL_OPTION='${opt}': $(printf '%s' "$out" | tail -1)"
    done
else
    echo "skip - no caddy binary (CADDY_BIN / PATH): the Caddyfile is not loaded by caddy here"
fi
rm -rf "$ET"

exit $fail
