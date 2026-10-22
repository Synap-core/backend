#!/usr/bin/env bash
# A pod moving to its new names (the Control Plane's move, brief: tenant naming
# v2): the pod half of the move contract, daemon-free.
#
#   • deploy/.env takes SYNAP_LEGACY_DOMAIN / SYNAP_LEGACY_POD_ADMIN_DOMAIN
#     through the ONE writer (env-config.sh, sourced under dash like the
#     pod-agent's busybox sh): a hostname or empty (clears the move), never one
#     of the pod's current names, never anything that is not a hostname;
#   • Caddy answers each set old name, TLS and :80, with a 308 to the same path
#     and query on the new host, ACME challenges excepted, and nothing else
#     (caddy-entrypoint.sh renders the blocks the Caddyfile imports; an unset
#     key renders none);
#   • on the host side of the configure (synap compose-request), the settings
#     derived from the names follow: SYNAP_BASE_DOMAIN becomes
#     <name>.pod.synap.live, the old origins in ALLOWED_ORIGINS the new ones,
#     every other entry kept; and the same through the operator's door
#     (`synap config set` + `synap apply`) for a pod moved by hand.
# Not covered: what a running Caddy serves (no daemon in CI; the rendered blocks
# were checked with `caddy adapt` when written), the Control Plane's side.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# ── the config door ───────────────────────────────────────────────────────────
D="$TMP/deploy"; mkdir -p "$D"
cp "$HERE/deploy/env-config.sh" "$HERE/deploy/env.schema" "$HERE/deploy/docker-compose.yml" "$D/"
reset_env() {
  printf '%s\n' 'DOMAIN=pod.alice.synap.live' 'POD_ADMIN_DOMAIN=pod-admin.alice.synap.live' \
    'PUBLIC_URL=https://pod.alice.synap.live' 'POD_AGENT_AUDIENCE=https://pod.alice.synap.live' > "$D/.env"
  rm -f "$D"/.env.bak.*
}
cfg() { SYNAP_DEPLOY_DIR="$D" dash -c '. "$1/env-config.sh"; shift; envcfg_set "$@"' _ "$D" "$@" > "$TMP/out" 2>&1; }
envval() { grep "^$1=" "$D/.env" | tail -1 | cut -d= -f2-; }

reset_env
cfg DOMAIN=alice.pod.synap.live POD_ADMIN_DOMAIN=admin.alice.pod.synap.live \
    PUBLIC_URL=https://alice.pod.synap.live POD_AGENT_AUDIENCE=https://alice.pod.synap.live \
    SYNAP_LEGACY_DOMAIN=pod.alice.synap.live SYNAP_LEGACY_POD_ADMIN_DOMAIN=pod-admin.alice.synap.live; rc=$?
[ "$rc" = 0 ] && [ "$(envval SYNAP_LEGACY_DOMAIN)" = pod.alice.synap.live ] && [ "$(envval DOMAIN)" = alice.pod.synap.live ] \
  && ok "the move's configure is accepted in one batch" || bad "move configure (rc=$rc): $(cat "$TMP/out")"
grep -q "caddy" "$TMP/out" && ok "the old names are read by caddy (recreate advice derived from compose)" || bad "recreate advice: $(cat "$TMP/out")"

cfg SYNAP_LEGACY_DOMAIN= SYNAP_LEGACY_POD_ADMIN_DOMAIN=; rc=$?
[ "$rc" = 0 ] && [ -z "$(envval SYNAP_LEGACY_DOMAIN)" ] && [ -z "$(envval SYNAP_LEGACY_POD_ADMIN_DOMAIN)" ] \
  && ok "an empty value clears the old names (window end, rollback)" || bad "clearing (rc=$rc): $(cat "$TMP/out")"

reset_env; before="$(cat "$D/.env")"
cfg SYNAP_LEGACY_DOMAIN=pod.alice.synap.live; rc=$?
[ "$rc" != 0 ] && [ "$(cat "$D/.env")" = "$before" ] && grep -q "SYNAP_LEGACY_DOMAIN (pod.alice.synap.live) is the pod's current DOMAIN" "$TMP/out" \
  && ok "an old name equal to the current DOMAIN is refused, nothing written" || bad "legacy = DOMAIN accepted (rc=$rc): $(cat "$TMP/out")"
