#!/usr/bin/env bash
# Tripwire: the bootstrap `install.sh` verifies the release manifest's cosign
# signature the SAME way `synap update` / `synap install` do (D12, warn mode).
#
# install.sh runs on a bare host BEFORE the bundle (and therefore `synap`) exists,
# so it cannot source `_ue_verify_manifest_sig`. It carries its own copy of the
# rule instead, and this test pins the two copies EQUAL:
#   1. the identity regexp + OIDC issuer are byte-identical in install.sh and synap
#      (and are the values docker-publish.yml actually signs as: the workflow file
#      name in the regexp exists under .github/workflows/)
#   2. the REAL `install.sh` (its own CLI, stub curl/cosign/docker on PATH, never
#      the network): warn (default) — no cosign / no bundle / a bad signature each
#      WARN and the install carries on to `synap install`; enforce — each of those
#      refuses BEFORE the bundle is downloaded or unpacked; off — cosign never runs
#   3. the cosign call carries exactly that regexp + issuer
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# ── 1. the two copies of the rule are equal ───────────────────────────────────
for name in SYNAP_RELEASE_SIGNER_RE SYNAP_RELEASE_OIDC_ISSUER; do
  a="$(grep -E "^${name}=" "$HERE/install.sh")"; b="$(grep -E "^${name}=" "$HERE/synap")"
  [ -n "$a" ] && [ "$(printf '%s\n' "$a" | wc -l)" -eq 1 ] && [ "$a" = "$b" ] \
    && ok "pin: $name is byte-identical in install.sh and synap" \
    || bad "pin: $name differs or is missing — install.sh: '${a:-<none>}' / synap: '${b:-<none>}'"
done
RE="$(sed -n "s/^SYNAP_RELEASE_SIGNER_RE='\(.*\)'$/\1/p" "$HERE/synap")"
wf="$(printf '%s' "$RE" | sed -n 's#.*/workflows/\([A-Za-z0-9_-]*\)\\\.yml@.*#\1.yml#p')"
[ -n "$wf" ] && [ -f "$HERE/.github/workflows/$wf" ] \
  && ok "pin: the signing workflow named in the regexp exists ($wf)" || bad "pin: workflow '$wf' named in the regexp is not in .github/workflows"

# ── 2. the real install.sh against stubs ──────────────────────────────────────
mkdir -p "$TMP/bin" "$TMP/rel/channel-stable" "$TMP/rel/v9.9.9" "$TMP/bundle/deploy"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/exec-args"\n' "$TMP" > "$TMP/bundle/synap"
echo "services: {}" > "$TMP/bundle/deploy/docker-compose.yml"
tar -czf "$TMP/rel/v9.9.9/synap-deploy-v9.9.9.tar.gz" -C "$TMP/bundle" .
SHA="$( { sha256sum "$TMP/rel/v9.9.9/synap-deploy-v9.9.9.tar.gz" 2>/dev/null || shasum -a 256 "$TMP/rel/v9.9.9/synap-deploy-v9.9.9.tar.gz"; } | cut -d' ' -f1)"
jq -n --arg s "$SHA" '{id:"v9.9.9", bundle:{asset:"synap-deploy-v9.9.9.tar.gz", sha256:$s}}' > "$TMP/rel/channel-stable/release.json"
cp "$TMP/rel/channel-stable/release.json" "$TMP/rel/v9.9.9/release.json"

cat > "$TMP/bin/curl" <<'C'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --retry|--max-time|-H) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
echo "${url#https://rel.test/}" >> "$STUB_LOG"
src="$STUB_REL/${url#https://rel.test/}"
[ -f "$src" ] || exit 22
cp "$src" "$out"
C
cat > "$TMP/bin/cosign" <<'C'
#!/usr/bin/env bash
echo cosign >> "$STUB_LOG"
printf '%s\n' "$@" > "$STUB_COSIGN_ARGS"
[ "${STUB_COSIGN_RESULT:-ok}" = ok ] && { echo "Verified OK" >&2; exit 0; }
echo "Error: none of the expected identities matched what was in the certificate" >&2
exit 1
C
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/docker"
chmod +x "$TMP/bin/curl" "$TMP/bin/cosign" "$TMP/bin/docker"
mkdir -p "$TMP/nocosign"; cp "$TMP/bin/curl" "$TMP/bin/docker" "$TMP/nocosign/"
SYS_PATH="/usr/bin:/bin"
PATH="$TMP/nocosign:$SYS_PATH" command -v cosign >/dev/null 2>&1 \
  && { bad "a real cosign is on $SYS_PATH — the 'no cosign' case cannot be staged"; exit 1; }
for t in jq tar openssl; do PATH="$SYS_PATH:/opt/homebrew/bin:/usr/local/bin" command -v $t >/dev/null || { bad "$t is required to run this test"; exit 1; }; done
JQ_DIR="$(dirname "$(command -v jq)")"

