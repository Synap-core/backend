#!/usr/bin/env bash
# kratos_config_errors (W6-HEAL N4/N5): the structural kratos.yml check shared
# by `synap doctor` and the update rollback (which falls back to
# ../kratos/kratos.yml.good when the pre-update file fails it).
#
# Renders the REAL generate_kratos_config twice (OIDC enabled through a fake
# CP read, and disabled) and asserts both pass — the check must never refuse
# what the installer writes — then cross-checks with PyYAML that the accepted
# render really parses. Each broken variant below is one way a render has
# broken or could break Kratos, and must be reported.
#
# Does NOT cover: a well-shaped wrong value (a valid-looking but wrong
# issuer), a wrong indent level, or anything only Kratos itself validates.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

extract() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {p=1} p{print} p&&/^}/{exit}' "$HERE/synap"; }
{
  echo 'RED=;YELLOW=;BLUE=;NC=;GREEN=;'
  for f in pod_admin_domain_for_domain pod_admin_url_for_domain shared_cookie_domain generate_kratos_config kratos_config_errors; do
    extract "$f"
  done
} > "$TMP/lib.sh"
grep -q '^kratos_config_errors()' "$TMP/lib.sh" || { bad "could not extract kratos_config_errors"; exit 1; }

render() { # <dir> <docker-output>
  mkdir -p "$1/bin" "$1/deploy" "$1/kratos"
  printf '#!/usr/bin/env bash\necho %s\n' "'{\"delivered\":true}'" > "$1/bin/curl"
  printf '#!/usr/bin/env bash\necho %s\n' "'$2'" > "$1/bin/docker"
  chmod +x "$1/bin/curl" "$1/bin/docker"
  printf 'KRATOS_WEBHOOK_SECRET=s\nCONTROL_PLANE_URL=https://api.synap.live\nPUBLIC_URL=https://pod.example.com\n' > "$1/deploy/.env"
  ( cd "$1/deploy"; PATH="$1/bin:$PATH"; . "$TMP/lib.sh"; generate_kratos_config pod.example.com ) >/dev/null 2>"$1/err"
}
check() { ( . "$TMP/lib.sh"; kratos_config_errors "$1" ); }

render "$TMP/on" 'pod:example.com|client-secret|https://api.synap.live'
render "$TMP/off" 'nothing row-shaped'
ON="$TMP/on/kratos/kratos.yml"; OFF="$TMP/off/kratos/kratos.yml"
grep -q 'issuer_url: https://api.synap.live' "$ON" && ok "render (oidc on): the provider block is present (non-vacuous)" || { bad "render on: $(cat "$TMP/on/err")"; exit 1; }
grep -q 'issuer_url' "$OFF" && bad "render (oidc off) has a provider" || ok "render (oidc off): no provider block"
[ -z "$(check "$ON")" ] && ok "the real render with OIDC on passes" || bad "real render (on) refused: $(check "$ON")"
[ -z "$(check "$OFF")" ] && ok "the real render with OIDC off passes" || bad "real render (off) refused: $(check "$OFF")"
if python3 -c 'import yaml' 2>/dev/null; then
  python3 -c 'import sys, yaml; c = yaml.safe_load(open(sys.argv[1])); assert c["selfservice"]["methods"]["oidc"]["config"]["providers"][0]["issuer_url"].startswith("https://")' "$ON" \
    && ok "PyYAML parses the accepted render (cross-check)" || bad "PyYAML refuses the render the check accepted"
else
  echo "skip - PyYAML not installed: no parser cross-check"
fi

# variant <name> <expected-error-regex> <transform: sed or awk program on $ON>
variant() {
  local name="$1" want="$2" out
  out="$(check "$TMP/$name.yml")"
  if grep -qE "$want" <<<"$out"; then ok "$name: reported ($(head -1 <<<"$out"))"
  else bad "$name: expected /$want/, got: ${out:-<nothing>}"; fi
}
sed 's|client_id: pod:example.com|client_id: {"level":30,"msg":"config loaded"}|' "$ON" > "$TMP/json-log-in-client-id.yml"
variant json-log-in-client-id "client_id is not a plain string"
sed 's|issuer_url: https://api.synap.live|issuer_url: http://api.synap.live|' "$ON" > "$TMP/http-issuer.yml"
variant http-issuer "issuer_url is not an https URL"
sed '/client_secret:/d' "$ON" > "$TMP/no-secret.yml"
variant no-secret "client_secret is missing"
sed 's|client_secret: client-secret|client_secret: |' "$ON" > "$TMP/empty-secret.yml"
variant empty-secret "client_secret is not a plain string"
sed 's|client_secret: client-secret|client_secret: "client-secret|' "$ON" > "$TMP/unclosed-quote.yml"
variant unclosed-quote "client_secret is not a plain string"
{ head -3 "$ON"; echo '{"level":30,"time":1}'; tail -n +4 "$ON"; } > "$TMP/raw-log-line.yml"
variant raw-log-line "not a YAML key or list item"
awk '{ if ($0 ~ /client_id:/) sub(/^  /, "\t"); print }' "$ON" > "$TMP/tab.yml"
variant tab "tab in the indentation"
awk '/^ *providers:/{s=1} s && /mapper_url/{s=0; next} !s' "$ON" > "$TMP/enabled-no-provider.yml"
variant enabled-no-provider "oidc sign-in is enabled with no provider"
: > "$TMP/empty.yml"
variant empty "missing or empty"
exit $fail