cfg SYNAP_LEGACY_POD_ADMIN_DOMAIN=POD-ADMIN.alice.synap.live; rc=$?
[ "$rc" != 0 ] && grep -q "current POD_ADMIN_DOMAIN" "$TMP/out" && ok "an old console name equal to POD_ADMIN_DOMAIN is refused (any case)" || bad "legacy console = current accepted: $(cat "$TMP/out")"
cfg DOMAIN=alice.pod.synap.live SYNAP_LEGACY_DOMAIN=alice.pod.synap.live; rc=$?
[ "$rc" != 0 ] && ok "the check reads the batch's own new DOMAIN" || bad "legacy = new DOMAIN in one batch accepted"
for v in https://pod.alice.synap.live pod.alice.synap.live/x 'a b'; do
  cfg "SYNAP_LEGACY_DOMAIN=$v"; [ $? != 0 ] || bad "accepted SYNAP_LEGACY_DOMAIN=$v"
done
ok "an old name that is not a bare hostname is refused"
printf 'SYNAP_LEGACY_DOMAIN=pod-admin.alice.synap.live\n' >> "$D/.env"
out="$(SYNAP_DEPLOY_DIR="$D" dash -c '. "$1/env-config.sh"; envcfg_validate' _ "$D" 2>&1)"
printf '%s\n' "$out" | grep -q "^error|SYNAP_LEGACY_DOMAIN|" && ok "validate reports an old name that is a current one" || bad "validate: $out"

# ── Caddy ─────────────────────────────────────────────────────────────────────
render() { # [VAR=value...] → the rendered snippet on stdout, stderr in $TMP/err
  rm -rf "$TMP/snip"
  env -i PATH="$PATH" DOMAIN=alice.pod.synap.live POD_ADMIN_DOMAIN=admin.alice.pod.synap.live \
    SYNAP_CADDY_SNIPPETS_DIR="$TMP/snip" "$@" sh "$HERE/deploy/caddy-entrypoint.sh" true 2>"$TMP/err" \
    && cat "$TMP/snip/legacy-names.caddy"
}
blocks() { grep -cE '^[^#[:space:]].* \{$' <<<"$1"; }

out="$(render)"; rc=$?
[ "$rc" = 0 ] && [ "$(blocks "$out")" = 0 ] && ok "no old names: no site block (the import is empty)" || bad "unset render (rc=$rc): $out"
out="$(render SYNAP_LEGACY_DOMAIN= SYNAP_LEGACY_POD_ADMIN_DOMAIN=)"
[ "$(blocks "$out")" = 0 ] && ok "empty old names: no site block" || bad "empty render: $out"

out="$(render SYNAP_LEGACY_DOMAIN=pod.alice.synap.live SYNAP_LEGACY_POD_ADMIN_DOMAIN=Pod-Admin.alice.synap.live)"
[ "$(blocks "$out")" = 4 ] && ok "two old names: a TLS block and a :80 twin each" || bad "blocks: $out"
for site in "pod.alice.synap.live" "pod.alice.synap.live:80"; do
  sed -n "/^${site} {\$/,/^}\$/p" <<<"$out" | grep -qF 'redir @moved https://{$DOMAIN}{uri} 308' \
    && ok "${site} → 308 to the same path and query on DOMAIN" || bad "${site} block: $out"
done
for site in "pod-admin.alice.synap.live" "pod-admin.alice.synap.live:80"; do
  sed -n "/^${site} {\$/,/^}\$/p" <<<"$out" | grep -qF 'redir @moved https://{$POD_ADMIN_DOMAIN}{uri} 308' \
    && ok "${site} → 308 on POD_ADMIN_DOMAIN (host lowercased)" || bad "${site} block: $out"
done
[ "$(grep -c '@moved not path /.well-known/acme-challenge/\*$' <<<"$out")" = 4 ] && ok "only ACME challenges are exempt (the old names' certificates renew)" || bad "acme exemption: $out"
directives="$(grep -vE '^[^#[:space:]].* \{$|^\}$|^#|^[[:space:]]*(@moved|redir @moved) ' <<<"$out" | grep -c . || true)"
[ "$directives" = 0 ] && ok "nothing else is served on the old names (no proxy, header, cookie, route)" || bad "extra directives: $out"

