#!/usr/bin/env bash
# Tripwire: the bootstrap `install.sh` verifies the release manifest's cosign
# signature the SAME way `synap update` / `synap install` do (D12, enforce).
#
# install.sh runs on a bare host BEFORE the bundle (and therefore `synap`) exists,
# so it cannot source `_ue_verify_manifest_sig`. It carries its own copy of the
# rule instead, and this test pins the two copies EQUAL:
#   1. the identity regexp, OIDC issuer and cosign image are byte-identical in
#      install.sh and synap (and the workflow file named in the regexp exists)
#   2. the REAL `install.sh` (its own CLI, stub curl/cosign/docker on PATH, never
#      the network): enforce (default) — no signature / a bad signature / a
#      docker that cannot run cosign each refuse BEFORE the bundle is downloaded
#      or unpacked; with no host cosign the pinned image runs through docker;
#      warn — they warn and the install carries on; off — cosign never runs
#   3. the cosign call carries exactly that regexp + issuer
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# ── 1. the two copies of the rule are equal ───────────────────────────────────
for name in SYNAP_RELEASE_SIGNER_RE SYNAP_RELEASE_OIDC_ISSUER SYNAP_COSIGN_IMAGE; do
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
# docker: `compose version` (step 1) answers ok; `run` is sigstore's image,
# answering like cosign (or, with STUB_DOCKER_RC, like a daemon that cannot run it).
cat > "$TMP/bin/docker" <<'C'
#!/usr/bin/env bash
[ "$1" = run ] || exit 0
echo docker-cosign >> "$STUB_LOG"
printf '%s\n' "$@" > "$STUB_DOCKER_ARGS"
[ -n "${STUB_DOCKER_RC:-}" ] && { echo "docker: Error response from daemon: pull access denied" >&2; exit "$STUB_DOCKER_RC"; }
[ "${STUB_COSIGN_RESULT:-ok}" = ok ] && { echo "Verified OK" >&2; exit 0; }
echo "Error: none of the expected identities matched what was in the certificate" >&2
exit 1
C
chmod +x "$TMP/bin/curl" "$TMP/bin/cosign" "$TMP/bin/docker"
mkdir -p "$TMP/dockeronly"; cp "$TMP/bin/curl" "$TMP/bin/docker" "$TMP/dockeronly/"
SYS_PATH="/usr/bin:/bin"
PATH="$TMP/dockeronly:$SYS_PATH" command -v cosign >/dev/null 2>&1 \
  && { bad "a real cosign is on $SYS_PATH — the 'no host cosign' case cannot be staged"; exit 1; }
for t in jq tar openssl; do PATH="$SYS_PATH:/opt/homebrew/bin:/usr/local/bin" command -v $t >/dev/null || { bad "$t is required to run this test"; exit 1; }; done
JQ_DIR="$(dirname "$(command -v jq)")"

# boot <path-dir> <mode|""> <with-bundle 0|1> <cosign-result> → rc in $RC, output in $TMP/out
boot() {
  local dir="$1" mode="$2" with_bundle="$3" res="$4" d="$TMP/opt"
  rm -rf "$d" "$TMP/exec-args" "$TMP/args" "$TMP/dargs" "$TMP/log"; : > "$TMP/log"
  rm -f "$TMP/rel/channel-stable/release.json.sigstore.json"
  [ "$with_bundle" = 1 ] && echo '{"bundle":"fake"}' > "$TMP/rel/channel-stable/release.json.sigstore.json"
  RC=0
  ( export PATH="$TMP/$dir:$SYS_PATH:$JQ_DIR" STUB_REL="$TMP/rel" STUB_LOG="$TMP/log" STUB_COSIGN_ARGS="$TMP/args" STUB_COSIGN_RESULT="$res" \
      STUB_DOCKER_ARGS="$TMP/dargs" STUB_DOCKER_RC="${STUB_DOCKER_RC:-}" \
      SYNAP_RELEASE_BASE_URL="https://rel.test" SYNAP_DIR="$d" SYNAP_BIN_DIR="$TMP/binlink"
    unset SYNAP_RELEASE_VERIFY; [ -n "$mode" ] && export SYNAP_RELEASE_VERIFY="$mode"
    mkdir -p "$TMP/binlink"
    bash "$HERE/install.sh" --name lab1 ) > "$TMP/out" 2>&1 </dev/null || RC=$?
}
downloaded_bundle() { grep -q 'synap-deploy-v9.9.9.tar.gz' "$TMP/log"; }
handed_over()       { [ -s "$TMP/exec-args" ] && grep -qx install "$TMP/exec-args"; }
refused_untouched() { [ "$RC" != 0 ] && ! downloaded_bundle && [ ! -e "$TMP/opt/synap" ] && ! handed_over; }

# enforce (the default) refuses before the bundle is touched
boot bin "" 0 ok
refused_untouched && grep -q 'refused: no signature (release.json.sigstore.json)' "$TMP/out" \
  && ok "default: no published signature → refused before the bundle is downloaded" || { bad "default/no bundle: rc=$RC"; cat "$TMP/out"; }