# boot <path-dir> <mode|""> <with-bundle 0|1> <cosign-result> → rc in $RC, output in $TMP/out
boot() {
  local dir="$1" mode="$2" with_bundle="$3" res="$4" d="$TMP/opt"
  rm -rf "$d" "$TMP/exec-args" "$TMP/args" "$TMP/log"; : > "$TMP/log"
  rm -f "$TMP/rel/channel-stable/release.json.sigstore.json"
  [ "$with_bundle" = 1 ] && echo '{"bundle":"fake"}' > "$TMP/rel/channel-stable/release.json.sigstore.json"
  RC=0
  ( export PATH="$TMP/$dir:$SYS_PATH:$JQ_DIR" STUB_REL="$TMP/rel" STUB_LOG="$TMP/log" STUB_COSIGN_ARGS="$TMP/args" STUB_COSIGN_RESULT="$res" \
      SYNAP_RELEASE_BASE_URL="https://rel.test" SYNAP_DIR="$d" SYNAP_BIN_DIR="$TMP/binlink"
    [ -n "$mode" ] && export SYNAP_RELEASE_VERIFY="$mode"
    mkdir -p "$TMP/binlink"
    bash "$HERE/install.sh" --name lab1 ) > "$TMP/out" 2>&1 </dev/null || RC=$?
}
downloaded_bundle() { grep -q 'synap-deploy-v9.9.9.tar.gz' "$TMP/log"; }
handed_over()       { [ -s "$TMP/exec-args" ] && grep -qx install "$TMP/exec-args"; }

# warn (the default) never blocks
boot nocosign "" 0 ok
[ "$RC" = 0 ] && handed_over && grep -q 'cosign is not installed' "$TMP/out" \
  && ok "warn: no cosign → warns, install carries on to synap install" || { bad "warn/no cosign: rc=$RC"; cat "$TMP/out"; }
boot bin "" 0 ok
[ "$RC" = 0 ] && handed_over && grep -q 'no signature (release.json.sigstore.json)' "$TMP/out" \
  && ok "warn: no published bundle → warns, carries on" || { bad "warn/no bundle: rc=$RC"; cat "$TMP/out"; }
boot bin "" 1 bad
[ "$RC" = 0 ] && handed_over && grep -q 'does not verify as Synap CI' "$TMP/out" \
  && ok "warn: a bad signature → warns, carries on" || { bad "warn/bad sig: rc=$RC"; cat "$TMP/out"; }
boot bin "" 1 ok
[ "$RC" = 0 ] && handed_over && grep -q 'signature verified' "$TMP/out" \
  && ok "a good signature → verified, carries on" || { bad "good sig: rc=$RC"; cat "$TMP/out"; }

# the cosign call is the shared rule, exactly
RE_SYN="$(sed -n "s/^SYNAP_RELEASE_SIGNER_RE='\(.*\)'$/\1/p" "$HERE/synap")"
ISS_SYN="$(sed -n 's/^SYNAP_RELEASE_OIDC_ISSUER="\(.*\)"$/\1/p' "$HERE/synap")"
{ grep -qxF -- "$RE_SYN" "$TMP/args" && grep -qxF -- "$ISS_SYN" "$TMP/args" && grep -qx 'verify-blob' "$TMP/args" && grep -q 'release.json$' "$TMP/args"; } \
  && ok "cosign verify-blob carries synap's identity regexp + issuer and the fetched manifest" || { bad "cosign args: $(tr '\n' ' ' < "$TMP/args")"; }

# enforce refuses, before the bundle is touched
boot nocosign enforce 0 ok
[ "$RC" != 0 ] && ! downloaded_bundle && [ ! -e "$TMP/opt/synap" ] && grep -q 'refused: cosign is not installed' "$TMP/out" \
  && ok "enforce: no cosign → refused before the bundle is downloaded" || { bad "enforce/no cosign: rc=$RC"; cat "$TMP/out"; }
boot bin enforce 0 ok
[ "$RC" != 0 ] && ! downloaded_bundle && [ ! -e "$TMP/opt/synap" ] \
  && ok "enforce: no bundle → refused before the bundle is downloaded" || { bad "enforce/no bundle: rc=$RC"; cat "$TMP/out"; }
boot bin enforce 1 bad
[ "$RC" != 0 ] && ! downloaded_bundle && [ ! -e "$TMP/opt/synap" ] && ! handed_over \
  && ok "enforce: a bad signature → refused, nothing unpacked, no hand-over" || { bad "enforce/bad sig: rc=$RC"; cat "$TMP/out"; }
boot bin enforce 1 ok
[ "$RC" = 0 ] && handed_over && ok "enforce: a good signature → installs" || { bad "enforce/good: rc=$RC"; cat "$TMP/out"; }

# off skips cosign entirely; an unknown mode falls back to warn
boot bin off 1 bad
[ "$RC" = 0 ] && ! grep -q '^cosign$' "$TMP/log" && ok "off: cosign is never run" || { bad "off: rc=$RC"; cat "$TMP/out"; }
boot bin bogus 1 bad
[ "$RC" = 0 ] && grep -q 'not warn|enforce|off — using warn' "$TMP/out" && ok "an unknown SYNAP_RELEASE_VERIFY falls back to warn" || { bad "bogus mode: rc=$RC"; cat "$TMP/out"; }

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