out="$(render SYNAP_LEGACY_DOMAIN=alice.pod.synap.live)"
[ "$(blocks "$out")" = 0 ] && grep -q "is a current name" "$TMP/err" && ok "an old name equal to a current one renders nothing (no redirect loop)" || bad "self-redirect: $out"
out="$(render 'SYNAP_LEGACY_DOMAIN=evil.example { respond 200 }' SYNAP_LEGACY_POD_ADMIN_DOMAIN='bad_host')"
[ "$(blocks "$out")" = 0 ] && grep -q "is not a hostname" "$TMP/err" && ok "a value that is not a hostname renders nothing (no Caddyfile injection)" || bad "injection: $out"
env -i PATH="$PATH" SYNAP_CADDY_SNIPPETS_DIR="$TMP/snip" sh "$HERE/deploy/caddy-entrypoint.sh" sh -c 'echo "ran $0 $*"' a b > "$TMP/exec" 2>&1
grep -qx "ran a b" "$TMP/exec" && ok "the entrypoint then runs the given command (caddy run / caddy validate)" || bad "exec: $(cat "$TMP/exec")"

grep -qxF 'import /etc/caddy/synap.d/*.caddy' "$HERE/deploy/Caddyfile" && ok "the Caddyfile imports the rendered blocks" || bad "Caddyfile import missing"
CADDY="$(python3 -c 'import sys,yaml; print(yaml.dump(yaml.safe_load(open(sys.argv[1]))["services"]["caddy"]))' "$HERE/deploy/docker-compose.yml" 2>&1)"
grep -qF -- "- ./caddy-entrypoint.sh:/usr/local/bin/synap-caddy-entrypoint:ro" <<<"$CADDY" && ok "compose mounts the entrypoint read-only" || bad "compose mount: $CADDY"
grep -qF "SYNAP_LEGACY_DOMAIN: \${SYNAP_LEGACY_DOMAIN:-}" <<<"$CADDY" && grep -qF "SYNAP_LEGACY_POD_ADMIN_DOMAIN: \${SYNAP_LEGACY_POD_ADMIN_DOMAIN:-}" <<<"$CADDY" \
  && ok "compose passes both old names to caddy" || bad "compose env: $CADDY"
python3 - "$HERE/deploy/docker-compose.yml" <<'PY' && ok "compose runs caddy through the entrypoint with the default caddy run command" || bad "compose entrypoint/command"
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))["services"]["caddy"]
assert c["entrypoint"] == ["/bin/sh", "/usr/local/bin/synap-caddy-entrypoint"], c.get("entrypoint")
assert c["command"] == ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"], c.get("command")
PY

# ── the host side of the configure ────────────────────────────────────────────
extract() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {p=1} p{print} p&&/^}/{exit}' "$HERE/synap"; }
{
  echo 'RED=;YELLOW=;BLUE=;NC=;GREEN=;'
  for f in update_env_value synap_tenant_zones synap_legacy_tenant_zones synap_pod_name_ok synap_is_tenant_zone \
           pod_admin_domain_for_domain pod_admin_url_for_domain is_public_suffix common_parent_domain shared_cookie_domain \
           backfill_federation_public_urls reconcile_moved_origins; do
    extract "$f"
  done
} > "$TMP/lib.sh"
grep -q '^reconcile_moved_origins()' "$TMP/lib.sh" || { bad "could not extract reconcile_moved_origins"; exit 1; }
printf 'com\n' > "$TMP/psl.dat"
moved() { # the .env after the move's configure, then the reconcile compose-request runs
  rm -f "$D"/.env.bak.*
  printf '%s\n' 'DOMAIN=alice.pod.synap.live' 'POD_ADMIN_DOMAIN=admin.alice.pod.synap.live' \
    'POD_ADMIN_URL=https://admin.alice.pod.synap.live' 'PUBLIC_URL=https://alice.pod.synap.live' \
    'SYNAP_BASE_DOMAIN=alice.synap.live' 'SYNAP_LEGACY_DOMAIN=pod.alice.synap.live' \
    'SYNAP_LEGACY_POD_ADMIN_DOMAIN=pod-admin.alice.synap.live' "$@" > "$D/.env"
  ( cd "$D" && . ./env-config.sh && . "$TMP/lib.sh" && SYNAP_PSL_FILE="$TMP/psl.dat" backfill_federation_public_urls alice.pod.synap.live \
      && reconcile_moved_origins ) > "$TMP/out" 2>&1
}
moved 'ALLOWED_ORIGINS=https://crm.example.com,https://pod.alice.synap.live,https://pod-admin.alice.synap.live'
[ "$(envval SYNAP_BASE_DOMAIN)" = alice.pod.synap.live ] && ok "SYNAP_BASE_DOMAIN follows the new names (alice.pod.synap.live)" || bad "base: $(envval SYNAP_BASE_DOMAIN) $(cat "$TMP/out")"
[ "$(envval ALLOWED_ORIGINS)" = "https://crm.example.com,https://alice.pod.synap.live,https://admin.alice.pod.synap.live" ] \
  && ok "ALLOWED_ORIGINS: the old origins become the new ones, other entries kept in place" || bad "allowed: $(envval ALLOWED_ORIGINS)"