boot bin "" 1 bad
refused_untouched && grep -q 'refused: the signature does not verify as Synap CI' "$TMP/out" \
  && ok "default: a bad signature → refused, nothing unpacked, no hand-over" || { bad "default/bad sig: rc=$RC"; cat "$TMP/out"; }
grep -q 'SYNAP_RELEASE_VERIFY=warn in the environment' "$TMP/out" \
  && ok "a refusal names the one-run way past it" || bad "the refusal does not say how to go on unverified"
boot bin "" 1 ok
[ "$RC" = 0 ] && handed_over && grep -q 'signature verified' "$TMP/out" \
  && ok "default: a good signature → verified, installs" || { bad "default/good sig: rc=$RC"; cat "$TMP/out"; }

# the cosign call is the shared rule, exactly (args of the run just above)
RE_SYN="$(sed -n "s/^SYNAP_RELEASE_SIGNER_RE='\(.*\)'$/\1/p" "$HERE/synap")"
ISS_SYN="$(sed -n 's/^SYNAP_RELEASE_OIDC_ISSUER="\(.*\)"$/\1/p' "$HERE/synap")"
IMG_SYN="$(sed -n 's/^SYNAP_COSIGN_IMAGE="\(.*\)"$/\1/p' "$HERE/synap")"
{ grep -qxF -- "$RE_SYN" "$TMP/args" && grep -qxF -- "$ISS_SYN" "$TMP/args" && grep -qx 'verify-blob' "$TMP/args" && grep -q 'release.json$' "$TMP/args"; } \
  && ok "cosign verify-blob carries synap's identity regexp + issuer and the fetched manifest" || { bad "cosign args: $(tr '\n' ' ' < "$TMP/args")"; }
[ ! -e "$TMP/dargs" ] && ok "a host cosign wins: docker run is never called" || bad "docker ran although a host cosign exists"

# no host cosign (a fresh host): sigstore's pinned image through docker
boot dockeronly "" 1 ok
[ "$RC" = 0 ] && handed_over && grep -q 'signature verified' "$TMP/out" \
  && ok "no host cosign: verified through the pinned cosign image, installs" || { bad "dockeronly/good: rc=$RC"; cat "$TMP/out"; }
dargs="$(tr '\n' ' ' < "$TMP/dargs" 2>/dev/null)"
for want in "run --rm" "--read-only" "--cap-drop ALL" "--security-opt no-new-privileges" \
            ",dst=/release,readonly" "$IMG_SYN" "verify-blob" "--certificate-identity-regexp" \
            "--certificate-oidc-issuer $ISS_SYN" \
            "--bundle /release/release.json.sigstore.json /release/release.json"; do
  grep -qF -- "$want" <<<"$dargs" && ok "docker cosign called with $want" || bad "docker cosign args lack '$want': $dargs"
done
boot dockeronly "" 1 bad
refused_untouched && grep -q 'refused: the signature does not verify' "$TMP/out" \
  && ok "no host cosign: a bad signature → refused" || { bad "dockeronly/bad: rc=$RC"; cat "$TMP/out"; }
STUB_DOCKER_RC=125 boot dockeronly "" 1 ok
refused_untouched && grep -q 'refused: could not run the signature check (docker exited 125' "$TMP/out" \
  && ! grep -q 'does not verify' "$TMP/out" \
  && ok "docker cannot run cosign (125) → refused, not called a bad signature" || { bad "dockeronly/125: rc=$RC"; cat "$TMP/out"; }

# warn (opt-in) carries on
boot bin warn 0 ok
[ "$RC" = 0 ] && handed_over && grep -q 'NOT signature-verified: no signature' "$TMP/out" \
  && ok "warn: no published signature → warns, carries on" || { bad "warn/no bundle: rc=$RC"; cat "$TMP/out"; }
boot bin warn 1 bad
[ "$RC" = 0 ] && handed_over && grep -q 'NOT signature-verified: the signature does not verify' "$TMP/out" \
  && ok "warn: a bad signature → warns, carries on" || { bad "warn/bad sig: rc=$RC"; cat "$TMP/out"; }

# off skips cosign entirely (and says so); an unknown mode means enforce
boot bin off 1 bad
[ "$RC" = 0 ] && ! grep -q '^cosign$\|^docker-cosign$' "$TMP/log" && grep -q 'NOT signature-checked' "$TMP/out" \
  && ok "off: cosign is never run, and the skip is printed" || { bad "off: rc=$RC"; cat "$TMP/out"; }
boot bin bogus 1 bad
refused_untouched && grep -q 'not warn|enforce|off — using enforce' "$TMP/out" \
  && ok "an unknown SYNAP_RELEASE_VERIFY falls back to enforce" || { bad "bogus mode: rc=$RC"; cat "$TMP/out"; }

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