moved 'ALLOWED_ORIGINS=https://alice.pod.synap.live,https://pod.alice.synap.live'
[ "$(envval ALLOWED_ORIGINS)" = "https://alice.pod.synap.live" ] && ok "ALLOWED_ORIGINS: no duplicate when the new origin was already listed" || bad "dedupe: $(envval ALLOWED_ORIGINS)"
moved 'ALLOWED_ORIGINS=https://crm.example.com'
[ "$(envval ALLOWED_ORIGINS)" = "https://crm.example.com" ] && ! ls "$D"/.env.bak.* >/dev/null 2>&1 \
  && ok "ALLOWED_ORIGINS without the old origins: left alone, nothing added" || bad "untouched: $(envval ALLOWED_ORIGINS)"
grep -n 'reconcile_moved_origins$' "$HERE/synap" | grep -q . && grep -q "grep -qxE 'kratos|backend|realtime'" "$HERE/synap" \
  && ok "compose-request reconciles before recreating kratos, backend or realtime" || bad "compose-request does not call the reconcile"

# ── the operator's door: `synap config set` + `synap apply` ───────────────────
# A pod with no agent (behind a front proxy: the founder's, the team's) is moved
# by hand. `synap apply` must derive the same settings as the configure above,
# also when nothing runs yet (a stopped pod reads them at its next start).
extract cmd_apply >> "$TMP/lib.sh"
grep -q '^cmd_apply()' "$TMP/lib.sh" || { bad "could not extract cmd_apply"; exit 1; }
rm -f "$D"/.env.bak.*
printf '%s\n' 'DOMAIN=antoinesrvt.pod.synap.live' 'POD_ADMIN_DOMAIN=admin.antoinesrvt.pod.synap.live' \
  'POD_ADMIN_URL=https://admin.antoinesrvt.pod.synap.live' 'PUBLIC_URL=https://antoinesrvt.pod.synap.live' \
  'SYNAP_BASE_DOMAIN=antoinesrvt.synap.live' 'SYNAP_LEGACY_DOMAIN=pod.antoinesrvt.synap.live' \
  'SYNAP_LEGACY_POD_ADMIN_DOMAIN=pod-admin.antoinesrvt.synap.live' \
  'ALLOWED_ORIGINS=https://studio.staging.synap.live,https://pod-admin.antoinesrvt.synap.live' \
  'POSTGRES_PASSWORD=pw0test' 'JWT_SECRET=jwt0test' 'KRATOS_SECRETS_COOKIE=cookie0test' > "$D/.env"
( cd "$D" && SYNAP_DEPLOY_DIR="$D" && . ./env-config.sh && . "$TMP/lib.sh" \
    && get_deploy_dir() { echo "$D"; } && docker() { :; } \
    && SYNAP_PSL_FILE="$TMP/psl.dat" cmd_apply ) > "$TMP/out" 2>&1; rc=$?
[ "$rc" = 0 ] && grep -q "no running services" "$TMP/out" && [ "$(envval SYNAP_BASE_DOMAIN)" = antoinesrvt.pod.synap.live ] \
  && ok "synap apply: SYNAP_BASE_DOMAIN follows a move made by hand (no agent), even with nothing running" \
  || bad "apply base (rc=$rc): $(envval SYNAP_BASE_DOMAIN) $(cat "$TMP/out")"
[ "$(envval ALLOWED_ORIGINS)" = "https://studio.staging.synap.live,https://admin.antoinesrvt.pod.synap.live" ] \
  && ok "synap apply: the old console origin in ALLOWED_ORIGINS becomes the new one" || bad "apply allowed: $(envval ALLOWED_ORIGINS)"

exit $fail
